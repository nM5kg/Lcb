// Categories phone machine (IVR path 1593, Olam Chesed option 3) — unit tests.
// Pure: no DB, no network. Run from artifacts/api-server:
//   DATABASE_URL='postgresql://user:pass@localhost:5432/dummy' \
//     node --test --import ./tests/register-ts-resolve.mjs tests/calling-categories.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_DIMENSIONS, newCategoriesState, parseCategoriesFlash, encodeCategoriesFlash,
  categoriesBackOneLevel, handleCategoriesDigit,
  categoriesMenuSpeech, categoryValuesSpeech, describeCategoryValue,
  describeCategoryContact, amountEntrySpeech,
} from "../src/lib/calling-categories.ts";
import type { CategoriesState } from "../src/lib/calling-categories.ts";

function menu(): CategoriesState {
  return newCategoriesState();
}

test("menu lists the 5 dimensions in order; digits 1-5 enter them; 5 is the amount entry", () => {
  assert.deepEqual(CATEGORY_DIMENSIONS.map((d) => d.key),
    ["outcome", "mood", "direction", "campaign", "amount"]);
  assert.ok(categoriesMenuSpeech().includes("Press 1 for result"));
  assert.ok(categoriesMenuSpeech().includes("Press 5 for amount"));
  for (const [d, key] of [["1", "outcome"], ["2", "mood"], ["3", "direction"], ["4", "campaign"]] as const) {
    const r = handleCategoriesDigit(menu(), d, 0);
    assert.equal(r.state.mode, "values");
    assert.equal(r.state.dimension, key);
    assert.equal(r.state.valuePos, 0);
  }
  const amount = handleCategoriesDigit(menu(), "5", 0);
  assert.equal(amount.state.mode, "amount-entry");
  assert.equal(amount.state.dimension, "amount");
  const junk = handleCategoriesDigit(menu(), "9", 0);
  assert.equal(junk.state.mode, "menu");
  assert.ok(junk.feedback.includes("Press 1 to 5"));
  const leave = handleCategoriesDigit(menu(), "*", 0);
  assert.equal(leave.effect.type, "leave");
  const leave0 = handleCategoriesDigit(menu(), "0", 0);
  assert.equal(leave0.effect.type, "leave");
});

test("values: fresh numbering — 1 selects the spoken value, 2-9 jump, # next, 8 previous", () => {
  const values: CategoriesState = { mode: "values", dimension: "outcome", valuePos: 0, pos: 0 };
  // 1 = hear the contacts for value 1 (fresh from 1).
  let r = handleCategoriesDigit(values, "1", 4);
  assert.equal(r.state.mode, "list");
  assert.equal(r.state.valuePos, 0);
  assert.equal(r.state.pos, 0);
  // 3 = jump straight to value 3.
  r = handleCategoriesDigit(values, "3", 4);
  assert.equal(r.state.mode, "list");
  assert.equal(r.state.valuePos, 2);
  // 9 with only 4 values: no such value.
  r = handleCategoriesDigit(values, "9", 4);
  assert.equal(r.state.mode, "values");
  assert.ok(r.feedback.includes("There is no value 9"));
  // # advances to the next value; 8 goes back.
  r = handleCategoriesDigit(values, "#", 4);
  assert.equal(r.state.valuePos, 1);
  r = handleCategoriesDigit(r.state, "#", 4);
  assert.equal(r.state.valuePos, 2);
  r = handleCategoriesDigit(r.state, "8", 4);
  assert.equal(r.state.valuePos, 1);
  // 8 at the first value stays at the first value.
  r = handleCategoriesDigit(values, "8", 4);
  assert.equal(r.state.valuePos, 0);
  // At the last value, # says so instead of wrapping.
  const last: CategoriesState = { mode: "values", dimension: "outcome", valuePos: 3, pos: 3 };
  r = handleCategoriesDigit(last, "#", 4);
  assert.equal(r.state.valuePos, 3);
  assert.ok(r.feedback.includes("last value"));
  // Empty dimension: back to the menu with an honest message.
  r = handleCategoriesDigit(values, "1", 0);
  assert.equal(r.state.mode, "menu");
  assert.ok(r.feedback.includes("no categories here yet"));
});

