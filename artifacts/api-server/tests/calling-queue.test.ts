import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  insertCallReport, updateCallReport, updateSessionFill, upsertCallReport,
  insertManualSession, resolveSingleOpenCase, sessionFillFromReport,
  normalizeReportOutcome, ensureContactByPhone, getCategoryValues, getCategoryContacts,
} from "../src/lib/calling-queue.ts";
import type { SessionFillDraft } from "../src/lib/calling-queue.ts";

type Row = Record<string, unknown>;
type QueryRecord = { sql: string; params: unknown[] };

/** A fake PoolClient: the responder answers by SQL shape and every query is logged. */
function makeClient(
  respond: (sql: string, params: unknown[]) => { rows: Row[]; rowCount?: number },
): { client: PoolClient; log: QueryRecord[] } {
  const log: QueryRecord[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      log.push({ sql, params });
      const r = respond(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  } as unknown as PoolClient;
  return { client, log };
}

const UUID_KEY = "11111111-2222-3333-4444-555555555555";

function sessionRow(over: Row = {}): Row {
  return {
    manual_request_id: UUID_KEY, number_e164: "+17185551234",
    contact_id: null, case_id: null, outcome: "", mood: "", note: "",
    amount: null, money_kind: null, payment_method: null,
    pledge_amount: null, purpose_type: null, purpose_key: null, ...over,
  };
}

/** Responder for the open-cases query (resolveReportCaseId / resolveSingleOpenCase). */
function openCasesResponder(ids: number[]) {
  return (sql: string) => {
    if (sql.includes("FROM public.askanus_cases") && sql.includes("ORDER BY id")) {
      return { rows: ids.map((id) => ({ id: String(id) })) };
    }
    return { rows: [] };
  };
}

// --- updateSessionFill --------------------------------------------------------
test("updateSessionFill writes outcome/mood/note/amount/money_kind onto the session and returns true", async () => {
  const { client, log } = makeClient(() => ({ rows: [], rowCount: 1 }));
  const draft: SessionFillDraft = { outcome: "given", amount: 250, moneyKind: "pledged", note: "Pledged $250", mood: "positive", paymentMethod: "cash", pledgeAmount: 250, purpose: { type: "campaign", key: "9" } };
  assert.equal(await updateSessionFill(client, 9, 7, draft), true);
  assert.equal(log.length, 1);
  assert.ok(log[0].sql.includes("UPDATE public.max_call_sessions SET outcome=$1,mood=$2,note=$3,amount=$4"));
  assert.ok(log[0].sql.includes("money_kind=COALESCE($5,money_kind)"));
  assert.ok(log[0].sql.includes("payment_method=COALESCE($8,payment_method)"));
  assert.ok(log[0].sql.includes("pledge_amount=COALESCE($9,pledge_amount)"));
  assert.ok(log[0].sql.includes("purpose_type=COALESCE($10,purpose_type)"));
  assert.ok(log[0].sql.includes("WHERE id=$6 AND user_id=$7"));
  assert.deepEqual(log[0].params, ["given", "positive", "Pledged $250", 250, "pledged", 9, 7, "cash", 250, "campaign", "9"]);
});

test("updateSessionFill with no money kind passes null (stored value kept); no row updated returns false", async () => {
  const { client, log } = makeClient(() => ({ rows: [], rowCount: 1 }));
  assert.equal(await updateSessionFill(client, 9, 7, { outcome: "callback", amount: null, note: null, mood: null }), true);
  assert.deepEqual(log[0].params, ["callback", "neutral", "", 0, null, 9, 7, null, null, null, null]);

  const none = makeClient(() => ({ rows: [], rowCount: 0 }));
  assert.equal(await updateSessionFill(none.client, 9, 7, { outcome: "given" }), false);
});

test("updateSessionFill rejects a bad user, bad session, bad outcome, negative amount, bad money kind, bad method, bad purpose", async () => {
  const { client } = makeClient(() => ({ rows: [], rowCount: 1 }));
  await assert.rejects(() => updateSessionFill(client, 9, 0, { outcome: "given" }), /Invalid user id/);
  await assert.rejects(() => updateSessionFill(client, 0, 7, { outcome: "given" }), /Invalid id/);
  await assert.rejects(() => updateSessionFill(client, 9, 7, { outcome: "yelling" as never }), /Invalid call outcome/);
  await assert.rejects(() => updateSessionFill(client, 9, 7, { outcome: "given", amount: -5 }), /Invalid amount/);
  await assert.rejects(() => updateSessionFill(client, 9, 7, { outcome: "given", moneyKind: "maybe" as never }), /Invalid money kind/);
  await assert.rejects(() => updateSessionFill(client, 9, 7, { outcome: "given", paymentMethod: "card_number" as never }), /Invalid payment method/);
  await assert.rejects(() => updateSessionFill(client, 9, 7, { outcome: "given", purpose: { type: "bogus", key: "1" } as never }), /Invalid call purpose/);
});

// --- resolveSingleOpenCase ------------------------------------------------------
test("resolveSingleOpenCase: exactly one open case -> its id; 0 or 3 -> null (never silently picks one)", async () => {
  const one = makeClient(openCasesResponder([5]));
  assert.equal(await resolveSingleOpenCase(one.client, 7), 5);
  const none = makeClient(openCasesResponder([]));
  assert.equal(await resolveSingleOpenCase(none.client, 7), null);
  const three = makeClient(openCasesResponder([5, 6, 7]));
  assert.equal(await resolveSingleOpenCase(three.client, 7), null);
});

// --- insertCallReport skip behaviour (unchanged) ---------------------------------
test("insertCallReport skip with exactly 1 open case still auto-uses it", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.askanus_cases") && sql.includes("ORDER BY id")) return { rows: [{ id: "5" }] };
    if (sql.includes("INSERT INTO public.fundraising_call_reports")) return { rows: [{ id: "42" }] };
    return { rows: [] };
  });
  const id = await insertCallReport(client, 7, { contactName: "Cohen", outcome: "given", amount: 250 });
  assert.equal(id, 42);
  const ins = log.find((q) => q.sql.includes("INSERT INTO public.fundraising_call_reports"))!;
  assert.equal(ins.params[1], 5); // case_id = the single open case
  assert.equal(ins.params[3], "Cohen");
  assert.equal(ins.params[4], "given");
  assert.equal(ins.params[10], null); // no payment method
  assert.equal(ins.params[11], null); // no campaign
  assert.equal(ins.params[12], null); // no project
  assert.equal(ins.params[13], 0); // no pledge amount
  assert.ok(!log.some((q) => q.sql.includes("UPDATE public.max_call_sessions")));
});

