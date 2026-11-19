/**
 * Hebrew calendar for the Tishl phone menu (IVR path 1591).
 *
 * Pure arithmetic, including a computed Parsha. No database, no network,
 * no table to regenerate: the Parsha is derived from the Hebrew date, so
 * it never expires.
 *
 * ALGORITHM (Rosh Hashanah postponement rules / Dechiyot)
 * --------------------------------------------------------
 * The molad (mean new moon) of Tishrei is computed from the molad Beharad
 * and the mean lunation of 29 days, 12 hours, 793 parts (1 part = 1/1080
 * hour; 1 day = 25,920 parts). The hours are counted in the traditional
 * way, from 18:00 (the start of the Jewish day), NOT from midnight:
 * Beharad is "Monday, 5 hours, 204 parts", i.e. Sunday 23:12 civil time.
 * In the midnight frame used here that is -876 parts before Monday 00:00.
 * (An earlier draft used +5,604 parts, i.e. Monday 05:12 civil, which is
 * 6 hours late and gives the wrong Rosh Hashanah for 5738, 5763 and 5789.)
 *
 * From the molad, Rosh Hashanah is fixed by four postponement rules:
 *  1. Molad Zaken: molad at/after 18:00 traditional time (civil noon)
 *     moves Rosh Hashanah to the next day.
 *  2. Lo ADU Rosh: Rosh Hashanah may not fall on Sunday, Wednesday or Friday.
 *  3. GaTRaD: molad on Tuesday at/after 9h 204p (9,924 parts), when
 *     Molad Zaken did NOT already move the day, and the CURRENT year is a
 *     common year, moves Rosh Hashanah two days later (to Thursday).
 *     (Without it the common year would be 356 days long.)
 *  4. BeTU TaKPaT: molad on Monday at/after 15h 589p (16,789 parts), when
 *     Molad Zaken did NOT already move the day, and the PREVIOUS year was
 *     a leap year, moves Rosh Hashanah one day later (to Tuesday).
 *     (Without it the year would be 352 days long.)
 * Rules 3 and 4 test the MOLAD's Jewish weekday, and they do not fire when
 * Molad Zaken already moved the day (e.g. a Tuesday molad at 23:15
 * traditional time is already Wednesday after Zaken, so GaTRaD stays out).
 *
 * VERIFICATION (all checked against hebcal.com, November 2026)
 * ------------------------------------------------------------
 *  1 Tishrei 5785 = 2024-10-03, 5786 = 2025-09-23, 5787 = 2026-09-12,
 *  5788 = 2027-10-02, 5789 = 2028-09-21, 5790 = 2029-09-10,
 *  15 Nisan 5786 = 2026-04-02, 25 Kislev 5786 = 2025-12-15,
 *  14 Adar 5786 = 2026-03-03, 6 Sivan 5786 = 2026-05-22,
 *  14 Adar II 5787 = 2027-03-23 (Purim 5787),
 *  1 Tishrei 5762 = 2001-09-18, 5763 = 2002-09-07, 5764 = 2003-09-27,
 *  5766 = 2005-10-04, 5771 = 2010-09-09, 5772 = 2011-09-29,
 *  5773 = 2012-09-17, 5738 = 1977-09-13, 5739 = 1978-10-02,
 *  5610 = 1849-09-17, 5630 = 1869-09-06, 5822 = 2061-09-15,
 *  5823 = 2062-10-05.
 * Over Hebrew years 5600-6000 every year length is 353/354/355 (common)
 * or 383/384/385 (leap), and round-trip conversions are exact.
 * NOTE: a task brief that listed "1 Tishrei 5786 = 2025-09-22",
 * "15 Nisan 5786 = 2026-04-01" and "1 Tishrei 5787 = 2026-09-11" was
 * using the EREV (evening-before) dates. The correct daytime dates are
 * 2025-09-23, 2026-04-02 and 2026-09-12. This module uses the daytime dates.
 *
 * MONTH NUMBERING (phone)
 * ------------------------
 * The phone asks for the month by number on a FIXED 13-slot list, so the
 * numbers never shift between leap and common years:
 *  1 Tishrei, 2 Cheshvan, 3 Kislev, 4 Teves, 5 Shevat, 6 Adar (Adar I in a
 *  leap year), 7 Adar II (leap years only), 8 Nisan, 9 Iyar, 10 Sivan,
 *  11 Tammuz, 12 Av, 13 Elul.
 * Slot 7 does not exist in a common year; a date-entry for it resolves to
 * the next leap year.
 *
 * PARSHA — COMPUTED FROM THE HEBREW DATE
 * ----------------------------------------
 * The reading cycle for Hebrew year Y runs from Simchat Torah
 * (23 Tishrei, year Y) to the next Simchat Torah (23 Tishrei, year Y+1).
 * Bereshis is read on the first Shabbos after Simchat Torah; the last
 * readings are Ha'azinu on Shabbos Shuva (the Shabbos between Rosh
 * Hashanah and Yom Kippur of year Y+1) and Vezos Habracha on Simchat
 * Torah itself. A Shabbos that is a Yom Tov or Chol Hamoed day
 * (Diaspora calendar) has no weekly Parsha:
 *   Tishrei 1, 2 (Rosh Hashanah), 10 (Yom Kippur), 15-22 (Sukkot);
 *   Nisan 15-22 (Pesach); Sivan 6, 7 (Shavuot).
 * 23 Tishrei itself is a reading day (Vezos Habracha), even though it
 * is a festival. (23 Tishrei can never fall on Shabbos — Rosh Hashanah
 * is never Friday — so Vezos Habracha is read on Simchat Torah the
 * weekday, and 53 portions fall on Shabbatot.)
 *
 * With 54 portions to read and fewer reading Shabbatot in the cycle,
 * some pairs are read together. WHICH pairs are combined is fixed by
 * the year's type (keviyah): whether the year is a leap year, the
 * weekday of Rosh Hashanah, and whether Cheshvan and Kislev are long
 * or short (incomplete / regular / complete). There are 14 such year
 * types, and each has a fixed list of what is read on every Shabbos
 * from the first Shabbos on or after Rosh Hashanah: a parsha, a
 * doubled pair, or a festival (no weekly Parsha that Shabbos). The
 * last readings of a cycle — Nitzavim, Vayeilech, Ha'azinu — fall at
 * the head of the NEXT year's list, so a Shabbos past the end of one
 * year's list is read from the next year's list.
 *
 * This is the traditional luach schedule (Diaspora reading), the same
 * one hebcal.com publishes; the lists below are that schedule, in the
 * phone's own numbering. Nothing here is dated: the same 14 year
 * types repeat forever, so the Parsha never expires.
 *
 * VERIFICATION: the computed readings reproduce, entry for entry, the
 * static 5786-5787 table this replaced (97 entries plus the festival
 * nulls), and match hebcal.com for every Shabbos of Hebrew years
 * 5780-5806 (see tests).
 */

