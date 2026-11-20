import test from "node:test";
import assert from "node:assert/strict";
import {
  CALLING_TZ, newCallingState, parseCallingFlash, encodeCallingFlash,
  callingBackOneLevel, handleCallingDigit, clampCallingPosAfterRemoval,
  resolveScheduledDate, normalizeCallingPhone, attachCallingNote,
  callingMenuSpeech, filterMenuSpeech, describeCallingItem, detailMenuSpeech,
  contactMenuSpeech, editFieldSpeech, editValueSpeech, selectCaseSpeech,
  phoneEntrySpeech, fillOutcomeSpeech, fillAmountSpeech, fillNoteSpeech,
  fillMoodSpeech, fillMethodSpeech, fillPaidSpeech, fillPaidAmountSpeech,
  pickupAddressSpeech, advanceAfterPickupAddress, dateChoiceSpeech, dateYearSpeech,
  callingHebrewMonthChoicesSpeech, buildVoiceNoteText,
} from "../src/lib/calling-phone.ts";
import type { CallingState, CallingContext, CallingItemView } from "../src/lib/calling-phone.ts";

const TZ = CALLING_TZ;
const NOW = new Date("2026-11-19T15:00:00-05:00"); // Thursday, 3 PM New York

const SW: CallingContext = { provider: "signalwire", option: 0, listLength: 0 };
const YEMOT: CallingContext = { provider: "yemot", option: 0, listLength: 0 };
const ctx = (provider: "yemot" | "signalwire", option: number, listLength: number): CallingContext =>
  ({ provider, option, listLength });

const logItems: CallingItemView[] = [
  { kind: "session", id: 9, title: "Call to +17185551234", detail: "completed", phone: "+17185551234", created_at: "2026-11-19T10:00:00Z" },
  { kind: "missed", id: 2, title: "Missed call from +12125550199", detail: "missed", phone: "+12125550199", created_at: "2026-11-18T10:00:00Z" },
  { kind: "report", id: 4, title: "Call report: Cohen", detail: "spoke $250", phone: null, created_at: "2026-11-17T10:00:00Z" },
];

function menu(): CallingState {
  return { mode: "menu", option: 0, pos: 0, kind: null, id: null };
}

function run(state: CallingState, digits: string[], c: CallingContext, now = NOW): { state: CallingState; last: ReturnType<typeof handleCallingDigit> } {
  let cur = state;
  let last: ReturnType<typeof handleCallingDigit> | null = null;
  for (const d of digits) {
    last = handleCallingDigit(cur, d, c, now, TZ);
    cur = last.state;
  }
  return { state: cur, last: last! };
}

// --- flash round trip -------------------------------------------------------
test("parse/encode Calling flash round-trips; bad JSON returns null", () => {
  const st: CallingState = {
    mode: "date-month", option: 6, pos: 0, kind: null, id: null,
    dateKind: "jewish", dateDay: 9, dateYear: null, phone: "+17185551234",
  };
  assert.deepEqual(parseCallingFlash(encodeCallingFlash(st)), st);
  assert.equal(parseCallingFlash(null), null);
  assert.equal(parseCallingFlash(""), null);
  assert.equal(parseCallingFlash("not json"), null);
  assert.equal(parseCallingFlash(JSON.stringify({ tishl: { mode: "listen", pos: 0 } })), null);
  assert.deepEqual(parseCallingFlash(JSON.stringify({ calling: { mode: "menu", pos: 0, option: 0 } })),
    { mode: "menu", pos: 0, option: 0, kind: null, id: null });
  assert.deepEqual(newCallingState(), { mode: "menu", option: 0, pos: 0, kind: null, id: null });
});

// --- menu: the provider gate ------------------------------------------------
test("menu: SignalWire lists option 1; Yemot does not, and refuses it", () => {
  assert.ok(callingMenuSpeech("signalwire").includes("Press 1 to make a call"));
  assert.ok(!callingMenuSpeech("yemot").includes("Press 1 to make a call"));
  assert.ok(callingMenuSpeech("yemot").includes("Press 2 to log a call"));
  assert.ok(callingMenuSpeech("yemot").includes("Press 6 to schedule a call"));
  const r = handleCallingDigit(menu(), "1", YEMOT, NOW, TZ);
  assert.equal(r.state.mode, "menu");
  assert.equal(r.effect.type, "none");
  assert.ok(r.feedback.includes("only on the calling line"));
  const s = handleCallingDigit(menu(), "1", SW, NOW, TZ);
  assert.equal(s.state.mode, "select-case");
  assert.equal(s.state.option, 1);
  assert.equal(s.effect.type, "none");
});
test("menu: 2-7 route to their flows; 0 and * leave; junk re-prompts", () => {
  assert.equal(handleCallingDigit(menu(), "2", SW, NOW, TZ).state.mode, "phone");
  assert.equal(handleCallingDigit(menu(), "3", SW, NOW, TZ).state.mode, "list");
  assert.equal(handleCallingDigit(menu(), "4", SW, NOW, TZ).state.mode, "list");
  assert.equal(handleCallingDigit(menu(), "5", SW, NOW, TZ).state.mode, "filter");
  assert.equal(handleCallingDigit(menu(), "6", SW, NOW, TZ).state.mode, "phone");
  assert.equal(handleCallingDigit(menu(), "7", SW, NOW, TZ).state.mode, "list");
  assert.equal(handleCallingDigit(menu(), "4", SW, NOW, TZ).state.option, 4);
  assert.equal(handleCallingDigit(menu(), "*", SW, NOW, TZ).effect.type, "leave");
  assert.equal(handleCallingDigit(menu(), "0", SW, NOW, TZ).effect.type, "leave");
  const junk = handleCallingDigit(menu(), "8", SW, NOW, TZ);
  assert.equal(junk.state.mode, "menu");
  assert.ok(junk.feedback.includes("Press 1 to 7"));
});

// --- phone normalization ------------------------------------------------------
test("normalizeCallingPhone accepts 10 or 11 digits, rejects the rest", () => {
  assert.equal(normalizeCallingPhone("7185551234"), "+17185551234");
  assert.equal(normalizeCallingPhone("17185551234"), "+17185551234");
  assert.equal(normalizeCallingPhone("+1 (718) 555-1234"), "+17185551234");
  assert.equal(normalizeCallingPhone("718555123"), null);
  assert.equal(normalizeCallingPhone("171855512345"), null);
  assert.equal(normalizeCallingPhone("0185551234"), null); // bad area code
  assert.equal(normalizeCallingPhone("7181551234"), null); // bad exchange
  assert.equal(normalizeCallingPhone(""), null);
});