test("insertCallReport skip with 0 or 3 open cases still throws — that is the gap the session hold fixes", async () => {
  const none = makeClient(openCasesResponder([]));
  await assert.rejects(
    () => insertCallReport(none.client, 7, { contactName: "Cohen", outcome: "given" }),
    /No open case/,
  );
  const three = makeClient(openCasesResponder([5, 6, 7]));
  await assert.rejects(
    () => insertCallReport(three.client, 7, { contactName: "Cohen", outcome: "given" }),
    /More than one open case/,
  );
});

test("insertCallReport carries the payment-method label, campaign and pledge amount on the report", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.askanus_cases") && sql.includes("ORDER BY id")) return { rows: [{ id: "5" }] };
    if (sql.includes("FROM public.featured_causes")) return { rows: [{ id: "9" }] }; // campaign active
    if (sql.includes("INSERT INTO public.fundraising_call_reports")) return { rows: [{ id: "43" }] };
    return { rows: [] };
  });
  const id = await insertCallReport(client, 7, {
    contactName: "Cohen", outcome: "given", amount: 250, moneyKind: "received",
    paymentMethod: "cash", campaignId: 9, pledgeAmount: 500,
  });
  assert.equal(id, 43);
  const ins = log.find((q) => q.sql.includes("INSERT INTO public.fundraising_call_reports"))!;
  assert.equal(ins.params[4], "given");
  assert.equal(ins.params[5], "received");
  assert.equal(ins.params[10], "cash");
  assert.equal(ins.params[11], 9); // campaign_id
  assert.equal(ins.params[12], null); // no project
  assert.equal(ins.params[13], 500); // pledge_amount
});

