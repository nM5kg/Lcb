import test from "node:test";
import assert from "node:assert/strict";
import {
  TISHL_TZ, newTishlState, parseTishlFlash, encodeTishlFlash,
  tishlBackOneLevel, handleTishlDigit, clampPosAfterRemoval,
  speakDigits, splitSpeechChunks, describeTishlItem, actionMenuSpeech,
  hebrewMonthChoicesSpeech, buildVoiceNoteText, parseDateDigits,
  remindInHours, remindTonight, formatSpokenDateTime, tzParts,
  resolveNumericReminder, resolveJewishReminder,
} from "../src/lib/tishl-phone.ts";
import type { TishlState, TishlQueueItemView } from "../src/lib/tishl-phone.ts";

const TZ = TISHL_TZ;
const NOW = new Date("2026-11-19T15:00:00-05:00"); // Thursday, 3 PM New York

const items: TishlQueueItemView[] = [
  { kind: "task", id: 5, title: "Call the printer", detail: "Main case", phone: null, created_at: "2026-11-19T10:00:00Z", held: false },
  { kind: "case", id: 9, title: "Cohen family", detail: "Needs help with rent", phone: null, created_at: "2026-11-18T10:00:00Z", held: false },
  { kind: "missed_call", id: 2, title: "Missed call", detail: "", phone: "17185551234", created_at: "2026-11-17T10:00:00Z", held: false },
  { kind: "message", id: 366, title: "New message", detail: "Hello, this is a long message about the campaign. It keeps going for many words so that it needs more than one spoken chunk to be heard in full.", phone: null, created_at: "2026-11-16T10:00:00Z", held: false },
];

function listen(pos = 0, kind: TishlQueueItemView["kind"] | null = null, id: number | null = null): TishlState {
  return { mode: "listen", pos, kind, id };
}

// --- flash round trip -------------------------------------------------------
test("parse/encode Tishl flash round-trips; bad JSON returns null", () => {
  const st = { ...listen(2, "missed_call", 2), fullRead: true, chunk: 1 };
  assert.deepEqual(parseTishlFlash(encodeTishlFlash(st)), st);
  assert.equal(parseTishlFlash(null), null);
  assert.equal(parseTishlFlash(""), null);
  assert.equal(parseTishlFlash("not json"), null);
  assert.equal(parseTishlFlash(JSON.stringify({ other: 1 })), null);
  assert.deepEqual(parseTishlFlash(JSON.stringify({ tishl: { mode: "listen", pos: 0 } })),
    { mode: "listen", pos: 0, kind: null, id: null }); // minimal state parses fine
});

// --- reminder math ----------------------------------------------------------
test("remindInHours: +1h and +24h from now", () => {
  assert.equal(remindInHours(NOW, 1).toISOString(), "2026-11-19T21:00:00.000Z");
  assert.equal(remindInHours(NOW, 24).toISOString(), "2026-11-20T20:00:00.000Z");
});
test("remindTonight: 23:59 local (New York)", () => {
  const t = remindTonight(NOW, TZ);
  assert.deepEqual(tzParts(t, TZ), { year: 2026, month: 11, day: 19, hour: 23, minute: 59, second: 0 });
  assert.equal(formatSpokenDateTime(t, TZ), "Thursday, November 19, 2026 at 11 59 P M");
});
test("formatSpokenDateTime spells out the time for TTS", () => {
  assert.equal(formatSpokenDateTime(new Date("2026-12-02T15:30:00-05:00"), TZ), "Wednesday, December 2, 2026 at 3 30 P M");
  assert.equal(formatSpokenDateTime(new Date("2026-12-02T00:05:00-05:00"), TZ), "Wednesday, December 2, 2026 at 12 05 A M");
  // Day-name rule (Yakob 2026-11-20): Friday is the full phrase, Saturday is Motzei.
  assert.equal(formatSpokenDateTime(new Date("2026-11-20T15:30:00-05:00"), TZ), "Friday Erev Shabbos Kodesh, November 20, 2026 at 3 30 P M");
  assert.equal(formatSpokenDateTime(new Date("2026-11-21T20:00:00-05:00"), TZ), "Motzei Shabbos Kodesh, November 21, 2026 at 8 00 P M");
});