// --- resolveScheduledDate -----------------------------------------------------
test("resolveScheduledDate (numeric): # = this year, past time rolls to next year", () => {
  const a = resolveScheduledDate(NOW, TZ, "numeric", 2, 12, null, 15, 30);
  assert.ok(a && a.toISOString() === "2026-12-02T20:30:00.000Z");
  const b = resolveScheduledDate(NOW, TZ, "numeric", 15, 1, 2027, 10, 0);
  assert.ok(b && b.toISOString() === "2027-01-15T15:00:00.000Z");
  // 19 November 10:00 already passed this year -> next year.
  const c = resolveScheduledDate(NOW, TZ, "numeric", 19, 11, null, 10, 0);
  assert.ok(c && c.toISOString() === "2027-11-19T15:00:00.000Z");
});
test("resolveScheduledDate (numeric): Feb 29 goes to the next leap year; Apr 31 is null", () => {
  const leap = resolveScheduledDate(NOW, TZ, "numeric", 29, 2, null, 10, 0);
  assert.ok(leap && leap.toISOString() === "2028-02-29T15:00:00.000Z");
  assert.equal(resolveScheduledDate(NOW, TZ, "numeric", 29, 2, 2027, 10, 0), null);
  assert.equal(resolveScheduledDate(NOW, TZ, "numeric", 31, 4, null, 10, 0), null);
  assert.equal(resolveScheduledDate(NOW, TZ, "numeric", 15, 13, null, 10, 0), null);
  assert.equal(resolveScheduledDate(NOW, TZ, "numeric", 15, 1, 1999, 10, 0), null); // year out of range
  assert.equal(resolveScheduledDate(NOW, TZ, "numeric", 15, 1, 2026, 24, 0), null);
});
test("resolveScheduledDate (Jewish): 15 Nisan # -> 2027-04-22; 1 Tishrei 5788 -> 2027-10-02", () => {
  const a = resolveScheduledDate(NOW, TZ, "jewish", 15, 8, null, 10, 0);
  assert.ok(a && a.toISOString() === "2027-04-22T14:00:00.000Z");
  const b = resolveScheduledDate(NOW, TZ, "jewish", 1, 1, 5788, 9, 0);
  assert.ok(b && b.toISOString() === "2027-10-02T13:00:00.000Z");
});
test("resolveScheduledDate (Jewish): explicitly past year is null; Adar II in a common year is null", () => {
  assert.equal(resolveScheduledDate(NOW, TZ, "jewish", 1, 1, 5787, 9, 0), null); // 2026-09-12 is past
  assert.equal(resolveScheduledDate(NOW, TZ, "jewish", 14, 7, 5786, 10, 0), null); // no Adar II in 5786
  assert.equal(resolveScheduledDate(NOW, TZ, "jewish", 31, 1, null, 10, 0), null);
  assert.equal(resolveScheduledDate(NOW, TZ, "jewish", 15, 14, null, 10, 0), null);
  assert.equal(resolveScheduledDate(NOW, TZ, "jewish", 15, 8, 5699, 10, 0), null); // year out of range
});

// --- speech helpers -----------------------------------------------------------
test("speech helpers name the options and the item", () => {
  assert.ok(filterMenuSpeech().includes("Press 1 for missed"));
  assert.ok(detailMenuSpeech(4, logItems[1], "signalwire").includes("mark this missed call done"));
  assert.ok(detailMenuSpeech(5, logItems[0], "signalwire").includes("call this number back"));
  assert.ok(!detailMenuSpeech(5, logItems[0], "yemot").includes("call this number back"));
  assert.ok(contactMenuSpeech(logItems[0]).includes("schedule a call"));
  assert.ok(editFieldSpeech().includes("Press 1 for the name"));
  assert.ok(editValueSpeech("name").includes("cannot be typed on the keypad"));
  assert.ok(selectCaseSpeech().includes("pound to skip"));
  assert.ok(phoneEntrySpeech().includes("Enter the phone number"));
  assert.ok(fillOutcomeSpeech().includes("Press 1 if they gave"));
  assert.ok(fillOutcomeSpeech().includes("Press 6 if they said to come pick it up"));
  assert.ok(fillOutcomeSpeech().includes("Press 7 if they did not or cannot give"));
  assert.ok(fillOutcomeSpeech().includes("Press 8 for a pledge"));
  assert.ok(fillMethodSpeech().includes("Press 1 for credit card"));
  assert.ok(fillMethodSpeech().includes("5 for a voucher"));
  assert.ok(fillPaidSpeech().includes("Press 1 if it was paid in full"));
  assert.ok(fillPaidSpeech().includes("Press 2 if part of it was paid"));
  assert.ok(fillPaidAmountSpeech().includes("Enter the amount that was paid"));
  assert.ok(pickupAddressSpeech().includes("press 1 to record a voice note"));
  assert.ok(fillAmountSpeech().includes("Enter the amount"));
  assert.ok(fillNoteSpeech().includes("record a voice note"));
  assert.ok(fillMoodSpeech().includes("Press 1 for good"));
  assert.ok(dateChoiceSpeech().includes("Press 1 for a Jewish date"));
  assert.ok(dateYearSpeech("jewish").includes("Hebrew year"));
  assert.ok(dateYearSpeech("numeric").includes("Enter the year"));
  const s = describeCallingItem(logItems[1], 1, 3);
  assert.ok(s.startsWith("Item 2 of 3. Missed call: Missed call from +12125550199."));
  assert.ok(s.includes("Number 1 2 1 2 5 5 5 0 1 9 9."));
  assert.ok(callingHebrewMonthChoicesSpeech(5787).includes("7, Adar II"));
  assert.ok(buildVoiceNoteText("ivr2:/x.wav", "2026-11-19T20:00:00.000Z").includes("ivr2:/x.wav"));
});

