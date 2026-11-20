// Day names — Jewish calendar (Yakob 2026-11-20 00:07–00:08, standing rule).
// Friday is ALWAYS the full phrase "Friday Erev Shabbos Kodesh" /
// "פרייטאג ערב שבת קודש" — a bare "Friday" and a bare "Erev Shabbos
// Kodesh" are BOTH violations for a Friday rendering. Saturday renders
// as Motzei Shabbos Kodesh. "Shabbos" / "שבת" must NEVER appear except
// inside those two phrases — never "Shabbos Kodesh", never "today is
// Shabbos". The single rendering helper is formatSpokenDateTime in
// tishl-phone.ts (used by Tishl reminders AND Calling schedules incl.
// pickup); the Yiddish forms live beside it for Yiddish prompts.
// hebrew-calendar.ts is NOT touched by this rule (Parsha rule stands).
//
// Run from artifacts/api-server:
//   DATABASE_URL='postgresql://user:pass@localhost:5432/dummy' \
//     node --test --import ./tests/register-ts-resolve.mjs tests/day-names.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSpokenDateTime, spokenDayName, describeTishlItem, actionMenuSpeech,
  hebrewMonthChoicesSpeech, splitSpeechChunks,
} from "../src/lib/tishl-phone.ts";
import type { TishlQueueItemView } from "../src/lib/tishl-phone.ts";
import {
  CALLING_TZ, handleCallingDigit,
  callingMenuSpeech, filterMenuSpeech, describeCallingItem, detailMenuSpeech,
  contactMenuSpeech, editFieldSpeech, editValueSpeech, selectCaseSpeech,
  phoneEntrySpeech, fillOutcomeSpeech, fillAmountSpeech, fillNoteSpeech,
  fillMoodSpeech, fillMethodSpeech, fillPaidSpeech, fillPaidAmountSpeech,
  pickupAddressSpeech, dateChoiceSpeech, dateYearSpeech,
  callingHebrewMonthChoicesSpeech,
} from "../src/lib/calling-phone.ts";
import type { CallingContext, CallingItemView, CallingState } from "../src/lib/calling-phone.ts";
import {
  categoriesMenuSpeech, categoryValuesSpeech, describeCategoryValue,
  describeCategoryContact, amountEntrySpeech,
} from "../src/lib/calling-categories.ts";
import {
  TRUE_ROOT_ENGLISH, DEPT_FIRST_SCREEN, LIVE_STUB_TEXT,
  GATE_FIRST_EN, GATE_REPROMPT_EN, GATE_WRONG_EN, GATE_NEED_ID_EN,
  GATE_WRONG_ID_EN, GATE_PASSWORD_EN, GATE_LOCKED_EN, GATE_WELCOME_EN,
} from "../src/lib/true-menu.ts";

const TZ = CALLING_TZ;
const NOW = new Date("2026-11-19T15:00:00-05:00"); // Thursday, 3 PM New York

const tishlItem: TishlQueueItemView =
  { kind: "task", id: 5, title: "Call the printer", detail: "Main case", phone: null, created_at: "2026-11-19T10:00:00Z", held: false };
const callItem: CallingItemView =
  { kind: "session", id: 9, title: "Call to +17185551234", detail: "completed", phone: "+17185551234", created_at: "2026-11-19T10:00:00Z" };

/** The spoken prompt set this build touches (English TTS prompts + the
 *  day-name renderings). Engine inline strings are covered by the audit
 *  in the report (grep: only formatSpokenDateTime renders a weekday). */