// --- numeric date resolution -------------------------------------------------
test("resolveNumericReminder: later today, and past time rolls to next year", () => {
  // Today is Thu 2026-11-19 15:00 NY. 20:00 today is still ahead.
  const a = resolveNumericReminder(NOW, TZ, 19, 11, 20, 0);
  assert.ok(a && a.toISOString() === "2026-11-20T01:00:00.000Z");
  // 10:00 today already passed -> next year.
  const b = resolveNumericReminder(NOW, TZ, 19, 11, 10, 0);
  assert.ok(b && b.toISOString() === "2027-11-19T15:00:00.000Z");
  // 2 December 2026 at 3:30 PM.
  const c = resolveNumericReminder(NOW, TZ, 2, 12, 15, 30);
  assert.ok(c && c.toISOString() === "2026-12-02T20:30:00.000Z");
});
test("resolveNumericReminder: Feb 29 goes to the next leap year; Apr 31 is null", () => {
  const leap = resolveNumericReminder(NOW, TZ, 29, 2, 10, 0);
  assert.ok(leap && leap.toISOString() === "2028-02-29T15:00:00.000Z");
  assert.equal(resolveNumericReminder(NOW, TZ, 31, 4, 10, 0), null);
  assert.equal(resolveNumericReminder(NOW, TZ, 30, 2, 10, 0), null);
  assert.equal(resolveNumericReminder(NOW, TZ, 32, 1, 10, 0), null);
  assert.equal(resolveNumericReminder(NOW, TZ, 15, 13, 10, 0), null);
  assert.equal(resolveNumericReminder(NOW, TZ, 15, 6, 24, 0), null);
});

// --- Jewish date resolution --------------------------------------------------
test("resolveJewishReminder: 15 Nisan — the next one after Nov 2026 is 5787 (2027-04-22)", () => {
  const at = resolveJewishReminder(NOW, TZ, 15, 8, 10, 0); // 15 Nisan
  assert.ok(at && at.toISOString() === "2027-04-22T14:00:00.000Z");
});
test("resolveJewishReminder: 1 Tishrei — the next one after Nov 2026 is 5788 (2027-10-02)", () => {
  const at = resolveJewishReminder(NOW, TZ, 1, 1, 9, 0);
  assert.ok(at && at.toISOString() === "2027-10-02T13:00:00.000Z");
});
test("resolveJewishReminder: Adar II (slot 7) in a common year waits for the leap year", () => {
  // 14 Adar II 5787 = 2027-03-23.
  const at = resolveJewishReminder(NOW, TZ, 14, 7, 10, 0);
  assert.ok(at && at.toISOString() === "2027-03-23T14:00:00.000Z");
});
test("resolveJewishReminder: a day that passed this year rolls to next year", () => {
  // 3 Kislev 5787 was 2026-11-13 (before NOW); the next 3 Kislev is 5788.
  // 1 Kislev 5788 = 2027-12-01 (RH 5788 = 2027-10-02, Tishrei 30 + Cheshvan 30).
  const at = resolveJewishReminder(NOW, TZ, 3, 3, 10, 0);
  assert.ok(at && at.toISOString() === "2027-12-03T15:00:00.000Z");
});
test("resolveJewishReminder: invalid inputs are null", () => {
  assert.equal(resolveJewishReminder(NOW, TZ, 31, 1, 10, 0), null);
  assert.equal(resolveJewishReminder(NOW, TZ, 15, 14, 10, 0), null);
  assert.equal(resolveJewishReminder(NOW, TZ, 15, 8, 25, 0), null);
});

