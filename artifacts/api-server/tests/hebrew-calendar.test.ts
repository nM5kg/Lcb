import test from "node:test";
import assert from "node:assert/strict";
import {
  isHebrewLeapYear, roshHashanahFixed, daysInHebrewYear, daysInHebrewMonth,
  fixedFromHebrew, hebrewFromFixed, hebrewFromGregorian, gregorianFromFixed,
  fixedFromGregorian, formatHebrewDate, hebrewMonthName, PARSHA_NAMES,
  parshaForGregorianDate,
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
test("parsha is computed, not tabulated: spot checks verified against hebcal.com", () => {
  // 5786 (common year)
  assert.equal(parshaForGregorianDate(2025, 9, 27), "Vayeilech");
  assert.equal(parshaForGregorianDate(2026, 3, 14), "Vayakhel-Pekudei"); // double
  // 5787 (leap year): Vayakhel and Pekudei are read separately.
  assert.equal(parshaForGregorianDate(2027, 3, 6), "Vayakhel");
  assert.equal(parshaForGregorianDate(2027, 3, 13), "Pekudei");
  // Past the old table's end (2027-09-25): the Parsha keeps working.
  assert.equal(parshaForGregorianDate(2027, 10, 2), null); // Rosh Hashanah Shabbos
  assert.equal(parshaForGregorianDate(2027, 10, 9), "Ha'azinu");
  assert.equal(parshaForGregorianDate(2027, 10, 30), "Bereshis"); // 5788
  assert.equal(parshaForGregorianDate(2028, 1, 1), "Mikeitz");
  assert.equal(parshaForGregorianDate(2028, 9, 23), "Ha'azinu"); // 5789
  assert.equal(parshaForGregorianDate(2030, 3, 16), "Vayikra"); // 5790
  // Cases that caught the first (wrong) doubling rule: 5781 and 5785
  // read Nitzavim and Vayeilech separately, not combined.
  assert.equal(parshaForGregorianDate(2021, 3, 13), "Vayakhel-Pekudei"); // 5781
  assert.equal(parshaForGregorianDate(2021, 9, 4), "Nitzavim");
  assert.equal(parshaForGregorianDate(2021, 9, 11), "Vayeilech");
  assert.equal(parshaForGregorianDate(2025, 9, 20), "Nitzavim"); // 5785
  assert.equal(parshaForGregorianDate(2025, 5, 3), "Tazria-Metzora"); // 5785
});

test("parsha: a full reading cycle reads portions 1-53 in order", () => {
  // The Shabbatot from just after Simchat Torah to the next Simchat
  // Torah, skipping festival Shabbatot and expanding doubled pairs,
  // must read Bereshis through Ha'azinu in order. (Vezos Habracha is
  // read on Simchat Torah itself, not on a Shabbos.)
  for (const year of [5785, 5786, 5787, 5790, 5795]) {
    const start = fixedFromHebrew(year, 1, 23);
    const end = fixedFromHebrew(year + 1, 1, 23);
    const read: string[] = [];
    for (let f = start + 1; f <= end; f++) {
      const g = gregorianFromFixed(f);
      const d = new Date(Date.UTC(g.year, g.month - 1, g.day));
      if (d.getUTCDay() !== 6) continue;
      const p = parshaForGregorianDate(g.year, g.month, g.day);
      if (p !== null) read.push(p);
    }
    const expanded = read.flatMap((p) => p.split("-"));
    assert.deepEqual(expanded, [...PARSHA_NAMES.slice(0, 53)], "cycle " + year);
  }
});

test("parsha: every year type 5700-5900 has a schedule (no unknown-type nulls)", () => {
  // A Shabbos is null only on a festival. If a year type were unknown
  // the whole year would come back null, so a year with more than a
  // handful of null Shabbatot is a broken schedule, not a festival.
  for (let year = 5780; year <= 5806; year++) {
    const start = fixedFromHebrew(year, 1, 23);
    const end = fixedFromHebrew(year + 1, 1, 23);
    let saturdays = 0, nulls = 0;
    for (let f = start + 1; f <= end; f++) {
      const g = gregorianFromFixed(f);
      const d = new Date(Date.UTC(g.year, g.month - 1, g.day));
      if (d.getUTCDay() !== 6) continue;
      saturdays++;
      if (parshaForGregorianDate(g.year, g.month, g.day) === null) nulls++;
    }
    assert.ok(saturdays >= 45 && saturdays <= 56, "cycle " + year + " saturdays " + saturdays);
    assert.ok(nulls >= 2 && nulls <= 6, "cycle " + year + " festival Shabbatot " + nulls);
  }
});
test("parshaForGregorianDate: the coming Shabbos", () => {
  assert.equal(parshaForGregorianDate(2025, 12, 13), "Vayeshev"); // Shabbos itself
  assert.equal(parshaForGregorianDate(2025, 12, 8), "Vayeshev"); // Monday -> that Shabbos
  assert.equal(parshaForGregorianDate(2025, 9, 23), "Vayeilech"); // Tuesday of RH week
  assert.equal(parshaForGregorianDate(2026, 3, 14), "Vayakhel-Pekudei");
  assert.equal(parshaForGregorianDate(2027, 3, 6), "Vayakhel");
  assert.equal(parshaForGregorianDate(2027, 3, 13), "Pekudei");
});
test("parshaForGregorianDate: festival Shabbos returns null, past dates still work", () => {
  assert.equal(parshaForGregorianDate(2026, 4, 4), null); // Pesach Shabbos
  assert.equal(parshaForGregorianDate(2025, 10, 11), null); // Sukkot Shabbos
  assert.equal(parshaForGregorianDate(2026, 5, 23), null); // Shavuot Shabbos
  // Past the old table's end there is no range limit any more.
  assert.equal(parshaForGregorianDate(2028, 1, 1), "Mikeitz");
  assert.equal(parshaForGregorianDate(2035, 6, 2), "Bamidbar");
});