// --- upsertCallReport --------------------------------------------------------------
test("upsertCallReport creates the report from the session's stored fill-in when a case is chosen later", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.max_call_sessions WHERE id=$1")) {
      return { rows: [sessionRow({ outcome: "callback", mood: "neutral", note: "stored note", amount: "100", money_kind: "pledged" })] };
    }
    if (sql.includes("FROM public.askanus_cases") && sql.includes("id=$1")) return { rows: [{ id: "5" }] };
    if (sql.includes("INSERT INTO public.fundraising_call_reports")) return { rows: [{ id: "77" }] };
    return { rows: [], rowCount: 1 };
  });
  // Sparse draft: only the fresh outcome — the stored amount/note/mood/money kind carry over.
  const id = await upsertCallReport(client, 7, 9, 5, { outcome: "given" });
  assert.equal(id, 77);
  const ins = log.find((q) => q.sql.includes("INSERT INTO public.fundraising_call_reports"))!;
  assert.deepEqual(ins.params, [7, 5, null, "+17185551234", "given", "pledged", 100, "stored note", UUID_KEY, "neutral", null, null, null, 0]);
  // The session is kept in sync (case included) and no report update ran.
  const sync = log.find((q) => q.sql.includes("UPDATE public.max_call_sessions SET case_id=$1,outcome=$2"))!;
  assert.deepEqual(sync.params, [5, "given", "neutral", "stored note", 100, "pledged", 9, 7, null, 0, null, null]);
  assert.ok(!log.some((q) => q.sql.includes("UPDATE public.fundraising_call_reports SET")));
});

test("upsertCallReport updates the existing report when one already exists under the session's request id", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.max_call_sessions WHERE id=$1")) return { rows: [sessionRow()] };
    if (sql.includes("FROM public.askanus_cases") && sql.includes("id=$1")) return { rows: [{ id: "6" }] };
    if (sql.includes("INSERT INTO public.fundraising_call_reports")) return { rows: [] }; // conflict: already saved
    if (sql.includes("FROM public.fundraising_call_reports WHERE user_id=$1 AND request_id=$2")) return { rows: [{ id: "77" }] };
    if (sql.includes("UPDATE public.fundraising_call_reports SET")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const draft: SessionFillDraft = {
    outcome: "given", amount: 50, moneyKind: "received",
    note: "new note", mood: "positive", contactName: "Cohen",
  };
  assert.equal(await upsertCallReport(client, 7, 9, 6, draft), 77);
  const upd = log.find((q) => q.sql.includes("UPDATE public.fundraising_call_reports SET"))!;
  assert.ok(upd.sql.includes("case_id="));
  assert.ok(upd.params.includes(6));
  assert.ok(upd.params.includes("Cohen") === false); // contact_name is insert-only; the update patches case/outcome/money/amount/note/mood
  assert.ok(upd.params.includes(50));
  assert.ok(log.some((q) => q.sql.includes("UPDATE public.max_call_sessions SET case_id=$1,outcome=$2")));
});

test("upsertCallReport mints and stores a manual_request_id when the session has none", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.max_call_sessions WHERE id=$1")) return { rows: [sessionRow({ manual_request_id: null })] };
    if (sql.includes("FROM public.askanus_cases") && sql.includes("id=$1")) return { rows: [{ id: "5" }] };
    if (sql.includes("INSERT INTO public.fundraising_call_reports")) return { rows: [{ id: "78" }] };
    return { rows: [], rowCount: 1 };
  });
  assert.equal(await upsertCallReport(client, 7, 9, 5, { outcome: "given", amount: 10 }), 78);
  const mint = log.find((q) => q.sql.includes("SET manual_request_id=$1"))!;
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(mint.params[0])));
  const ins = log.find((q) => q.sql.includes("INSERT INTO public.fundraising_call_reports"))!;
  assert.equal(ins.params[8], mint.params[0]); // the report uses the minted key
});

test("upsertCallReport throws when the session is missing, and when no case can be resolved", async () => {
  const missing = makeClient(() => ({ rows: [] }));
  await assert.rejects(() => upsertCallReport(missing.client, 7, 9, 5, { outcome: "given" }), /Call session not found/);

  const twoCases = makeClient((sql) => {
    if (sql.includes("FROM public.max_call_sessions WHERE id=$1")) return { rows: [sessionRow()] };
    if (sql.includes("FROM public.askanus_cases") && sql.includes("ORDER BY id")) return { rows: [{ id: "5" }, { id: "6" }] };
    return { rows: [] };
  });
  await assert.rejects(() => upsertCallReport(twoCases.client, 7, 9, null, { outcome: "given" }), /More than one open case/);
});