// --- speech helpers -----------------------------------------------------------
test("speakDigits spells a phone number digit by digit", () => {
  assert.equal(speakDigits("17185551234"), "1 7 1 8 5 5 5 1 2 3 4");
  assert.equal(speakDigits("+1 (718) 555-1234"), "1 7 1 8 5 5 5 1 2 3 4");
});
test("splitSpeechChunks stays under the limit and is lossless", () => {
  const text = items[3].detail;
  const chunks = splitSpeechChunks(text, 60);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 60, c);
  assert.equal(chunks.join(" "), text);
  assert.deepEqual(splitSpeechChunks(""), []);
  const long = (text + " ").repeat(3).trim();
  for (const c of splitSpeechChunks(long, 215)) assert.ok(c.length <= 215, c);
});
test("describeTishlItem names the type, title, detail and navigation hint", () => {
  const s = describeTishlItem(items[0], 0, 4, "Priority high. Due 2026-11-20. ");
  assert.ok(s.startsWith("Item 1 of 4. Task: Call the printer."));
  assert.ok(s.includes("Priority high."));
  assert.ok(s.includes("Press 1 for options"));
  const m = describeTishlItem(items[2], 2, 4);
  assert.ok(m.includes("Missed call: Missed call. From 1 7 1 8 5 5 5 1 2 3 4."));
  const held = describeTishlItem({ ...items[1], held: true }, 1, 4);
  assert.ok(held.includes("This item is on hold."));
});
test("actionMenuSpeech names the contextual action per kind", () => {
  assert.ok(actionMenuSpeech(items[2]).includes("Press 1 to call this number back"));
  assert.ok(actionMenuSpeech(items[0]).includes("Press 1 to open this task"));
  assert.ok(actionMenuSpeech(items[1]).includes("Press 1 to open this case"));
  assert.ok(actionMenuSpeech(items[3]).includes("Press 1 to hear this message in full"));
  assert.ok(actionMenuSpeech(items[0]).includes("Press 9 to put this item on hold"));
});
test("hebrewMonthChoicesSpeech lists the months with numbers", () => {
  const s = hebrewMonthChoicesSpeech(5786);
  assert.ok(s.includes("1, Tishrei"));
  assert.ok(s.includes("6, Adar"));
  assert.ok(!s.includes("Adar II")); // 5786 is common
  assert.ok(hebrewMonthChoicesSpeech(5787).includes("7, Adar II"));
  // In a common year, Adar II can still be offered when the next year is leap.
  assert.ok(hebrewMonthChoicesSpeech(5786, true).includes("7, Adar II"));
});
test("buildVoiceNoteText keeps the recording reference", () => {
  const t = buildVoiceNoteText("ivr2:/path/file.wav", "2026-11-19T20:00:00.000Z");
  assert.ok(t.includes("ivr2:/path/file.wav"));
  assert.ok(t.startsWith("Voice note recorded via phone on 2026-11-19"));
});
test("parseDateDigits strips a trailing pound and rejects junk", () => {
  assert.equal(parseDateDigits("15#"), 15);
  assert.equal(parseDateDigits("7"), 7);
  assert.equal(parseDateDigits(""), null);
  assert.equal(parseDateDigits("None"), null);
  assert.equal(parseDateDigits("12a"), null);
  assert.equal(parseDateDigits(null), null);
});