// Fixed (Rata Die) day numbers: R.D. 1 = Monday 1 January year 1.
const DAY_MS = 86400000;
const RD_1970_01_01 = 719163;
// Fixed day of 1 Tishrei, Hebrew year 1 (a Monday).
const HEBREW_EPOCH = -1373427;
// 1 part = 1/1080 hour; 1 day = 24 * 1080 = 25,920 parts.
const PARTS_PER_DAY = 25920;
// Mean lunation: 29 days, 12 hours, 793 parts.
const LUNATION_PARTS = 29 * PARTS_PER_DAY + 12 * 1080 + 793;
// Molad Beharad (Tishrei year 1): Jewish Monday, 5h 204p after 18:00,
// i.e. Sunday 23:12 civil time = -876 parts from Monday 00:00.
const BEHARAD_PARTS = -876;
// Postponement thresholds, in traditional parts (hours since 18:00).
const MOLAD_ZAKEN_PARTS = 18 * 1080; // 19,440 = 18:00 traditional (noon civil)
const GATRAD_PARTS = 9 * 1080 + 204; // 9,924 = 9h 204p
const BETU_PARTS = 15 * 1080 + 589; // 16,789 = 15h 589p

export function isHebrewLeapYear(year: number): boolean {
  return (7 * year + 1) % 19 < 7;
}

