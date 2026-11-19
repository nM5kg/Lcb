/**
 * Tishl phone helpers and the pure Tishl state machine (IVR path 1591).
 *
 * Pure: no database, no network, no pg import. The IVR engine
 * (yemot-api-driven-phone.ts) calls handleTishlDigit and executes the
 * returned effect against the database. Everything here is unit-testable
 * with node --test.
 *
 * THE TWO 9s — READ THIS BEFORE CHANGING THE KEY MAP
 * --------------------------------------------------
 * The digit 9 means TWO DIFFERENT THINGS depending on the mode:
 *   9 while LISTENING (mode 'listen') = previous message (go back one item).
 *   9 in the ACTION MENU (mode 'action', after pressing 1) = HOLD toggle.
 * There is a third 9 context: 9 while reading a message in full
 * (fullRead) = stop reading and go back to the item list.
 * This is context-dependent by design, per the task brief. If Yakob wants
 * the hold on a different key, change only handleTishlDigit's action
 * branch and the menu text in actionMenuSpeech.
 *
 * STATE (stored as JSON in the call state's action_flash, key "tishl"):
 *   {mode, pos, kind, id, fullRead?, chunk?, dateKind?, dateDay?,
 *    dateMonth?, dateHour?, dateRetries?, dateLastError?}
 * mode: 'listen' | 'action' | 'date-choice' | 'date-day' | 'date-month' |
 *       'date-hour' | 'date-minute' | 'note' | 'confirm-delete'
 * pos: index into the queue (newest first). pos == queue length means
 *      "past the end of the queue".
 * kind/id: the item at pos (mirrored for the engine; the queue is the
 *      source of truth, these are just a convenience).
 *
 * TIMEZONE: all reminder times are in America/New_York (the community's
 * local time). "Tonight by 12 midnight" = 23:59 local time.
 */

import { hebrewFromFixed, fixedFromGregorian, gregorianFromFixed, fixedFromHebrew, daysInHebrewMonth, hebrewMonthName } from "./hebrew-calendar";

export const TISHL_TZ = "America/New_York";

/** Queue item shape (mirrors TishlQueueItem from tishl-queue.ts). */
export type TishlItemKind = "task" | "case" | "missed_call" | "message";
export type TishlQueueItemView = {
  kind: TishlItemKind;
  id: number;
  title: string;
  detail: string;
  phone: string | null;
  created_at: string;
  held: boolean;
};

export type TishlMode =
  | "listen" | "action" | "date-choice" | "date-day" | "date-month"
  | "date-hour" | "date-minute" | "note" | "confirm-delete";

export type TishlState = {
  mode: TishlMode;
  pos: number;
  kind: TishlItemKind | null;
  id: number | null;
  fullRead?: boolean;
  chunk?: number;
  dateKind?: "jewish" | "numeric";
  dateDay?: number;
  dateMonth?: number;
  dateHour?: number;
  dateRetries?: number;
};

export function newTishlState(): TishlState {
  return { mode: "listen", pos: 0, kind: null, id: null };
}

/** Parse the Tishl state out of the action_flash JSON. Null on no/bad state. */
export function parseTishlFlash(manualFlash: string | null | undefined): TishlState | null {
  if (!manualFlash) return null;
  try {
    const parsed = JSON.parse(manualFlash) as { tishl?: unknown };
    const st = parsed && typeof parsed === "object" ? parsed.tishl : null;
    if (!st || typeof st !== "object") return null;
    const s = st as Partial<TishlState>;
    if (typeof s.pos !== "number" || typeof s.mode !== "string") return null;
    const out: TishlState = {
      mode: s.mode as TishlMode,
      pos: Math.max(0, Math.floor(s.pos)),
      kind: s.kind ?? null,
      id: typeof s.id === "number" ? s.id : null,
    };
    if (s.fullRead) out.fullRead = true;
    if (typeof s.chunk === "number") out.chunk = s.chunk;
    if (s.dateKind) out.dateKind = s.dateKind;
    if (typeof s.dateDay === "number") out.dateDay = s.dateDay;
    if (typeof s.dateMonth === "number") out.dateMonth = s.dateMonth;
    if (typeof s.dateHour === "number") out.dateHour = s.dateHour;
    if (typeof s.dateRetries === "number") out.dateRetries = s.dateRetries;
    return out;
  } catch {
    return null;
  }
}

