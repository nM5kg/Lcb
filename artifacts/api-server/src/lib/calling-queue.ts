import type { PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { TISHL_OPEN_RETURN_CALL_STATUSES } from "./tishl-queue";
import type { CallReportDraft, CallingPaymentMethod } from "./calling-phone";

/** max_call_sessions.manual_request_id is UUID on prod (MAX workspace
 * type); mint real UUIDs for it. fundraising_call_reports.request_id is
 * TEXT, so the 64-hex idempotency key there stays as-is. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Calling data layer (Olam Chesed option 2 "Call-2", IVR path 1592).
 *
 * The DB half of the Calling build; the pure state machine lives in
 * calling-phone.ts. All queries are parameterized and scoped by
 * user_id / owner_user_id, following the tishl-queue.ts pattern.
 * Nothing here touches production data.
 *
 * TARGET SCHEMA — READ BEFORE RUNNING
 * -----------------------------------
 * This module targets the POST-migration schema in
 * ~/workspace/gavhah-copy/calling-migration.sql (calling_scheduled_calls
 * plus the max_return_calls columns). Until that migration is applied,
 * insertScheduledCall / getScheduledCalls / cancelScheduledCall fail
 * (the table does not exist yet) and the scheduled_call branch of
 * getTishlQueue can never fire.
 *
 * KNOWN GAP (verified live on staging 2026-11-19): the migration file
 * says tishl_reminders.item_kind is "unconstrained text". It is NOT:
 * staging has CHECKs on tishl_reminders, tishl_done, tishl_notes and
 * tishl_holds restricting item_kind to
 * ('task','case','missed_call','message'). Inserting a 'scheduled_call'
 * reminder/done/note/hold row FAILS until those four CHECKs are widened
 * to include 'scheduled_call' (additive ALTER TABLE ... DROP CONSTRAINT
 * + ADD CONSTRAINT). The SQL for that belongs in the migration, not here;
 * insertScheduledCall documents the failure mode. Reads (getTishlQueue)
 * are unaffected by the CHECKs.
 *
 * CALL REPORTS AND CASES — THE SKIP FLOW
 * --------------------------------------
 * fundraising_call_reports.case_id is NOT NULL (FK, ON DELETE RESTRICT),
 * so a report always needs a case. When the caller presses # to skip the
 * case choice, the call is NOT attributed to any case — never silently
 * pick one (the 141 manual flow's rule). Instead the fill-in lives on
 * the max_call_sessions row until a case is chosen:
 *
 *   1. saveReport with casePos null -> the engine resolves the case
 *      (resolveCaseSelection, then resolveSingleOpenCase for the
 *      single-open-case convenience) and, when there is still no case,
 *      calls updateSessionFill: outcome/mood/note/amount/money_kind are
 *      stored on the session row. No report row is created yet.
 *      A campaign/project pick is NOT lost in this hold: it is written
 *      to the session's purpose_type/purpose_key (and to the report's
 *      campaign_id/project_id once the report is created).
 *   2. Option 3 (update/edit) on that session -> the caller picks a case
 *      first (the phone machine already offers select-case in the edit
 *      flow), then the engine calls upsertCallReport: it creates the
 *      report from the session's stored fill-in (merged over the fresh
 *      fill-in draft), keyed by the session's manual_request_id, or
 *      updates the report if one already exists under that request_id.
 *   3. The single-open-case convenience is preserved: skip auto-uses the
 *      one open case when exactly one exists (resolveSingleOpenCase /
 *      resolveReportCaseId). With 0 or 2+ open cases the fill-in stays
 *      on the session; nothing is thrown at the caller.
 *   A report always needs a case_id (NOT NULL): a campaign/project pick
 *   alone cannot create a report yet — the fill-in stays on the session
 *   WITH the purpose persisted, until a case is chosen in option 3.
 *   (That is the honest limit of the NOT NULL case_id column, not a
 *   silent drop: the purpose is on the session row from the start.)
 *
 * money_kind is CHECK-constrained to ('none','received','pledged') on
 * the report; amount is NOT NULL, >= 0. On max_call_sessions, amount
 * (numeric) and money_kind (text) are added by a parallel migration;
 * updateSessionFill / upsertCallReport write against those columns.
 * A session's money_kind is only overwritten when the draft carries
 * one (COALESCE keeps the stored value otherwise); amount 0 means
 * "no amount", mirroring the report column.
 *
 * ENGINE CONTRACT for the saveReport effect (see calling-phone.ts):
 * the engine must have a max_call_sessions row id before it executes
 * saveReport — created at dial time for option 1 (insertPreparedSession)
 * or at manual-log start for option 2 (insertManualSession: a
 * 'completed' log row, never a 'prepared' dial intent, so the outbound
 * dial path can never claim it). Pass that id as sessionId to
 * insertCallReport / updateSessionFill. For updateReport on a session
 * entry (option 3), the engine calls upsertCallReport when the entry
 * has no report yet, and updateSessionFill when no case was chosen.
 */

export type CallLogFilter = "missed" | "outgoing" | "incoming" | "all";
export type CallLogKind = "missed" | "session" | "report";
export type LogEntryKind = "session" | "return_call" | "report";

export type CallLogItem = {
  kind: CallLogKind;
  id: number;
  title: string;
  detail: string;
  phone: string | null;
  created_at: string;
};

export type CallingContactRow = {
  id: number;
  name: string;
  phone: string;
  city: string | null;
  do_not_call: boolean;
  contact_role: string | null;
  updated_at: string;
};

/** One row of the combined case / campaign / project picker list. */
export type CaseProjectRow = {
  kind: "case" | "campaign" | "project";
  id: number;
  title: string;
};

export type CallReportOutcome =
  | "given" | "no_answer" | "callback" | "not_interested" | "do_not_call"
  | "pickup" | "cannot_give" | "pledged";
export const CALL_REPORT_OUTCOMES: readonly CallReportOutcome[] = [
  "given", "no_answer", "callback", "not_interested", "do_not_call",
  "pickup", "cannot_give", "pledged",
];

/**
 * LEGACY TRAP (Yakob 23:32 renamed "spoke" -> "given"): rows written
 * before the rename carry outcome='spoke'. Verified live 2026-11-19:
 * NEITHER table has an outcome CHECK (outcome is unconstrained text),
 * and there are currently ZERO 'spoke' rows in either table — so no
 * CHECK widening and no data rewrite are needed. New code NEVER writes
 * 'spoke'; reads map it to "given" via normalizeReportOutcome, so any
 * legacy row that appears later still shows under the "given" category.
 */
export function normalizeReportOutcome(outcome: string): CallReportOutcome {
  if (outcome === "spoke") return "given";
  assertOutcome(outcome);
  return outcome as CallReportOutcome;
}

/** Payment-method labels (CALLING_PAYMENT_METHODS in calling-phone.ts).
 * A label only — never a card number. */
/** Payment-method LABEL only — never a card number. Alias of the pure
 * machine's union (calling-phone.ts) so both layers share one type. */
export type PaymentMethod = CallingPaymentMethod;
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  "credit_card", "cash", "check", "tzedakah_card", "voucher",
];

/** A case / campaign / project pick, persisted (Yakob 23:33 DECIDED):
 * purpose_type/purpose_key on max_call_sessions (columns already exist
 * live), campaign_id/project_id on fundraising_call_reports (migration
 * 20261119_calling_categories.sql adds them). A pick is NEVER treated
 * like a skip any more. */
export type CallPurpose = {
  type: "case" | "campaign" | "project";
  /** The picked row's id, as a string (purpose_key is text). */
  key: string;
};

export type MoneyKind = "none" | "received" | "pledged";
export const MONEY_KINDS: readonly MoneyKind[] = ["none", "received", "pledged"];

export type CallReportInput = {
  caseId?: number | null;
  contactId?: number | null;
  contactName: string;
  outcome: CallReportOutcome;
  moneyKind?: MoneyKind;
  amount?: number | null;
  note?: string;
  mood?: string;
  /** Idempotency key. Generated when omitted. */
  requestId?: string;
  /** When set, the session row also gets outcome/mood/note. */
  sessionId?: number | null;
  /** Payment-method LABEL only (never a card number). */
  paymentMethod?: PaymentMethod | null;
  /** Campaign / project pick carried on the report (migration adds
   * the columns). caseId carries a case pick. */
  campaignId?: number | null;
  projectId?: number | null;
  /** What was undertaken, when the outcome is a (partly) paid pledge. */
  pledgeAmount?: number | null;
  /** The case/campaign/project pick, written to the session row's
   * purpose_type/purpose_key when sessionId is set. */
  purpose?: CallPurpose | null;
};