test("upsertCallReport with do_not_call and a contact enables Do Not Call on the contact", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.max_call_sessions WHERE id=$1")) return { rows: [sessionRow({ contact_id: "3" })] };
    if (sql.includes("FROM public.askanus_cases") && sql.includes("id=$1")) return { rows: [{ id: "5" }] };
    if (sql.includes("INSERT INTO public.fundraising_call_reports")) return { rows: [{ id: "79" }] };
    return { rows: [], rowCount: 1 };
  });
  assert.equal(await upsertCallReport(client, 7, 9, 5, { outcome: "do_not_call" }), 79);
  const dnc = log.find((q) => q.sql.includes("SET do_not_call=true"))!;
  assert.deepEqual(dnc.params, [3, 7]);
});

// --- insertManualSession ------------------------------------------------------------
test("insertManualSession inserts a completed log row (never a prepared dial intent) with a request key", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("INSERT INTO public.max_call_sessions")) return { rows: [{ id: "11" }] };
    return { rows: [] };
  });
  const out = await insertManualSession(client, 7, "+17185551234", { provider: "yemot" });
  assert.equal(out.sessionId, 11);
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out.manualRequestId));
  assert.ok(log[0].sql.includes("'completed'"));
  assert.ok(!log[0].sql.includes("'prepared'"));
  assert.deepEqual(log[0].params, [7, "+17185551234", "outbound", "yemot", out.manualRequestId, null, "none", null]);

  const fixed = makeClient((sql) => {
    if (sql.includes("INSERT INTO public.max_call_sessions")) return { rows: [{ id: "12" }] };
    return { rows: [] };
  });
  const out2 = await insertManualSession(fixed.client, 7, "+17185551234", { manualRequestId: UUID_KEY });
  assert.equal(out2.manualRequestId, UUID_KEY);
  await assert.rejects(() => insertManualSession(client, 7, "5551234"), /Invalid US\/Canada number/);
});

// --- sessionFillFromReport ---------------------------------------------------------------
test("sessionFillFromReport maps a phone-machine draft onto a session fill draft", () => {
  assert.deepEqual(
    sessionFillFromReport({ outcome: "given", amount: 250, note: null, mood: "neutral", phone: "+17185551234", casePos: null, source: "manual", moneyKind: "received", paymentMethod: "cash", pledgeAmount: null }),
    { outcome: "given", amount: 250, moneyKind: "received", note: null, mood: "neutral", phone: "+17185551234", paymentMethod: "cash", pledgeAmount: undefined },
  );
  // A legacy 'spoke' draft maps to 'given' at read time.
  assert.equal(sessionFillFromReport({ outcome: "spoke" as never, amount: null, note: null, mood: null, phone: null, casePos: null, source: "manual" }).outcome, "given");
});

// --- legacy outcome 'spoke' -> 'given' (read-time mapping, no data rewrite) --
test("normalizeReportOutcome maps legacy 'spoke' to 'given'; every other outcome passes through; junk throws", () => {
  assert.equal(normalizeReportOutcome("spoke"), "given");
  assert.equal(normalizeReportOutcome("given"), "given");
  for (const o of ["no_answer", "callback", "not_interested", "do_not_call", "pickup", "cannot_give", "pledged"]) {
    assert.equal(normalizeReportOutcome(o), o);
  }
  assert.throws(() => normalizeReportOutcome("yelling"), /Invalid call outcome/);
  assert.throws(() => normalizeReportOutcome(""), /Invalid call outcome/);
});

// --- auto-contact ---------------------------------------------------------------
test("ensureContactByPhone returns the existing contact (no duplicate) when the last-10 digits match", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.communication_contacts WHERE user_id=$1")) return { rows: [{ id: "31" }] };
    return { rows: [] };
  });
  assert.deepEqual(await ensureContactByPhone(client, 7, "+17185551234"), { id: 31, created: false });
  assert.equal(log.length, 1); // no INSERT ran
  assert.deepEqual(log[0].params, [7, "7185551234"]);
  assert.ok(!log.some((q) => q.sql.includes("INSERT INTO public.communication_contacts")));
});