test("amount-entry: digits accumulate, # commits to the list, 0 is a digit here", () => {
  let st: CategoriesState = { mode: "amount-entry", dimension: "amount", amountDigits: "", pos: 0 };
  let r = handleCategoriesDigit(st, "2", 0);
  assert.equal(r.state.amountDigits, "2");
  r = handleCategoriesDigit(r.state, "50#", 0);
  assert.equal(r.state.mode, "list");
  assert.equal(r.state.amount, 250);
  assert.equal(r.state.amountDigits, undefined);
  // Bare pound: enter the amount first.
  r = handleCategoriesDigit(st, "#", 0);
  assert.equal(r.state.mode, "amount-entry");
  assert.ok(r.feedback.includes("Enter the amount first"));
  // 0 is a digit of the amount here, not "back" (250 has a 0).
  r = handleCategoriesDigit({ ...st, amountDigits: "25" }, "0", 0);
  assert.equal(r.state.amountDigits, "250");
  assert.equal(r.state.mode, "amount-entry");
  // Non-digits are refused.
  r = handleCategoriesDigit(st, "a", 0);
  assert.ok(r.feedback.includes("digits only"));
});

test("list: # next, 9 previous, past the end restarts with # or goes last with 9", () => {
  const list: CategoriesState = { mode: "list", dimension: "outcome", valuePos: 0, pos: 0 };
  let r = handleCategoriesDigit(list, "#", 3);
  assert.equal(r.state.pos, 1);
  r = handleCategoriesDigit(r.state, "9", 3);
  assert.equal(r.state.pos, 0);
  // Past the end: # restarts, 9 goes to the last contact.
  const past: CategoriesState = { mode: "list", dimension: "outcome", valuePos: 0, pos: 3 };
  r = handleCategoriesDigit(past, "#", 3);
  assert.equal(r.state.pos, 0);
  r = handleCategoriesDigit(past, "9", 3);
  assert.equal(r.state.pos, 2);
  r = handleCategoriesDigit(past, "1", 3);
  assert.equal(r.state.pos, 3);
  assert.ok(r.feedback.includes("end of the list"));
  // Empty list: back one level with an honest message.
  r = handleCategoriesDigit(list, "#", 0);
  assert.equal(r.state.mode, "values");
  assert.ok(r.feedback.includes("no contacts in this category"));
});

test("back one level: list -> values, values -> menu, amount list -> amount-entry, menu -> leave", () => {
  assert.equal(categoriesBackOneLevel(menu()), null);
  assert.deepEqual(categoriesBackOneLevel({ mode: "values", dimension: "mood", valuePos: 1, pos: 1 }), { mode: "menu", pos: 0 });
  assert.deepEqual(categoriesBackOneLevel({ mode: "list", dimension: "mood", valuePos: 1, pos: 0 }),
    { mode: "values", dimension: "mood", valuePos: 1, pos: 1 });
  assert.deepEqual(categoriesBackOneLevel({ mode: "list", dimension: "amount", amount: 250, pos: 0 }),
    { mode: "amount-entry", dimension: "amount", amount: 250, pos: 0 });
  const fromList = handleCategoriesDigit({ mode: "list", dimension: "outcome", valuePos: 0, pos: 0 }, "*", 2);
  assert.equal(fromList.state.mode, "values");
  const fromMenu = handleCategoriesDigit(menu(), "0", 0);
  assert.equal(fromMenu.effect.type, "leave");
});

test("flash round-trips; bad JSON returns null", () => {
  const st: CategoriesState = { mode: "list", dimension: "outcome", valuePos: 1, pos: 2 };
  assert.deepEqual(parseCategoriesFlash(encodeCategoriesFlash(st)), st);
  assert.equal(parseCategoriesFlash(null), null);
  assert.equal(parseCategoriesFlash(""), null);
  assert.equal(parseCategoriesFlash("not json"), null);
  assert.equal(parseCategoriesFlash(JSON.stringify({ calling: { mode: "menu" } })), null);
});

test("speech helpers number values and contacts fresh from 1", () => {
  assert.ok(categoryValuesSpeech("Result").includes("Press 1 to hear the contacts"));
  assert.ok(describeCategoryValue("Given", 0, 4).startsWith("Value 1 of 4: Given."));
  assert.ok(describeCategoryValue("Given", 3, 4).startsWith("Value 4 of 4: Given."));
  const c = describeCategoryContact("Cohen", "+17185551234", "Given $250", 0, 2);
  assert.ok(c.startsWith("Contact 1 of 2: Cohen."));
  assert.ok(c.includes("Number 1 7 1 8 5 5 5 1 2 3 4."));
  assert.ok(c.includes("Given $250."));
  assert.ok(describeCategoryContact("+12125550199", null, "No answer", 1, 2).startsWith("Contact 2 of 2: +12125550199."));
  assert.ok(amountEntrySpeech().includes("Enter the amount in dollars"));
});
