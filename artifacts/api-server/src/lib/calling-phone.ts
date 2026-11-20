/**
 * Calling phone helpers and the pure Calling state machine (IVR path 1592,
 * Olam Chesed option 2 "Call-2").
 *
 * Pure: no database, no network, no pg import. The IVR engine
 * (yemot-api-driven-phone.ts, to be wired by the engine agent) calls
 * handleCallingDigit and executes the returned effect against the database
 * via calling-queue.ts. Everything here is unit-testable with node --test.
 *
 * THE PROVIDER GATE — READ THIS BEFORE CHANGING ANYTHING
 * ------------------------------------------------------
 * Yemot NEVER dials. Option 1 (make a call) and redial exist ONLY on
 * SignalWire; on Yemot the menu starts at 2 and this machine NEVER emits
 * a dial/redial effect (the Yemot branch returns an informational
 * feedback string instead). The engine enforces the same gate.
 *
 * STATE (stored as JSON in the call state's action_flash, key "calling"):
 *   {mode, option, pos, kind, id, filter?, returnTo?, fromContact?,
 *    dateKind?, dateDay?, dateMonth?, dateYear?, dateHour?, dateRetries?,
 *    phoneDigits?, phone?, casePos?, caseSelected?, source?, editing?,
 *    fillOutcome?, fillAmount?, fillAmountDigits?, fillNote?, fillMood?,
 *    editField?}
 * mode: 'menu' | 'list' | 'detail' | 'filter' | 'date-choice' |
 *       'date-day' | 'date-month' | 'date-year' | 'date-hour' |
 *       'date-minute' | 'phone' | 'select-case' | 'fill-outcome' |
 *       'fill-amount' | 'fill-method' | 'fill-paid' | 'fill-paid-amount' |
 *       'fill-note' | 'fill-mood' | 'pickup-address' | 'edit-field' |
 *       'edit-value' | 'confirm-delete' | 'confirm-delete-all' |
 *       'contact-menu'
 * option: 0 = top menu, else 1..7 (the option the caller is inside).
 * pos: index into the list the engine loaded for the current mode
 *      (call log / missed calls / contacts / cases+projects). pos ==
 *      list length means "past the end of the list".
 * kind/id: the item at pos (mirrored for the engine; the list the engine
 *      loaded is the source of truth — exactly like Tishl).
 * casePos: index into getOpenCasesAndProjects() (cases, then campaigns,
 *      then projects, each by title). null = skipped / no case yet.
 *      The engine resolves casePos to {kind, id} when it executes an
 *      effect that carries it (dial / saveReport / schedule). A skipped
 *      case is NEVER silently replaced with another case: when no case
 *      was chosen, the fill-in is held on the max_call_sessions row
 *      (updateSessionFill) and the report is created later, when a case
 *      is chosen in option 3 (upsertCallReport) — except for the
 *      single-open-case convenience, where the queue resolves the one
 *      open case (resolveSingleOpenCase). Editing a report: null means
 *      keep the current case. Editing a session: null means no case
 *      was chosen yet.
 * phone: the normalized +1 E.164 number the caller keyed in.
 *
 * EFFECTS AND WHO RESOLVES WHAT
 * ------------------------------
 * Effects that act on a list item carry pos; the engine resolves the item
 * from the list it loaded for the current option/filter (same pattern as
 * Tishl, where the engine re-reads queue[pos]).
 * Effects that act on keyed-in data carry the data (phone, casePos, at,
 * report draft). The engine resolves casePos via getOpenCasesAndProjects()
 * in the SAME order the list was spoken.
 * 'saveReport' ALWAYS carries report.casePos (number|null). The engine:
 * case resolved -> insertCallReport as before; case null -> first try
 * the single open case (resolveSingleOpenCase), and when there is still
 * no case -> updateSessionFill on the session row (the engine must have
 * a session id: created at dial time for option 1, or at manual-log
 * start for option 2 via insertManualSession). The feedback already
 * tells the caller the case can be added later via option 3.
 * 'updateReport' (option 3 edit) carries pos + report. The engine
 * resolves pos to the entry: a report -> updateCallReport as before;
 * a session without a report -> case chosen: upsertCallReport (creates
 * the report from the stored session fill-in); no case chosen:
 * updateSessionFill (the fill-in stays on the session).
 * 'recordNote' means: the engine should record a voice note now, then
 * call attachCallingNote(state, text) with buildVoiceNoteText(ref, now)
 * to advance the fill form. 'saveContactNote' means the same for a
 * contact name/address/note edit; the engine records, then calls
 * addContactNote with buildVoiceNoteText(ref, now).
 *
 * DATE ENTRY (option 6, and scheduling a contact)
 * ------------------------------------------------
 * date-choice: 1 = Jewish, 2 = numeric.
 * Jewish: day -> month (1-13 fixed slots, Hebrew month names) -> year
 *   (4 Hebrew digits, or # for the current Hebrew year) -> hour -> minute.
 * Numeric: month -> day -> year (4 Gregorian digits, or # for the current
 *   Gregorian year) -> hour -> minute. NOTE the order differs: the spec
 *   gives Jewish as day-first and numeric as month-first.
 * "#" as the year means "this year"; if that date already passed, the
 * next year's occurrence is used (same next-occurrence rule as Tishl).
 * An explicitly entered year that is already past is invalid.
 * One re-prompt on an invalid entry, then the entry is cancelled
 * (Tishl pattern). A date that can never occur (31 April, 30 Cheshvan
 * in a 29-day year) re-prompts the day once, then cancels.
 * Scheduling is NEVER auto-dial: the effect only carries the date; the
 * engine inserts the row (insertScheduledCall) and the item surfaces on
 * Tishl as a reminder.
 *
 * NAME / ADDRESS EDITING (honest limit)
 * --------------------------------------
 * A contact's name or address cannot be typed on a phone keypad (digits
 * only). Editing a name/address therefore records a VOICE NOTE attached
 * to the contact (same buildVoiceNoteText pattern as Tishl); the typed
 * edit happens on the website. DNC toggle and delete work by keypad.
 *
 * TIMEZONE: all scheduled times are in America/New_York (the community's
 * local time), same as Tishl.
 */

import {
  hebrewFromFixed, fixedFromGregorian, gregorianFromFixed, fixedFromHebrew,
  daysInHebrewMonth, hebrewMonthName, parshaForGregorianDate,
} from "./hebrew-calendar";
import {
  TISHL_TZ, tzParts, zonedTimeToUtc, speakDigits, parseDateDigits,
  hebrewMonthChoicesSpeech, buildVoiceNoteText, formatSpokenDateTime,
} from "./tishl-phone";

export const CALLING_TZ = TISHL_TZ;

export type CallingProvider = "yemot" | "signalwire";
export type CallLogFilter = "missed" | "outgoing" | "incoming" | "all";
export type CallingItemKind = "missed" | "session" | "report" | "contact";

export type CallingItemView = {
  kind: CallingItemKind;
  id: number;
  title: string;
  detail: string;
  phone: string | null;
  created_at: string;
};

export type CallingMode =
  | "menu" | "list" | "detail" | "filter"
  | "date-choice" | "date-day" | "date-month" | "date-year" | "date-hour" | "date-minute"
  | "phone" | "select-case"
  | "fill-outcome" | "fill-amount" | "fill-method" | "fill-paid" | "fill-paid-amount"
  | "fill-note" | "fill-mood" | "pickup-address"
  | "edit-field" | "edit-value" | "confirm-delete" | "confirm-delete-all"
  | "contact-menu";

