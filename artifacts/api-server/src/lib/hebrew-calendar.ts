/**
 * Hebrew calendar for the Tishl phone menu (IVR path 1591).
 *
 * Pure arithmetic + a static Parsha table. No database, no network.
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
 * PARSHA TABLE
 * ------------
 * Static Shabbos table for Jewish years 5786-5787 (Diaspora reading),
 * copied from hebcal.com in November 2026. It covers Shabbos
 * 2025-09-27 through 2027-09-25. A Shabbos that is a festival (no weekly
 * Parsha read) has no entry, and parshaForGregorianDate returns null for
 * it. REGENERATE YEARLY: after September 2027 the table is out of range
 * and the phone simply omits the Parsha instead of guessing.
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
  "Tazria", "Metzora", "Achrei Mos", "Kedoshim", "Emor", "Behar", "Bechukosai",
  "Bamidbar", "Naso", "Beha'aloscha", "Shelach", "Korach", "Chukas", "Balak",
  "Pinchas", "Matos", "Masei", "Devarim", "Va'eschanan", "Eikev", "Re'eh",
  "Shoftim", "Ki Seitzei", "Ki Savo", "Nitzavim", "Vayeilech", "Ha'azinu",
  "Vezos Habracha",
];

/**
 * Static Shabbos -> Parsha table, Jewish years 5786-5787, Diaspora reading.
 * Source: hebcal.com, November 2026. Combined readings are one entry with
 * a hyphenated name ("Vayakhel-Pekudei"). Shabbos days that are festivals
 * (no weekly Parsha) have no entry.
 * REGENERATE YEARLY: covers Shabbos 2025-09-27 through 2027-09-25 only.
 */