test("ensureContactByPhone inserts a blank-name contact from the number only when none exists", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.communication_contacts WHERE user_id=$1")) return { rows: [] };
    if (sql.includes("INSERT INTO public.communication_contacts")) return { rows: [{ id: "32" }] };
    return { rows: [] };
  });
  assert.deepEqual(await ensureContactByPhone(client, 7, "+17185551234"), { id: 32, created: true });
  const ins = log.find((q) => q.sql.includes("INSERT INTO public.communication_contacts"))!;
  assert.ok(ins.sql.includes("VALUES($1,'',$2)")); // name is a literal blank
  assert.deepEqual(ins.params, [7, "+17185551234"]);
});

test("ensureContactByPhone rejects a bad user or a non-E.164 number", async () => {
  const { client } = makeClient(() => ({ rows: [] }));
  await assert.rejects(() => ensureContactByPhone(client, 0, "+17185551234"), /Invalid user id/);
  await assert.rejects(() => ensureContactByPhone(client, 7, "5551234"), /Invalid US\/Canada number/);
});

// --- campaign/project persistence -------------------------------------------------
test("insertManualSession persists the campaign pick on the session (purpose_type/purpose_key)", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("INSERT INTO public.max_call_sessions")) return { rows: [{ id: "13" }] };
    return { rows: [] };
  });
  const out = await insertManualSession(client, 7, "+17185551234", { provider: "signalwire", purpose: { type: "campaign", key: "9" } });
  assert.equal(out.sessionId, 13);
  assert.deepEqual(log[0].params, [7, "+17185551234", "outbound", "signalwire", out.manualRequestId, null, "campaign", "9"]);
});

test("updateCallReport patches payment method, campaign, project and pledge amount", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("UPDATE public.fundraising_call_reports SET")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
  assert.equal(await updateCallReport(client, 7, 42, {
    outcome: "given", moneyKind: "received", amount: 250,
    paymentMethod: "tzedakah_card", campaignId: 9, pledgeAmount: 500,
  }), true);
  const upd = log.find((q) => q.sql.includes("UPDATE public.fundraising_call_reports SET"))!;
  assert.ok(upd.sql.includes("payment_method="));
  assert.ok(upd.sql.includes("campaign_id="));
  assert.ok(upd.sql.includes("pledge_amount="));
  assert.ok(upd.params.includes("tzedakah_card"));
  assert.ok(upd.params.includes(9));
  assert.ok(upd.params.includes(500));
  assert.ok(upd.params.includes(42));
});

test("upsertCallReport carries a campaign pick onto the report (campaign_id) and the session (purpose)", async () => {
  const { client, log } = makeClient((sql) => {
    if (sql.includes("FROM public.max_call_sessions WHERE id=$1")) return { rows: [sessionRow()] };
    if (sql.includes("FROM public.askanus_cases") && sql.includes("id=$1")) return { rows: [{ id: "5" }] };
    if (sql.includes("INSERT INTO public.fundraising_call_reports")) return { rows: [{ id: "80" }] };
    return { rows: [], rowCount: 1 };
  });
  const id = await upsertCallReport(client, 7, 9, 5, { outcome: "given", amount: 100, purpose: { type: "campaign", key: "9" } });
  assert.equal(id, 80);
  const ins = log.find((q) => q.sql.includes("INSERT INTO public.fundraising_call_reports"))!;
  assert.equal(ins.params[11], 9); // campaign_id — the pick is never dropped
  assert.equal(ins.params[12], null);
  const sync = log.find((q) => q.sql.includes("UPDATE public.max_call_sessions SET case_id=$1,outcome=$2"))!;
  assert.equal(sync.params[10], "campaign");
  assert.equal(sync.params[11], "9");
});

