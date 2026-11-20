/**
 * Categories phone machine (IVR path 1593, Olam Chesed option 3).
 *
 * Pure: no database, no network, no pg import. The IVR engine
 * (yemot-api-driven-phone.ts) calls handleCategoriesDigit and loads the
 * lists from calling-queue.ts (getCategoryValues / getCategoryContacts).
 * Unit-testable with node --test.
 *
 * YAKOB 2026-11-19 23:18–23:35 — every post-call statistic is a
 * category, and ONE call appears under EVERY matching value
 * (multi-label). Structure, exactly as specified:
 *   1593 menu -> 5 DIMENSIONS (result, mood, direction, campaign /
 *   case / project, amount)
 *   dimension -> its VALUES, numbered FRESH from 1
 *   value -> its CONTACTS, numbered FRESH from 1
 *   amount -> type the amount, hear all contacts/calls on that amount
 * Value lookup applies to ALL categories (amount was only an example).
 *
 * NUMBERING: inside every dimension the values restart at 1, and
 * inside every value the contacts restart at 1 (23:35 clarification).
 * The lists are browsed the same way as every other list on this
 * hotline (Tishl / call log / contacts): pound = next, 8 = previous
 * (the select-case precedent), 1 = hear the contacts for the value
 * currently spoken; digits 2-7 and 9 jump straight to that numbered
 * value (8 is previous, never a jump target). Star (or 0) goes back
 * one level, exactly like Calling.
 *
 * STATE (stored as JSON in the call state's action_flash, key
 * "categories"): {mode, dimension?, valuePos?, amount?, amountDigits?, pos}
 * mode: 'menu' | 'values' | 'amount-entry' | 'list'
 * dimension: the dimension the caller is inside.
 * valuePos: index into getCategoryValues(dimension) (0-based).
 * amount: the amount entered in amount-entry (list mode for amount).
 * pos: index into the contacts list the engine loaded.
 *
 * The engine resolves valuePos against the values list it loaded for
 * the current dimension (same pattern as Tishl/Calling: the list the
 * engine loaded is the source of truth, in the same order it spoke).
 * The machine never sees the values themselves — only listLength.
 */

export type CategoryDimension = "outcome" | "mood" | "direction" | "campaign" | "amount";

export const CATEGORY_DIMENSIONS: ReadonlyArray<{ key: CategoryDimension; label: string }> = [
  { key: "outcome", label: "Result" },
  { key: "mood", label: "Mood" },
  { key: "direction", label: "Direction" },
  { key: "campaign", label: "Campaign, case, or project" },
  { key: "amount", label: "Amount" },
];

export type CategoriesMode = "menu" | "values" | "amount-entry" | "list";

export type CategoriesState = {
  mode: CategoriesMode;
  dimension?: CategoryDimension;
  valuePos?: number;
  amount?: number | null;
  amountDigits?: string;
  pos: number;
};

export type CategoriesEffect = { type: "none" } | { type: "leave" };

export type CategoriesDigitResult = {
  state: CategoriesState;
  effect: CategoriesEffect;
  feedback: string;
};

export function newCategoriesState(): CategoriesState {
  return { mode: "menu", pos: 0 };
}

export function parseCategoriesFlash(manualFlash: string | null | undefined): CategoriesState | null {
  if (!manualFlash) return null;
  try {
    const parsed = JSON.parse(manualFlash) as { categories?: unknown };
    const st = parsed && typeof parsed === "object" ? parsed.categories : null;
    if (!st || typeof st !== "object") return null;
    const s = st as Partial<CategoriesState>;
    if (typeof s.pos !== "number" || typeof s.mode !== "string") return null;
    const out: CategoriesState = {
      mode: s.mode as CategoriesMode,
      pos: Math.max(0, Math.floor(s.pos)),
    };
    if (s.dimension) out.dimension = s.dimension;
    if (typeof s.valuePos === "number") out.valuePos = Math.max(0, Math.floor(s.valuePos));
    if (typeof s.amount === "number" || s.amount === null) out.amount = s.amount;
    if (typeof s.amountDigits === "string") out.amountDigits = s.amountDigits;
    return out;
  } catch {
    return null;
  }
}