export const PARSHA_TABLE_START = "2025-09-27";
export const PARSHA_TABLE_END = "2027-09-25";
export const PARSHA_TABLE: readonly { date: string; parsha: string }[] = [
  // 5786 (common year)
  { date: "2025-09-27", parsha: "Vayeilech" },
  { date: "2025-10-04", parsha: "Ha'azinu" },
  { date: "2025-10-18", parsha: "Bereshis" },
  { date: "2025-10-25", parsha: "Noach" },
  { date: "2025-11-01", parsha: "Lech Lecha" },
  { date: "2025-11-08", parsha: "Vayeira" },
  { date: "2025-11-15", parsha: "Chayei Sarah" },
  { date: "2025-11-22", parsha: "Toldos" },
  { date: "2025-11-29", parsha: "Vayetzei" },
  { date: "2025-12-06", parsha: "Vayishlach" },
  { date: "2025-12-13", parsha: "Vayeshev" },
  { date: "2025-12-20", parsha: "Mikeitz" },
  { date: "2025-12-27", parsha: "Vayigash" },
  { date: "2026-01-03", parsha: "Vayechi" },
  { date: "2026-01-10", parsha: "Shemos" },
  { date: "2026-01-17", parsha: "Va'eira" },
  { date: "2026-01-24", parsha: "Bo" },
  { date: "2026-01-31", parsha: "Beshalach" },
  { date: "2026-02-07", parsha: "Yisro" },
  { date: "2026-02-14", parsha: "Mishpatim" },
  { date: "2026-02-21", parsha: "Terumah" },
  { date: "2026-02-28", parsha: "Tetzaveh" },
  { date: "2026-03-07", parsha: "Ki Sisa" },
  { date: "2026-03-14", parsha: "Vayakhel-Pekudei" },
  { date: "2026-03-21", parsha: "Vayikra" },
  { date: "2026-03-28", parsha: "Tzav" },
  { date: "2026-04-11", parsha: "Shemini" },
  { date: "2026-04-18", parsha: "Tazria-Metzora" },
  { date: "2026-04-25", parsha: "Achrei Mot-Kedoshim" },
  { date: "2026-05-02", parsha: "Emor" },
  { date: "2026-05-09", parsha: "Behar-Bechukosai" },
  { date: "2026-05-16", parsha: "Bamidbar" },
  { date: "2026-05-30", parsha: "Naso" },
  { date: "2026-06-06", parsha: "Beha'aloscha" },
  { date: "2026-06-13", parsha: "Shelach" },
  { date: "2026-06-20", parsha: "Korach" },
  { date: "2026-06-27", parsha: "Chukas-Balak" },
  { date: "2026-07-04", parsha: "Pinchas" },
  { date: "2026-07-11", parsha: "Matos-Masei" },
  { date: "2026-07-18", parsha: "Devarim" },
  { date: "2026-07-25", parsha: "Va'eschanan" },
  { date: "2026-08-01", parsha: "Eikev" },
  { date: "2026-08-08", parsha: "Re'eh" },
  { date: "2026-08-15", parsha: "Shoftim" },
  { date: "2026-08-22", parsha: "Ki Seitzei" },
  { date: "2026-08-29", parsha: "Ki Savo" },
  { date: "2026-09-05", parsha: "Nitzavim-Vayeilech" },
  // 5787 (leap year)
  { date: "2026-09-19", parsha: "Ha'azinu" },
  { date: "2026-10-10", parsha: "Bereshis" },
  { date: "2026-10-17", parsha: "Noach" },
  { date: "2026-10-24", parsha: "Lech Lecha" },
  { date: "2026-10-31", parsha: "Vayeira" },
  { date: "2026-11-07", parsha: "Chayei Sarah" },
  { date: "2026-11-14", parsha: "Toldos" },
  { date: "2026-11-21", parsha: "Vayetzei" },
  { date: "2026-11-28", parsha: "Vayishlach" },
  { date: "2026-12-05", parsha: "Vayeshev" },
  { date: "2026-12-12", parsha: "Mikeitz" },
  { date: "2026-12-19", parsha: "Vayigash" },
  { date: "2026-12-26", parsha: "Vayechi" },
  { date: "2027-01-02", parsha: "Shemos" },
  { date: "2027-01-09", parsha: "Va'eira" },
  { date: "2027-01-16", parsha: "Bo" },
  { date: "2027-01-23", parsha: "Beshalach" },
  { date: "2027-01-30", parsha: "Yisro" },
  { date: "2027-02-06", parsha: "Mishpatim" },
  { date: "2027-02-13", parsha: "Terumah" },
  { date: "2027-02-20", parsha: "Tetzaveh" },
  { date: "2027-02-27", parsha: "Ki Sisa" },
  { date: "2027-03-06", parsha: "Vayakhel" },
  { date: "2027-03-13", parsha: "Pekudei" },
  { date: "2027-03-20", parsha: "Vayikra" },
  { date: "2027-03-27", parsha: "Tzav" },
  { date: "2027-04-03", parsha: "Shemini" },
  { date: "2027-04-10", parsha: "Tazria" },
  { date: "2027-04-17", parsha: "Metzora" },
  { date: "2027-05-01", parsha: "Achrei Mos" },
  { date: "2027-05-08", parsha: "Kedoshim" },
  { date: "2027-05-15", parsha: "Emor" },
  { date: "2027-05-22", parsha: "Behar" },
  { date: "2027-05-29", parsha: "Bechukosai" },
  { date: "2027-06-05", parsha: "Bamidbar" },
  { date: "2027-06-19", parsha: "Naso" },
  { date: "2027-06-26", parsha: "Beha'aloscha" },
  { date: "2027-07-03", parsha: "Shelach" },
  { date: "2027-07-10", parsha: "Korach" },
  { date: "2027-07-17", parsha: "Chukas-Balak" },
  { date: "2027-07-24", parsha: "Pinchas" },
  { date: "2027-07-31", parsha: "Matos-Masei" },
  { date: "2027-08-07", parsha: "Devarim" },
  { date: "2027-08-14", parsha: "Va'eschanan" },
  { date: "2027-08-21", parsha: "Eikev" },
  { date: "2027-08-28", parsha: "Re'eh" },
  { date: "2027-09-04", parsha: "Shoftim" },
  { date: "2027-09-11", parsha: "Ki Seitzei" },
  { date: "2027-09-18", parsha: "Ki Savo" },
  { date: "2027-09-25", parsha: "Nitzavim-Vayeilech" },
];

function isoDate(year: number, month: number, day: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return year + "-" + p(month) + "-" + p(day);
}

/**
 * The Parsha of the Shabbos of the week containing a Gregorian date:
 * the Saturday on or after the given date. Returns null when that Shabbos
 * has no weekly Parsha (festival) or is outside the static table.
 */
export function parshaForGregorianDate(year: number, month: number, day: number): string | null {
  const fixed = fixedFromGregorian(year, month, day);
  // R.D. weekday: 0 = Sunday ... 6 = Saturday.
  const dow = mod7(fixed);
  const daysToSaturday = (6 - dow + 7) % 7;
  const shabbos = gregorianFromFixed(fixed + daysToSaturday);
  const key = isoDate(shabbos.year, shabbos.month, shabbos.day);
  for (const row of PARSHA_TABLE) {
    if (row.date === key) return row.parsha;
    if (row.date > key) break;
  }
  return null;
}