export function encodeTishlFlash(state: TishlState): string {
  return JSON.stringify({ tishl: state });
}

/** One level back. Returns null when leaving Tishl entirely (back to 159). */
export function tishlBackOneLevel(state: TishlState): TishlState | null {
  if (state.fullRead) return { ...state, fullRead: false, chunk: 0 };
  switch (state.mode) {
    case "listen": return null;
    case "action": return { ...state, mode: "listen" };
    case "confirm-delete": return { ...state, mode: "action" };
    case "date-choice": return { ...state, mode: "action" };
    case "date-day": case "date-month": case "date-hour": case "date-minute":
      return { ...state, mode: "action", dateKind: undefined, dateDay: undefined,
               dateMonth: undefined, dateHour: undefined, dateRetries: 0 };
    case "note": return { ...state, mode: "action" };
    default: return { ...state, mode: "listen" };
  }
}

export type TishlEffect =
  | { type: "none" }
  | { type: "leave" }
  | { type: "done" }
  | { type: "delete" }
  | { type: "hold" }
  | { type: "contextual" }
  | { type: "remind"; at: Date };

export type TishlDigitResult = {
  state: TishlState;
  effect: TishlEffect;
  /** Spoken confirmation to prepend to the next prompt ("" = none). */
  feedback: string;
};

// ---------------------------------------------------------------------------
// Time helpers (America/New_York unless stated)
// ---------------------------------------------------------------------------

/** Local date parts of an instant in a timezone (month 1-12). */
export function tzParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"),
           hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** UTC offset in minutes of a timezone at an instant. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = tzParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Local wall-clock time -> UTC instant (guess and refine, DST-safe). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMinutes(new Date(asUtc), timeZone);
  const candidate = new Date(asUtc - off1 * 60000);
  const off2 = tzOffsetMinutes(candidate, timeZone);
  if (off2 === off1) return candidate;
  // The first guess landed across a DST boundary; redo with the new offset.
  return new Date(asUtc - off2 * 60000);
}

/** now + N hours. */
export function remindInHours(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * 3600 * 1000);
}

/** Tonight, 23:59 local time. ("12 midnight" = the end of today.) */
export function remindTonight(now: Date, timeZone: string): Date {
  const p = tzParts(now, timeZone);
  return zonedTimeToUtc(p.year, p.month, p.day, 23, 59, timeZone);
}

/** "Tuesday, December 2, 2026 at 3 30 PM" (spaces, not colons, for TTS). */
export function formatSpokenDateTime(date: Date, timeZone: string): string {
  const p = tzParts(date, timeZone);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July",
                  "August", "September", "October", "November", "December"];
  const weekday = weekdays[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "A M" : "P M";
  const minute = String(p.minute).padStart(2, "0");
  return weekday + ", " + months[p.month - 1] + " " + p.day + ", " + p.year +
         " at " + hour12 + " " + minute + " " + ampm;
}

const GREGORIAN_MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isGregorianLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function gregorianMonthLength(y: number, m: number): number {
  if (m === 2) return isGregorianLeapYear(y) ? 29 : 28;
  return GREGORIAN_MONTH_LENGTHS[m - 1];
}

/**
 * Next occurrence of a numeric (Gregorian) date/time, strictly after now.
 * day 1-31, month 1-12, hour 0-23, minute 0-59. Returns null when the
 * date can never occur (e.g. 31 April, 30 February).
 */