// --- option 2: log a call from another phone ----------------------------------
test("option 2: phone -> skip case -> fill form -> saveReport (manual)", () => {
  let st = handleCallingDigit(menu(), "2", SW, NOW, TZ).state;
  assert.equal(st.mode, "phone");
  let r = handleCallingDigit(st, "17185551234#", ctx("signalwire", 2, 0), NOW, TZ);
  assert.equal(r.state.mode, "select-case");
  assert.equal(r.state.phone, "+17185551234");
  r = handleCallingDigit(r.state, "#", ctx("signalwire", 2, 3), NOW, TZ); // skip the case
  assert.equal(r.state.mode, "fill-outcome");
  assert.equal(r.state.casePos, null);
  r = handleCallingDigit(r.state, "1", ctx("signalwire", 2, 3), NOW, TZ); // given
  assert.equal(r.state.mode, "fill-amount");
  r = handleCallingDigit(r.state, "250#", ctx("signalwire", 2, 3), NOW, TZ);
  assert.equal(r.state.fillAmount, 250);
  assert.equal(r.state.mode, "fill-method"); // given asks how? (method label)
  r = handleCallingDigit(r.state, "#", ctx("signalwire", 2, 3), NOW, TZ); // skip method
  assert.equal(r.state.mode, "fill-note");
  r = handleCallingDigit(r.state, "#", ctx("signalwire", 2, 3), NOW, TZ); // skip note
  assert.equal(r.state.mode, "fill-mood");
  r = handleCallingDigit(r.state, "2", ctx("signalwire", 2, 3), NOW, TZ); // neutral
  assert.equal(r.effect.type, "saveReport");
  assert.equal(r.state.mode, "menu");
  assert.ok(r.feedback.includes("Call result saved"));
  if (r.effect.type === "saveReport") {
    assert.deepEqual(r.effect.report, {
      outcome: "given", amount: 250, note: null, mood: "neutral",
      phone: "+17185551234", casePos: null, source: "manual",
      moneyKind: "received", paymentMethod: null, pledgeAmount: null, pickupAt: null,
    });
  }
});
test("option 2: phone entry accumulates one digit at a time; invalid re-prompts once, then cancels", () => {
  let st = handleCallingDigit(menu(), "2", SW, NOW, TZ).state;
  let r = handleCallingDigit(st, "7", ctx("signalwire", 2, 0), NOW, TZ);
  assert.equal(r.state.phoneDigits, "7");
  r = handleCallingDigit(r.state, "185551234#", ctx("signalwire", 2, 0), NOW, TZ);
  assert.equal(r.state.phone, "+17185551234");
  assert.equal(r.state.mode, "select-case");

  st = handleCallingDigit(menu(), "2", SW, NOW, TZ).state;
  r = handleCallingDigit(st, "123#", ctx("signalwire", 2, 0), NOW, TZ); // too short
  assert.equal(r.state.mode, "phone");
  assert.equal(r.state.dateRetries, 1);
  assert.ok(r.feedback.includes("not a valid"));
  r = handleCallingDigit(r.state, "456#", ctx("signalwire", 2, 0), NOW, TZ);
  assert.equal(r.state.mode, "menu");
  assert.ok(r.feedback.includes("Phone entry cancelled"));
});
test("fill form: voice note attaches and advances; amount skipped with bare pound", () => {
  let st: CallingState = { mode: "fill-note", option: 2, pos: 0, kind: null, id: null, fillOutcome: "given", phone: "+17185551234", source: "manual" };
  let r = handleCallingDigit(st, "1", ctx("signalwire", 2, 0), NOW, TZ);
  assert.equal(r.effect.type, "recordNote");
  assert.equal(r.state.mode, "fill-note");
  const advanced = attachCallingNote(r.state, buildVoiceNoteText("ivr2:/n.wav", "2026-11-19T20:00:00.000Z"));
  assert.equal(advanced.mode, "fill-mood");
  assert.ok((advanced.fillNote || "").includes("ivr2:/n.wav"));
  assert.equal(attachCallingNote({ ...st, mode: "fill-mood" }, "x").mode, "fill-mood"); // no-op outside fill-note

  st = { mode: "fill-amount", option: 2, pos: 0, kind: null, id: null, fillOutcome: "callback", phone: "+17185551234", source: "manual", fillAmountDigits: "" };
  r = handleCallingDigit(st, "#", ctx("signalwire", 2, 0), NOW, TZ); // skip amount
  assert.equal(r.state.fillAmount, null);
  assert.equal(r.state.mode, "fill-note");
});

// --- option 1: make a call (SignalWire only) ----------------------------------
test("option 1 (SignalWire): select case -> phone -> dial -> fill form -> saveReport (dialled)", () => {
  const c3 = ctx("signalwire", 1, 3);
  let st = handleCallingDigit(menu(), "1", SW, NOW, TZ).state;
  let r = handleCallingDigit(st, "1", c3, NOW, TZ); // choose case at pos 0
  assert.equal(r.state.casePos, 0);
  assert.equal(r.state.mode, "phone");
  r = handleCallingDigit(r.state, "7185551234#", c3, NOW, TZ);
  assert.equal(r.effect.type, "dial");
  assert.equal(r.state.mode, "fill-outcome");
  if (r.effect.type === "dial") {
    assert.equal(r.effect.phone, "+17185551234");
    assert.equal(r.effect.casePos, 0);
  }
  const { state, last } = run(r.state, ["3", "100#", "#", "#"], c3); // callback, $100, skip note, skip mood
  assert.equal(last.effect.type, "saveReport");
  assert.equal(state.mode, "menu");
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.outcome, "callback");
    assert.equal(last.effect.report.amount, 100);
    assert.equal(last.effect.report.mood, null);
    assert.equal(last.effect.report.source, "dialled");
    assert.equal(last.effect.report.casePos, 0);
  }
});
test("option 1: Yemot never emits dial — the menu refuses option 1 outright", () => {
  const r = handleCallingDigit(menu(), "1", YEMOT, NOW, TZ);
  assert.equal(r.effect.type, "none");
  assert.notEqual(r.effect.type, "dial");
  assert.notEqual(r.effect.type, "redial");
});