export type CallReportPatch = {
  caseId?: number | null;
  contactId?: number | null;
  outcome?: CallReportOutcome;
  moneyKind?: MoneyKind;
  amount?: number | null;
  note?: string;
  mood?: string;
  /** When set, the session row also gets outcome/mood/note. */
  sessionId?: number | null;
  paymentMethod?: PaymentMethod | null;
  campaignId?: number | null;
  projectId?: number | null;
  pledgeAmount?: number | null;
};

/**
 * The fill-in for one call, as carried by the phone machine's
 * CallReportDraft (calling-phone.ts) and stored on the max_call_sessions
 * row while no case is chosen yet. Only outcome is required: every other
 * field falls back to the session's stored value when the draft leaves
 * it null/undefined (upsertCallReport), or to the report defaults
 * (amount 0, moneyKind 'none', note '', mood 'neutral').
 */
export type SessionFillDraft = {
  outcome: CallReportOutcome;
  amount?: number | null;
  moneyKind?: MoneyKind;
  note?: string | null;
  mood?: string | null;
  /** Contact name for the report; the session phone number when omitted. */
  contactName?: string;
  phone?: string | null;
  /** Payment-method LABEL only (never a card number). */
  paymentMethod?: PaymentMethod | null;
  /** What was undertaken, when the outcome is a (partly) paid pledge. */
  pledgeAmount?: number | null;
  /** The case/campaign/project pick, persisted on the session row. */
  purpose?: CallPurpose | null;
};

/** Map a phone-machine CallReportDraft onto a SessionFillDraft. The engine
 * should set contactName from the resolved contact when it knows one. */
export function sessionFillFromReport(report: CallReportDraft): SessionFillDraft {
  return {
    outcome: normalizeReportOutcome(report.outcome),
    amount: report.amount ?? null,
    moneyKind: report.moneyKind ?? undefined,
    note: report.note ?? null,
    mood: report.mood ?? null,
    phone: report.phone ?? null,
    paymentMethod: report.paymentMethod ?? undefined,
    pledgeAmount: report.pledgeAmount ?? undefined,
  };
}

export type ScheduledCallInput = {
  contactId?: number | null;
  numberE164: string;
  displayName?: string;
  scheduledAt: Date;
  caseId?: number | null;
  campaignId?: number | null;
  projectId?: number | null;
  note?: string;
};

export type ScheduledCallRow = {
  id: number;
  contact_id: number | null;
  number_e164: string;
  display_name: string;
  scheduled_at: string;
  status: string;
  case_id: number | null;
  campaign_id: number | null;
  project_id: number | null;
  note: string;
  created_at: string;
};

/** max_return_calls statuses that still need a return call. 'completed' is done. */
export const CALLING_OPEN_RETURN_CALL_STATUSES: readonly string[] = TISHL_OPEN_RETURN_CALL_STATUSES;

const E164 = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/;
const CALL_LOG_PAGE = 50;
const CONTACTS_PAGE = 10;

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id");
}

function assertId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid id: " + String(id));
}

function assertE164(numberE164: string): void {
  if (!E164.test(numberE164)) throw new Error("Invalid US/Canada number: " + String(numberE164));
}

function assertOutcome(outcome: string): asserts outcome is CallReportOutcome {
  if (!(CALL_REPORT_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error("Invalid call outcome: " + outcome);
  }
}

function assertMoneyKind(moneyKind: string): asserts moneyKind is MoneyKind {
  if (!(MONEY_KINDS as readonly string[]).includes(moneyKind)) {
    throw new Error("Invalid money kind: " + moneyKind);
  }
}

function assertPaymentMethod(paymentMethod: string): asserts paymentMethod is PaymentMethod {
  if (!(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    throw new Error("Invalid payment method: " + paymentMethod);
  }
}

function assertPurpose(purpose: CallPurpose): void {
  if (!["case", "campaign", "project"].includes(purpose.type) ||
      !/^[0-9]+$/.test(String(purpose.key ?? ""))) {
    throw new Error("Invalid call purpose");
  }
}

/** Resolve a picked case/campaign/project to its report columns:
 * a case pick goes on case_id, a campaign pick on campaign_id, a
 * project pick on project_id. */
export function purposeToReportColumns(purpose: CallPurpose | null | undefined): {
  caseId: number | null; campaignId: number | null; projectId: number | null;
} {
  if (!purpose) return { caseId: null, campaignId: null, projectId: null };
  assertPurpose(purpose);
  const id = Number(purpose.key);
  if (purpose.type === "case") return { caseId: id, campaignId: null, projectId: null };
  if (purpose.type === "campaign") return { caseId: null, campaignId: id, projectId: null };
  return { caseId: null, campaignId: null, projectId: id };
}

/**
 * The member's call log, newest first.
 * - max_call_sessions by direction (outbound / inbound);
 * - open max_return_calls as missed calls (completed ones appear under
 *   'incoming' and 'all' as history);
 * - fundraising_call_reports as logged calls (under 'all' only: a report
 *   has no direction of its own).
 * Filter: 'missed' = open return calls only; 'outgoing' = outbound
 * sessions; 'incoming' = inbound sessions + return calls; 'all' = all
 * three sources. Capped at 50 rows (newest first).
 */
export async function getCallLog(
  client: PoolClient,
  userId: number,
  filter: CallLogFilter,
): Promise<CallLogItem[]> {
  assertUserId(userId);
  if (!["missed", "outgoing", "incoming", "all"].includes(filter)) {
    throw new Error("Invalid call log filter: " + String(filter));
  }
  const r = await client.query<{
    kind: CallLogKind;
    id: string;
    title: string;
    detail: string;
    phone: string | null;
    created_at: string;
  }>(
    "SELECT kind,id::bigint AS id,title,detail,phone,created_at::text AS created_at FROM (" +
      "SELECT 'session'::text AS kind,s.id," +
      "(CASE WHEN s.direction='outbound' THEN 'Call to ' ELSE 'Call from ' END || s.number_e164) AS title," +
      "COALESCE(NULLIF(s.outcome,''),s.status) AS detail,s.number_e164 AS phone,s.created_at " +
      "FROM public.max_call_sessions s WHERE s.user_id=$1 AND " +
      "($2='all' OR ($2='outgoing' AND s.direction='outbound') OR ($2='incoming' AND s.direction='inbound')) " +
      "UNION ALL " +
      "SELECT 'missed'::text,m.id,('Missed call from '||m.incoming_from) AS title," +
      "m.status AS detail,m.incoming_from AS phone,m.created_at " +
      "FROM public.max_return_calls m WHERE m.owner_user_id=$1 AND " +
      "($2='all' OR $2='incoming' OR ($2='missed' AND m.status=ANY($3::text[]))) " +
      "UNION ALL " +
      "SELECT 'report'::text,rep.id,('Call report: '||rep.contact_name) AS title," +
      "(rep.outcome || CASE WHEN rep.amount>0 THEN (' $'||rep.amount::text) ELSE '' END) AS detail," +
      "NULL::text AS phone,rep.created_at " +
      "FROM public.fundraising_call_reports rep WHERE rep.user_id=$1 AND $2='all'" +
      ") q ORDER BY q.created_at DESC,kind,id DESC LIMIT " + CALL_LOG_PAGE,
    [userId, filter, [...CALLING_OPEN_RETURN_CALL_STATUSES]],
  );
  return r.rows.map((row) => ({
    kind: row.kind,
    id: Number(row.id),
    title: row.title,
    detail: row.detail,
    phone: row.phone,
    created_at: row.created_at,
  }));
}

/** Open missed calls (still needing a return call), newest first. */
export async function getMissedCalls(
  client: PoolClient,
  userId: number,
): Promise<CallLogItem[]> {
  assertUserId(userId);
  const r = await client.query<{
    kind: CallLogKind;
    id: string;
    title: string;
    detail: string;
    phone: string | null;
    created_at: string;
  }>(
    "SELECT 'missed'::text AS kind,m.id::bigint AS id," +
      "('Missed call from '||m.incoming_from) AS title,''::text AS detail," +
      "m.incoming_from AS phone,m.created_at::text AS created_at " +
      "FROM public.max_return_calls m WHERE m.owner_user_id=$1 " +
      "AND m.status=ANY($2::text[]) ORDER BY m.created_at DESC,m.id DESC",
    [userId, [...CALLING_OPEN_RETURN_CALL_STATUSES]],
  );
  return r.rows.map((row) => ({
    kind: row.kind,
    id: Number(row.id),
    title: row.title,
    detail: row.detail,
    phone: row.phone,
    created_at: row.created_at,
  }));
}

/** The member's contact book, newest first, 10 per page. Archived/hidden contacts are excluded. */
export async function getCallingContacts(
  client: PoolClient,
  userId: number,
  offset = 0,
): Promise<CallingContactRow[]> {
  assertUserId(userId);
  const off = Math.max(0, Math.min(1000, Math.trunc(offset) || 0));
  const r = await client.query<{
    id: string;
    name: string;
    phone: string;
    city: string | null;
    do_not_call: boolean;
    contact_role: string | null;
    updated_at: string;
  }>(
    "SELECT id::bigint AS id,name,phone,city,do_not_call,contact_role,updated_at::text AS updated_at " +
      "FROM public.communication_contacts WHERE user_id=$1 " +
      "AND archived_at IS NULL AND hidden_at IS NULL " +
      "ORDER BY updated_at DESC,id DESC LIMIT " + CONTACTS_PAGE + " OFFSET $2",
    [userId, off],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    phone: row.phone,
    city: row.city,
    do_not_call: row.do_not_call,
    contact_role: row.contact_role,
    updated_at: row.updated_at,
  }));
}