// --- categories (1593) ---------------------------------------------------------------
function categoriesClient() {
  return makeClient((sql) => {
    if (sql.includes("FROM public.fundraising_call_reports")) {
      return { rows: [
        // Legacy outcome 'spoke' must still show under "given".
        { id: "1", contact_id: "3", contact_name: "Cohen", outcome: "spoke", observed_mood: "positive", amount: "250", money_kind: "received", campaign_id: "9", project_id: null, case_id: "5", created_at: "2026-11-19T10:00:00Z" },
        { id: "2", contact_id: null, contact_name: "+12125550199", outcome: "callback", observed_mood: "neutral", amount: "0", money_kind: "none", campaign_id: null, project_id: null, case_id: "5", created_at: "2026-11-17T10:00:00Z" },
      ] };
    }
    if (sql.includes("FROM public.max_call_sessions")) {
      return { rows: [
        { id: "9", contact_id: null, number_e164: "+12125550199", outcome: "no_answer", mood: "neutral", amount: "0", money_kind: "none", direction: "outbound", case_id: null, purpose_type: "none", purpose_key: null, created_at: "2026-11-18T10:00:00Z" },
        { id: "10", contact_id: "3", number_e164: "+17185551234", outcome: "pledged", mood: "positive", amount: "500", money_kind: "pledged", direction: "inbound", case_id: "5", purpose_type: "case", purpose_key: "5", created_at: "2026-11-16T10:00:00Z" },
      ] };
    }
    if (sql.includes("FROM public.communication_contacts")) {
      return { rows: [{ id: "3", name: "Cohen", phone: "+17185551234" }] };
    }
    // Picker for the campaign dimension: case 5 + campaign 9.
    if (sql.includes("UNION ALL")) {
      return { rows: [
        { kind: "campaign", id: "9", title: "OJC Vouchers" },
        { kind: "case", id: "5", title: "Winter Appeal" },
      ] };
    }
    return { rows: [] };
  });
}

test("getCategoryValues: outcome lists given (legacy spoke counts), pledged, callback, no_answer — in fixed order, counts>0 only", async () => {
  const { client } = categoriesClient();
  assert.deepEqual(await getCategoryValues(client, 7, "outcome"), [
    { key: "given", label: "Given", count: 1 },
    { key: "no_answer", label: "No answer", count: 1 },
    { key: "callback", label: "Callback requested", count: 1 },
    { key: "pledged", label: "Pledge", count: 1 },
  ]);
  assert.deepEqual(await getCategoryValues(client, 7, "mood"), [
    { key: "positive", label: "Good", count: 2 },
    { key: "neutral", label: "Neutral", count: 2 },
  ]);
  assert.deepEqual(await getCategoryValues(client, 7, "direction"), [
    { key: "dialled", label: "Called out", count: 1 },
    { key: "manual", label: "Logged from another phone", count: 1 },
  ]);
  assert.deepEqual(await getCategoryValues(client, 7, "campaign"), [
    { key: "case:5", label: "Winter Appeal", count: 2 },
    { key: "campaign:9", label: "OJC Vouchers", count: 1 },
  ]);
  assert.deepEqual(await getCategoryValues(client, 7, "amount"), []); // the caller types the amount
  await assert.rejects(() => getCategoryValues(client, 7, "bogus" as never), /Invalid category dimension/);
});

test("getCategoryContacts: one contact under every matching value (multi-label); legacy spoke lists as Given $250", async () => {
  const { client } = categoriesClient();
  // Outcome "given": Cohen (legacy spoke report, $250). The pledged
  // session for the same contact is a different outcome, so it is not here.
  assert.deepEqual(await getCategoryContacts(client, 7, "outcome", "given"), [
    { contactId: 3, name: "Cohen", phone: "+17185551234", detail: "Given $250", calls: 1 },
  ]);
  // Mood "positive": the SAME contact appears again (multi-label).
  const positive = await getCategoryContacts(client, 7, "mood", "positive");
  assert.equal(positive.length, 1);
  assert.equal(positive[0].name, "Cohen");
  assert.equal(positive[0].calls, 2); // the given report + the pledged session
  assert.equal(positive[0].detail, "Given $250"); // latest matching call
  // Amount lookup: type 250, hear the contact on that amount.
  assert.deepEqual(await getCategoryContacts(client, 7, "amount", "250"), [
    { contactId: 3, name: "Cohen", phone: "+17185551234", detail: "Given $250", calls: 1 },
  ]);
  assert.deepEqual(await getCategoryContacts(client, 7, "amount", "999"), []);
  // Direction "dialled": the number-only session (no contact row yet).
  assert.deepEqual(await getCategoryContacts(client, 7, "direction", "dialled"), [
    { contactId: null, name: "+12125550199", phone: "+12125550199", detail: "No answer", calls: 1 },
  ]);
  // Pledge value: money_kind pledged counts even though the outcome is "pledged" too.
  const pledged = await getCategoryContacts(client, 7, "outcome", "pledged");
  assert.equal(pledged.length, 1);
  assert.equal(pledged[0].detail, "Pledge $500");
  await assert.rejects(() => getCategoryContacts(client, 7, "bogus" as never, "given"), /Invalid category dimension/);
});