// --- option 5: call log + filter; option 4: missed calls -----------------------
test("option 5: filter menu routes to the right list filter", () => {
  let st = handleCallingDigit(menu(), "5", SW, NOW, TZ).state;
  assert.equal(st.mode, "filter");
  let r = handleCallingDigit(st, "1", ctx("signalwire", 5, 0), NOW, TZ);
  assert.equal(r.state.mode, "list"); assert.equal(r.state.filter, "missed");
  r = handleCallingDigit({ ...st }, "2", ctx("signalwire", 5, 0), NOW, TZ);
  assert.equal(r.state.filter, "outgoing");
  r = handleCallingDigit({ ...st }, "3", ctx("signalwire", 5, 0), NOW, TZ);
  assert.equal(r.state.filter, "incoming");
  r = handleCallingDigit({ ...st }, "4", ctx("signalwire", 5, 0), NOW, TZ);
  assert.equal(r.state.filter, "all");
  r = handleCallingDigit({ ...st }, "9", ctx("signalwire", 5, 0), NOW, TZ);
  assert.equal(r.state.mode, "filter");
  assert.ok(r.feedback.includes("Press 1 for missed"));
});
test("list navigation: # next, 9 previous, 1 detail, past the end restarts, empty list returns to menu", () => {
  const c = ctx("signalwire", 5, 3);
  let st: CallingState = { mode: "list", option: 5, pos: 0, kind: null, id: null, filter: "all" };
  let r = handleCallingDigit(st, "#", c, NOW, TZ);
  assert.equal(r.state.pos, 1);
  r = handleCallingDigit(r.state, "9", c, NOW, TZ);
  assert.equal(r.state.pos, 0);
  r = handleCallingDigit(r.state, "1", c, NOW, TZ);
  assert.equal(r.state.mode, "detail");
  r = handleCallingDigit({ ...st, pos: 3 }, "#", c, NOW, TZ); // past the end
  assert.equal(r.state.pos, 0);
  r = handleCallingDigit({ ...st, pos: 3 }, "9", c, NOW, TZ);
  assert.equal(r.state.pos, 2);
  const empty = handleCallingDigit(st, "#", ctx("signalwire", 5, 0), NOW, TZ);
  assert.equal(empty.state.mode, "menu");
  assert.ok(empty.feedback.includes("empty"));
});
test("detail (missed, option 4): 2 = mark done; 1 = redial on SignalWire only", () => {
  const detail: CallingState = { mode: "detail", option: 4, pos: 1, kind: "missed", id: 2 };
  let r = handleCallingDigit(detail, "2", ctx("signalwire", 4, 3), NOW, TZ);
  assert.equal(r.effect.type, "markDone");
  if (r.effect.type === "markDone") assert.equal(r.effect.pos, 1);
  assert.equal(r.state.mode, "list");
  r = handleCallingDigit(detail, "1", ctx("signalwire", 4, 3), NOW, TZ);
  assert.equal(r.effect.type, "redial");
  if (r.effect.type === "redial") assert.equal(r.effect.pos, 1);
  const yemot = handleCallingDigit(detail, "1", ctx("yemot", 4, 3), NOW, TZ);
  assert.equal(yemot.effect.type, "none"); // Yemot never dials
  assert.ok(yemot.feedback.includes("cannot place calls"));
});
test("detail (log, option 5): delete needs 3 twice; anything else cancels; 4 = delete all", () => {
  const detail: CallingState = { mode: "detail", option: 5, pos: 0, kind: "session", id: 9 };
  const c = ctx("signalwire", 5, 3);
  let r = handleCallingDigit(detail, "3", c, NOW, TZ);
  assert.equal(r.state.mode, "confirm-delete");
  r = handleCallingDigit(r.state, "3", c, NOW, TZ);
  assert.equal(r.effect.type, "deleteLog");
  if (r.effect.type === "deleteLog") assert.equal(r.effect.pos, 0);
  assert.equal(r.state.mode, "list");
  r = handleCallingDigit({ mode: "confirm-delete", option: 5, pos: 0, kind: "session", id: 9 }, "2", c, NOW, TZ);
  assert.equal(r.effect.type, "none");
  assert.equal(r.state.mode, "detail");
  assert.ok(r.feedback.includes("Delete cancelled"));
  r = handleCallingDigit(detail, "4", c, NOW, TZ);
  assert.equal(r.state.mode, "confirm-delete-all");
  r = handleCallingDigit(r.state, "3", c, NOW, TZ);
  assert.equal(r.effect.type, "deleteAllLog");
  assert.equal(r.state.mode, "list");
});

// --- option 3: update / edit call info -----------------------------------------
test("option 3: detail -> edit -> skip case -> fill form -> updateReport", () => {
  const c = ctx("signalwire", 3, 3);
  let st: CallingState = { mode: "list", option: 3, pos: 0, kind: "session", id: 9, filter: "all" };
  let r = handleCallingDigit(st, "1", c, NOW, TZ);
  assert.equal(r.state.mode, "detail");
  r = handleCallingDigit(r.state, "2", c, NOW, TZ); // edit
  assert.equal(r.state.mode, "select-case");
  assert.equal(r.state.editing, true);
  r = handleCallingDigit(r.state, "#", c, NOW, TZ); // keep the current case
  assert.equal(r.state.mode, "fill-outcome");
  assert.equal(r.state.casePos, null);
  const { last } = run(r.state, ["1", "50#", "#", "#", "1"], c); // given, $50, skip method, skip note, good
  assert.equal(last.effect.type, "updateReport");
  if (last.effect.type === "updateReport") {
    assert.equal(last.effect.pos, 0);
    assert.equal(last.effect.report.outcome, "given");
    assert.equal(last.effect.report.amount, 50);
    assert.equal(last.effect.report.mood, "positive");
  }
});