/**
 * The combined case / campaign / project picker for the pre-call selection:
 * open askanus_cases, active community_projects owned by the member, and
 * active featured_causes. This is the list the phone state machine
 * indexes with casePos (cases, then campaigns, then projects, by title).
 */
export async function getOpenCasesAndProjects(
  client: PoolClient,
  userId: number,
): Promise<CaseProjectRow[]> {
  assertUserId(userId);
  const r = await client.query<{ kind: "case" | "campaign" | "project"; id: string; title: string }>(
    "SELECT kind,id::bigint AS id,title FROM (" +
      "SELECT 'case'::text AS kind,c.id,c.title FROM public.askanus_cases c " +
      "WHERE c.user_id=$1 AND c.status!='closed' " +
      "UNION ALL " +
      "SELECT 'campaign'::text,f.id,f.title FROM public.featured_causes f " +
      "WHERE f.status='active' " +
      "UNION ALL " +
      "SELECT 'project'::text,p.id,p.title FROM public.community_projects p " +
      "WHERE p.owner_id=$1 AND p.status='active'" +
      ") q ORDER BY kind,title",
    [userId],
  );
  return r.rows.map((row) => ({ kind: row.kind, id: Number(row.id), title: row.title }));
}

/** Resolve a casePos from the phone machine to {kind, id} via the picker list. */
export async function resolveCaseSelection(
  client: PoolClient,
  userId: number,
  casePos: number | null,
): Promise<CaseProjectRow | null> {
  if (casePos === null || casePos === undefined) return null;
  const list = await getOpenCasesAndProjects(client, userId);
  return list[casePos] ?? null;
}

/** Ids of the member's open askanus cases, by id. */
async function getOpenCaseIds(
  client: PoolClient,
  userId: number,
): Promise<number[]> {
  const open = await client.query<{ id: string }>(
    "SELECT id FROM public.askanus_cases WHERE user_id=$1 AND status!='closed' ORDER BY id",
    [userId],
  );
  return open.rows.map((row) => Number(row.id));
}

/**
 * The single-open-case convenience: the one open case id when the member
 * has exactly one open case, else null (0 or 2+ open cases). The caller
 * never gets a case picked for them silently — null means "no case
 * chosen yet", and the fill-in stays on the session (updateSessionFill).
 */
export async function resolveSingleOpenCase(
  client: PoolClient,
  userId: number,
): Promise<number | null> {
  assertUserId(userId);
  const ids = await getOpenCaseIds(client, userId);
  return ids.length === 1 ? ids[0] : null;
}

async function resolveReportCaseId(
  client: PoolClient,
  userId: number,
  caseId: number | null | undefined,
): Promise<number> {
  if (caseId) {
    assertId(caseId);
    const owned = await client.query(
      "SELECT id FROM public.askanus_cases WHERE id=$1 AND user_id=$2 AND status!='closed'",
      [caseId, userId],
    );
    if (!owned.rows[0]) throw new Error("Case is not open on this account");
    return caseId;
  }
  // No case chosen (# to skip): use the single open case when there is
  // exactly one; otherwise the caller (or option 3) must pick one — the
  // engine must NOT call insertCallReport in that case, it must hold the
  // fill-in on the session with updateSessionFill instead.
  const ids = await getOpenCaseIds(client, userId);
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) throw new Error("No open case on this account: pick one on the website first");
  throw new Error("More than one open case: pick one on the website first");
}

async function assertOwnedContact(
  client: PoolClient,
  userId: number,
  contactId: number,
): Promise<void> {
  assertId(contactId);
  const owned = await client.query(
    "SELECT id FROM public.communication_contacts WHERE id=$1 AND user_id=$2",
    [contactId, userId],
  );
  if (!owned.rows[0]) throw new Error("Contact is not on this account");
}

/**
 * Insert a call report (fundraising_call_reports) and, when a session id
 * is given, update that max_call_sessions row's outcome/mood/note.
 * Returns the report id, or null when the request_id was already saved
 * (idempotent retry). A 'do_not_call' outcome also enables DNC on the
 * contact, mirroring the existing manual-result flow (141).
 */
export async function insertCallReport(
  client: PoolClient,
  userId: number,
  input: CallReportInput,
): Promise<number | null> {
  assertUserId(userId);
  const outcome = normalizeReportOutcome(input.outcome);
  const moneyKind = input.moneyKind ?? "none";
  assertMoneyKind(moneyKind);
  if (input.paymentMethod !== undefined && input.paymentMethod !== null) {
    assertPaymentMethod(input.paymentMethod);
  }
  if (input.purpose !== undefined && input.purpose !== null) assertPurpose(input.purpose);
  const amount = input.amount ?? 0;
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid amount");
  const pledgeAmount = input.pledgeAmount ?? 0;
  if (!Number.isFinite(pledgeAmount) || pledgeAmount < 0) throw new Error("Invalid pledge amount");
  const contactName = String(input.contactName ?? "").trim();
  if (!contactName) throw new Error("Contact name is empty");
  const caseId = await resolveReportCaseId(client, userId, input.caseId);
  if (input.contactId) await assertOwnedContact(client, userId, input.contactId);
  if (input.campaignId) {
    const owned = await client.query(
      "SELECT id FROM public.featured_causes WHERE id=$1 AND status='active'",
      [input.campaignId],
    );
    if (!owned.rows[0]) throw new Error("Campaign is not active");
  }
  if (input.projectId) {
    const owned = await client.query(
      "SELECT id FROM public.community_projects WHERE id=$1 AND owner_id=$2",
      [input.projectId, userId],
    );
    if (!owned.rows[0]) throw new Error("Project is not on this account");
  }
  const requestId = input.requestId && /^[0-9a-f]{64}$/.test(input.requestId)
    ? input.requestId
    : randomBytes(32).toString("hex");
  const mood = String(input.mood ?? "neutral").slice(0, 40);
  const note = String(input.note ?? "").slice(0, 2000);
  const ins = await client.query<{ id: string }>(
    "INSERT INTO public.fundraising_call_reports " +
      "(user_id,case_id,contact_id,contact_name,outcome,money_kind,amount,note,request_id,observed_mood," +
      "payment_method,campaign_id,project_id,pledge_amount) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) " +
      "ON CONFLICT(user_id,request_id) DO NOTHING RETURNING id",
    [userId, caseId, input.contactId ?? null, contactName, outcome,
     moneyKind, amount, note, requestId, mood,
     input.paymentMethod ?? null, input.campaignId ?? null,
     input.projectId ?? null, pledgeAmount],
  );
  if (!ins.rows[0]) return null; // already saved under this request_id
  const reportId = Number(ins.rows[0].id);
  if (input.sessionId) {
    await client.query(
      "UPDATE public.max_call_sessions SET outcome=$1,mood=$2,note=$3,updated_at=now()," +
        "money_kind=COALESCE($6,money_kind),payment_method=COALESCE($7,payment_method)," +
        "pledge_amount=COALESCE($8,pledge_amount)," +
        "purpose_type=COALESCE($9,purpose_type),purpose_key=COALESCE($10,purpose_key) " +
        "WHERE id=$4 AND user_id=$5",
      [outcome, mood, note, input.sessionId, userId,
       input.moneyKind ?? null,
       input.paymentMethod ?? null, input.pledgeAmount ?? null,
       input.purpose ? input.purpose.type : null,
       input.purpose ? input.purpose.key : null],
    );
  }
  if (outcome === "do_not_call" && input.contactId) {
    await client.query(
      "UPDATE public.communication_contacts SET do_not_call=true," +
      "opt_out_reason='Do Not Call explicitly confirmed through verified hotline'," +
      "updated_at=now() WHERE id=$1 AND user_id=$2",
      [input.contactId, userId],
    );
  }
  return reportId;
}