export function encodeCategoriesFlash(state: CategoriesState): string {
  return JSON.stringify({ categories: state });
}

/** One level back. Returns null when leaving Categories entirely (back to 159). */
export function categoriesBackOneLevel(state: CategoriesState): CategoriesState | null {
  switch (state.mode) {
    case "menu": return null;
    case "values": case "amount-entry":
      return { mode: "menu", pos: 0 };
    case "list":
      return state.dimension === "amount"
        ? { mode: "amount-entry", dimension: "amount", amount: state.amount, pos: 0 }
        : { mode: "values", dimension: state.dimension, valuePos: state.valuePos, pos: state.valuePos ?? 0 };
    default: return { mode: "menu", pos: 0 };
  }
}

export function categoriesMenuSpeech(): string {
  return "Categories. Press 1 for result. Press 2 for mood. Press 3 for direction. " +
    "Press 4 for campaign, case, or project. Press 5 for amount. Press star to go back.";
}

export function categoryValuesSpeech(dimensionLabel: string): string {
  return dimensionLabel + ". Press 1 to hear the contacts in this category. " +
    "Press 2 to 9 to choose a value by its number. Press pound for the next value, " +
    "8 for the previous value, or star to go back.";
}

export function describeCategoryValue(label: string, pos: number, total: number): string {
  return "Value " + (pos + 1) + " of " + total + ": " + label + ". " +
    "Press 1 to hear the contacts in this category, pound for the next value, " +
    "8 for the previous value, or star to go back.";
}

export function describeCategoryContact(title: string, phone: string | null, detail: string, pos: number, total: number): string {
  let text = "Contact " + (pos + 1) + " of " + total + ": " + title + ". ";
  if (phone) text += "Number " + phone.replace(/\D/g, "").split("").join(" ") + ". ";
  if (detail) text += detail + ". ";
  text += "Press pound for the next contact, 9 for the previous contact, or star to go back.";
  return text;
}

export function amountEntrySpeech(): string {
  return "Enter the amount in dollars, then press pound. Press star to go back.";
}