function monthsElapsed(year: number): number {
  return Math.floor((235 * year - 234) / 19);
}

function mod7(n: number): number {
  return ((n % 7) + 7) % 7;
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function floorMod(a: number, b: number): number {
  return a - Math.floor(a / b) * b;
}

/** Fixed day of 1 Tishrei for a Hebrew year (Rosh Hashanah). */
export function roshHashanahFixed(year: number): number {
  const parts = BEHARAD_PARTS + LUNATION_PARTS * monthsElapsed(year);
  const civilDay = HEBREW_EPOCH + floorDiv(parts, PARTS_PER_DAY);
  const civilTime = floorMod(parts, PARTS_PER_DAY);
  // Jewish day J and traditional time T (hours since 18:00, start of day).
  const jewishDay = civilTime < 18 * 1080 ? civilDay : civilDay + 1;
  const traditionalTime = civilTime < 18 * 1080 ? civilTime + 6 * 1080 : civilTime - 18 * 1080;
  const moladWeekday = mod7(jewishDay);
  let rh = jewishDay;
  // 1. Molad Zaken: molad at/after 18:00 traditional time.
  if (traditionalTime >= MOLAD_ZAKEN_PARTS) rh += 1;
  // 2. Lo ADU Rosh: not Sunday (0), Wednesday (3) or Friday (5).
  const dow = mod7(rh);
  if (dow === 0 || dow === 3 || dow === 5) rh += 1;
  // 3. GaTRaD: molad Tuesday, 9h204p or later, Zaken did not fire,
  //    current year is common -> +2 days (to Thursday).
  if (moladWeekday === 2 && traditionalTime >= GATRAD_PARTS &&
      traditionalTime < MOLAD_ZAKEN_PARTS && !isHebrewLeapYear(year)) rh += 2;
  // 4. BeTU TaKPaT: molad Monday, 15h589p or later, Zaken did not fire,
  //    previous year was a leap year -> +1 day (to Tuesday).
  if (moladWeekday === 1 && traditionalTime >= BETU_PARTS &&
      traditionalTime < MOLAD_ZAKEN_PARTS && isHebrewLeapYear(year - 1)) rh += 1;
  return rh;
}

export function daysInHebrewYear(year: number): number {
  return roshHashanahFixed(year + 1) - roshHashanahFixed(year);
}

/**
 * Days in a Hebrew month, by the fixed 13-slot numbering (see header).
 * Slot 7 (Adar II) is 0 in a common year: it does not exist.
 */
export function daysInHebrewMonth(year: number, slot: number): number {
  const len = daysInHebrewYear(year);
  const leap = isHebrewLeapYear(year);
  switch (slot) {
    case 1: return 30; // Tishrei
    case 2: return len === 355 || len === 385 ? 30 : 29; // Cheshvan
    case 3: return len === 353 || len === 383 ? 29 : 30; // Kislev
    case 4: return 29; // Teves
    case 5: return 30; // Shevat
    case 6: return leap ? 30 : 29; // Adar I / Adar
    case 7: return leap ? 29 : 0; // Adar II (leap only)
    case 8: return 30; // Nisan
    case 9: return 29; // Iyar
    case 10: return 30; // Sivan
    case 11: return 29; // Tammuz
    case 12: return 30; // Av
    case 13: return 29; // Elul
    default: return 0;
  }
}

export const HEBREW_MONTH_NAMES_13: readonly string[] = [
  "Tishrei", "Cheshvan", "Kislev", "Teves", "Shevat", "Adar", "Adar II",
  "Nisan", "Iyar", "Sivan", "Tammuz", "Av", "Elul",
];

/** Transliterated month name for a slot in a given year. */
export function hebrewMonthName(year: number, slot: number): string {
  if (slot === 6 && isHebrewLeapYear(year)) return "Adar I";
  return HEBREW_MONTH_NAMES_13[slot - 1] || "";
}

export type HebrewDate = { year: number; month: number; day: number };

export function fixedFromGregorian(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS) + RD_1970_01_01;
}