// --- option 6: schedule a call --------------------------------------------------
test("option 6 (numeric): phone -> skip case -> month/day/year/hour/minute -> schedule", () => {
  const c = ctx("signalwire", 6, 3);
  let st = handleCallingDigit(menu(), "6", SW, NOW, TZ).state;
  let r = handleCallingDigit(st, "17185551234#", ctx("signalwire", 6, 0), NOW, TZ);
  assert.equal(r.state.mode, "select-case");
  r = handleCallingDigit(r.state, "#", c, NOW, TZ);
  assert.equal(r.state.mode, "date-choice");
  r = handleCallingDigit(r.state, "2", c, NOW, TZ); // numeric
  assert.equal(r.state.mode, "date-day");
  assert.equal(r.state.dateKind, "numeric");
  r = handleCallingDigit(r.state, "12", c, NOW, TZ); // month first for numeric
  assert.equal(r.state.dateMonth, 12);
  r = handleCallingDigit(r.state, "2", c, NOW, TZ); // day
  assert.equal(r.state.dateDay, 2);
  r = handleCallingDigit(r.state, "#", c, NOW, TZ); // # = this year
  assert.equal(r.state.dateYear, null);
  assert.equal(r.state.mode, "date-hour");
  r = handleCallingDigit(r.state, "15", c, NOW, TZ);
  assert.equal(r.state.mode, "date-minute");
  r = handleCallingDigit(r.state, "30", c, NOW, TZ);
  assert.equal(r.effect.type, "schedule");
  assert.equal(r.state.mode, "menu");
  assert.ok(r.feedback.includes("Scheduled for Wednesday, December 2, 2026 at 3 30 P M"));
  assert.ok(r.feedback.includes("Tishl"));
  if (r.effect.type === "schedule") {
    assert.equal(r.effect.at.toISOString(), "2026-12-02T20:30:00.000Z");
    assert.equal(r.effect.phone, "+17185551234");
    assert.equal(r.effect.contactPos, null);
    assert.equal(r.effect.casePos, null);
  }
});
test("option 6 (Jewish): day/month/year/hour/minute -> schedule with Parsha", () => {
  const c = ctx("signalwire", 6, 3);
  // Start mid-flow: phone + case already chosen, at the date choice.
  let st: CallingState = {
    mode: "date-choice", option: 6, pos: 0, kind: null, id: null,
    phone: "+17185551234", casePos: null, returnTo: "menu", dateRetries: 0,
  };
  let r = handleCallingDigit(st, "1", c, NOW, TZ); // Jewish
  r = handleCallingDigit(r.state, "9", c, NOW, TZ); // day 9 Kislev
  assert.equal(r.state.dateDay, 9);
  r = handleCallingDigit(r.state, "3", c, NOW, TZ); // Kislev
  assert.equal(r.state.dateMonth, 3);
  r = handleCallingDigit(r.state, "#", c, NOW, TZ); // # = this Hebrew year
  assert.equal(r.state.dateYear, null);
  r = handleCallingDigit(r.state, "20", c, NOW, TZ);
  r = handleCallingDigit(r.state, "0", c, NOW, TZ); // minute 0 — a digit, not back
  assert.equal(r.effect.type, "schedule");
  if (r.effect.type === "schedule") assert.equal(r.effect.at.toISOString(), "2026-11-20T01:00:00.000Z");
  assert.ok(r.feedback.includes("Parsha is Vayetzei"));
  assert.ok(r.feedback.includes("9 of Kislev, 5787"));
});
test("option 6 (Jewish, explicit year): 1 Tishrei 5788 -> 2027-10-02", () => {
  const c = ctx("signalwire", 6, 0);
  let st: CallingState = { mode: "date-day", option: 6, pos: 0, kind: null, id: null, dateKind: "jewish", dateRetries: 0, returnTo: "menu" };
  const { last } = run(st, ["1", "1", "5788", "9", "0"], c);
  assert.equal(last.effect.type, "schedule");
  if (last.effect.type === "schedule") assert.equal(last.effect.at.toISOString(), "2027-10-02T13:00:00.000Z");
});
test("date entry: invalid input re-prompts once, then cancels; impossible date re-prompts the day", () => {
  const c = ctx("signalwire", 6, 0);
  let st: CallingState = { mode: "date-day", option: 6, pos: 0, kind: null, id: null, dateKind: "numeric", dateRetries: 0, returnTo: "menu" };
  let r = handleCallingDigit(st, "13", c, NOW, TZ); // month 13 is invalid
  assert.equal(r.state.mode, "date-day");
  assert.equal(r.state.dateRetries, 1);
  assert.ok(r.feedback.includes("not valid"));
  r = handleCallingDigit(r.state, "99", c, NOW, TZ);
  assert.equal(r.state.mode, "menu");
  assert.ok(r.feedback.includes("Date entry cancelled"));

  // 31 April can never occur: re-enter once, then a valid date resolves.
  st = { mode: "date-day", option: 6, pos: 0, kind: null, id: null, dateKind: "numeric", dateRetries: 0, returnTo: "menu" };
  const { state, last } = run(st, ["4", "31", "#", "10", "0"], c);
  assert.equal(last.effect.type, "none");
  assert.equal(state.mode, "date-day");
  assert.equal(state.dateRetries, 1);
  assert.ok(last.feedback.includes("does not exist"));
  const done = run(state, ["5", "10", "#", "10", "0"], c);
  assert.equal(done.last.effect.type, "schedule");
  if (done.last.effect.type === "schedule") assert.equal(done.last.effect.at.toISOString(), "2027-05-10T14:00:00.000Z");
});
test("date choice: 1 = Jewish, 2 = numeric; anything else re-prompts", () => {
  const choice: CallingState = { mode: "date-choice", option: 6, pos: 0, kind: null, id: null, dateRetries: 0, returnTo: "menu" };
  const c = ctx("signalwire", 6, 0);
  assert.equal(handleCallingDigit(choice, "1", c, NOW, TZ).state.dateKind, "jewish");
  assert.equal(handleCallingDigit(choice, "2", c, NOW, TZ).state.dateKind, "numeric");
  const bad = handleCallingDigit(choice, "5", c, NOW, TZ);
  assert.equal(bad.state.mode, "date-choice");
  assert.ok(bad.feedback.includes("Press 1 for a Jewish date"));
});

// --- option 7: contacts ---------------------------------------------------------
test("option 7: contact menu -> schedule this contact -> schedule effect with contactPos", () => {
  const c = ctx("signalwire", 7, 2);
  let st: CallingState = { mode: "list", option: 7, pos: 0, kind: "contact", id: 11 };
  let r = handleCallingDigit(st, "1", c, NOW, TZ);
  assert.equal(r.state.mode, "contact-menu");
  r = handleCallingDigit(r.state, "1", c, NOW, TZ); // schedule this contact
  assert.equal(r.state.mode, "date-choice");
  assert.equal(r.state.fromContact, true);
  const { last } = run(r.state, ["2", "12", "2", "#", "15", "30"], c);
  assert.equal(last.effect.type, "schedule");
  if (last.effect.type === "schedule") {
    assert.equal(last.effect.contactPos, 0);
    assert.equal(last.effect.phone, null); // the engine resolves the phone from the contact
    assert.equal(last.effect.at.toISOString(), "2026-12-02T20:30:00.000Z");
  }
});
test("option 7: edit name is a voice note (no keypad typing); DNC toggles; delete confirms", () => {
  const c = ctx("signalwire", 7, 2);
  let st: CallingState = { mode: "contact-menu", option: 7, pos: 0, kind: "contact", id: 11 };
  let r = handleCallingDigit(st, "3", c, NOW, TZ);
  assert.equal(r.state.mode, "edit-field");
  r = handleCallingDigit(r.state, "1", c, NOW, TZ); // name
  assert.equal(r.state.mode, "edit-value");
  assert.equal(r.state.editField, "name");
  r = handleCallingDigit(r.state, "1", c, NOW, TZ); // record a voice note
  assert.equal(r.effect.type, "saveContactNote");
  assert.equal(r.state.mode, "contact-menu");
  if (r.effect.type === "saveContactNote") {
    assert.equal(r.effect.pos, 0);
    assert.equal(r.effect.field, "name");
  }
  r = handleCallingDigit({ ...st }, "4", c, NOW, TZ); // DNC toggle
  assert.equal(r.effect.type, "toggleDNC");
  if (r.effect.type === "toggleDNC") assert.equal(r.effect.pos, 0);
  assert.equal(r.state.mode, "contact-menu");
  r = handleCallingDigit({ ...st }, "2", c, NOW, TZ); // delete
  assert.equal(r.state.mode, "confirm-delete");
  r = handleCallingDigit(r.state, "3", c, NOW, TZ);
  assert.equal(r.effect.type, "deleteContact");
  if (r.effect.type === "deleteContact") assert.equal(r.effect.pos, 0);
});