function promptSet(): string[] {
  return [
    TRUE_ROOT_ENGLISH,
    GATE_FIRST_EN, GATE_REPROMPT_EN, GATE_WRONG_EN, GATE_NEED_ID_EN,
    GATE_WRONG_ID_EN, GATE_PASSWORD_EN, GATE_LOCKED_EN, GATE_WELCOME_EN,
    LIVE_STUB_TEXT, ...Object.values(DEPT_FIRST_SCREEN),
    callingMenuSpeech("signalwire"), callingMenuSpeech("yemot"),
    filterMenuSpeech(),
    describeCallingItem(callItem, 0, 3),
    detailMenuSpeech(4, callItem, "signalwire"),
    detailMenuSpeech(5, callItem, "yemot"),
    contactMenuSpeech(callItem),
    editFieldSpeech(), editValueSpeech("name"), editValueSpeech("address"), editValueSpeech("note"),
    selectCaseSpeech(), phoneEntrySpeech(), fillOutcomeSpeech(), fillAmountSpeech(),
    fillNoteSpeech(), fillMoodSpeech(), fillMethodSpeech(), fillPaidSpeech(),
    fillPaidAmountSpeech(), pickupAddressSpeech(), dateChoiceSpeech(),
    dateYearSpeech("jewish"), dateYearSpeech("numeric"),
    callingHebrewMonthChoicesSpeech(5787),
    categoriesMenuSpeech(), categoryValuesSpeech("Result"),
    describeCategoryValue("Given", 0, 4),
    describeCategoryContact("Cohen", "+17185551234", "Given $250", 0, 2),
    amountEntrySpeech(),
    describeTishlItem(tishlItem, 0, 4),
    actionMenuSpeech(tishlItem), actionMenuSpeech(null),
    hebrewMonthChoicesSpeech(5787), hebrewMonthChoicesSpeech(5787, true),
    splitSpeechChunks("Hello world, this is a test message for the prompt set.").join(" "),
    // Every weekday rendering, both languages.
    ...[15, 16, 17, 18, 19, 20, 21].map((d) =>
      formatSpokenDateTime(new Date(`2026-11-${d}T12:00:00-05:00`), TZ)),
    ...[15, 16, 17, 18, 19, 20, 21].map((d) =>
      spokenDayName(new Date(`2026-11-${d}T12:00:00-05:00`), TZ, "en")),
    ...[15, 16, 17, 18, 19, 20, 21].map((d) =>
      spokenDayName(new Date(`2026-11-${d}T12:00:00-05:00`), TZ, "yi")),
  ];
}

/** Remove the ONLY allowed Shabbos/Friday phrases, then nothing
 *  Shabbos- or Friday-like may remain. A bare "Erev Shabbos Kodesh"
 *  (no Friday) or a bare "Friday" (no Erev) does not match the full
 *  phrase, so it survives the strip and fails the assertions below. */
function stripAllowed(s: string): string {
  return s
    .replaceAll("Friday Erev Shabbos Kodesh", "")
    .replaceAll("Motzei Shabbos Kodesh", "")
    .replaceAll("פרייטאג ערב שבת קודש", "")
    .replaceAll("מוצאי שבת קודש", "");
}

test("no spoken prompt contains Shabbos except inside Erev/Motzei Shabbos Kodesh", () => {
  for (const s of promptSet()) {
    const stripped = stripAllowed(s);
    assert.ok(!/Shabbos/i.test(stripped), `bare Shabbos in: ${s}`);
    assert.ok(!/שבת/.test(stripped), `bare שבת in: ${s}`);
    assert.ok(!/today is Shabbos/i.test(stripped), `today is Shabbos in: ${s}`);
    assert.ok(!/Shabbos Kodesh/i.test(stripped), `bare Shabbos Kodesh in: ${s}`);
  }
});

test("no spoken prompt contains a bare Friday as a day name", () => {
  for (const s of promptSet()) {
    const stripped = stripAllowed(s);
    assert.ok(!/\bFriday\b/.test(stripped), `bare Friday in: ${s}`);
  }
});

test("formatSpokenDateTime renders Friday as the full phrase and Saturday as Motzei", () => {
  // Week of 2026-11-15 (Sunday) to 2026-11-21 (Saturday), New York.
  const at = (d: number) => new Date(`2026-11-${d}T15:30:00-05:00`);
  assert.equal(formatSpokenDateTime(at(15), TZ), "Sunday, November 15, 2026 at 3 30 P M");
  assert.equal(formatSpokenDateTime(at(16), TZ), "Monday, November 16, 2026 at 3 30 P M");
  assert.equal(formatSpokenDateTime(at(17), TZ), "Tuesday, November 17, 2026 at 3 30 P M");
  assert.equal(formatSpokenDateTime(at(18), TZ), "Wednesday, November 18, 2026 at 3 30 P M");
  assert.equal(formatSpokenDateTime(at(19), TZ), "Thursday, November 19, 2026 at 3 30 P M");
  assert.equal(
    formatSpokenDateTime(at(20), TZ),
    "Friday Erev Shabbos Kodesh, November 20, 2026 at 3 30 P M");
  assert.equal(
    formatSpokenDateTime(at(21), TZ),
    "Motzei Shabbos Kodesh, November 21, 2026 at 3 30 P M");
});