export type CallingState = {
  mode: CallingMode;
  option: number;
  pos: number;
  kind: CallingItemKind | null;
  id: number | null;
  filter?: CallLogFilter;
  returnTo?: CallingMode;
  fromContact?: boolean;
  dateKind?: "jewish" | "numeric";
  dateDay?: number;
  dateMonth?: number;
  /** Hebrew or Gregorian year. null = "#" (current year, rolling forward). */
  dateYear?: number | null;
  dateHour?: number;
  dateRetries?: number;
  phoneDigits?: string;
  phone?: string;
  casePos?: number | null;
  caseSelected?: boolean;
  source?: "dialled" | "manual";
  editing?: boolean;
  fillOutcome?: string;
  fillAmount?: number | null;
  fillAmountDigits?: string;
  fillNote?: string | null;
  fillMood?: string | null;
  editField?: "name" | "address" | "note";
  /** Payment-method label (CALLING_PAYMENT_METHODS value) once the
   * caller picks one in fill-method; null = skipped / not asked. */
  fillMethod?: CallingPaymentMethod | null;
  /** Pledge settlement in fill-paid: "full" (paid whole), "part"
   * (paid part — the paid amount follows in fill-paid-amount),
   * "none" (not paid yet). */
  fillPaid?: "full" | "part" | "none" | null;
  /** The amount undertaken, while a pledge is being settled. */
  fillPledgeAmount?: number | null;
  fillPaidAmountDigits?: string;
  /** ISO timestamp of the pickup scheduled in the pickup flow. */
  fillPickupAt?: string | null;
};

/** The engine calls this with the list it loaded for the current mode. */
export type CallingContext = {
  provider: CallingProvider;
  /** The option the engine believes is active (must match state.option outside the menu). */
  option: number;
  /** Length of the list currently displayed (call log / missed / contacts / cases). */
  listLength: number;
};

/** Outcome keypad map (same as the existing manual-result flow, 141).
 * Yakob 2026-11-19 23:32: "1" is "given" (was "spoke"), plus three new
 * outcomes — 6 pickup ("said to come pick up"), 7 cannot_give
 * ("did not / cannot give"), 8 pledged (undertook bl"n, not yet given,
 * or gave part). Legacy rows with outcome='spoke' still exist in the
 * database: they are mapped to "given" at READ time (normalizeOutcome,
 * calling-queue.ts) — no data rewrite, no CHECK change (neither table
 * has an outcome CHECK — verified live 2026-11-19). */
export const CALLING_OUTCOMES: Readonly<Record<string, string>> = {
  "1": "given",
  "2": "no_answer",
  "3": "callback",
  "4": "not_interested",
  "5": "do_not_call",
  "6": "pickup",
  "7": "cannot_give",
  "8": "pledged",
};

/** The legacy outcome value, kept only for read-time mapping. Never
 * written by new code: new reports/sessions always store "given". */
export const LEGACY_OUTCOME_SPOKEN = "spoke";

/** Payment-method keypad map (Yakob 23:32). METHOD LABEL ONLY: the
 * caller picks how the money was given (credit card / cash / check /
 * tzedakah card / voucher, e.g. an OJC voucher). No card number is
 * ever asked for, accepted, or stored — there is no card processing
 * and no secure card saving in this system. The amount entry is
 * digits-only and means an AMOUNT only. */
export const CALLING_PAYMENT_METHODS: Readonly<Record<string, string>> = {
  "1": "credit_card",
  "2": "cash",
  "3": "check",
  "4": "tzedakah_card",
  "5": "voucher",
};

/** Payment-method LABEL only — never a card number. Defined here (pure
 * module) so both the machine and the data layer share one union. */
export type CallingPaymentMethod = "credit_card" | "cash" | "check" | "tzedakah_card" | "voucher";

export const CALLING_MOODS: Readonly<Record<string, string>> = {
  "1": "positive",
  "2": "neutral",
  "3": "negative",
};

export type CallReportDraft = {
  outcome: string;
  amount: number | null;
  note: string | null;
  mood: string | null;
  phone: string | null;
  casePos: number | null;
  source: "dialled" | "manual";
  /** "received" when money changed hands, "pledged" while a pledge is
   * open, "none" otherwise. Derived by the machine (buildDraft). */
  moneyKind?: "none" | "received" | "pledged";
  /** Payment-method LABEL only (see CALLING_PAYMENT_METHODS). Never a
   * card number. Null = not asked / skipped. */
  paymentMethod?: CallingPaymentMethod | null;
  /** The pledge amount when outcome is "pledged" (or a pledge was
   * partly paid: pledgeAmount is what was undertaken, amount is what
   * was actually paid). Null otherwise. */
  pledgeAmount?: number | null;
  /** ISO timestamp of the pickup the caller scheduled (outcome
   * "pickup"); the pickup itself is stored as a scheduled call and
   * surfaces on Tishl as a reminder. Null otherwise. */
  pickupAt?: string | null;
};

export type CallingEffect =
  | { type: "none" }
  | { type: "leave" }
  | { type: "dial"; phone: string; casePos: number | null }
  | { type: "redial"; pos: number }
  | { type: "saveReport"; report: CallReportDraft }
  | { type: "updateReport"; pos: number; report: CallReportDraft }
  | { type: "deleteLog"; pos: number }
  | { type: "deleteAllLog" }
  | { type: "deleteContact"; pos: number }
  | { type: "toggleDNC"; pos: number }
  | { type: "saveContactNote"; pos: number; field: "name" | "address" | "note" }
  | { type: "recordNote" }
  /** Record the pickup address as a voice note (engine: pending
   * "pickup-address", then addContactNote on the contact resolved
   * from the call's phone number). The address is a voice note because
   * a keypad cannot type it. */
  | { type: "savePickupAddress" }
  | { type: "schedule"; at: Date; phone: string | null; contactPos: number | null; casePos: number | null; note: string | null }
  | { type: "markDone"; pos: number };

export type CallingDigitResult = {
  state: CallingState;
  effect: CallingEffect;
  /** Spoken confirmation to prepend to the next prompt ("" = none). */
  feedback: string;
};

export function newCallingState(): CallingState {
  return { mode: "menu", option: 0, pos: 0, kind: null, id: null };
}

