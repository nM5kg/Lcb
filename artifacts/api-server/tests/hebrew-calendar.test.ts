import test from "node:test";
import assert from "node:assert/strict";
import {
  isHebrewLeapYear, roshHashanahFixed, daysInHebrewYear, daysInHebrewMonth,
  fixedFromHebrew, hebrewFromFixed, hebrewFromGregorian, gregorianFromFixed,
  fixedFromGregorian, formatHebrewDate, hebrewMonthName, PARSHA_NAMES,
  PARSHA_TABLE, parshaForGregorianDate,
} from "../src/lib/hebrew-calendar.ts";

// Anchors verified against hebcal.com, November 2026.
// (The task brief listed 2025-09-22 / 2026-04-01 / 2026-09-11 — those are
// the EREV dates. The correct daytime dates are used here.)

test("anchors: 1 Tishrei 5786 = 2025-09-23", () => {
  assert.deepEqual(gregorianFromFixed(fixedFromHebrew(5786, 1, 1)), { year: 2025, month: 9, day: 23 });
});
test("anchors: 15 Nisan 5786 = 2026-04-02", () => {
  assert.deepEqual(gregorianFromFixed(fixedFromHebrew(5786, 8, 15)), { year: 2026, month: 4, day: 2 });
});
test("anchors: 1 Tishrei 5787 = 2026-09-12", () => {
  assert.deepEqual(gregorianFromFixed(fixedFromHebrew(5787, 1, 1)), { year: 2026, month: 9, day: 12 });
});
test("anchors: more Rosh Hashanah dates from hebcal", () => {
  const cases: [number, number, number, number][] = [
    [5785, 10, 3, 2024], [5788, 10, 2, 2027], [5789, 9, 21, 2028],
    [5762, 9, 18, 2001], [5763, 9, 7, 2002], [5764, 9, 27, 2003],
    [5766, 10, 4, 2005], [5771, 9, 9, 2010], [5772, 9, 29, 2011],
    [5773, 9, 17, 2012], [5738, 9, 13, 1977], [5739, 10, 2, 1978],
    [5610, 9, 17, 1849], [5630, 9, 6, 1869], [5822, 9, 15, 2061],
    [5823, 10, 5, 2062],
  ];
  for (const [y, m, d, gy] of cases) {
    assert.deepEqual(gregorianFromFixed(roshHashanahFixed(y)), { year: gy, month: m, day: d },
      "RH " + y);
  }
});
test("anchors: other holidays from hebcal", () => {
  assert.deepEqual(gregorianFromFixed(fixedFromHebrew(5786, 3, 25)), { year: 2025, month: 12, day: 15 }); // 25 Kislev 5786
  assert.deepEqual(gregorianFromFixed(fixedFromHebrew(5786, 6, 14)), { year: 2026, month: 3, day: 3 }); // 14 Adar 5786
  assert.deepEqual(gregorianFromFixed(fixedFromHebrew(5786, 10, 6)), { year: 2026, month: 5, day: 22 }); // 6 Sivan 5786
  assert.deepEqual(gregorianFromFixed(fixedFromHebrew(5787, 7, 14)), { year: 2027, month: 3, day: 23 }); // 14 Adar II 5787
});
test("leap years follow the 19-year cycle", () => {
  assert.equal(isHebrewLeapYear(5787), true);
  assert.equal(isHebrewLeapYear(5786), false);
  assert.equal(isHebrewLeapYear(5784), true);
  assert.equal(isHebrewLeapYear(5782), true);
});
test("year lengths are only 353/354/355 (common) and 383/384/385 (leap), years 5600-6000", () => {
  for (let y = 5600; y <= 6000; y++) {
    const len = daysInHebrewYear(y);
    if (isHebrewLeapYear(y)) assert.ok(len === 383 || len === 384 || len === 385, y + " -> " + len);
    else assert.ok(len === 353 || len === 354 || len === 355, y + " -> " + len);
  }
});
test("month lengths: Cheshvan/Kislev vary, Adar II is 0 in common years", () => {
  assert.equal(daysInHebrewMonth(5786, 7), 0); // common year, no Adar II
  assert.equal(daysInHebrewMonth(5787, 7), 29); // leap year
  assert.equal(daysInHebrewMonth(5786, 6), 29); // Adar in a common year
  assert.equal(daysInHebrewMonth(5787, 6), 30); // Adar I in a leap year
  assert.equal(hebrewMonthName(5787, 6), "Adar I");
  assert.equal(hebrewMonthName(5786, 6), "Adar");
  assert.equal(hebrewMonthName(5787, 7), "Adar II");
  // 5786 is 354 days: Cheshvan 29, Kislev 30
  assert.equal(daysInHebrewYear(5786), 354);
  assert.equal(daysInHebrewMonth(5786, 2), 29);
  assert.equal(daysInHebrewMonth(5786, 3), 30);
});
test("round-trip conversions are exact", () => {
  // Every day from 2025-01-01 to 2028-12-31.
  for (let ms = Date.UTC(2025, 0, 1); ms <= Date.UTC(2028, 11, 31); ms += 86400000) {
    const d = new Date(ms);
    const g = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const h = hebrewFromGregorian(g.year, g.month, g.day);
    const back = gregorianFromFixed(fixedFromHebrew(h.year, h.month, h.day));
    assert.deepEqual(back, g, "round trip " + g.year + "-" + g.month + "-" + g.day);
    const h2 = hebrewFromFixed(fixedFromGregorian(g.year, g.month, g.day));
    assert.deepEqual(h2, h);
  }
});
test("hebrewFromGregorian: known dates", () => {
  assert.deepEqual(hebrewFromGregorian(2025, 9, 23), { year: 5786, month: 1, day: 1 });
  assert.deepEqual(hebrewFromGregorian(2026, 4, 2), { year: 5786, month: 8, day: 15 });
  assert.deepEqual(hebrewFromGregorian(2026, 9, 12), { year: 5787, month: 1, day: 1 });
  assert.deepEqual(hebrewFromGregorian(2025, 9, 22), { year: 5785, month: 13, day: 29 }); // Erev RH 5786
});
test("formatHebrewDate speaks Latin letters", () => {
  assert.equal(formatHebrewDate({ year: 5786, month: 3, day: 3 }), "3rd of Kislev, 5786");
  assert.equal(formatHebrewDate({ year: 5786, month: 1, day: 1 }), "1st of Tishrei, 5786");
  assert.equal(formatHebrewDate({ year: 5787, month: 7, day: 14 }), "14th of Adar II, 5787");
});
test("54 Parsha names in order", () => {
  assert.equal(PARSHA_NAMES.length, 54);
  assert.equal(PARSHA_NAMES[0], "Bereshis");
  assert.equal(PARSHA_NAMES[53], "Vezos Habracha");
});
test("Parsha table covers 5786-5787, one entry per Shabbos with a reading", () => {
  assert.equal(PARSHA_TABLE.length, 97);
  assert.equal(PARSHA_TABLE[0].date, "2025-09-27");
  assert.equal(PARSHA_TABLE[PARSHA_TABLE.length - 1].date, "2027-09-25");
  const seen = new Set(PARSHA_TABLE.map((r) => r.date));
  assert.equal(seen.size, PARSHA_TABLE.length);
  for (const row of PARSHA_TABLE) assert.ok(row.parsha.length > 0, row.date);
});
test("parshaForGregorianDate: the coming Shabbos", () => {
  assert.equal(parshaForGregorianDate(2025, 12, 13), "Vayeshev"); // Shabbos itself
  assert.equal(parshaForGregorianDate(2025, 12, 8), "Vayeshev"); // Monday -> that Shabbos
  assert.equal(parshaForGregorianDate(2025, 9, 23), "Vayeilech"); // Tuesday of RH week
  assert.equal(parshaForGregorianDate(2026, 3, 14), "Vayakhel-Pekudei");
  assert.equal(parshaForGregorianDate(2027, 3, 6), "Vayakhel");
  assert.equal(parshaForGregorianDate(2027, 3, 13), "Pekudei");
});
test("parshaForGregorianDate: festival Shabbos and out of range return null", () => {
  assert.equal(parshaForGregorianDate(2026, 4, 4), null); // Pesach Shabbos
  assert.equal(parshaForGregorianDate(2025, 10, 11), null); // Sukkot Shabbos
  assert.equal(parshaForGregorianDate(2026, 5, 23), null); // Shavuot Shabbos
  assert.equal(parshaForGregorianDate(2028, 1, 1), null); // past the table
});