// --- state machine: listening -------------------------------------------------
test("listening: # = next, 9 = previous (min 0), 1 = action menu, * and 0 = leave", () => {
  let r = handleTishlDigit(listen(0, "task", 5), "#", 4, NOW, TZ);
  assert.equal(r.state.pos, 1); assert.equal(r.effect.type, "none");
  r = handleTishlDigit(listen(1, "case", 9), "9", 4, NOW, TZ);
  assert.equal(r.state.pos, 0);
  r = handleTishlDigit(listen(0, "task", 5), "9", 4, NOW, TZ);
  assert.equal(r.state.pos, 0); // already at the start
  r = handleTishlDigit(listen(0, "task", 5), "1", 4, NOW, TZ);
  assert.equal(r.state.mode, "action");
  r = handleTishlDigit(listen(0, "task", 5), "*", 4, NOW, TZ);
  assert.equal(r.effect.type, "leave");
  r = handleTishlDigit(listen(0, "task", 5), "0", 4, NOW, TZ);
  assert.equal(r.effect.type, "leave");
  r = handleTishlDigit(listen(0, "task", 5), "7", 4, NOW, TZ);
  assert.ok(r.feedback.includes("Press 1 for options"));
});
test("listening: past the end, # restarts, 9 goes to the last item", () => {
  let r = handleTishlDigit(listen(4, null, null), "#", 4, NOW, TZ);
  assert.equal(r.state.pos, 0);
  r = handleTishlDigit(listen(4, null, null), "9", 4, NOW, TZ);
  assert.equal(r.state.pos, 3);
  r = handleTishlDigit(listen(4, null, null), "7", 4, NOW, TZ);
  assert.ok(r.feedback.includes("end of your Tishl"));
  r = handleTishlDigit(listen(3, "message", 366), "#", 4, NOW, TZ);
  assert.equal(r.state.pos, 4); // stepped past the end
});
test("listening: an empty queue leaves Tishl", () => {
  const r = handleTishlDigit(listen(0), "#", 0, NOW, TZ);
  assert.equal(r.effect.type, "leave");
  assert.ok(r.feedback.includes("empty"));
});

// --- state machine: the two 9s ------------------------------------------------
test("THE TWO 9s: 9 while listening = previous; 9 in the action menu = hold", () => {
  const inListen = handleTishlDigit(listen(2, "missed_call", 2), "9", 4, NOW, TZ);
  assert.equal(inListen.state.pos, 1);
  assert.equal(inListen.effect.type, "none");
  const inAction = handleTishlDigit({ mode: "action", pos: 2, kind: "missed_call", id: 2 }, "9", 4, NOW, TZ);
  assert.equal(inAction.effect.type, "hold");
  assert.equal(inAction.state.pos, 2); // stays on the same item
  assert.equal(inAction.state.mode, "listen");
});
test("action menu: 9 while reading a message in full = stop reading", () => {
  const reading: TishlState = { mode: "listen", pos: 3, kind: "message", id: 366, fullRead: true, chunk: 1 };
  const r = handleTishlDigit(reading, "9", 4, NOW, TZ);
  assert.equal(r.state.fullRead, false);
  assert.equal(r.state.chunk, 0);
  const next = handleTishlDigit(reading, "2", 4, NOW, TZ);
  assert.equal(next.state.chunk, 2);
  const junk = handleTishlDigit(reading, "5", 4, NOW, TZ);
  assert.ok(junk.feedback.includes("Press 2 for the next part"));
});