/** Parse the Calling state out of the action_flash JSON. Null on no/bad state. */
export function parseCallingFlash(manualFlash: string | null | undefined): CallingState | null {
  if (!manualFlash) return null;
  try {
    const parsed = JSON.parse(manualFlash) as { calling?: unknown };
    const st = parsed && typeof parsed === "object" ? parsed.calling : null;
    if (!st || typeof st !== "object") return null;
    const s = st as Partial<CallingState>;
    if (typeof s.pos !== "number" || typeof s.mode !== "string" || typeof s.option !== "number") return null;
    const out: CallingState = {
      mode: s.mode as CallingMode,
      option: Math.max(0, Math.floor(s.option)),
      pos: Math.max(0, Math.floor(s.pos)),
      kind: s.kind ?? null,
      id: typeof s.id === "number" ? s.id : null,
    };
    if (s.filter) out.filter = s.filter;
    if (s.returnTo) out.returnTo = s.returnTo;
    if (s.fromContact) out.fromContact = true;
    if (s.dateKind) out.dateKind = s.dateKind;
    if (typeof s.dateDay === "number") out.dateDay = s.dateDay;
    if (typeof s.dateMonth === "number") out.dateMonth = s.dateMonth;
    if (typeof s.dateYear === "number" || s.dateYear === null) out.dateYear = s.dateYear;
    if (typeof s.dateHour === "number") out.dateHour = s.dateHour;
    if (typeof s.dateRetries === "number") out.dateRetries = s.dateRetries;
    if (typeof s.phoneDigits === "string") out.phoneDigits = s.phoneDigits;
    if (typeof s.phone === "string") out.phone = s.phone;
    if (typeof s.casePos === "number" || s.casePos === null) out.casePos = s.casePos;
    if (s.caseSelected) out.caseSelected = true;
    if (s.source) out.source = s.source;
    if (s.editing) out.editing = true;
    if (typeof s.fillOutcome === "string") out.fillOutcome = s.fillOutcome;
    if (typeof s.fillAmount === "number" || s.fillAmount === null) out.fillAmount = s.fillAmount;
    if (typeof s.fillAmountDigits === "string") out.fillAmountDigits = s.fillAmountDigits;
    if (typeof s.fillNote === "string" || s.fillNote === null) out.fillNote = s.fillNote;
    if (typeof s.fillMood === "string" || s.fillMood === null) out.fillMood = s.fillMood;
    if (s.editField) out.editField = s.editField;
    if (typeof s.fillMethod === "string" || s.fillMethod === null) out.fillMethod = s.fillMethod;
    if (s.fillPaid === "full" || s.fillPaid === "part" || s.fillPaid === "none") out.fillPaid = s.fillPaid;
    if (typeof s.fillPledgeAmount === "number" || s.fillPledgeAmount === null) out.fillPledgeAmount = s.fillPledgeAmount;
    if (typeof s.fillPaidAmountDigits === "string") out.fillPaidAmountDigits = s.fillPaidAmountDigits;
    if (typeof s.fillPickupAt === "string") out.fillPickupAt = s.fillPickupAt;
    return out;
  } catch {
    return null;
  }
}

export function encodeCallingFlash(state: CallingState): string {
  return JSON.stringify({ calling: state });
}

/** One level back. Returns null when leaving Calling entirely (back to 159). */
export function callingBackOneLevel(state: CallingState): CallingState | null {
  const toMenu: CallingState = {
    ...state, mode: "menu", option: 0, pos: 0, kind: null, id: null,
    filter: undefined, returnTo: undefined, fromContact: undefined,
    dateKind: undefined, dateDay: undefined, dateMonth: undefined,
    dateYear: undefined, dateHour: undefined, dateRetries: 0,
    phoneDigits: undefined, phone: undefined, casePos: undefined,
    caseSelected: undefined, source: undefined, editing: undefined,
    fillOutcome: undefined, fillAmount: undefined, fillAmountDigits: undefined,
    fillNote: undefined, fillMood: undefined, editField: undefined,
    fillMethod: undefined, fillPaid: undefined, fillPledgeAmount: undefined,
    fillPaidAmountDigits: undefined, fillPickupAt: undefined,
  };
  switch (state.mode) {
    case "menu": return null;
    case "list": case "filter": return toMenu;
    case "detail": return { ...state, mode: "list" };
    case "contact-menu": return { ...state, mode: "list" };
    case "edit-field": return { ...state, mode: "contact-menu", editField: undefined };
    case "edit-value": return { ...state, mode: "edit-field" };
    case "confirm-delete":
      return state.option === 7
        ? { ...state, mode: "contact-menu" }
        : { ...state, mode: "detail" };
    case "confirm-delete-all": return { ...state, mode: "detail" };
    case "date-choice": case "date-day": case "date-month": case "date-year":
    case "date-hour": case "date-minute":
      return state.returnTo === "contact-menu"
        ? { ...state, mode: "contact-menu", dateKind: undefined, dateDay: undefined,
            dateMonth: undefined, dateYear: undefined, dateHour: undefined, dateRetries: 0 }
        : toMenu;
    case "phone": case "select-case":
      return state.returnTo ? { ...state, mode: state.returnTo } : toMenu;
    case "fill-outcome": case "fill-amount": case "fill-method": case "fill-paid":
    case "fill-paid-amount": case "fill-note": case "fill-mood": case "pickup-address":
      return state.returnTo === "list"
        ? { ...state, mode: "list", fillOutcome: undefined, fillAmount: undefined,
            fillAmountDigits: undefined, fillNote: undefined, fillMood: undefined, editing: undefined,
            fillMethod: undefined, fillPaid: undefined, fillPledgeAmount: undefined,
            fillPaidAmountDigits: undefined, fillPickupAt: undefined }
        : toMenu;
    default: return toMenu;
  }
}

// ---------------------------------------------------------------------------
// Date / phone helpers
// ---------------------------------------------------------------------------

const GREGORIAN_MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isGregorianLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function gregorianMonthLength(y: number, m: number): number {
  if (m === 2) return isGregorianLeapYear(y) ? 29 : 28;
  return GREGORIAN_MONTH_LENGTHS[m - 1];
}

/**
 * Resolve an explicitly entered date/time to an exact instant.
 * kind "jewish": day 1-30, month 1-13 (fixed slots), year = Hebrew year.
 * kind "numeric": month 1-12, day 1-31, year = Gregorian year.
 * year === null means "#" (current year): the next occurrence is used,
 * rolling to the next year when this year's date already passed.
 * An explicitly entered year must be in the future. Returns null when
 * the date can never occur (31 April, 30 Cheshvan in a 29-day year) or
 * is in the past.
 */
export function resolveScheduledDate(
  now: Date, timeZone: string,
  kind: "jewish" | "numeric",
  day: number, month: number, year: number | null,
  hour: number, minute: number,
): Date | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const p = tzParts(now, timeZone);
  if (kind === "jewish") {
    if (day < 1 || day > 30 || month < 1 || month > 13) return null;
    if (year !== null && (year < 5700 || year > 5900)) return null;
    const todayHebrew = hebrewFromFixed(fixedFromGregorian(p.year, p.month, p.day));
    const startYear = year ?? todayHebrew.year;
    // Search up to 8 Hebrew years: short months (29-day Cheshvan) and
    // Adar II (leap years only) may not occur again until years ahead.
    const years = year !== null ? [year]
      : Array.from({ length: 8 }, (_, i) => startYear + i);
    for (const y of years) {
      if (day > daysInHebrewMonth(y, month)) continue;
      const g = gregorianFromFixed(fixedFromHebrew(y, month, day));
      const at = zonedTimeToUtc(g.year, g.month, g.day, hour, minute, timeZone);
      if (at.getTime() > now.getTime()) return at;
      // Explicit year in the past: invalid, do not roll forward.
      if (year !== null) return null;
    }
    return null;
  }
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  if (year !== null && (year < 2000 || year > 2100)) return null;
  const startYear = year ?? p.year;
  // Feb 29 only ever happens in a leap year: search up to 8 years ahead.
  const years = year !== null ? [year]
    : Array.from({ length: 8 }, (_, i) => startYear + i);
  for (const y of years) {
    if (day > gregorianMonthLength(y, month)) continue;
    const at = zonedTimeToUtc(y, month, day, hour, minute, timeZone);
    if (at.getTime() > now.getTime()) return at;
    if (year !== null) return null;
  }
  return null;
}