// --- select-case edge cases -----------------------------------------------------
test("select-case: 2/8 navigate, # skips, empty case list skips gracefully", () => {
  const c = ctx("signalwire", 1, 3);
  let st: CallingState = { mode: "select-case", option: 1, pos: 0, kind: null, id: null, source: "dialled", returnTo: "menu" };
  let r = handleCallingDigit(st, "2", c, NOW, TZ);
  assert.equal(r.state.pos, 1);
  r = handleCallingDigit(r.state, "2", c, NOW, TZ);
  assert.equal(r.state.pos, 2);
  r = handleCallingDigit(r.state, "2", c, NOW, TZ); // already last
  assert.equal(r.state.pos, 2);
  assert.ok(r.feedback.includes("last one"));
  r = handleCallingDigit(r.state, "8", c, NOW, TZ);
  assert.equal(r.state.pos, 1);
  r = handleCallingDigit(r.state, "#", c, NOW, TZ); // skip
  assert.equal(r.state.casePos, null);
  assert.equal(r.state.mode, "phone");

  const empty = handleCallingDigit(st, "#", ctx("signalwire", 1, 0), NOW, TZ);
  assert.equal(empty.state.mode, "phone");
  assert.equal(empty.state.casePos, null);
  assert.ok(empty.feedback.includes("No case"));
});

// --- back one level ---------------------------------------------------------------
test("back one level from every mode", () => {
  assert.equal(callingBackOneLevel(menu()), null);
  assert.equal(callingBackOneLevel({ mode: "list", option: 5, pos: 0, kind: null, id: null })?.mode, "menu");
  assert.equal(callingBackOneLevel({ mode: "detail", option: 5, pos: 0, kind: "session", id: 9 })?.mode, "list");
  assert.equal(callingBackOneLevel({ mode: "contact-menu", option: 7, pos: 0, kind: "contact", id: 11 })?.mode, "list");
  assert.equal(callingBackOneLevel({ mode: "edit-field", option: 7, pos: 0, kind: "contact", id: 11 })?.mode, "contact-menu");
  assert.equal(callingBackOneLevel({ mode: "edit-value", option: 7, pos: 0, kind: "contact", id: 11, editField: "name" })?.mode, "edit-field");
  assert.equal(callingBackOneLevel({ mode: "confirm-delete", option: 5, pos: 0, kind: "session", id: 9 })?.mode, "detail");
  assert.equal(callingBackOneLevel({ mode: "confirm-delete-all", option: 5, pos: 0, kind: "session", id: 9 })?.mode, "detail");
  assert.equal(callingBackOneLevel({ mode: "date-month", option: 6, pos: 0, kind: null, id: null, returnTo: "menu" })?.mode, "menu");
  const fromContact = callingBackOneLevel({ mode: "date-month", option: 7, pos: 0, kind: "contact", id: 11, returnTo: "contact-menu" });
  assert.equal(fromContact?.mode, "contact-menu");
  assert.equal(callingBackOneLevel({ mode: "fill-amount", option: 2, pos: 0, kind: null, id: null, returnTo: "menu" })?.mode, "menu");
});

// --- after removal --------------------------------------------------------------
test("clampCallingPosAfterRemoval: same index slides the next item in; last item goes past the end", () => {
  assert.deepEqual(clampCallingPosAfterRemoval(1, 4), { pos: 1, empty: false });
  assert.deepEqual(clampCallingPosAfterRemoval(3, 3), { pos: 3, empty: false });
  assert.deepEqual(clampCallingPosAfterRemoval(0, 0), { pos: 0, empty: true });
});