// --- state machine: action menu ------------------------------------------------
test("action menu: 2 = done, 3+3 = delete, 3+other cancels", () => {
  const action: TishlState = { mode: "action", pos: 0, kind: "task", id: 5 };
  let r = handleTishlDigit(action, "2", 4, NOW, TZ);
  assert.equal(r.effect.type, "done"); assert.equal(r.state.mode, "listen");
  r = handleTishlDigit(action, "3", 4, NOW, TZ);
  assert.equal(r.state.mode, "confirm-delete"); assert.equal(r.effect.type, "none");
  r = handleTishlDigit({ mode: "confirm-delete", pos: 0, kind: "task", id: 5 }, "3", 4, NOW, TZ);
  assert.equal(r.effect.type, "delete"); assert.equal(r.state.mode, "listen");
  r = handleTishlDigit({ mode: "confirm-delete", pos: 0, kind: "task", id: 5 }, "2", 4, NOW, TZ);
  assert.equal(r.effect.type, "none"); assert.equal(r.state.mode, "action");
  assert.ok(r.feedback.includes("Delete cancelled"));
});
test("action menu: 4/5/6 set reminders at +1h / +24h / tonight 23:59", () => {
  const action: TishlState = { mode: "action", pos: 0, kind: "task", id: 5 };
  let r = handleTishlDigit(action, "4", 4, NOW, TZ);
  assert.equal(r.effect.type, "remind");
  if (r.effect.type === "remind") assert.equal(r.effect.at.toISOString(), "2026-11-19T21:00:00.000Z");
  r = handleTishlDigit(action, "5", 4, NOW, TZ);
  if (r.effect.type === "remind") assert.equal(r.effect.at.toISOString(), "2026-11-20T20:00:00.000Z");
  r = handleTishlDigit(action, "6", 4, NOW, TZ);
  if (r.effect.type === "remind") {
    assert.deepEqual(tzParts(r.effect.at, TZ), { year: 2026, month: 11, day: 19, hour: 23, minute: 59, second: 0 });
  }
  assert.ok(r.feedback.includes("Reminder set for Thursday, November 19, 2026 at 11 59 P M"));
});
test("action menu: 1 on a message starts a full read; 1 on a task is contextual", () => {
  const r = handleTishlDigit({ mode: "action", pos: 3, kind: "message", id: 366 }, "1", 4, NOW, TZ);
  assert.equal(r.state.fullRead, true); assert.equal(r.state.chunk, 0); assert.equal(r.state.mode, "listen");
  assert.equal(r.effect.type, "none");
  const t = handleTishlDigit({ mode: "action", pos: 0, kind: "task", id: 5 }, "1", 4, NOW, TZ);
  assert.equal(t.effect.type, "contextual"); assert.equal(t.state.mode, "listen");
  const m = handleTishlDigit({ mode: "action", pos: 2, kind: "missed_call", id: 2 }, "1", 4, NOW, TZ);
  assert.equal(m.effect.type, "contextual");
});
test("action menu: 7 = date choice, 8 = note; 0 and * go back to listening", () => {
  const action: TishlState = { mode: "action", pos: 0, kind: "task", id: 5 };
  assert.equal(handleTishlDigit(action, "7", 4, NOW, TZ).state.mode, "date-choice");
  assert.equal(handleTishlDigit(action, "8", 4, NOW, TZ).state.mode, "note");
  assert.equal(handleTishlDigit(action, "0", 4, NOW, TZ).state.mode, "listen");
  assert.equal(handleTishlDigit(action, "*", 4, NOW, TZ).state.mode, "listen");
});