/**
 * Hold a call's fill-in on its max_call_sessions row when no case was
 * chosen (# to skip with 0 or 2+ open cases, so no report can be
 * created yet). Writes outcome/mood/note/amount/money_kind; amount 0
 * means "no amount". money_kind is only overwritten when the draft
 * carries one — otherwise the stored value is kept (COALESCE).
 * Returns true when a session row owned by the caller was updated.
 * Requires the parallel migration's amount (numeric) + money_kind
 * (text) columns on max_call_sessions.
 */
export async function updateSessionFill(
  client: PoolClient,
  sessionId: number,
  userId: number,
  draft: SessionFillDraft,
): Promise<boolean> {
  assertUserId(userId);
  assertId(sessionId);
  const outcome = normalizeReportOutcome(draft.outcome);
  if (draft.moneyKind !== undefined) assertMoneyKind(draft.moneyKind);
  if (draft.paymentMethod !== undefined && draft.paymentMethod !== null) {
    assertPaymentMethod(draft.paymentMethod);
  }
  if (draft.purpose !== undefined && draft.purpose !== null) assertPurpose(draft.purpose);
  const amount = draft.amount ?? 0;
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid amount");
  const pledgeAmount = draft.pledgeAmount ?? null;
  if (pledgeAmount !== null && (!Number.isFinite(pledgeAmount) || pledgeAmount < 0)) {
    throw new Error("Invalid pledge amount");
  }
  const r = await client.query(
    "UPDATE public.max_call_sessions SET outcome=$1,mood=$2,note=$3,amount=$4," +
      "money_kind=COALESCE($5,money_kind)," +
      "payment_method=COALESCE($8,payment_method)," +
      "pledge_amount=COALESCE($9,pledge_amount)," +
      "purpose_type=COALESCE($10,purpose_type),purpose_key=COALESCE($11,purpose_key)," +
      "updated_at=now() " +
      "WHERE id=$6 AND user_id=$7",
    [outcome, String(draft.mood ?? "neutral").slice(0, 40),
     String(draft.note ?? "").slice(0, 2000), amount,
     draft.moneyKind ?? null, sessionId, userId,
     draft.paymentMethod ?? null, pledgeAmount,
     draft.purpose ? draft.purpose.type : null,
     draft.purpose ? draft.purpose.key : null],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Create the call report for a session once a case is chosen (option 3),
 * or update it if one already exists — keyed by the session's
 * manual_request_id, which becomes the report's request_id.
 *
 * The report is built from the session's stored fill-in merged under the
 * fresh draft: a draft field wins when it is not null/undefined, else
 * the stored session value is used (outcome always comes from the draft;
 * contact name falls back to the session phone number). caseId null
 * means "no case chosen": the session's own case (if any) is used, else
 * the single open case when exactly one exists; with 0 or 2+ open cases
 * this throws and the engine must keep the fill-in on the session
 * (updateSessionFill) instead of creating a report.
 * Returns the report id. A 'do_not_call' outcome also enables DNC on
 * the contact, mirroring insertCallReport.
 */
export async function upsertCallReport(
  client: PoolClient,
  userId: number,
  sessionId: number,
  caseId: number | null,
  draft: SessionFillDraft,
): Promise<number> {
  assertUserId(userId);
  assertId(sessionId);
  const draftOutcome = normalizeReportOutcome(draft.outcome);
  if (draft.moneyKind !== undefined) assertMoneyKind(draft.moneyKind);
  if (draft.paymentMethod !== undefined && draft.paymentMethod !== null) {
    assertPaymentMethod(draft.paymentMethod);
  }
  if (draft.purpose !== undefined && draft.purpose !== null) assertPurpose(draft.purpose);
  if (draft.amount !== undefined && draft.amount !== null &&
      (!Number.isFinite(draft.amount) || draft.amount < 0)) {
    throw new Error("Invalid amount");
  }
  if (draft.pledgeAmount !== undefined && draft.pledgeAmount !== null &&
      (!Number.isFinite(draft.pledgeAmount) || draft.pledgeAmount < 0)) {
    throw new Error("Invalid pledge amount");
  }
  const sess = await client.query<{
    manual_request_id: string | null;
    number_e164: string;
    contact_id: string | null;
    case_id: string | null;
    outcome: string;
    mood: string;
    note: string;
    amount: string | null;
    money_kind: string | null;
    payment_method: string | null;
    pledge_amount: string | null;
    purpose_type: string | null;
    purpose_key: string | null;
  }>(
    "SELECT manual_request_id,number_e164,contact_id::bigint AS contact_id," +
      "case_id::bigint AS case_id,outcome,mood,note,amount::text AS amount,money_kind," +
      "payment_method,pledge_amount::text AS pledge_amount,purpose_type,purpose_key " +
      "FROM public.max_call_sessions WHERE id=$1 AND user_id=$2",
    [sessionId, userId],
  );
  const s = sess.rows[0];
  if (!s) throw new Error("Call session not found");
  // The idempotency key: the session's manual_request_id when it is a
  // UUID, else mint one and store it so retries stay stable.
  let requestId = s.manual_request_id;
  if (!requestId || !UUID_RE.test(requestId)) {
    requestId = randomUUID();
    await client.query(
      "UPDATE public.max_call_sessions SET manual_request_id=$1,updated_at=now() " +
        "WHERE id=$2 AND user_id=$3",
      [requestId, sessionId, userId],
    );
  }
  const wantedCase = caseId ??
    (s.case_id === null ? null : Number(s.case_id));
  // A case pick (draft purpose or the explicit caseId) wins over the
  // session's stored case; a campaign/project pick does not replace
  // the case — the report still needs its NOT NULL case_id, resolved
  // by the single-open-case convenience below, or the engine holds
  // the fill-in on the session (with the purpose persisted).
  const purposeCaseId = draft.purpose?.type === "case" ? Number(draft.purpose.key) : null;
  const resolvedCaseId = await resolveReportCaseId(
    client, userId, caseId ?? purposeCaseId ?? wantedCase);
  const storedAmount = s.amount === null || s.amount === "" ? null : Number(s.amount);
  const amount = draft.amount ?? storedAmount ?? 0;
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid amount");
  const moneyKind: MoneyKind = draft.moneyKind ??
    ((MONEY_KINDS as readonly string[]).includes(s.money_kind ?? "") ? (s.money_kind as MoneyKind) : "none");
  const outcome = draftOutcome;
  const mood = String(draft.mood ?? s.mood ?? "neutral").slice(0, 40);
  const note = String(draft.note ?? s.note ?? "").slice(0, 2000);
  const contactName = (draft.contactName ?? "").trim() || draft.phone || s.number_e164;
  const contactId = s.contact_id === null ? null : Number(s.contact_id);
  // The purpose: the fresh draft wins, else the session's stored pick
  // (purpose_type/purpose_key), else a case pick resolves to a case.
  // A campaign/project pick lands on campaign_id/project_id so the
  // report carries it too — never silently dropped.
  const purpose: CallPurpose | null = draft.purpose ??
    (s.purpose_type && s.purpose_type !== "none" && s.purpose_key
      ? { type: s.purpose_type as CallPurpose["type"], key: s.purpose_key }
      : null);
  const cols = purposeToReportColumns(purpose);
  const campaignId = cols.campaignId;
  const projectId = cols.projectId;
  const paymentMethod: PaymentMethod | null = draft.paymentMethod ??
    ((PAYMENT_METHODS as readonly string[]).includes(s.payment_method ?? "")
      ? (s.payment_method as PaymentMethod) : null);
  const storedPledge = s.pledge_amount === null || s.pledge_amount === "" ? null : Number(s.pledge_amount);
  const pledgeAmount = draft.pledgeAmount ?? storedPledge ?? 0;
  const ins = await client.query<{ id: string }>(
    "INSERT INTO public.fundraising_call_reports " +
      "(user_id,case_id,contact_id,contact_name,outcome,money_kind,amount,note,request_id,observed_mood," +
      "payment_method,campaign_id,project_id,pledge_amount) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) " +
      "ON CONFLICT(user_id,request_id) DO NOTHING RETURNING id",
    [userId, resolvedCaseId, contactId, contactName, outcome,
     moneyKind, amount, note, requestId, mood,
     paymentMethod, campaignId, projectId, pledgeAmount],
  );
  let reportId: number;
  if (ins.rows[0]) {
    reportId = Number(ins.rows[0].id);
  } else {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM public.fundraising_call_reports WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    );
    if (!existing.rows[0]) throw new Error("Call report could not be saved");
    reportId = Number(existing.rows[0].id);
    await updateCallReport(client, userId, reportId, {
      caseId: resolvedCaseId, contactId, outcome, moneyKind, amount, note, mood,
      paymentMethod, campaignId, projectId, pledgeAmount,
    });
  }
  // Keep the session in sync with the report (case + purpose included).
  await client.query(
    "UPDATE public.max_call_sessions SET case_id=$1,outcome=$2,mood=$3,note=$4," +
      "amount=$5,money_kind=$6,updated_at=now()," +
      "payment_method=COALESCE($9,payment_method)," +
      "pledge_amount=COALESCE($10,pledge_amount)," +
      "purpose_type=COALESCE($11,purpose_type),purpose_key=COALESCE($12,purpose_key) " +
      "WHERE id=$7 AND user_id=$8",
    [resolvedCaseId, outcome, mood, note, amount, moneyKind, sessionId, userId,
     paymentMethod, pledgeAmount,
     purpose ? purpose.type : null, purpose ? purpose.key : null],
  );
  if (outcome === "do_not_call" && contactId) {
    await client.query(
      "UPDATE public.communication_contacts SET do_not_call=true," +
      "opt_out_reason='Do Not Call explicitly confirmed through verified hotline'," +
      "updated_at=now() WHERE id=$1 AND user_id=$2",
      [contactId, userId],
    );
  }
  return reportId;
}

/**
 * Insert the max_call_sessions row for a manual log (option 2: a call
 * from another phone). The call already happened elsewhere, so this is a
 * 'completed' log row — never 'prepared', so the outbound dial path can
 * never claim it as a dial intent. Returns the session id plus the
 * manual_request_id the engine passes on as the report's request_id
 * (upsertCallReport). The provider is the IVR line the log came in on.
 */
export async function insertManualSession(
  client: PoolClient,
  userId: number,
  numberE164: string,
  opts: {
    provider?: "yemot" | "signalwire";
    direction?: "outbound" | "inbound";
    contactId?: number | null;
    manualRequestId?: string;
    /** The case/campaign/project pick, persisted on the session row. */
    purpose?: CallPurpose | null;
  } = {},
): Promise<{ sessionId: number; manualRequestId: string }> {
  assertUserId(userId);
  assertE164(numberE164);
  const provider = opts.provider ?? "yemot";
  const direction = opts.direction ?? "outbound";
  if (direction !== "outbound" && direction !== "inbound") throw new Error("Invalid direction");
  if (opts.contactId) await assertOwnedContact(client, userId, opts.contactId);
  if (opts.purpose !== undefined && opts.purpose !== null) assertPurpose(opts.purpose);
  const manualRequestId = opts.manualRequestId && UUID_RE.test(opts.manualRequestId)
    ? opts.manualRequestId
    : randomUUID();
  const r = await client.query<{ id: string }>(
    "INSERT INTO public.max_call_sessions " +
      "(user_id,number_e164,destination_country,direction,status,provider,manual_request_id,contact_id," +
      "purpose_type,purpose_key) " +
      "VALUES($1,$2,'US',$3,'completed',$4,$5,$6,$7,$8) RETURNING id",
    [userId, numberE164, direction, provider, manualRequestId, opts.contactId ?? null,
     opts.purpose ? opts.purpose.type : "none", opts.purpose ? opts.purpose.key : null],
  );
  return { sessionId: Number(r.rows[0].id), manualRequestId };
}

/**
 * Update an existing call report (option 3). Only the fields present in
 * the patch are changed. When a session id is given, that session row's
 * outcome/mood/note are updated from the patched values. Returns true
 * when a report row owned by the caller was updated.
 */
export async function updateCallReport(
  client: PoolClient,
  userId: number,
  reportId: number,
  patch: CallReportPatch,
): Promise<boolean> {
  assertUserId(userId);
  assertId(reportId);
  if (patch.outcome !== undefined) normalizeReportOutcome(patch.outcome);
  if (patch.moneyKind !== undefined) assertMoneyKind(patch.moneyKind);
  if (patch.paymentMethod !== undefined && patch.paymentMethod !== null) {
    assertPaymentMethod(patch.paymentMethod);
  }
  if (patch.amount !== undefined && patch.amount !== null && (!Number.isFinite(patch.amount) || patch.amount < 0)) {
    throw new Error("Invalid amount");
  }
  if (patch.pledgeAmount !== undefined && patch.pledgeAmount !== null &&
      (!Number.isFinite(patch.pledgeAmount) || patch.pledgeAmount < 0)) {
    throw new Error("Invalid pledge amount");
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    args.push(value);
    sets.push(sql + "$" + args.length);
  };
  if (patch.caseId !== undefined) {
    if (patch.caseId === null) throw new Error("Case cannot be cleared: a report always needs a case");
    push("case_id=", await resolveReportCaseId(client, userId, patch.caseId));
  }
  if (patch.contactId !== undefined) {
    if (patch.contactId !== null) await assertOwnedContact(client, userId, patch.contactId);
    push("contact_id=", patch.contactId);
  }
  if (patch.outcome !== undefined) push("outcome=", normalizeReportOutcome(patch.outcome));
  if (patch.moneyKind !== undefined) push("money_kind=", patch.moneyKind);
  if (patch.amount !== undefined) push("amount=", patch.amount ?? 0);
  if (patch.note !== undefined) push("note=", String(patch.note ?? "").slice(0, 2000));
  if (patch.mood !== undefined) push("observed_mood=", String(patch.mood ?? "neutral").slice(0, 40));
  if (patch.paymentMethod !== undefined) push("payment_method=", patch.paymentMethod ?? null);
  if (patch.campaignId !== undefined) push("campaign_id=", patch.campaignId ?? null);
  if (patch.projectId !== undefined) push("project_id=", patch.projectId ?? null);
  if (patch.pledgeAmount !== undefined) push("pledge_amount=", patch.pledgeAmount ?? 0);
  if (sets.length === 0 && !patch.sessionId) return false;
  let updated = false;
  if (sets.length > 0) {
    const r = await client.query(
      "UPDATE public.fundraising_call_reports SET " + sets.join(",") +
        " WHERE id=$" + (args.length + 1) + " AND user_id=$" + (args.length + 2),
      [...args, reportId, userId],
    );
    updated = (r.rowCount ?? 0) > 0;
  }
  if (patch.sessionId) {
    const cur = await client.query<{ outcome: string; mood: string; note: string }>(
      "SELECT outcome,mood,note FROM public.max_call_sessions WHERE id=$1 AND user_id=$2",
      [patch.sessionId, userId],
    );
    const row = cur.rows[0];
    if (row) {
      await client.query(
        "UPDATE public.max_call_sessions SET outcome=$1,mood=$2,note=$3,updated_at=now() " +
          "WHERE id=$4 AND user_id=$5",
        [patch.outcome ?? row.outcome, patch.mood ?? row.mood,
         patch.note !== undefined ? String(patch.note).slice(0, 2000) : row.note,
         patch.sessionId, userId],
      );
      updated = true;
    }
  }
  return updated;
}

/**
 * Insert a scheduled call (option 6) and its Tishl reminder row, so the
 * item surfaces on Tishl at the scheduled time.
 *
 * SCHEDULING IS NOT AUTO-DIAL: this row only ever becomes a Tishl
 * reminder. No call is placed from it.
 *
 * FAILS UNTIL THE MIGRATION GAP IS CLOSED: the tishl_reminders insert
 * violates the live item_kind CHECK ('task','case','missed_call',
 * 'message') until the migration widens it to include 'scheduled_call'.
 * The scheduled-call row itself is inserted first, so a failure here
 * leaves an orphan row with no reminder — the engine should run this
 * inside a transaction and report the failure instead of confirming.
 */
export async function insertScheduledCall(
  client: PoolClient,
  userId: number,
  input: ScheduledCallInput,
): Promise<number> {
  assertUserId(userId);
  assertE164(input.numberE164);
  if (!(input.scheduledAt instanceof Date) || Number.isNaN(input.scheduledAt.getTime())) {
    throw new Error("Invalid scheduled_at");
  }
  if (input.contactId) await assertOwnedContact(client, userId, input.contactId);
  if (input.caseId) {
    const owned = await client.query(
      "SELECT id FROM public.askanus_cases WHERE id=$1 AND user_id=$2",
      [input.caseId, userId],
    );
    if (!owned.rows[0]) throw new Error("Case is not on this account");
  }
  if (input.projectId) {
    const owned = await client.query(
      "SELECT id FROM public.community_projects WHERE id=$1 AND owner_id=$2",
      [input.projectId, userId],
    );
    if (!owned.rows[0]) throw new Error("Project is not on this account");
  }
  const r = await client.query<{ id: string }>(
    "INSERT INTO public.calling_scheduled_calls " +
      "(user_id,contact_id,number_e164,display_name,scheduled_at,status,case_id,campaign_id,project_id,note) " +
      "VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9) RETURNING id",
    [userId, input.contactId ?? null, input.numberE164,
     String(input.displayName ?? "").slice(0, 200), input.scheduledAt.toISOString(),
     input.caseId ?? null, input.campaignId ?? null, input.projectId ?? null,
     String(input.note ?? "").slice(0, 2000)],
  );
  const id = Number(r.rows[0].id);
  await client.query(
    "INSERT INTO public.tishl_reminders(user_id,item_kind,item_id,remind_at) " +
      "VALUES($1,'scheduled_call',$2,$3)",
    [userId, id, input.scheduledAt.toISOString()],
  );
  return id;
}

/** Pending / reminded scheduled calls for the member, soonest first. */
export async function getScheduledCalls(
  client: PoolClient,
  userId: number,
): Promise<ScheduledCallRow[]> {
  assertUserId(userId);
  const r = await client.query<{
    id: string;
    contact_id: string | null;
    number_e164: string;
    display_name: string;
    scheduled_at: string;
    status: string;
    case_id: string | null;
    campaign_id: string | null;
    project_id: string | null;
    note: string;
    created_at: string;
  }>(
    "SELECT id::bigint AS id,contact_id::bigint AS contact_id,number_e164,display_name," +
      "scheduled_at::text AS scheduled_at,status,case_id::bigint AS case_id," +
      "campaign_id::bigint AS campaign_id,project_id::bigint AS project_id," +
      "note,created_at::text AS created_at FROM public.calling_scheduled_calls " +
      "WHERE user_id=$1 AND status IN ('pending','reminded') ORDER BY scheduled_at,id",
    [userId],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    contact_id: row.contact_id === null ? null : Number(row.contact_id),
    number_e164: row.number_e164,
    display_name: row.display_name,
    scheduled_at: row.scheduled_at,
    status: row.status,
    case_id: row.case_id === null ? null : Number(row.case_id),
    campaign_id: row.campaign_id === null ? null : Number(row.campaign_id),
    project_id: row.project_id === null ? null : Number(row.project_id),
    note: row.note,
    created_at: row.created_at,
  }));
}