export function gregorianFromFixed(fixed: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(1970, 0, 1) + (fixed - RD_1970_01_01) * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Fixed day of a Hebrew date (slot numbering, see header). */
export function fixedFromHebrew(year: number, slot: number, day: number): number {
  let fixed = roshHashanahFixed(year);
  for (let s = 1; s < slot; s++) fixed += daysInHebrewMonth(year, s);
  return fixed + (day - 1);
}

export function hebrewFromFixed(fixed: number): HebrewDate {
  let year = Math.floor((fixed - HEBREW_EPOCH) / 366) + 1;
  while (roshHashanahFixed(year + 1) <= fixed) year++;
  while (roshHashanahFixed(year) > fixed) year--;
  let remaining = fixed - roshHashanahFixed(year);
  let slot = 1;
  while (slot <= 13) {
    const len = daysInHebrewMonth(year, slot);
    if (len === 0) { slot++; continue; }
    if (remaining < len) break;
    remaining -= len;
    slot++;
  }
  return { year, month: slot, day: remaining + 1 };
}

export function hebrewFromGregorian(year: number, month: number, day: number): HebrewDate {
  return hebrewFromFixed(fixedFromGregorian(year, month, day));
}

function ordinal(n: number): string {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return n + "th";
}

/** Latin-letter Hebrew date for the English phone voice, e.g. "3rd of Kislev, 5786". */
export function formatHebrewDate(h: HebrewDate): string {
  return ordinal(h.day) + " of " + hebrewMonthName(h.year, h.month) + ", " + h.year;
}

/** The 54 weekly Parshiyot in order, transliterated. */
export const PARSHA_NAMES: readonly string[] = [
  "Bereshis", "Noach", "Lech Lecha", "Vayeira", "Chayei Sarah", "Toldos",
  "Vayetzei", "Vayishlach", "Vayeshev", "Mikeitz", "Vayigash", "Vayechi",
  "Shemos", "Va'eira", "Bo", "Beshalach", "Yisro", "Mishpatim", "Terumah",
  "Tetzaveh", "Ki Sisa", "Vayakhel", "Pekudei", "Vayikra", "Tzav", "Shemini",
  "Tazria", "Metzora", "Achrei Mot", "Kedoshim", "Emor", "Behar", "Bechukosai",
  "Bamidbar", "Naso", "Beha'aloscha", "Shelach", "Korach", "Chukas", "Balak",
  "Pinchas", "Matos", "Masei", "Devarim", "Va'eschanan", "Eikev", "Re'eh",
  "Shoftim", "Ki Seitzei", "Ki Savo", "Nitzavim", "Vayeilech", "Ha'azinu",
  "Vezos Habracha",
];

/** One week of a reading year: a parsha index (0-based), a doubled pair (negative: -p means parshiyot p and p+1 together), or a festival (null — no weekly Parsha). */
type SedraEntry = number | null;

const SEDRA_020: readonly SedraEntry[] = [51, 52, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, -21, 23, 24, null, 25, -26, -28, 30, -31, 33, 34, 35, 36, 37, 38, 39, 40, -41, 43, 44, 45, 46, 47, 48, 49, -50];
const SEDRA_022: readonly SedraEntry[] = [51, 52, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, -21, 23, 24, null, 25, -26, -28, 30, -31, 33, null, 34, 35, 36, 37, -38, 40, -41, 43, 44, 45, 46, 47, 48, 49, -50];
const SEDRA_051: readonly SedraEntry[] = [52, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, -21, 23, 24, null, null, 25, -26, -28, 30, -31, 33, 34, 35, 36, 37, 38, 39, 40, -41, 43, 44, 45, 46, 47, 48, 49, 50];
const SEDRA_052: readonly SedraEntry[] = [52, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, null, 25, -26, -28, 30, -31, 33, 34, 35, 36, 37, 38, 39, 40, -41, 43, 44, 45, 46, 47, 48, 49, 50];
const SEDRA_070: readonly SedraEntry[] = [null, 52, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, -21, 23, 24, null, 25, -26, -28, 30, -31, 33, 34, 35, 36, 37, 38, 39, 40, -41, 43, 44, 45, 46, 47, 48, 49, 50];
const SEDRA_072: readonly SedraEntry[] = [null, 52, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, -21, 23, 24, null, 25, -26, -28, 30, -31, 33, 34, 35, 36, 37, 38, 39, 40, -41, 43, 44, 45, 46, 47, 48, 49, -50];
const SEDRA_120: readonly SedraEntry[] = [51, 52, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, null, 28, 29, 30, 31, 32, 33, null, 34, 35, 36, 37, -38, 40, -41, 43, 44, 45, 46, 47, 48, 49, -50];
const SEDRA_122: readonly SedraEntry[] = [51, 52, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, null, null, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, -41, 43, 44, 45, 46, 47, 48, 49, 50];
const SEDRA_150: readonly SedraEntry[] = [52, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, null, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50];
const SEDRA_152: readonly SedraEntry[] = [52, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, null, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, -50];
const SEDRA_170: readonly SedraEntry[] = [null, 52, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, null, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, -41, 43, 44, 45, 46, 47, 48, 49, -50];
const SEDRA_172: readonly SedraEntry[] = [null, 52, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, null, 28, 29, 30, 31, 32, 33, null, 34, 35, 36, 37, -38, 40, -41, 43, 44, 45, 46, 47, 48, 49, -50];

const SEDRA_BY_YEAR_TYPE: Record<string, readonly SedraEntry[]> = {
  "020": SEDRA_020,
  "0220": SEDRA_022,
  "0310": SEDRA_022,
  "0510": SEDRA_051,
  "052": SEDRA_052,
  "070": SEDRA_070,
  "072": SEDRA_072,
  "1200": SEDRA_120,
  "1220": SEDRA_122,
  "1310": SEDRA_122,
  "150": SEDRA_150,
  "152": SEDRA_152,
  "170": SEDRA_170,
  "1720": SEDRA_172,
};

/** The reading schedule for a Hebrew year (Diaspora), or null if the year type is unknown. */
function sedraArrayForYear(year: number): readonly SedraEntry[] | null {
  const leap = isHebrewLeapYear(year) ? 1 : 0;
  const rhDay = mod7(roshHashanahFixed(year)) + 1; // 1 = Sunday ... 7 = Saturday
  const longCheshvan = daysInHebrewMonth(year, 2) === 30;
  const shortKislev = daysInHebrewMonth(year, 3) === 29;
  const type = longCheshvan && !shortKislev ? 2 : !longCheshvan && shortKislev ? 0 : 1;
  const core = "" + leap + rhDay + type;
  return SEDRA_BY_YEAR_TYPE[core] ?? SEDRA_BY_YEAR_TYPE[core + "0"] ?? null;
}

/** First Saturday on or after Rosh Hashanah of a Hebrew year (fixed day). */
function firstSaturdayOnOrAfterRoshHashanah(year: number): number {
  const rh = roshHashanahFixed(year);
  return rh + ((6 - mod7(rh) + 7) % 7);
}

/**
 * The Parsha of the Shabbos of the week containing a Gregorian date:
 * the Saturday on or after the given date. Returns null when that
 * Shabbos has no weekly Parsha (festival / Chol Hamoed). Computed from
 * the Hebrew date — no table, no range limit.
 */
export function parshaForGregorianDate(year: number, month: number, day: number): string | null {
  const fixed = fixedFromGregorian(year, month, day);
  const shabbosFixed = fixed + ((6 - mod7(fixed) + 7) % 7);
  let hebYear = hebrewFromFixed(shabbosFixed).year;
  for (let attempt = 0; attempt < 3; attempt++) {
    const array = sedraArrayForYear(hebYear);
    if (!array) return null;
    const firstSat = firstSaturdayOnOrAfterRoshHashanah(hebYear);
    const weekNum = Math.floor((shabbosFixed - firstSat) / 7);
    if (weekNum < 0) { hebYear--; continue; }
    if (weekNum >= array.length) { hebYear++; continue; }
    const entry = array[weekNum];
    if (entry === null) return null;
    if (entry >= 0) return PARSHA_NAMES[entry];
    return PARSHA_NAMES[-entry] + "-" + PARSHA_NAMES[-entry + 1];
  }
  return null;
}