// --- state machine: date entry -------------------------------------------------
test("date choice: 1 = Jewish, 2 = numeric; anything else re-prompts", () => {
  const choice: TishlState = { mode: "date-choice", pos: 0, kind: "task", id: 5, dateRetries: 0 };
  let r = handleTishlDigit(choice, "1", 4, NOW, TZ);
  assert.equal(r.state.mode, "date-day"); assert.equal(r.state.dateKind, "jewish");
  r = handleTishlDigit(choice, "2", 4, NOW, TZ);
  assert.equal(r.state.mode, "date-day"); assert.equal(r.state.dateKind, "numeric");
  r = handleTishlDigit(choice, "5", 4, NOW, TZ);
  assert.equal(r.state.mode, "date-choice");
  assert.ok(r.feedback.includes("Press 1 for a Jewish date"));
});
test("date entry (numeric): day -> month -> hour -> minute -> reminder set", () => {
  let st: TishlState = { mode: "date-day", pos: 0, kind: "task", id: 5, dateKind: "numeric", dateRetries: 0 };
  let r = handleTishlDigit(st, "2", 4, NOW, TZ); // day 2
  assert.equal(r.state.mode, "date-month"); assert.equal(r.state.dateDay, 2);
  r = handleTishlDigit(r.state, "12#", 4, NOW, TZ); // month 12, trailing pound stripped
  assert.equal(r.state.mode, "date-hour"); assert.equal(r.state.dateMonth, 12);
  r = handleTishlDigit(r.state, "15", 4, NOW, TZ);
  assert.equal(r.state.mode, "date-minute"); assert.equal(r.state.dateHour, 15);
  r = handleTishlDigit(r.state, "30", 4, NOW, TZ);
  assert.equal(r.effect.type, "remind");
  if (r.effect.type === "remind") assert.equal(r.effect.at.toISOString(), "2026-12-02T20:30:00.000Z");
  assert.equal(r.state.mode, "listen");
  assert.ok(r.feedback.includes("Reminder set for Wednesday, December 2, 2026 at 3 30 P M"));
});
test("date entry (Jewish): 15 Nisan resolves to the next occurrence, 2027-04-22", () => {
  let st: TishlState = { mode: "date-day", pos: 0, kind: "task", id: 5, dateKind: "jewish", dateRetries: 0 };
  let r = handleTishlDigit(st, "15", 4, NOW, TZ);
  r = handleTishlDigit(r.state, "8", 4, NOW, TZ); // Nisan
  r = handleTishlDigit(r.state, "10", 4, NOW, TZ);
  r = handleTishlDigit(r.state, "0", 4, NOW, TZ); // minute 0 — NOTE: "0" is a digit here, not back
  assert.equal(r.effect.type, "remind");
  if (r.effect.type === "remind") assert.equal(r.effect.at.toISOString(), "2027-04-22T14:00:00.000Z");
});
test("date entry: invalid input re-prompts once, then cancels to the action menu", () => {
  let st: TishlState = { mode: "date-day", pos: 0, kind: "task", id: 5, dateKind: "numeric", dateRetries: 0 };
  let r = handleTishlDigit(st, "45", 4, NOW, TZ); // day 45 is invalid
  assert.equal(r.state.mode, "date-day"); assert.equal(r.state.dateRetries, 1);
  assert.ok(r.feedback.includes("not valid"));
  r = handleTishlDigit(r.state, "99", 4, NOW, TZ); // second invalid input
  assert.equal(r.state.mode, "action");
  assert.ok(r.feedback.includes("Date entry cancelled"));
});
test("date entry: 0 as a minute value is accepted (not 'back')", () => {
  const st: TishlState = { mode: "date-minute", pos: 0, kind: "task", id: 5, dateKind: "numeric", dateRetries: 0, dateDay: 2, dateMonth: 12, dateHour: 15 };
  const r = handleTishlDigit(st, "0", 4, NOW, TZ);
  assert.equal(r.effect.type, "remind"); // minute 0, not a back-out
});
test("back one level from every mode", () => {
  assert.equal(tishlBackOneLevel({ mode: "listen", pos: 0, kind: null, id: null }), null);
  assert.equal(tishlBackOneLevel({ mode: "action", pos: 0, kind: "task", id: 5 })?.mode, "listen");
  assert.equal(tishlBackOneLevel({ mode: "confirm-delete", pos: 0, kind: "task", id: 5 })?.mode, "action");
  assert.equal(tishlBackOneLevel({ mode: "date-month", pos: 0, kind: "task", id: 5, dateKind: "numeric" })?.mode, "action");
  assert.equal(tishlBackOneLevel({ mode: "note", pos: 0, kind: "task", id: 5 })?.mode, "action");
  const reading = tishlBackOneLevel({ mode: "listen", pos: 3, kind: "message", id: 366, fullRead: true, chunk: 2 });
  assert.equal(reading?.fullRead, false);
  assert.equal(reading?.mode, "listen");
});

// --- after removal --------------------------------------------------------------
test("clampPosAfterRemoval: same index slides the next item in; last item goes past the end", () => {
  assert.deepEqual(clampPosAfterRemoval(1, 4), { pos: 1, empty: false });
  assert.deepEqual(clampPosAfterRemoval(3, 3), { pos: 3, empty: false }); // was last, now past the end
  assert.deepEqual(clampPosAfterRemoval(0, 0), { pos: 0, empty: true });
});