/** Cancel a scheduled call (and its pending Tishl reminder). Returns true when cancelled. */
export async function cancelScheduledCall(
  client: PoolClient,
  userId: number,
  id: number,
): Promise<boolean> {
  assertUserId(userId);
  assertId(id);
  const r = await client.query(
    "UPDATE public.calling_scheduled_calls SET status='cancelled',updated_at=now() " +
      "WHERE id=$1 AND user_id=$2 AND status IN ('pending','reminded')",
    [id, userId],
  );
  await client.query(
    "UPDATE public.tishl_reminders SET status='cancelled' " +
      "WHERE user_id=$1 AND item_kind='scheduled_call' AND item_id=$2 AND status='pending'",
    [userId, id],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Delete one log entry, ownership-checked: only the caller's own rows.
 * kind 'session' -> max_call_sessions; 'return_call' -> max_return_calls
 * (plus its Tishl side rows, mirroring deleteTishlItem); 'report' ->
 * fundraising_call_reports. Returns true when a row was deleted.
 */
export async function deleteLogEntry(
  client: PoolClient,
  userId: number,
  kind: LogEntryKind,
  id: number,
): Promise<boolean> {
  assertUserId(userId);
  assertId(id);
  let removed = 0;
  if (kind === "session") {
    removed = (await client.query(
      "DELETE FROM public.max_call_sessions WHERE id=$1 AND user_id=$2",
      [id, userId],
    )).rowCount ?? 0;
  } else if (kind === "return_call") {
    removed = (await client.query(
      "DELETE FROM public.max_return_calls WHERE id=$1 AND owner_user_id=$2",
      [id, userId],
    )).rowCount ?? 0;
    if (removed > 0) {
      for (const table of ["tishl_done", "tishl_reminders", "tishl_notes", "tishl_holds"]) {
        await client.query(
          "DELETE FROM public." + table + " WHERE user_id=$1 AND item_kind='missed_call' AND item_id=$2",
          [userId, id],
        );
      }
    }
  } else if (kind === "report") {
    removed = (await client.query(
      "DELETE FROM public.fundraising_call_reports WHERE id=$1 AND user_id=$2",
      [id, userId],
    )).rowCount ?? 0;
  } else {
    throw new Error("Invalid log entry kind: " + String(kind));
  }
  return removed > 0;
}

/**
 * Delete ALL of the caller's log entries (sessions + return calls +
 * reports), ownership-checked. Returns how many rows of each kind were
 * deleted. Tishl side rows for missed calls are cleaned too.
 */
export async function deleteAllLogEntries(
  client: PoolClient,
  userId: number,
): Promise<{ sessions: number; returnCalls: number; reports: number }> {
  assertUserId(userId);
  const sessions = (await client.query(
    "DELETE FROM public.max_call_sessions WHERE user_id=$1", [userId],
  )).rowCount ?? 0;
  const returnCalls = (await client.query(
    "DELETE FROM public.max_return_calls WHERE owner_user_id=$1", [userId],
  )).rowCount ?? 0;
  const reports = (await client.query(
    "DELETE FROM public.fundraising_call_reports WHERE user_id=$1", [userId],
  )).rowCount ?? 0;
  for (const table of ["tishl_done", "tishl_reminders", "tishl_notes", "tishl_holds"]) {
    await client.query(
      "DELETE FROM public." + table + " WHERE user_id=$1 AND item_kind='missed_call'",
      [userId],
    );
  }
  return { sessions, returnCalls, reports };
}

/** Delete one contact, ownership-checked. Returns true when deleted. */
export async function deleteContact(
  client: PoolClient,
  userId: number,
  contactId: number,
): Promise<boolean> {
  assertUserId(userId);
  assertId(contactId);
  const r = await client.query(
    "DELETE FROM public.communication_contacts WHERE id=$1 AND user_id=$2",
    [contactId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Append a (voice-)note to a contact's notes field, ownership-checked.
 * The note text is built by the engine with buildVoiceNoteText
 * (calling-phone.ts) from the recording reference. Returns true when saved.
 */
export async function addContactNote(
  client: PoolClient,
  userId: number,
  contactId: number,
  note: string,
): Promise<boolean> {
  assertUserId(userId);
  assertId(contactId);
  const text = String(note ?? "").trim();
  if (!text) throw new Error("Note is empty");
  const r = await client.query(
    "UPDATE public.communication_contacts SET notes=" +
      "CASE WHEN notes IS NULL OR notes='' THEN $3 ELSE notes || chr(10) || $3 END," +
      "updated_at=now() WHERE id=$1 AND user_id=$2",
    [contactId, userId, text.slice(0, 2000)],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Set (or clear) Do Not Call on a contact, ownership-checked.
 * Returns true when a row was updated.
 */
export async function setContactDNC(
  client: PoolClient,
  userId: number,
  contactId: number,
  dnc: boolean,
): Promise<boolean> {
  assertUserId(userId);
  assertId(contactId);
  const r = await client.query(
    "UPDATE public.communication_contacts SET do_not_call=$3," +
      "opt_out_reason=CASE WHEN $3 THEN 'Marked Do Not Call by account owner using verified telephone session' ELSE opt_out_reason END," +
      "updated_at=now() WHERE id=$1 AND user_id=$2",
    [contactId, userId, dnc],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Insert a prepared outbound session (status 'prepared', direction
 * 'outbound', provider 'signalwire'). This is an INTENT only, not a
 * call — placeOlamMaxOutboundCall claims it and dials (and throws 503
 * while OLAM_SIGNALWIRE_CALLING_ENABLED is off; that gate is untouched).
 * Returns the session id.
 */
export async function insertPreparedSession(
  client: PoolClient,
  userId: number,
  numberE164: string,
  opts: {
    destinationCountry?: "US" | "CA";
    caseId?: number | null;
    contactId?: number | null;
    campaignId?: number | null;
    campaignContactId?: number | null;
    /** The case/campaign/project pick, persisted on the session row. */
    purpose?: CallPurpose | null;
  } = {},
): Promise<number> {
  assertUserId(userId);
  assertE164(numberE164);
  const country = opts.destinationCountry ?? "US";
  if (country !== "US" && country !== "CA") throw new Error("Invalid destination country");
  if (opts.caseId) {
    const owned = await client.query(
      "SELECT id FROM public.askanus_cases WHERE id=$1 AND user_id=$2",
      [opts.caseId, userId],
    );
    if (!owned.rows[0]) throw new Error("Case is not on this account");
  }
  if (opts.contactId) await assertOwnedContact(client, userId, opts.contactId);
  if (opts.purpose !== undefined && opts.purpose !== null) assertPurpose(opts.purpose);
  const r = await client.query<{ id: string }>(
    "INSERT INTO public.max_call_sessions " +
      "(user_id,case_id,contact_id,number_e164,destination_country,direction,status,provider,reporting_source,cc_campaign_id,cc_contact_id," +
      "purpose_type,purpose_key) " +
      "VALUES($1,$2,$3,$4,$5,'outbound','prepared','signalwire','provider',$6,$7,$8,$9) RETURNING id",
    [userId, opts.caseId ?? null, opts.contactId ?? null, numberE164, country,
     opts.campaignId ?? null, opts.campaignContactId ?? null,
     opts.purpose ? opts.purpose.type : "none", opts.purpose ? opts.purpose.key : null],
  );
  return Number(r.rows[0].id);
}

/**
 * AUTO-CONTACT (Yakob 2026-11-19 23:09): every call made (option 1 dial)
 * or logged (option 2 manual log, and any flow that enters a number —
 * redial, return call) AUTOMATICALLY creates a contact from the number
 * only. Name and other info stay blank / unchecked for later: the row
 * is inserted with an empty name (communication_contacts.name is NOT
 * NULL, so a blank string is the literal "blank"), and city / notes /
 * address stay at their defaults. No duplicate is created when the
 * number already exists as a contact (matched on the last 10 digits,
 * the same rule findCallingContact uses in the engine).
 * Returns the contact id and whether it was just created. The engine
 * calls this (best-effort, never failing the call) from the dial,
 * manual-log, redial and return-call effects.
 */
export async function ensureContactByPhone(
  client: PoolClient,
  userId: number,
  phone: string,
): Promise<{ id: number; created: boolean }> {
  assertUserId(userId);
  assertE164(phone);
  const digits = phone.replace(/\D/g, "").slice(-10);
  const found = await client.query<{ id: string }>(
    "SELECT id FROM public.communication_contacts WHERE user_id=$1 " +
      "AND RIGHT(regexp_replace(phone,'[^0-9]','','g'),10)=$2 " +
      "ORDER BY updated_at DESC,id DESC LIMIT 1",
    [userId, digits],
  );
  if (found.rows[0]) return { id: Number(found.rows[0].id), created: false };
  const ins = await client.query<{ id: string }>(
    "INSERT INTO public.communication_contacts(user_id,name,phone) " +
      "VALUES($1,'',$2) RETURNING id",
    [userId, phone],
  );
  return { id: Number(ins.rows[0].id), created: true };
}

// ---------------------------------------------------------------------------
// CATEGORIES (Olam option 3, path 1593 — Yakob 2026-11-19 23:18–23:35)
// ---------------------------------------------------------------------------

export type CategoryDimension = "outcome" | "mood" | "direction" | "campaign" | "amount";

export const CATEGORY_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  given: "Given",
  no_answer: "No answer",
  callback: "Callback requested",
  not_interested: "Not interested",
  do_not_call: "Do not call",
  pickup: "Said to come pick up",
  cannot_give: "Did not or cannot give",
  pledged: "Pledge",
};

export const CATEGORY_MOOD_LABELS: Readonly<Record<string, string>> = {
  positive: "Good",
  neutral: "Neutral",
  negative: "Not good",
};

export const CATEGORY_DIRECTION_LABELS: Readonly<Record<string, string>> = {
  dialled: "Called out",
  manual: "Logged from another phone",
};

/** One value inside a dimension, with how many calls carry it. */
export type CategoryValue = {
  key: string;
  label: string;
  count: number;
};

/** One contact inside a category value (deduped by contact). */
export type CategoryContact = {
  contactId: number | null;
  name: string;
  phone: string | null;
  /** Latest matching call, e.g. "Given $250" / "No answer". */
  detail: string;
  /** How many matching calls this contact has in this value. */
  calls: number;
};

type CallRecord = {
  source: "report" | "session";
  id: number;
  contactId: number | null;
  contactName: string;
  phone: string | null;
  outcome: string;
  mood: string | null;
  amount: number;
  moneyKind: string;
  direction: "dialled" | "manual" | null;
  purpose: string | null;
  createdAt: string;
};

/**
 * The unified call records behind every category: fundraising reports
 * plus max_call_sessions rows (the fill-in held on a session counts
 * too — a call without a case yet is still a call with an outcome).
 * Legacy outcome 'spoke' is normalized to 'given' here (read time).
 * A session that already has a report for the same call is dropped
 * (same contact + same outcome, or the report's contact name is the
 * session's number) so one call is not counted twice; the CONTACT
 * listing dedupes by contact regardless.
 */
async function loadCallRecords(client: PoolClient, userId: number): Promise<CallRecord[]> {
  assertUserId(userId);
  const reps = await client.query<{
    id: string; contact_id: string | null; contact_name: string; outcome: string;
    observed_mood: string; amount: string; money_kind: string;
    campaign_id: string | null; project_id: string | null; case_id: string;
    created_at: string;
  }>(
    "SELECT id::bigint AS id,contact_id::bigint AS contact_id,contact_name,outcome," +
      "observed_mood,amount::text AS amount,money_kind," +
      "campaign_id::bigint AS campaign_id,project_id::bigint AS project_id," +
      "case_id::bigint AS case_id,created_at::text AS created_at " +
      "FROM public.fundraising_call_reports WHERE user_id=$1 ORDER BY created_at DESC,id DESC",
    [userId],
  );
  const sess = await client.query<{
    id: string; contact_id: string | null; number_e164: string; outcome: string;
    mood: string; amount: string; money_kind: string; direction: string;
    case_id: string | null; purpose_type: string; purpose_key: string | null;
    created_at: string;
  }>(
    "SELECT id::bigint AS id,contact_id::bigint AS contact_id,number_e164,outcome," +
      "mood,amount::text AS amount,money_kind,direction," +
      "case_id::bigint AS case_id,purpose_type,purpose_key,created_at::text AS created_at " +
      "FROM public.max_call_sessions WHERE user_id=$1 ORDER BY created_at DESC,id DESC",
    [userId],
  );
  const records: CallRecord[] = reps.rows.map((r) => ({
    source: "report" as const,
    id: Number(r.id),
    contactId: r.contact_id === null ? null : Number(r.contact_id),
    contactName: r.contact_name,
    phone: null,
    outcome: normalizeReportOutcome(r.outcome),
    mood: r.observed_mood || null,
    amount: Number(r.amount) || 0,
    moneyKind: r.money_kind,
    direction: null,
    purpose: r.campaign_id !== null ? "campaign:" + r.campaign_id
      : r.project_id !== null ? "project:" + r.project_id
      : "case:" + r.case_id,
    createdAt: r.created_at,
  }));
  for (const s of sess.rows) {
    const outcome = s.outcome ? normalizeReportOutcome(s.outcome) : "";
    const dupe = records.some((r) =>
      r.source === "report" &&
      ((s.contact_id !== null && r.contactId === Number(s.contact_id)) ||
       (r.contactName === s.number_e164)) &&
      r.outcome === outcome);
    if (dupe) continue;
    records.push({
      source: "session",
      id: Number(s.id),
      contactId: s.contact_id === null ? null : Number(s.contact_id),
      contactName: s.number_e164,
      phone: s.number_e164,
      outcome,
      mood: s.mood || null,
      amount: Number(s.amount) || 0,
      moneyKind: s.money_kind,
      direction: s.direction === "outbound" ? "dialled" : s.direction === "inbound" ? "manual" : null,
      purpose: s.purpose_type && s.purpose_type !== "none" && s.purpose_key
        ? s.purpose_type + ":" + s.purpose_key
        : s.case_id !== null ? "case:" + s.case_id : null,
      createdAt: s.created_at,
    });
  }
  return records;
}

const OUTCOME_ORDER = ["given", "no_answer", "callback", "not_interested", "do_not_call", "pickup", "cannot_give", "pledged"];
const MOOD_ORDER = ["positive", "neutral", "negative"];
const DIRECTION_ORDER = ["dialled", "manual"];

function recordMatches(rec: CallRecord, dimension: CategoryDimension, valueKey: string): boolean {
  if (dimension === "outcome") {
    if (valueKey === "pledged") return rec.moneyKind === "pledged" || rec.outcome === "pledged";
    return rec.outcome === valueKey;
  }
  if (dimension === "mood") return rec.mood === valueKey;
  if (dimension === "direction") return rec.direction === valueKey;
  if (dimension === "campaign") return rec.purpose === valueKey;
  if (dimension === "amount") return rec.amount > 0 && String(rec.amount) === valueKey;
  return false;
}

/**
 * The values of one dimension, each with its call count, in the
 * order the phone machine speaks them (fresh numbering from 1).
 * The amount dimension has no value list — the caller types the
 * amount instead (getCategoryContacts with dimension "amount").
 */
export async function getCategoryValues(
  client: PoolClient,
  userId: number,
  dimension: CategoryDimension,
): Promise<CategoryValue[]> {
  assertUserId(userId);
  if (!["outcome", "mood", "direction", "campaign", "amount"].includes(dimension)) {
    throw new Error("Invalid category dimension: " + String(dimension));
  }
  if (dimension === "amount") return [];
  const records = await loadCallRecords(client, userId);
  if (dimension === "campaign") {
    const counts = new Map<string, number>();
    for (const r of records) if (r.purpose) counts.set(r.purpose, (counts.get(r.purpose) ?? 0) + 1);
    if (!counts.size) return [];
    const picker = await getOpenCasesAndProjects(client, userId);
    const labels = new Map(picker.map((p) => [p.kind + ":" + p.id, p.title]));
    // Titles for referenced rows the picker no longer lists (closed
    // cases): read them directly so the value still has a name.
    const missing = [...counts.keys()].filter((k) => !labels.has(k));
    for (const key of missing) {
      const [kind, id] = key.split(":");
      const table = kind === "case" ? "askanus_cases"
        : kind === "campaign" ? "featured_causes" : "community_projects";
      const owner = kind === "case" ? "user_id=$2" : kind === "project" ? "owner_id=$2" : "1=1";
      const rows = await client.query<{ title: string }>(
        "SELECT title FROM public." + table + " WHERE id=$1 AND " + owner,
        kind === "campaign" ? [Number(id)] : [Number(id), userId],
      );
      if (rows.rows[0]) labels.set(key, rows.rows[0].title);
    }
    return [...counts.entries()]
      .map(([key, count]) => ({
        key,
        label: labels.get(key) ?? key.replace(":", " "),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
  const order = dimension === "outcome" ? OUTCOME_ORDER
    : dimension === "mood" ? MOOD_ORDER : DIRECTION_ORDER;
  const labels = dimension === "outcome" ? CATEGORY_OUTCOME_LABELS
    : dimension === "mood" ? CATEGORY_MOOD_LABELS : CATEGORY_DIRECTION_LABELS;
  return order
    .map((key) => ({
      key,
      label: labels[key] ?? key,
      count: records.filter((r) => recordMatches(r, dimension, key)).length,
    }))
    .filter((v) => v.count > 0);
}

/**
 * The contacts in one category value, newest first, numbered fresh
 * from 1 by the caller. ONE contact appears under EVERY value its
 * calls match (multi-label); a contact with several matching calls
 * appears ONCE here, with its call count. Contacts are resolved from
 * the contact book (by contact_id, else by phone); a number with no
 * contact row yet still lists under its number (auto-contact creates
 * the row on the next call, but a category must not hide a call).
 */
export async function getCategoryContacts(
  client: PoolClient,
  userId: number,
  dimension: CategoryDimension,
  valueKey: string,
): Promise<CategoryContact[]> {
  assertUserId(userId);
  if (!["outcome", "mood", "direction", "campaign", "amount"].includes(dimension)) {
    throw new Error("Invalid category dimension: " + String(dimension));
  }
  const records = await loadCallRecords(client, userId);
  const matching = records.filter((r) => recordMatches(r, dimension, valueKey));
  const byKey = new Map<string, { contactId: number | null; name: string; phone: string | null; latest: CallRecord; calls: number }>();
  for (const rec of matching) {
    const key = rec.contactId !== null ? "id:" + rec.contactId : "phone:" + (rec.phone ?? rec.contactName);
    const cur = byKey.get(key);
    if (cur) {
      cur.calls += 1;
      if (rec.createdAt > cur.latest.createdAt) cur.latest = rec;
    } else {
      byKey.set(key, {
        contactId: rec.contactId,
        name: rec.contactName,
        phone: rec.phone,
        latest: rec,
        calls: 1,
      });
    }
  }
  const contacts = [...byKey.values()];
  // Resolve display names/phones from the contact book.
  const ids = contacts.map((c) => c.contactId).filter((x): x is number => x !== null);
  if (ids.length) {
    const rows = await client.query<{ id: string; name: string; phone: string }>(
      "SELECT id::bigint AS id,name,phone FROM public.communication_contacts " +
        "WHERE user_id=$1 AND id=ANY($2::bigint[])",
      [userId, ids],
    );
    const byId = new Map(rows.rows.map((r) => [Number(r.id), r]));
    for (const c of contacts) {
      if (c.contactId !== null) {
        const row = byId.get(c.contactId);
        if (row) {
          c.name = row.name || row.phone;
          c.phone = row.phone;
        }
      }
    }
  }
  contacts.sort((a, b) => (a.latest.createdAt < b.latest.createdAt ? 1 : -1));
  return contacts.map((c) => {
    const latest = c.latest;
    const label = latest.outcome === "pledged" || latest.moneyKind === "pledged"
      ? "Pledge"
      : (CATEGORY_OUTCOME_LABELS[latest.outcome] ?? latest.outcome);
    const detail = label + (latest.amount > 0 ? " $" + latest.amount : "");
    return {
      contactId: c.contactId,
      name: c.name || c.phone || "Unknown",
      phone: c.phone,
      detail,
      calls: c.calls,
    };
  });
}