test("spokenDayName renders every day in English and in Yiddish", () => {
  const at = (d: number) => new Date(`2026-11-${d}T12:00:00-05:00`);
  assert.deepEqual([15, 16, 17, 18, 19, 20, 21].map((d) => spokenDayName(at(d), TZ, "en")),
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
     "Friday Erev Shabbos Kodesh", "Motzei Shabbos Kodesh"]);
  assert.deepEqual([15, 16, 17, 18, 19, 20, 21].map((d) => spokenDayName(at(d), TZ, "yi")),
    ["זונטאג", "מאָנטאג", "דינסטאג", "מיטוואך", "דאנערשטאג",
     "פרייטאג ערב שבת קודש", "מוצאי שבת קודש"]);
});

test("Calling schedule feedback announces Friday as Friday Erev Shabbos Kodesh (option 6, numeric)", () => {
  const c: CallingContext = { provider: "signalwire", option: 6, listLength: 3 };
  const start: CallingState = {
    mode: "date-choice", option: 6, pos: 0, kind: null, id: null,
    phone: "+17185551234", casePos: null, returnTo: "menu", dateRetries: 0,
  };
  let cur = start;
  let last: ReturnType<typeof handleCallingDigit> | null = null;
  // Friday, December 25, 2026, 10:00 — numeric month-first entry.
  for (const d of ["2", "12", "25", "2026", "10", "0"]) {
    last = handleCallingDigit(cur, d, c, NOW, TZ);
    cur = last.state;
  }
  assert.equal(last!.effect.type, "schedule");
  assert.ok(last!.feedback.includes("Friday Erev Shabbos Kodesh, December 25, 2026 at 10 00 A M"),
    last!.feedback);
  assert.ok(!last!.feedback.includes("Friday,"), last!.feedback); // no bare Friday
  assert.ok(!/Shabbos/i.test(stripAllowed(last!.feedback)));
});

test("Calling schedule feedback announces Saturday as Motzei Shabbos Kodesh (option 6, numeric)", () => {
  const c: CallingContext = { provider: "signalwire", option: 6, listLength: 3 };
  const start: CallingState = {
    mode: "date-choice", option: 6, pos: 0, kind: null, id: null,
    phone: "+17185551234", casePos: null, returnTo: "menu", dateRetries: 0,
  };
  let cur = start;
  let last: ReturnType<typeof handleCallingDigit> | null = null;
  // Saturday, November 21, 2026, 20:00.
  for (const d of ["2", "11", "21", "2026", "20", "0"]) {
    last = handleCallingDigit(cur, d, c, NOW, TZ);
    cur = last.state;
  }
  assert.equal(last!.effect.type, "schedule");
  assert.ok(last!.feedback.includes("Motzei Shabbos Kodesh, November 21, 2026 at 8 00 P M"),
    last!.feedback);
  assert.ok(!last!.feedback.includes("Saturday"), last!.feedback);
});

test("Pickup scheduling announces Friday as Friday Erev Shabbos Kodesh", () => {
  const c: CallingContext = { provider: "signalwire", option: 2, listLength: 3 };
  const start: CallingState = {
    mode: "fill-outcome", option: 2, pos: 0, kind: null, id: null,
    phone: "+17185551234", casePos: null, source: "manual",
  };
  let cur = start;
  let last: ReturnType<typeof handleCallingDigit> | null = null;
  // Pickup (6) -> numeric date -> Friday, December 25, 2026, 10:00.
  for (const d of ["6", "2", "12", "25", "2026", "10", "0"]) {
    last = handleCallingDigit(cur, d, c, NOW, TZ);
    cur = last.state;
  }
  assert.equal(last!.effect.type, "schedule");
  assert.equal(cur.mode, "pickup-address");
  assert.ok(last!.feedback.includes("Friday Erev Shabbos Kodesh, December 25, 2026 at 10 00 A M"),
    last!.feedback);
  assert.ok(!last!.feedback.includes("Friday,"), last!.feedback);
});