/**
 * Normalize keyed-in digits to +1 E.164 (US/Canada NANP only, same rule
 * as the MAX outbound path). Accepts 10 national digits or 11 starting
 * with 1. Returns null when the number is not a valid NANP number.
 */
export function normalizeCallingPhone(digits: string): string | null {
  const d = String(digits || "").replace(/\D/g, "");
  if (d.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return "+1" + d;
  if (d.length === 11 && d[0] === "1" && /^[2-9]\d{2}[2-9]\d{6}$/.test(d.slice(1))) return "+" + d;
  return null;
}

/** After the engine records a voice note for the fill form, advance it. */
export function attachCallingNote(state: CallingState, noteText: string): CallingState {
  if (state.mode !== "fill-note") return state;
  return { ...state, fillNote: String(noteText || "").slice(0, 2000), mode: "fill-mood" };
}

/** After the engine records a pickup-address voice note (and attaches
 * it to the contact), move on to the call's voice note. */
export function advanceAfterPickupAddress(state: CallingState): CallingState {
  if (state.mode !== "pickup-address") return state;
  return { ...state, mode: "fill-note" };
}

// ---------------------------------------------------------------------------
// Speech helpers (English TTS-safe text; the engine's safeVoice strips
// non-ASCII, and Yiddish drafts come separately — same as Tishl).
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<CallingItemKind, string> = {
  missed: "Missed call",
  session: "Call",
  report: "Call report",
  contact: "Contact",
};

/** The top Calling menu. On Yemot there is no option 1 (no outbound dial). */
export function callingMenuSpeech(provider: CallingProvider): string {
  const makeCall = provider === "signalwire"
    ? "Press 1 to make a call. "
    : "";
  return "Calling. " + makeCall +
    "Press 2 to log a call from another phone. " +
    "Press 3 to update call information. " +
    "Press 4 to hear missed calls. " +
    "Press 5 for the call log. " +
    "Press 6 to schedule a call. " +
    "Press 7 for contacts. " +
    "Press star to go back.";
}

export function filterMenuSpeech(): string {
  return "Call log. Press 1 for missed calls. Press 2 for outgoing calls. " +
    "Press 3 for incoming calls. Press 4 for all calls. Press star to go back.";
}

/** The spoken line for one list item. */
export function describeCallingItem(item: CallingItemView, pos: number, total: number): string {
  let text = "Item " + (pos + 1) + " of " + total + ". " + KIND_LABEL[item.kind] + ": " + item.title + ". ";
  if (item.phone) text += "Number " + speakDigits(item.phone) + ". ";
  if (item.detail) text += item.detail + ". ";
  text += "Press 1 for options, pound for the next item, 9 for the previous item, or star to go back.";
  return text;
}

/** The spoken detail/action menu for a call-log or missed-call item. */
export function detailMenuSpeech(option: number, item: CallingItemView | null, provider: CallingProvider): string {
  const callBack = provider === "signalwire" ? "Press 1 to call this number back. " : "";
  if (option === 4) {
    return "Options. " + callBack +
      "Press 2 to mark this missed call done. " +
      "Press 3 to delete this missed call. " +
      "Press zero or star to go back to the list.";
  }
  return "Options. " + callBack +
    "Press 2 to edit the information for this call. " +
    "Press 3 to delete this log entry. " +
    "Press 4 to delete all log entries. " +
    "Press zero or star to go back to the list.";
}

/** The spoken menu for one contact. */
export function contactMenuSpeech(item: CallingItemView | null): string {
  const name = item ? item.title : "this contact";
  return "Contact " + name + ". Press 1 to schedule a call with this contact. " +
    "Press 2 to delete this contact. " +
    "Press 3 to edit the name, address, or note. " +
    "Press 4 to turn Do Not Call on or off for this contact. " +
    "Press zero or star to go back to the list.";
}

export function editFieldSpeech(): string {
  return "What do you want to edit? Press 1 for the name. Press 2 for the address. " +
    "Press 3 to add a note. Press zero or star to go back.";
}

export function editValueSpeech(field: "name" | "address" | "note"): string {
  const what = field === "name" ? "the name" : field === "address" ? "the address" : "a note";
  return "To change " + what + ", press 1 to record a voice note now. " +
    "A name or address cannot be typed on the keypad, so your recording is saved " +
    "with this contact and the typed change is made on the website. " +
    "Press pound to cancel, or star to go back.";
}

export function selectCaseSpeech(): string {
  return "Choose a case, campaign, or project for this call. " +
    "Press 1 to choose this one. Press 2 for the next one. Press 8 for the previous one. " +
    "Press pound to skip. Press star to go back.";
}

export function phoneEntrySpeech(): string {
  return "Enter the phone number, then press pound. Press star to go back.";
}

export function fillOutcomeSpeech(): string {
  return "What was the result of the call? Press 1 if they gave. Press 2 for no answer. " +
    "Press 3 for callback requested. Press 4 for not interested. Press 5 for Do Not Call. " +
    "Press 6 if they said to come pick it up. Press 7 if they did not or cannot give. " +
    "Press 8 for a pledge. Press star to cancel.";
}

export function fillAmountSpeech(): string {
  return "Enter the amount in dollars, then press pound. Press pound with no amount to skip. " +
    "Press star to go back.";
}

/** After "given": how was it given? METHOD LABEL ONLY — never a card
 * number. The caller picks a label; no card data is ever entered. */
export function fillMethodSpeech(): string {
  return "How was it given? Press 1 for credit card, 2 for cash, 3 for check, " +
    "4 for a tzedakah card, or 5 for a voucher. Press pound to skip. Press star to go back.";
}

/** After a pledge amount: was it paid, part or whole? */
export function fillPaidSpeech(): string {
  return "Was the pledge paid? Press 1 if it was paid in full. Press 2 if part of it was paid. " +
    "Press 3 if it has not been paid yet. Press star to go back.";
}

export function fillPaidAmountSpeech(): string {
  return "Enter the amount that was paid, in dollars, then press pound. Press star to go back.";
}

/** After a pickup is scheduled: the address cannot be typed on a
 * keypad, so it is recorded as a voice note and — on the caller's
 * confirmation — attached to the contact (addContactNote). */
export function pickupAddressSpeech(): string {
  return "To add the pickup address, press 1 to record a voice note now. " +
    "The address will be saved with this contact. Press pound to skip the address. " +
    "Press star to go back.";
}

export function fillNoteSpeech(): string {
  return "Press 1 to record a voice note about this call. Press pound to skip the note. " +
    "Press star to go back.";
}

export function fillMoodSpeech(): string {
  return "How did the call go? Press 1 for good. Press 2 for neutral. Press 3 for not good. " +
    "Press pound to skip. Press star to go back.";
}

export function dateChoiceSpeech(): string {
  return "Press 1 for a Jewish date, or 2 for numbers. Press star to go back.";
}

export function dateYearSpeech(kind: "jewish" | "numeric"): string {
  return kind === "jewish"
    ? "Enter the Hebrew year, 4 digits, then press pound. Press pound alone for this year. Press star to go back."
    : "Enter the year, 4 digits, then press pound. Press pound alone for this year. Press star to go back.";
}

/**
 * The Hebrew month list spoken during Jewish date entry. Adar II is
 * always offered: the resolver rolls it to the next leap year, so a
 * caller planning ahead is never stuck.
 */
export function callingHebrewMonthChoicesSpeech(year: number): string {
  return hebrewMonthChoicesSpeech(year, true);
}

/** Re-exported so the engine wiring agent has one import for voice notes. */
export { buildVoiceNoteText };

/** After a removal (delete / mark done), clamp the position to the new list. */
export function clampCallingPosAfterRemoval(pos: number, newLength: number): { pos: number; empty: boolean } {
  if (newLength === 0) return { pos: 0, empty: true };
  if (pos >= newLength) return { pos: newLength, empty: false }; // past the end
  return { pos, empty: false };
}

function buildDraft(state: CallingState): CallReportDraft {
  const outcome = state.fillOutcome || "given";
  let moneyKind: "none" | "received" | "pledged" = "none";
  let amount = state.fillAmount ?? null;
  let pledgeAmount: number | null = null;
  if (outcome === "pledged") {
    // fillPledgeAmount is what was undertaken; fillAmount is what was
    // actually paid (part) or the pledge itself (full / unpaid).
    pledgeAmount = state.fillPledgeAmount ?? state.fillAmount ?? null;
    if (state.fillPaid === "full") { moneyKind = "received"; amount = pledgeAmount; }
    else if (state.fillPaid === "part") { moneyKind = "received"; }
    else moneyKind = "pledged";
  } else if (outcome === "given" && (amount ?? 0) > 0) {
    moneyKind = "received";
  }
  return {
    outcome,
    amount,
    note: state.fillNote ?? null,
    mood: state.fillMood ?? null,
    phone: state.phone ?? null,
    casePos: state.casePos ?? null,
    source: state.source ?? "manual",
    moneyKind,
    paymentMethod: state.fillMethod ?? null,
    pledgeAmount,
    pickupAt: state.fillPickupAt ?? null,
  };
}

function clearFill(state: CallingState): CallingState {
  return {
    ...state,
    fillOutcome: undefined, fillAmount: undefined, fillAmountDigits: undefined,
    fillNote: undefined, fillMood: undefined, editing: undefined,
    fillMethod: undefined, fillPaid: undefined, fillPledgeAmount: undefined,
    fillPaidAmountDigits: undefined, fillPickupAt: undefined,
  };
}

/** After the amount step: a pledge goes to the paid? question, a gift
 * goes to the how? (method label) question, everything else goes on
 * to the note. */
function afterAmountStep(state: CallingState, amount: number | null): CallingState {
  const next: CallingState = { ...state, fillAmount: amount, fillAmountDigits: undefined, dateRetries: 0 };
  if (state.fillOutcome === "pledged") {
    next.fillPledgeAmount = amount;
    next.mode = "fill-paid";
  } else if (state.fillOutcome === "given") {
    next.mode = "fill-method";
  } else {
    next.mode = "fill-note";
  }
  return next;
}

// ---------------------------------------------------------------------------
// The pure digit state machine
// ---------------------------------------------------------------------------

export function handleCallingDigit(
  state: CallingState,
  digit: string,
  ctx: CallingContext,
  now: Date,
  timeZone: string,
): CallingDigitResult {
  const d = String(digit ?? "").trim();
  const base: CallingState = { ...state };
  const provider = ctx.provider;
  const listLength = Math.max(0, Math.floor(ctx.listLength || 0));
  const isYemot = provider === "yemot";

  // 0 or * = back one level (in every mode, for both providers).
  // EXCEPTIONS: in date-hour and date-minute, 0 is a valid value
  // (midnight, :00); in phone and fill-amount, 0 is a digit; in
  // date-year, "0" is part of a year string, never a lone back-out
  // (the engine passes the whole year as one string, as with Tishl).
  const backOut =
    d === "*" ||
    (d === "0" && !["date-hour", "date-minute", "phone", "fill-amount", "fill-paid-amount", "date-year"].includes(state.mode));
  if (backOut) {
    const back = callingBackOneLevel(base);
    if (back === null) return { state: base, effect: { type: "leave" }, feedback: "" };
    return { state: back, effect: { type: "none" }, feedback: "" };
  }

  // Past the end of a list: # restarts, 9 goes to the last item.
  if ((state.mode === "list" || state.mode === "detail" || state.mode === "contact-menu") &&
      state.pos >= listLength && listLength > 0) {
    if (d === "#") return { state: { ...base, pos: 0 }, effect: { type: "none" }, feedback: "" };
    if (d === "9") return { state: { ...base, pos: listLength - 1 }, effect: { type: "none" }, feedback: "" };
    return { state: base, effect: { type: "none" },
             feedback: "You have reached the end of the list. Press pound to hear them again, or star to go back. " };
  }

  switch (state.mode) {
    case "menu": {
      if (!/^[1-7]$/.test(d)) {
        return { state: base, effect: { type: "none" },
                 feedback: "Press 1 to 7 for an option, or star to go back. " };
      }
      const option = Number(d);
      // Yemot NEVER dials: option 1 does not exist on Yemot.
      if (option === 1 && isYemot) {
        return { state: base, effect: { type: "none" },
                 feedback: "Making a call is only on the calling line. This menu cannot place calls. " };
      }
      const next: CallingState = { ...base, option, pos: 0, kind: null, id: null };
      if (option === 1) {
        next.mode = "select-case"; next.source = "dialled"; next.returnTo = "menu";
      } else if (option === 2) {
        next.mode = "phone"; next.source = "manual"; next.returnTo = "menu";
      } else if (option === 3) {
        next.mode = "list"; next.filter = "all";
      } else if (option === 4) {
        next.mode = "list"; next.filter = "missed";
      } else if (option === 5) {
        next.mode = "filter";
      } else if (option === 6) {
        next.mode = "phone"; next.returnTo = "menu";
      } else {
        next.mode = "list";
      }
      return { state: next, effect: { type: "none" }, feedback: "" };
    }

    case "filter": {
      const map: Record<string, CallLogFilter> = { "1": "missed", "2": "outgoing", "3": "incoming", "4": "all" };
      if (map[d]) {
        return { state: { ...base, mode: "list", filter: map[d], pos: 0 }, effect: { type: "none" }, feedback: "" };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 for missed, 2 for outgoing, 3 for incoming, or 4 for all calls. " };
    }

    case "list": {
      if (listLength === 0) {
        return { state: { ...base, mode: "menu", option: 0, pos: 0 }, effect: { type: "none" },
                 feedback: "This list is empty. " };
      }
      if (d === "#") return { state: { ...base, pos: state.pos + 1 }, effect: { type: "none" }, feedback: "" };
      if (d === "9") return { state: { ...base, pos: Math.max(0, state.pos - 1) }, effect: { type: "none" }, feedback: "" };
      if (d === "1") {
        const mode: CallingMode = state.option === 7 ? "contact-menu" : "detail";
        return { state: { ...base, mode }, effect: { type: "none" }, feedback: "" };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 for options, pound for the next item, 9 for the previous item, or star to go back. " };
    }

    case "detail": {
      // 1 = call back (SignalWire only; on Yemot, information only).
      if (d === "1") {
        if (isYemot) {
          return { state: base, effect: { type: "none" },
                   feedback: "This menu cannot place calls. To call this number back, use the calling line. " };
        }
        return { state: { ...base, mode: "list" }, effect: { type: "redial", pos: state.pos },
                 feedback: "Calling this number back. " };
      }
      if (state.option === 4) {
        if (d === "2") return { state: { ...base, mode: "list" }, effect: { type: "markDone", pos: state.pos }, feedback: "" };
        if (d === "3") return { state: { ...base, mode: "confirm-delete" }, effect: { type: "none" }, feedback: "" };
      } else {
        if (d === "2") {
          // Edit this log entry: re-pick the case/project, then the fill form.
          return { state: { ...base, mode: "select-case", pos: 0, editing: true, returnTo: "list" },
                   effect: { type: "none" }, feedback: "" };
        }
        if (d === "3") return { state: { ...base, mode: "confirm-delete" }, effect: { type: "none" }, feedback: "" };
        if (d === "4") return { state: { ...base, mode: "confirm-delete-all" }, effect: { type: "none" }, feedback: "" };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 to 4 for an action, or zero to go back to the list. " };
    }

    case "contact-menu": {
      if (d === "1") {
        return { state: { ...base, mode: "date-choice", fromContact: true, returnTo: "contact-menu", dateRetries: 0 },
                 effect: { type: "none" }, feedback: "" };
      }
      if (d === "2") return { state: { ...base, mode: "confirm-delete" }, effect: { type: "none" }, feedback: "" };
      if (d === "3") return { state: { ...base, mode: "edit-field" }, effect: { type: "none" }, feedback: "" };
      if (d === "4") {
        return { state: base, effect: { type: "toggleDNC", pos: state.pos },
                 feedback: "Do Not Call for this contact has been changed. " };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 to 4 for an action, or zero to go back to the list. " };
    }

    case "edit-field": {
      const map: Record<string, "name" | "address" | "note"> = { "1": "name", "2": "address", "3": "note" };
      if (map[d]) {
        return { state: { ...base, mode: "edit-value", editField: map[d] }, effect: { type: "none" }, feedback: "" };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 for the name, 2 for the address, or 3 to add a note. " };
    }

    case "edit-value": {
      if (d === "1") {
        const field = state.editField || "note";
        return { state: { ...base, mode: "contact-menu", editField: undefined },
                 effect: { type: "saveContactNote", pos: state.pos, field },
                 feedback: "Record your note after the tone. " };
      }
      if (d === "#") {
        return { state: { ...base, mode: "contact-menu", editField: undefined },
                 effect: { type: "none" }, feedback: "No change made. " };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 to record a voice note, or pound to cancel. " };
    }

    case "confirm-delete": {
      if (d === "3") {
        const effect: CallingEffect = state.option === 7
          ? { type: "deleteContact", pos: state.pos }
          : { type: "deleteLog", pos: state.pos };
        return { state: { ...base, mode: "list" }, effect, feedback: "" };
      }
      return { state: { ...base, mode: state.option === 7 ? "contact-menu" : "detail" },
               effect: { type: "none" }, feedback: "Delete cancelled. " };
    }

    case "confirm-delete-all": {
      if (d === "3") {
        return { state: { ...base, mode: "list" }, effect: { type: "deleteAllLog" }, feedback: "" };
      }
      return { state: { ...base, mode: "detail" }, effect: { type: "none" }, feedback: "Delete cancelled. " };
    }

    case "select-case": {
      // No cases/projects/campaigns at all: any digit skips the selection.
      if (listLength === 0) {
        if (d === "1" || d === "2" || d === "8" || d === "#") {
          return { state: advanceAfterCaseChoice({ ...base, casePos: null }), effect: { type: "none" },
                   feedback: "No case, campaign, or project is on your account. Continuing without one. " };
        }
        return { state: base, effect: { type: "none" }, feedback: "Press pound to continue without a case. " };
      }
      if (d === "1") {
        return { state: advanceAfterCaseChoice({ ...base, casePos: state.pos, caseSelected: true }),
                 effect: { type: "none" }, feedback: "" };
      }
      if (d === "#") {
        // Skip: no case is picked for the caller, ever. Editing a report
        // keeps its current case; anything else holds the fill-in on the
        // session until a case is chosen (option 3).
        const feedback = state.editing && state.kind !== "session"
          ? "Keeping the current case. "
          : "Continuing without a case. You can add one later from option 3. ";
        return { state: advanceAfterCaseChoice({ ...base, casePos: null }),
                 effect: { type: "none" }, feedback };
      }
      if (d === "2") {
        if (state.pos + 1 < listLength) return { state: { ...base, pos: state.pos + 1 }, effect: { type: "none" }, feedback: "" };
        return { state: base, effect: { type: "none" }, feedback: "That is the last one. Press 1 to choose it, or pound to skip. " };
      }
      if (d === "8") return { state: { ...base, pos: Math.max(0, state.pos - 1) }, effect: { type: "none" }, feedback: "" };
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 to choose this one, 2 for the next, 8 for the previous, or pound to skip. " };
    }

    case "phone": {
      const terminated = d.endsWith("#");
      const chunk = terminated ? d.slice(0, -1) : d;
      if (!/^\d*$/.test(chunk)) {
        return { state: base, effect: { type: "none" }, feedback: "Please enter digits only. " };
      }
      const accumulated = (state.phoneDigits || "") + chunk;
      if (accumulated.length > 11) {
        if ((state.dateRetries || 0) < 1) {
          return { state: { ...base, phoneDigits: "", dateRetries: 1 }, effect: { type: "none" },
                   feedback: "That number is too long. Please enter the phone number again. " };
        }
        return { state: { ...base, mode: "menu", option: 0, pos: 0, phoneDigits: undefined, dateRetries: 0 },
                 effect: { type: "none" }, feedback: "Phone entry cancelled. Back to the Calling menu. " };
      }
      // Commit on pound, or when a full 11-digit number has been keyed.
      if (terminated || accumulated.length === 11) {
        const phone = normalizeCallingPhone(accumulated);
        if (!phone) {
          if ((state.dateRetries || 0) < 1) {
            return { state: { ...base, phoneDigits: "", dateRetries: 1 }, effect: { type: "none" },
                     feedback: "That is not a valid United States or Canada number. Please try again. " };
          }
          return { state: { ...base, mode: "menu", option: 0, pos: 0, phoneDigits: undefined, dateRetries: 0 },
                   effect: { type: "none" }, feedback: "Phone entry cancelled. Back to the Calling menu. " };
        }
        const next: CallingState = { ...base, phone, phoneDigits: undefined, dateRetries: 0 };
        if (state.option === 1) {
          // Make a call (SignalWire only — Yemot can never reach this
          // mode because option 1 is refused in the menu). Dial now;
          // the fill form follows immediately for the session.
          next.mode = "fill-outcome";
          next.returnTo = "menu";
          return { state: next, effect: { type: "dial", phone, casePos: next.casePos ?? null },
                   feedback: "Calling now. After the call, please fill in the result. " };
        }
        // Options 2 and 6: pick a case/project next (pound skips it).
        next.mode = "select-case"; next.pos = 0; next.returnTo = "phone";
        return { state: next, effect: { type: "none" }, feedback: "" };
      }
      return { state: { ...base, phoneDigits: accumulated }, effect: { type: "none" }, feedback: "" };
    }

    case "fill-outcome": {
      const outcome = CALLING_OUTCOMES[d];
      if (outcome) {
        // Pickup ("said to come pick up") goes to the date entry
        // first: when? what time — today or another day? The date
        // machinery below emits the schedule effect and lands in
        // pickup-address; the amount/method steps do not apply.
        if (outcome === "pickup") {
          return { state: { ...base, fillOutcome: outcome, mode: "date-choice", dateRetries: 0 },
                   effect: { type: "none" }, feedback: "" };
        }
        return { state: { ...base, fillOutcome: outcome, mode: "fill-amount", fillAmountDigits: "" },
                 effect: { type: "none" }, feedback: "" };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 if they gave, 2 for no answer, 3 for callback, 4 for not interested, 5 for Do Not Call, 6 for pickup, 7 if they cannot give, or 8 for a pledge. " };
    }

    case "fill-amount": {
      const terminated = d.endsWith("#");
      const chunk = terminated ? d.slice(0, -1) : d;
      if (!/^\d*$/.test(chunk)) {
        return { state: base, effect: { type: "none" }, feedback: "Please enter digits only. " };
      }
      const accumulated = (state.fillAmountDigits || "") + chunk;
      if (!terminated) {
        if (accumulated.length > 9) {
          return { state: base, effect: { type: "none" }, feedback: "That amount is too large. Please press pound to finish, or star to go back. " };
        }
        return { state: { ...base, fillAmountDigits: accumulated }, effect: { type: "none" }, feedback: "" };
      }
      // Pound commits: empty = skip the amount ("I don't know yet" for
      // a gift; no pledge amount for a pledge).
      if (accumulated === "") {
        return { state: afterAmountStep({ ...base }, null),
                 effect: { type: "none" }, feedback: "" };
      }
      const amount = Number(accumulated);
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999) {
        if ((state.dateRetries || 0) < 1) {
          return { state: { ...base, fillAmountDigits: "", dateRetries: 1 }, effect: { type: "none" },
                   feedback: "That amount is not valid. Please try again. " };
        }
        return { state: afterAmountStep({ ...base, dateRetries: 0 }, null),
                 effect: { type: "none" }, feedback: "Amount skipped. " };
      }
      return { state: afterAmountStep({ ...base }, amount),
               effect: { type: "none" }, feedback: "" };
    }

    case "fill-method": {
      const method = CALLING_PAYMENT_METHODS[d] as CallingPaymentMethod | undefined;
      if (method) {
        return { state: { ...base, fillMethod: method, mode: "fill-note" },
                 effect: { type: "none" }, feedback: "" };
      }
      if (d === "#") {
        return { state: { ...base, fillMethod: null, mode: "fill-note" },
                 effect: { type: "none" }, feedback: "" };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 for credit card, 2 for cash, 3 for check, 4 for a tzedakah card, or 5 for a voucher. Press pound to skip. " };
    }

    case "fill-paid": {
      if (d === "1") {
        // Paid in full: the pledge amount is the paid amount; ask how?
        return { state: { ...base, fillPaid: "full", mode: "fill-method" },
                 effect: { type: "none" }, feedback: "" };
      }
      if (d === "2") {
        return { state: { ...base, fillPaid: "part", mode: "fill-paid-amount", fillPaidAmountDigits: "" },
                 effect: { type: "none" }, feedback: "" };
      }
      if (d === "3" || d === "#") {
        return { state: { ...base, fillPaid: "none", mode: "fill-note" },
                 effect: { type: "none" }, feedback: "" };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 if it was paid in full, 2 if part of it was paid, or 3 if it has not been paid yet. " };
    }

    case "fill-paid-amount": {
      const terminated = d.endsWith("#");
      const chunk = terminated ? d.slice(0, -1) : d;
      if (!/^\d*$/.test(chunk)) {
        return { state: base, effect: { type: "none" }, feedback: "Please enter digits only. " };
      }
      const accumulated = (state.fillPaidAmountDigits || "") + chunk;
      if (!terminated) {
        if (accumulated.length > 9) {
          return { state: base, effect: { type: "none" }, feedback: "That amount is too large. Please press pound to finish, or star to go back. " };
        }
        return { state: { ...base, fillPaidAmountDigits: accumulated }, effect: { type: "none" }, feedback: "" };
      }
      if (accumulated === "") {
        // No paid amount entered: treat as not paid yet.
        return { state: { ...base, fillPaid: "none", fillPaidAmountDigits: undefined, mode: "fill-note" },
                 effect: { type: "none" }, feedback: "" };
      }
      const paid = Number(accumulated);
      if (!Number.isSafeInteger(paid) || paid < 0 || paid > 999999999) {
        if ((state.dateRetries || 0) < 1) {
          return { state: { ...base, fillPaidAmountDigits: "", dateRetries: 1 }, effect: { type: "none" },
                   feedback: "That amount is not valid. Please try again. " };
        }
        return { state: { ...base, fillPaid: "none", fillPaidAmountDigits: undefined, mode: "fill-note", dateRetries: 0 },
                 effect: { type: "none" }, feedback: "Paid amount skipped. " };
      }
      // The paid amount becomes the report amount; the pledge amount
      // stays in fillPledgeAmount (buildDraft keeps both).
      return { state: { ...base, fillAmount: paid, fillPaidAmountDigits: undefined, mode: "fill-method", dateRetries: 0 },
               effect: { type: "none" }, feedback: "" };
    }

    case "pickup-address": {
      if (d === "1") {
        return { state: base, effect: { type: "savePickupAddress" },
                 feedback: "Record the pickup address after the tone. " };
      }
      if (d === "#") {
        return { state: { ...base, mode: "fill-note" }, effect: { type: "none" },
                 feedback: "Address skipped. " };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 to record the pickup address, or pound to skip it. " };
    }

    case "fill-note": {
      if (d === "#") {
        return { state: { ...base, fillNote: null, mode: "fill-mood" }, effect: { type: "none" }, feedback: "" };
      }
      if (d === "1") {
        return { state: base, effect: { type: "recordNote" },
                 feedback: "Record your note after the tone. " };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 to record a voice note, or pound to skip the note. " };
    }

    case "fill-mood": {
      const mood = CALLING_MOODS[d];
      if (mood || d === "#") {
        const filled: CallingState = { ...base, fillMood: mood ?? null };
        const report = buildDraft(filled);
        if (state.editing) {
          // Editing a session with no case chosen yet: the fill-in stays
          // on the session and the report is created once a case is
          // chosen (engine: upsertCallReport). Editing a report with no
          // case chosen keeps its current case.
          const noCaseYet = state.casePos === null && state.kind === "session";
          return { state: { ...clearFill(filled), mode: "list" },
                   effect: { type: "updateReport", pos: state.pos, report },
                   feedback: noCaseYet
                     ? "Call information saved on the call. No case was chosen yet. You can add one later from option 3. "
                     : "Call information updated. " };
        }
        return { state: { ...clearFill(filled), mode: "menu", option: 0, pos: 0 },
                 effect: { type: "saveReport", report },
                 feedback: report.casePos === null
                   ? "Call result saved without a case. You can add a case later from option 3, update call information. "
                   : "Call result saved. " };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 for good, 2 for neutral, 3 for not good, or pound to skip. " };
    }

    case "date-choice": {
      if (d === "1") return { state: { ...base, mode: "date-day", dateKind: "jewish", dateRetries: 0 }, effect: { type: "none" }, feedback: "" };
      if (d === "2") return { state: { ...base, mode: "date-day", dateKind: "numeric", dateRetries: 0 }, effect: { type: "none" }, feedback: "" };
      return { state: base, effect: { type: "none" }, feedback: "Press 1 for a Jewish date, or 2 for numbers. " };
    }

    case "date-day": case "date-month": case "date-year": case "date-hour": case "date-minute": {
      // Numeric order is month -> day; Jewish order is day -> month.
      // The machine stores both in dateDay/dateMonth regardless of the
      // order they were asked, so resolveScheduledDate sees the same shape.
      const value = parseDateDigits(d);
      const jewish = state.dateKind === "jewish";
      const isDayStep = state.mode === "date-day";
      const isMonthStep = state.mode === "date-month";
      const maxDay = jewish ? 30 : 31;
      const maxMonth = jewish ? 13 : 12;
      // In the numeric flow the "date-day" step asks for the MONTH first.
      const askingMonthFirst = !jewish && isDayStep;
      const askingDaySecond = !jewish && isMonthStep;
      let valid = false;
      if (value !== null) {
        if (state.mode === "date-day") valid = askingMonthFirst ? (value >= 1 && value <= 12) : (value >= 1 && value <= maxDay);
        else if (state.mode === "date-month") valid = askingDaySecond ? (value >= 1 && value <= 31) : (value >= 1 && value <= maxMonth);
        else if (state.mode === "date-year") valid = jewish ? (value >= 5700 && value <= 5900) : (value >= 2000 && value <= 2100);
        else if (state.mode === "date-hour") valid = value >= 0 && value <= 23;
        else if (state.mode === "date-minute") valid = value >= 0 && value <= 59;
      }
      // "#" alone in date-year = current year.
      if (state.mode === "date-year" && d === "#") {
        return { state: { ...base, dateYear: null, mode: "date-hour" }, effect: { type: "none" }, feedback: "" };
      }
      // A null value (no digits at all) is invalid too; narrowing value
      // to number here lets the assignments below typecheck.
      if (value === null || !valid) {
        // One re-prompt, then cancel the date entry.
        if ((state.dateRetries || 0) < 1) {
          return { state: { ...base, dateRetries: 1 }, effect: { type: "none" },
                   feedback: "That number is not valid. Please try again. " };
        }
        const back = callingBackOneLevel({ ...base, mode: "date-choice" });
        return { state: back ?? { ...base, mode: "menu", option: 0, pos: 0 },
                 effect: { type: "none" }, feedback: "Date entry cancelled. " };
      }
      const next = { ...base, dateRetries: 0 };
      if (state.mode === "date-day") {
        if (askingMonthFirst) { next.dateMonth = value; } else { next.dateDay = value; }
        next.mode = "date-month";
      } else if (state.mode === "date-month") {
        if (askingDaySecond) { next.dateDay = value; } else { next.dateMonth = value; }
        next.mode = "date-year";
      } else if (state.mode === "date-year") {
        next.dateYear = value; next.mode = "date-hour";
      } else if (state.mode === "date-hour") {
        next.dateHour = value; next.mode = "date-minute";
      } else {
        // Minute entered: resolve the full date/time.
        const at = resolveScheduledDate(now, timeZone, jewish ? "jewish" : "numeric",
          state.dateDay || 1, state.dateMonth || 1, state.dateYear ?? null, state.dateHour || 0, value);
        if (!at) {
          // A date that can never occur, or an explicitly entered year in
          // the past: re-enter the day (Jewish) or month (numeric) once,
          // then cancel.
          if ((state.dateRetries || 0) < 1) {
            return { state: { ...base, mode: "date-day", dateRetries: 1 },
                     effect: { type: "none" },
                     feedback: "That date does not exist. Please enter it again. " };
          }
          const back = callingBackOneLevel({ ...base, mode: "date-choice" });
          return { state: back ?? { ...base, mode: "menu", option: 0, pos: 0 },
                   effect: { type: "none" }, feedback: "Date entry cancelled. " };
        }
        let feedback = "Scheduled for " + formatSpokenDateTime(at, timeZone) + ". ";
        if (jewish) {
          const gp = tzParts(at, timeZone);
          const parsha = parshaForGregorianDate(gp.year, gp.month, gp.day);
          if (parsha) feedback += "This week's Parsha is " + parsha + ". ";
          const heb = hebrewFromFixed(fixedFromGregorian(gp.year, gp.month, gp.day));
          feedback += "That is " + heb.day + " of " + hebrewMonthName(heb.year, heb.month) + ", " + heb.year + ". ";
        }
        feedback += "It will appear on your Tishl as a reminder. ";
        // Pickup flow: the scheduled pickup surfaces on Tishl (the
        // schedule effect below), then the caller gives the address
        // (voice note -> contact). The fill form continues afterwards
        // and saveReport carries outcome "pickup" + fillPickupAt.
        if (state.fillOutcome === "pickup") {
          const pickup: CallingState = {
            ...next, mode: "pickup-address",
            fillPickupAt: at.toISOString(),
            dateKind: undefined, dateDay: undefined, dateMonth: undefined,
            dateYear: undefined, dateHour: undefined, dateRetries: 0,
          };
          return { state: pickup,
                   effect: { type: "schedule", at, phone: state.phone ?? null,
                             contactPos: null,
                             casePos: state.casePos ?? null, note: "Pickup" },
                   feedback: feedback + "Now the pickup address. " };
        }
        const done: CallingState = {
          ...next, mode: state.fromContact ? "contact-menu" : "menu",
          option: state.fromContact ? state.option : 0, pos: state.fromContact ? state.pos : 0,
          dateKind: undefined, dateDay: undefined, dateMonth: undefined,
          dateYear: undefined, dateHour: undefined, dateRetries: 0,
        };
        return { state: done,
                 effect: { type: "schedule", at, phone: state.phone ?? null,
                           contactPos: state.fromContact ? state.pos : null,
                           casePos: state.casePos ?? null, note: state.fillNote ?? null },
                 feedback };
      }
      return { state: next, effect: { type: "none" }, feedback: "" };
    }

    default: {
      return { state: { ...base, mode: "menu", option: 0, pos: 0 }, effect: { type: "none" }, feedback: "" };
    }
  }
}

/** Where select-case goes next, by option. */
function advanceAfterCaseChoice(state: CallingState): CallingState {
  const next: CallingState = { ...state, pos: 0 };
  if (state.option === 1) {
    next.mode = "phone"; next.returnTo = "select-case";
  } else if (state.option === 2) {
    next.mode = "fill-outcome"; next.returnTo = "menu";
    next.fillOutcome = undefined; next.fillAmount = undefined;
    next.fillAmountDigits = undefined; next.fillNote = undefined; next.fillMood = undefined;
  } else if (state.option === 6) {
    next.mode = "date-choice"; next.returnTo = "menu"; next.dateRetries = 0;
  } else if (state.editing) {
    // Editing a log entry (option 3): case re-picked (or skipped: keep
    // the current case for a report, no case yet for a session), then
    // the fill form. The engine upserts the report from the stored
    // session fill-in when a case is chosen (upsertCallReport).
    next.mode = "fill-outcome"; next.returnTo = "list";
    next.fillOutcome = undefined; next.fillAmount = undefined;
    next.fillAmountDigits = undefined; next.fillNote = undefined; next.fillMood = undefined;
  } else {
    next.mode = "menu"; next.option = 0;
  }
  return next;
}