export function resolveNumericReminder(now: Date, timeZone: string, day: number, month: number, hour: number, minute: number): Date | null {
  if (day < 1 || day > 31 || month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const p = tzParts(now, timeZone);
  // Feb 29 only ever happens in a leap year.
  if (month === 2 && day === 29) {
    let y = p.year;
    for (let i = 0; i < 8; i++) {
      if (isGregorianLeapYear(y)) {
        const at = zonedTimeToUtc(y, 2, 29, hour, minute, timeZone);
        if (at.getTime() > now.getTime()) return at;
      }
      y++;
    }
    return null;
  }
  // Apr 31 / Jun 31 / Sep 31 / Nov 31 / Feb 30 never happen at all.
  if (day > gregorianMonthLength(p.year, month)) return null;
  let at = zonedTimeToUtc(p.year, month, day, hour, minute, timeZone);
  if (at.getTime() <= now.getTime()) at = zonedTimeToUtc(p.year + 1, month, day, hour, minute, timeZone);
  return at;
}

/**
 * Next occurrence of a Hebrew date/time, strictly after now.
 * day 1-30, month 1-13 (fixed slots; 7 = Adar II, leap years only).
 * Searches forward year by year (up to 8 Hebrew years) so short months
 * (29-day Cheshvan) and Adar II resolve to the next year that has them.
 */
export function resolveJewishReminder(now: Date, timeZone: string, day: number, month: number, hour: number, minute: number): Date | null {
  if (day < 1 || day > 30 || month < 1 || month > 13 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const p = tzParts(now, timeZone);
  const todayHebrew = hebrewFromFixed(fixedFromGregorian(p.year, p.month, p.day));
  for (let y = todayHebrew.year; y < todayHebrew.year + 8; y++) {
    if (day > daysInHebrewMonth(y, month)) continue;
    const fixed = fixedFromHebrew(y, month, day);
    const g = gregorianFromFixed(fixed);
    const at = zonedTimeToUtc(g.year, g.month, g.day, hour, minute, timeZone);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Speech helpers
// ---------------------------------------------------------------------------

/** "1 7 1 2 0 0" — a phone number spelled digit by digit for TTS. */
export function speakDigits(phone: string): string {
  return phone.replace(/\D/g, "").split("").join(" ");
}

/** Split long text into chunks of at most maxChars, on word boundaries. */
export function splitSpeechChunks(text: string, maxChars = 215): string[] {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const chunks: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + " " + w).length > maxChars) { chunks.push(cur); cur = w; }
    else cur += " " + w;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const KIND_LABEL: Record<TishlItemKind, string> = {
  task: "Task",
  case: "Case",
  missed_call: "Missed call",
  message: "Message",
};

/** The spoken line for one queue item while listening. */
export function describeTishlItem(item: TishlQueueItemView, pos: number, total: number, extraDetail = ""): string {
  let text = "Item " + (pos + 1) + " of " + total + ". " + KIND_LABEL[item.kind] + ": " + item.title + ". ";
  if (item.kind === "missed_call" && item.phone) text += "From " + speakDigits(item.phone) + ". ";
  if (item.detail) text += item.detail + ". ";
  if (extraDetail) text += extraDetail;
  if (item.held) text += "This item is on hold. ";
  text += "Press 1 for options, pound for the next item, 9 for the previous item, or star to go back.";
  return text;
}

/** The spoken action menu (after pressing 1 while listening). */
export function actionMenuSpeech(item: TishlQueueItemView | null): string {
  const contextual =
    item?.kind === "missed_call" ? "call this number back" :
    item?.kind === "task" ? "open this task" :
    item?.kind === "case" ? "open this case" :
    item?.kind === "message" ? "hear this message in full" : "use this item";
  return "Options. Press 1 to " + contextual +
    ". Press 2 to mark done. Press 3 to delete. Press 4 to remind in one hour. " +
    "Press 5 to remind in one day. Press 6 to remind tonight. Press 7 for another day and time. " +
    "Press 8 to add a voice note. Press 9 to put this item on hold, or release the hold. " +
    "Press zero or star to go back to listening.";
}

/** "1, Tishrei. 2, Cheshvan. ..." — the month list for Jewish date entry.
 *  Adar II is skipped in a common year unless includeAdarII is set (the
 *  next leap year is then close enough that the caller may want it). */
export function hebrewMonthChoicesSpeech(year: number, includeAdarII = false): string {
  const names: string[] = [];
  for (let slot = 1; slot <= 13; slot++) {
    if (slot === 7 && daysInHebrewMonth(year, 7) === 0 && !includeAdarII) continue;
    names.push(slot + ", " + hebrewMonthName(year, slot));
  }
  return names.join(". ") + ".";
}

/** Note text stored in tishl_notes for a phone voice note. */
export function buildVoiceNoteText(recordingRef: string, whenIso: string): string {
  return "Voice note recorded via phone on " + whenIso + ". Recording: " + recordingRef;
}

/**
 * Parse a multi-digit date-entry input. Yemot may return the digits with a
 * trailing pound (#) when the caller presses it to finish. Returns null
 * for an empty/non-numeric input.
 */
export function parseDateDigits(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/#$/, "");
  if (!/^\d{1,8}$/.test(stripped)) return null;
  return Number(stripped);
}

// ---------------------------------------------------------------------------
// The pure digit state machine
// ---------------------------------------------------------------------------

export function handleTishlDigit(
  state: TishlState,
  digit: string,
  queueLength: number,
  now: Date,
  timeZone: string,
): TishlDigitResult {
  const d = String(digit ?? "").trim();
  const base: TishlState = { ...state };

  // Empty queue: nothing to act on; leave Tishl.
  if (queueLength === 0) {
    return { state: base, effect: { type: "leave" }, feedback: "Your Tishl is now empty. " };
  }

  // 0 or * = back one level (in every mode, for both providers).
  // EXCEPTION: in date-hour and date-minute, 0 is a valid value
  // (midnight, :00), so only * backs out there.
  const backOut = d === "*" || (d === "0" && state.mode !== "date-hour" && state.mode !== "date-minute");
  if (backOut) {
    const back = tishlBackOneLevel(base);
    if (back === null) return { state: base, effect: { type: "leave" }, feedback: "" };
    return { state: back, effect: { type: "none" }, feedback: "" };
  }

  // Reading a message in full: 2 = next part, 9 = stop (third 9 context).
  if (state.fullRead) {
    if (d === "2") {
      const chunk = (state.chunk || 0) + 1;
      return { state: { ...base, chunk }, effect: { type: "none" }, feedback: "" };
    }
    if (d === "9") {
      return { state: { ...base, fullRead: false, chunk: 0 }, effect: { type: "none" },
               feedback: "Back to your Tishl. " };
    }
    return { state: base, effect: { type: "none" },
             feedback: "Press 2 for the next part, or 9 to return to the list. " };
  }

  // Past the end of the queue.
  if (state.pos >= queueLength) {
    if (d === "#") return { state: { ...base, pos: 0 }, effect: { type: "none" }, feedback: "" };
    if (d === "9") return { state: { ...base, pos: queueLength - 1 }, effect: { type: "none" }, feedback: "" };
    return { state: base, effect: { type: "none" },
             feedback: "You have reached the end of your Tishl. Press pound to hear them again, or star to go back. " };
  }

  switch (state.mode) {
    case "listen": {
      if (d === "#") return { state: { ...base, pos: state.pos + 1 }, effect: { type: "none" }, feedback: "" };
      if (d === "9") return { state: { ...base, pos: Math.max(0, state.pos - 1) }, effect: { type: "none" }, feedback: "" };
      if (d === "1") return { state: { ...base, mode: "action" }, effect: { type: "none" }, feedback: "" };
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 for options, pound for the next item, 9 for the previous item, or star to go back. " };
    }
    case "action": {
      if (d === "1") {
        if (state.kind === "message") {
          return { state: { ...base, mode: "listen", fullRead: true, chunk: 0 },
                   effect: { type: "none" }, feedback: "Reading the full message. " };
        }
        return { state: { ...base, mode: "listen" }, effect: { type: "contextual" }, feedback: "" };
      }
      if (d === "2") return { state: { ...base, mode: "listen" }, effect: { type: "done" }, feedback: "" };
      if (d === "3") return { state: { ...base, mode: "confirm-delete" }, effect: { type: "none" }, feedback: "" };
      if (d === "4") {
        const at = remindInHours(now, 1);
        return { state: { ...base, mode: "listen" }, effect: { type: "remind", at },
                 feedback: "Reminder set for " + formatSpokenDateTime(at, timeZone) + ". " };
      }
      if (d === "5") {
        const at = remindInHours(now, 24);
        return { state: { ...base, mode: "listen" }, effect: { type: "remind", at },
                 feedback: "Reminder set for " + formatSpokenDateTime(at, timeZone) + ". " };
      }
      if (d === "6") {
        const at = remindTonight(now, timeZone);
        return { state: { ...base, mode: "listen" }, effect: { type: "remind", at },
                 feedback: "Reminder set for " + formatSpokenDateTime(at, timeZone) + ". " };
      }
      if (d === "7") return { state: { ...base, mode: "date-choice", dateRetries: 0 }, effect: { type: "none" }, feedback: "" };
      if (d === "8") return { state: { ...base, mode: "note" }, effect: { type: "none" }, feedback: "" };
      // 9 in the ACTION MENU = hold toggle (NOT previous message).
      if (d === "9") return { state: { ...base, mode: "listen" }, effect: { type: "hold" }, feedback: "" };
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 to 9 for an action, or zero to go back to listening. " };
    }
    case "confirm-delete": {
      if (d === "3") return { state: { ...base, mode: "listen" }, effect: { type: "delete" }, feedback: "" };
      return { state: { ...base, mode: "action" }, effect: { type: "none" }, feedback: "Delete cancelled. " };
    }
    case "date-choice": {
      if (d === "1") return { state: { ...base, mode: "date-day", dateKind: "jewish", dateRetries: 0 }, effect: { type: "none" }, feedback: "" };
      if (d === "2") return { state: { ...base, mode: "date-day", dateKind: "numeric", dateRetries: 0 }, effect: { type: "none" }, feedback: "" };
      return { state: base, effect: { type: "none" }, feedback: "Press 1 for a Jewish date, or 2 for numbers. " };
    }
    case "date-day": case "date-month": case "date-hour": case "date-minute": {
      const value = parseDateDigits(d);
      const jewish = state.dateKind === "jewish";
      const maxDay = jewish ? 30 : 31;
      const maxMonth = jewish ? 13 : 12;
      const valid =
        value !== null && (
          (state.mode === "date-day" && value >= 1 && value <= maxDay) ||
          (state.mode === "date-month" && value >= 1 && value <= maxMonth) ||
          (state.mode === "date-hour" && value >= 0 && value <= 23) ||
          (state.mode === "date-minute" && value >= 0 && value <= 59));
      if (!valid) {
        // One re-prompt, then back to the action menu.
        if ((state.dateRetries || 0) < 1) {
          return { state: { ...base, dateRetries: 1 }, effect: { type: "none" },
                   feedback: "That number is not valid. Please try again. " };
        }
        return { state: { ...base, mode: "action", dateKind: undefined, dateDay: undefined,
                          dateMonth: undefined, dateHour: undefined, dateRetries: 0 },
                 effect: { type: "none" }, feedback: "Date entry cancelled. Back to the item options. " };
      }
      const next = { ...base };
      if (state.mode === "date-day") { next.dateDay = value; next.mode = "date-month"; }
      else if (state.mode === "date-month") { next.dateMonth = value; next.mode = "date-hour"; }
      else if (state.mode === "date-hour") { next.dateHour = value; next.mode = "date-minute"; }
      else {
        // Minute entered: resolve the full date/time.
        const at = jewish
          ? resolveJewishReminder(now, timeZone, state.dateDay || 1, state.dateMonth || 1, state.dateHour || 0, value)
          : resolveNumericReminder(now, timeZone, state.dateDay || 1, state.dateMonth || 1, state.dateHour || 0, value);
        if (!at) {
          // A date that can never occur (31 April, 30 Cheshvan in a
          // 29-day year handled by the resolver returning null after the
          // search): re-enter the day once, then cancel.
          if ((state.dateRetries || 0) < 1) {
            return { state: { ...base, mode: "date-day", dateRetries: 1 },
                     effect: { type: "none" },
                     feedback: "That date does not exist. Please enter the day again. " };
          }
          return { state: { ...base, mode: "action", dateKind: undefined, dateDay: undefined,
                            dateMonth: undefined, dateHour: undefined, dateRetries: 0 },
                   effect: { type: "none" }, feedback: "Date entry cancelled. Back to the item options. " };
        }
        next.mode = "listen";
        next.dateKind = undefined; next.dateDay = undefined; next.dateMonth = undefined;
        next.dateHour = undefined; next.dateRetries = 0;
        return { state: next, effect: { type: "remind", at },
                 feedback: "Reminder set for " + formatSpokenDateTime(at, timeZone) + ". " };
      }
      return { state: next, effect: { type: "none" }, feedback: "" };
    }
    case "note": {
      // A recording reference arrives as the digit; the engine validates it.
      return { state: base, effect: { type: "none" }, feedback: "" };
    }
    default: {
      return { state: { ...base, mode: "listen" }, effect: { type: "none" }, feedback: "" };
    }
  }
}

/** After a removal (done / delete / remind), clamp the position to the new queue. */
export function clampPosAfterRemoval(pos: number, newLength: number): { pos: number; empty: boolean } {
  if (newLength === 0) return { pos: 0, empty: true };
  if (pos >= newLength) return { pos: newLength, empty: false }; // past the end
  return { pos, empty: false };
}