// --- skip-the-case fix: the fill-in is held on the session, no case is ever picked for the caller ---
test("skip with 3 cases: # continues to the fill form, saveReport carries casePos null and says add it later via option 3", () => {
  const c = ctx("signalwire", 2, 3); // 3 cases/campaigns/projects on the account
  let st = handleCallingDigit(menu(), "2", SW, NOW, TZ).state;
  let r = handleCallingDigit(st, "17185551234#", ctx("signalwire", 2, 0), NOW, TZ);
  assert.equal(r.state.mode, "select-case");
  r = handleCallingDigit(r.state, "#", c, NOW, TZ); // skip with 3 open cases
  assert.equal(r.state.mode, "fill-outcome");
  assert.equal(r.state.casePos, null);
  assert.ok(r.feedback.includes("without a case"));
  assert.ok(r.feedback.includes("option 3"));
  const { last } = run(r.state, ["1", "250#", "#", "#", "2"], c); // given, $250, skip method, skip note, neutral
  assert.equal(last.effect.type, "saveReport");
  assert.equal(last.state.mode, "menu");
  assert.ok(last.feedback.includes("saved without a case"));
  assert.ok(last.feedback.includes("option 3"));
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.casePos, null);
    assert.equal(last.effect.report.outcome, "given");
    assert.equal(last.effect.report.amount, 250);
    assert.equal(last.effect.report.source, "manual");
  }
});
test("skip with 0 cases: option 2 with an empty case list continues without a case", () => {
  const c = ctx("signalwire", 2, 0);
  let st = handleCallingDigit(menu(), "2", SW, NOW, TZ).state;
  let r = handleCallingDigit(st, "17185551234#", ctx("signalwire", 2, 0), NOW, TZ);
  assert.equal(r.state.mode, "select-case");
  r = handleCallingDigit(r.state, "#", c, NOW, TZ);
  assert.equal(r.state.mode, "fill-outcome");
  assert.equal(r.state.casePos, null);
  assert.ok(r.feedback.includes("No case"));
  const { last } = run(r.state, ["1", "#", "#", "#", "#"], c); // given, skip amount/method/note/mood
  assert.equal(last.effect.type, "saveReport");
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.casePos, null);
    assert.equal(last.effect.report.amount, null);
    assert.equal(last.effect.report.mood, null);
    assert.equal(last.effect.report.moneyKind, "none"); // given, nothing known yet
    assert.equal(last.effect.report.paymentMethod, null);
  }
  assert.ok(last.feedback.includes("saved without a case"));
});
test("skip with exactly 1 case: # still skips at the phone — the single-case convenience lives in the queue, not the machine", () => {
  const c = ctx("signalwire", 2, 1);
  let st = handleCallingDigit(menu(), "2", SW, NOW, TZ).state;
  let r = handleCallingDigit(st, "17185551234#", ctx("signalwire", 2, 0), NOW, TZ);
  r = handleCallingDigit(r.state, "#", c, NOW, TZ);
  assert.equal(r.state.mode, "fill-outcome");
  assert.equal(r.state.casePos, null); // the machine never auto-picks a case
  const { last } = run(r.state, ["1", "#", "#", "#", "#"], c);
  assert.equal(last.effect.type, "saveReport");
  if (last.effect.type === "saveReport") assert.equal(last.effect.report.casePos, null);
});
test("option 1 with 3 cases: # skips, the dial carries casePos null", () => {
  const c = ctx("signalwire", 1, 3);
  let st = handleCallingDigit(menu(), "1", SW, NOW, TZ).state;
  let r = handleCallingDigit(st, "#", c, NOW, TZ);
  assert.equal(r.state.mode, "phone");
  assert.equal(r.state.casePos, null);
  r = handleCallingDigit(r.state, "7185551234#", c, NOW, TZ);
  assert.equal(r.effect.type, "dial");
  assert.equal(r.state.mode, "fill-outcome");
  if (r.effect.type === "dial") {
    assert.equal(r.effect.phone, "+17185551234");
    assert.equal(r.effect.casePos, null);
  }
});
test("option 3: edit a session, choose a case -> updateReport carries the chosen casePos (engine upserts the report)", () => {
  const c = ctx("signalwire", 3, 3);
  let st: CallingState = { mode: "list", option: 3, pos: 0, kind: "session", id: 9, filter: "all" };
  let r = handleCallingDigit(st, "1", c, NOW, TZ);
  assert.equal(r.state.mode, "detail");
  r = handleCallingDigit(r.state, "2", c, NOW, TZ); // edit
  assert.equal(r.state.mode, "select-case");
  r = handleCallingDigit(r.state, "1", c, NOW, TZ); // choose the case at pos 0
  assert.equal(r.state.mode, "fill-outcome");
  assert.equal(r.state.casePos, 0);
  const { last } = run(r.state, ["1", "50#", "#", "#", "1"], c); // given, $50, skip method, skip note, good
  assert.equal(last.effect.type, "updateReport");
  if (last.effect.type === "updateReport") {
    assert.equal(last.effect.pos, 0);
    assert.equal(last.effect.report.casePos, 0);
    assert.equal(last.effect.report.outcome, "given");
    assert.equal(last.effect.report.amount, 50);
  }
  assert.ok(last.feedback.includes("Call information updated"));
});
test("option 3: edit a session, skip the case -> updateReport casePos null, feedback says the case can be added later", () => {
  const c = ctx("signalwire", 3, 3);
  let st: CallingState = { mode: "list", option: 3, pos: 0, kind: "session", id: 9, filter: "all" };
  let r = handleCallingDigit(st, "1", c, NOW, TZ);
  r = handleCallingDigit(r.state, "2", c, NOW, TZ); // edit
  r = handleCallingDigit(r.state, "#", c, NOW, TZ); // skip: no case yet for this session
  assert.equal(r.state.mode, "fill-outcome");
  assert.equal(r.state.casePos, null);
  assert.ok(r.feedback.includes("option 3"));
  const { last } = run(r.state, ["1", "#", "#", "#", "#"], c);
  assert.equal(last.effect.type, "updateReport");
  if (last.effect.type === "updateReport") assert.equal(last.effect.report.casePos, null);
  assert.ok(last.feedback.includes("No case was chosen yet"));
  assert.ok(last.feedback.includes("option 3"));
});
test("option 3: edit a report, skip the case -> the current case is kept", () => {
  const c = ctx("signalwire", 3, 3);
  let st: CallingState = { mode: "list", option: 3, pos: 2, kind: "report", id: 4, filter: "all" };
  let r = handleCallingDigit(st, "1", c, NOW, TZ);
  r = handleCallingDigit(r.state, "2", c, NOW, TZ); // edit
  r = handleCallingDigit(r.state, "#", c, NOW, TZ); // skip = keep the report's case
  assert.equal(r.state.mode, "fill-outcome");
  assert.equal(r.state.casePos, null);
  assert.ok(r.feedback.includes("Keeping the current case"));
  const { last } = run(r.state, ["1", "#", "#", "#", "#"], c);
  assert.equal(last.effect.type, "updateReport");
  assert.ok(last.feedback.includes("Call information updated"));
});

// --- new outcomes: given + method, pledge, pickup, cannot give -------------
// Fill form starts at fill-outcome with the phone/case already set.
function fillStart(): CallingState {
  return { mode: "fill-outcome", option: 2, pos: 0, kind: null, id: null, phone: "+17185551234", casePos: null, source: "manual" };
}

test("given: amount -> method cash -> skip note/mood -> saveReport carries method + received", () => {
  const c = ctx("signalwire", 2, 3);
  const { last } = run(fillStart(), ["1", "250#", "2", "#", "#"], c); // given, $250, cash, skip note, skip mood
  assert.equal(last.effect.type, "saveReport");
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.outcome, "given");
    assert.equal(last.effect.report.amount, 250);
    assert.equal(last.effect.report.moneyKind, "received");
    assert.equal(last.effect.report.paymentMethod, "cash");
    assert.equal(last.effect.report.pledgeAmount, null);
    assert.equal(last.effect.report.pickupAt, null);
  }
});