export function handleCategoriesDigit(
  state: CategoriesState,
  digit: string,
  listLength: number,
): CategoriesDigitResult {
  const d = String(digit ?? "").trim();
  const base: CategoriesState = { ...state };
  const len = Math.max(0, Math.floor(listLength || 0));

  // 0 or * = back one level (every mode). EXCEPT in amount-entry,
  // where 0 is a digit of the amount.
  const backOut = d === "*" || (d === "0" && state.mode !== "amount-entry");
  if (backOut) {
    const back = categoriesBackOneLevel(base);
    if (back === null) return { state: base, effect: { type: "leave" }, feedback: "" };
    return { state: back, effect: { type: "none" }, feedback: "" };
  }

  // Past the end of a list: # restarts, 9 goes to the last item.
  if (state.mode === "list" && state.pos >= len && len > 0) {
    if (d === "#") return { state: { ...base, pos: 0 }, effect: { type: "none" }, feedback: "" };
    if (d === "9") return { state: { ...base, pos: len - 1 }, effect: { type: "none" }, feedback: "" };
    return { state: base, effect: { type: "none" },
             feedback: "You have reached the end of the list. Press pound to hear them again, or star to go back. " };
  }

  switch (state.mode) {
    case "menu": {
      if (!/^[1-5]$/.test(d)) {
        return { state: base, effect: { type: "none" },
                 feedback: "Press 1 to 5 for a category, or star to go back. " };
      }
      const dimension = CATEGORY_DIMENSIONS[Number(d) - 1].key;
      if (dimension === "amount") {
        return { state: { ...base, mode: "amount-entry", dimension, amountDigits: "", pos: 0 },
                 effect: { type: "none" }, feedback: "" };
      }
      return { state: { ...base, mode: "values", dimension, valuePos: 0, pos: 0 },
               effect: { type: "none" }, feedback: "" };
    }

    case "values": {
      if (len === 0) {
        return { state: { ...base, mode: "menu", dimension: undefined, valuePos: undefined, pos: 0 },
                 effect: { type: "none" }, feedback: "There are no categories here yet. " };
      }
      // 1 = hear the contacts for the value currently spoken.
      if (d === "1") {
        const at = Math.min(state.valuePos ?? 0, len - 1);
        return { state: { ...base, mode: "list", valuePos: at, pos: 0 },
                 effect: { type: "none" }, feedback: "" };
      }
      // 8 = previous value (the select-case precedent): it must be
      // checked BEFORE the 2-9 jump below, or "8" would try to jump
      // to value 8 instead of going back one value.
      if (d === "8") {
        const at = Math.max(0, (state.valuePos ?? 0) - 1);
        return { state: { ...base, valuePos: at, pos: at }, effect: { type: "none" }, feedback: "" };
      }
      // 2-7 and 9 = jump straight to that numbered value (fresh 1-based).
      if (/^[2-79]$/.test(d)) {
        const at = Number(d) - 1;
        if (at < len) {
          return { state: { ...base, mode: "list", valuePos: at, pos: 0 },
                   effect: { type: "none" }, feedback: "" };
        }
        return { state: base, effect: { type: "none" },
                 feedback: "There is no value " + d + " here. " };
      }
      if (d === "#") {
        if ((state.valuePos ?? 0) + 1 < len) {
          return { state: { ...base, valuePos: (state.valuePos ?? 0) + 1, pos: (state.valuePos ?? 0) + 1 },
                   effect: { type: "none" }, feedback: "" };
        }
        return { state: base, effect: { type: "none" },
                 feedback: "That is the last value. Press 1 to hear its contacts, or star to go back. " };
      }
      return { state: base, effect: { type: "none" },
               feedback: "Press 1 to hear the contacts, 2 to 9 to choose a value, pound for the next value, or 8 for the previous value. " };
    }

    case "amount-entry": {
      const terminated = d.endsWith("#");
      const chunk = terminated ? d.slice(0, -1) : d;
      if (!/^\d*$/.test(chunk)) {
        return { state: base, effect: { type: "none" }, feedback: "Please enter digits only. " };
      }
      const accumulated = (state.amountDigits || "") + chunk;
      if (!terminated) {
        if (accumulated.length > 9) {
          return { state: base, effect: { type: "none" },
                   feedback: "That amount is too large. Please press pound to finish, or star to go back. " };
        }
        return { state: { ...base, amountDigits: accumulated }, effect: { type: "none" }, feedback: "" };
      }
      if (accumulated === "") {
        return { state: base, effect: { type: "none" },
                 feedback: "Enter the amount first, then press pound. " };
      }
      const amount = Number(accumulated);
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999) {
        return { state: { ...base, amountDigits: "" }, effect: { type: "none" },
                 feedback: "That amount is not valid. Please try again. " };
      }
      return { state: { ...base, amount, amountDigits: undefined, mode: "list", pos: 0 },
               effect: { type: "none" }, feedback: "" };
    }

    case "list": {
      if (len === 0) {
        return { state: categoriesBackOneLevel(base) ?? { mode: "menu", pos: 0 },
                 effect: { type: "none" }, feedback: "There are no contacts in this category. " };
      }
      if (d === "#") return { state: { ...base, pos: state.pos + 1 }, effect: { type: "none" }, feedback: "" };
      if (d === "9") return { state: { ...base, pos: Math.max(0, state.pos - 1) }, effect: { type: "none" }, feedback: "" };
      return { state: base, effect: { type: "none" },
               feedback: "Press pound for the next contact, 9 for the previous contact, or star to go back. " };
    }

    default: {
      return { state: { mode: "menu", pos: 0 }, effect: { type: "none" }, feedback: "" };
    }
  }
}