test("given: method labels are labels only — credit card is a label, never a number", () => {
  const c = ctx("signalwire", 2, 3);
  const { last } = run(fillStart(), ["1", "100#", "1", "#", "#"], c); // given, $100, credit card label
  assert.equal(last.effect.type, "saveReport");
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.paymentMethod, "credit_card");
    assert.equal(last.effect.report.moneyKind, "received");
  }
  // The machine never asks for card digits: fill-method only accepts 1-5/#.
  const mid = run(fillStart(), ["1", "100#"], c).state;
  assert.equal(mid.mode, "fill-method");
  const bad = handleCallingDigit(mid, "9", c, NOW, TZ);
  assert.equal(bad.state.mode, "fill-method");
  assert.ok(bad.feedback.includes("Press 1 for credit card"));
});

test("pledge: amount -> paid in full -> method -> saveReport received, pledge kept", () => {
  const c = ctx("signalwire", 2, 3);
  const { last } = run(fillStart(), ["8", "500#", "1", "3", "#", "#"], c); // pledge $500, paid full, check
  assert.equal(last.effect.type, "saveReport");
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.outcome, "pledged");
    assert.equal(last.effect.report.amount, 500); // paid in full = the pledge amount
    assert.equal(last.effect.report.pledgeAmount, 500);
    assert.equal(last.effect.report.moneyKind, "received");
    assert.equal(last.effect.report.paymentMethod, "check");
  }
});

test("pledge: amount -> paid part -> paid amount -> method -> saveReport received with part paid", () => {
  const c = ctx("signalwire", 2, 3);
  const { last } = run(fillStart(), ["8", "500#", "2", "200#", "2", "#", "#"], c); // pledge $500, part $200 cash
  assert.equal(last.effect.type, "saveReport");
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.outcome, "pledged");
    assert.equal(last.effect.report.amount, 200); // what was actually paid
    assert.equal(last.effect.report.pledgeAmount, 500); // what was undertaken
    assert.equal(last.effect.report.moneyKind, "received");
    assert.equal(last.effect.report.paymentMethod, "cash");
  }
});

test("pledge: amount -> not paid yet -> saveReport stays pledged", () => {
  const c = ctx("signalwire", 2, 3);
  const { last } = run(fillStart(), ["8", "500#", "3", "#", "#"], c); // pledge $500, not paid
  assert.equal(last.effect.type, "saveReport");
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.outcome, "pledged");
    assert.equal(last.effect.report.amount, 500);
    assert.equal(last.effect.report.pledgeAmount, 500);
    assert.equal(last.effect.report.moneyKind, "pledged");
    assert.equal(last.effect.report.paymentMethod, null);
  }
});

test("pickup: outcome 6 -> numeric date -> schedule effect + pickup-address; skip address -> fill-note -> saveReport", () => {
  const c = ctx("signalwire", 2, 3);
  const { state, last } = run(fillStart(), ["6", "2", "12", "2", "#", "15", "30"], c);
  assert.equal(last.effect.type, "schedule"); // the pickup surfaces on Tishl
  assert.equal(state.mode, "pickup-address");
  assert.equal(state.fillOutcome, "pickup");
  assert.ok(state.fillPickupAt, "fillPickupAt must be set");
  if (last.effect.type === "schedule") {
    assert.equal(last.effect.at.toISOString(), "2026-12-02T20:30:00.000Z");
    assert.equal(last.effect.phone, "+17185551234");
    assert.equal(last.effect.note, "Pickup");
  }
  const skipped = handleCallingDigit(state, "#", c, NOW, TZ); // skip the address
  assert.equal(skipped.state.mode, "fill-note");
  assert.ok(skipped.feedback.includes("Address skipped"));
  const { last: saved } = run(skipped.state, ["#", "#"], c); // skip note + mood
  assert.equal(saved.effect.type, "saveReport");
  if (saved.effect.type === "saveReport") {
    assert.equal(saved.effect.report.outcome, "pickup");
    assert.equal(saved.effect.report.pickupAt, "2026-12-02T20:30:00.000Z");
    assert.equal(saved.effect.report.moneyKind, "none");
    assert.equal(saved.effect.report.amount, null);
  }
});

test("pickup-address: 1 records the address as a voice note (savePickupAddress); advanceAfterPickupAddress continues to fill-note", () => {
  const st: CallingState = { ...fillStart(), mode: "pickup-address", fillOutcome: "pickup", fillPickupAt: "2026-12-02T20:30:00.000Z" };
  const c = ctx("signalwire", 2, 3);
  const r = handleCallingDigit(st, "1", c, NOW, TZ);
  assert.equal(r.effect.type, "savePickupAddress");
  assert.equal(r.state.mode, "pickup-address"); // the engine advances after the recording
  assert.equal(advanceAfterPickupAddress(r.state).mode, "fill-note");
  assert.equal(advanceAfterPickupAddress({ ...st, mode: "fill-note" }).mode, "fill-note"); // no-op elsewhere
  const bad = handleCallingDigit(st, "5", c, NOW, TZ);
  assert.equal(bad.state.mode, "pickup-address");
  assert.ok(bad.feedback.includes("Press 1 to record the pickup address"));
});

test("cannot give: outcome 7 -> skip amount -> saveReport with outcome cannot_give", () => {
  const c = ctx("signalwire", 2, 3);
  const { last } = run(fillStart(), ["7", "#", "#", "#"], c); // cannot give, skip amount/note/mood
  assert.equal(last.effect.type, "saveReport");
  if (last.effect.type === "saveReport") {
    assert.equal(last.effect.report.outcome, "cannot_give");
    assert.equal(last.effect.report.amount, null);
    assert.equal(last.effect.report.moneyKind, "none");
  }
});

test("fill-outcome: an unknown digit re-prompts with all 8 options; star goes back", () => {
  const c = ctx("signalwire", 2, 3);
  const bad = handleCallingDigit(fillStart(), "9", c, NOW, TZ);
  assert.equal(bad.state.mode, "fill-outcome");
  assert.ok(bad.feedback.includes("6 for pickup"));
  assert.ok(bad.feedback.includes("8 for a pledge"));
  const back = handleCallingDigit(fillStart(), "*", c, NOW, TZ);
  assert.equal(back.state.mode, "menu");
});
