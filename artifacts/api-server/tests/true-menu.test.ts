// TRUE 16-department menu — unit tests (no DB, no network).
//
// Run from artifacts/api-server:
//   DATABASE_URL='postgresql://user:pass@localhost:5432/dummy' \
//     node --test --import ./tests/register-ts-resolve.mjs tests/true-menu.test.ts
// The dummy DATABASE_URL only lets @workspace/db construct its Pool at
// import time; no connection is ever made. The resolve hook was extended
// (tests/ts-resolve.mjs) to resolve directory imports ("./schema" ->
// "./schema/index.ts") so the IVR engine (phoneTree, menuPrompt) can be
// imported here at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  safeVoice,
  TRUE_ROOT_YIDDISH,
  TRUE_ROOT_ENGLISH,
  ROOT_MAP,
  FAST_PATH_DIGITS,
  rootTargetForDigit,
  GATE_PATH,
  GATE_TARGET_4444,
  encodeGateFlash,
  parseGateFlash,
  YIDDISH_SPOKEN_PATHS,
  DEPT_FIRST_SCREEN,
  GATE_FIRST_YI,
  GATE_FIRST_EN,
  gateText,
  resolveRootTtsPrompt,
  gateAudioKeyForState,
  hasHebrewScript,
} from "../src/lib/true-menu";
import { publicIdSections, canonicalPublicIdPath } from "../src/lib/yemot-section-batch1";
import { phoneTree, phoneNode } from "../src/routes/yemot-whole-platform-ivr";
import { menuPrompt } from "../src/lib/yemot-api-driven-phone";
import { convertGavhahReplyToCxml } from "../src/lib/signalwire-next-hotline";
import { safePath, knownPath } from "../src/routes/yemot-voice-studio";

// --- A. Root digit map (live v117 entry) -----------------------------------
describe("root map", () => {
  it("maps every live root digit to its target", () => {
    const expected: Record<string, string> = {
      "1": "11",
      "2": "9702",
      "3": "9703",
      "4": "9704",
      "5": "159",
      "6": "9706",
      "7": "17",
      "8": "9708",
      "9": "12",
      "11": "97190",
      "12": "181",
      "13": "97193",
      "14": "19",
      "15": "182",
      "16": "9716",
      "77": "192",
      "88": "88",
    };
    for (const [digit, path] of Object.entries(expected)) {
      const t = rootTargetForDigit(digit);
      assert.ok(t && t.kind === "path", `${digit} should map to a path`);
      assert.equal(t.path, path, `${digit} -> ${path}`);
    }
    assert.deepEqual(rootTargetForDigit("4444"), { kind: "folder4444" });
    assert.deepEqual(rootTargetForDigit("64"), { kind: "folder64" });
    assert.deepEqual(rootTargetForDigit("0"), { kind: "register" });
  });

  it("rejects digits live v117 does not accept", () => {
    for (const d of ["10", "20", "99", "00", "", "44444", "100"]) {
      assert.equal(rootTargetForDigit(d), null, d);
    }
  });

  it("gates every department except 1, 8 and 0 (live gate list)", () => {
    const gated = ["2", "3", "4", "5", "6", "7", "9", "11", "12", "13", "14", "15", "16", "77", "88"];
    for (const d of gated) {
      const t = rootTargetForDigit(d);
      assert.ok(t && t.kind === "path" && t.gated, `${d} must be gated`);
    }
    for (const d of ["1", "8"]) {
      const t = rootTargetForDigit(d);
      assert.ok(t && t.kind === "path" && !t.gated, `${d} must be ungated`);
    }
    // 64: live never tested whether it is gated — no gate is invented.
    assert.deepEqual(rootTargetForDigit("64"), { kind: "folder64" });
  });

  it("fast path keeps only the plain-menu departments (1, 7, 9)", () => {
    assert.deepEqual([...FAST_PATH_DIGITS].sort(), ["1", "7", "9"]);
    for (const d of FAST_PATH_DIGITS) {
      const t = rootTargetForDigit(d);
      assert.ok(t && t.kind === "path");
      // Their slow-path render is exactly menuPrompt(): a group with children.
      assert.ok(phoneNode(t.path)?.children, `${t.path} must be a menu group`);
    }
  });
});

// --- B. Root text ----------------------------------------------------------
describe("root text", () => {
  it("Yiddish root names every department in live order", () => {
    assert.ok(TRUE_ROOT_YIDDISH.startsWith("ברוכים הבאים צו גבהה"));
    for (const frag of ["דרוקט 1", "דרוקט 2", "דרוקט 5", "דרוקט 7", "דרוקט 9",
      "גיט אריין 11", "12", "13", "14", "15", "דרוקט 16", "דרוקט 77",
      "דרוקט 88", "גיט אריין 4444", "דרוקט 0", "דרוקט שטערן"]) {
      assert.ok(TRUE_ROOT_YIDDISH.includes(frag), `root must contain ${frag}`);
    }
  });

  it("Yiddish root fits the 950-char root cap (it did NOT fit the old 430)", () => {
    assert.ok(TRUE_ROOT_YIDDISH.length <= 950, `root is ${TRUE_ROOT_YIDDISH.length} chars`);
    assert.ok(TRUE_ROOT_ENGLISH.length <= 950, `english root is ${TRUE_ROOT_ENGLISH.length} chars`);
    const spoken = safeVoice(TRUE_ROOT_YIDDISH, 950, true);
    assert.ok(spoken.includes("שטערן"), "spoken root must reach the closing line");
    assert.ok(spoken.includes("88"), "spoken root must reach department 88");
    // The old 430 cap cut the root off at department 77 — regression guard.
    assert.ok(!safeVoice(TRUE_ROOT_YIDDISH, 430, true).includes("שטערן"));
  });

  it("gate first prompt fits the 950-char gate cap (it did NOT fit the old 430)", () => {
    assert.ok(GATE_FIRST_YI.length <= 950, `gate prompt is ${GATE_FIRST_YI.length} chars`);
    const spoken = safeVoice(GATE_FIRST_YI, 950, true);
    assert.ok(spoken.includes("איין מעניו דרוקט שטערן"), "spoken gate prompt must reach the closing star-back line");
    // The old 430 cap cut it mid-sentence, before the closing line.
    assert.ok(!safeVoice(GATE_FIRST_YI, 430, true).includes("איין מעניו דרוקט שטערן"));
  });
});

// --- C. safeVoice (decision C: Yiddish must not be silenced) ---------------
describe("safeVoice", () => {
  it("leaves English untouched", () => {
    assert.equal(safeVoice("Hello world", 430), "Hello world");
    assert.equal(safeVoice("Hello world", 430, true), "Hello world");
  });

  it("silences Hebrew WITHOUT the flag (old behaviour, kept for dynamic text)", () => {
    assert.equal(safeVoice("ברוכים הבאים", 430), "");
    assert.equal(safeVoice("Hello ברוכים", 430), "");
  });

  it("passes Hebrew WITH the flag (menu/root/gate prompts)", () => {
    assert.equal(safeVoice("ברוכים הבאים צו גבהה", 430, true), "ברוכים הבאים צו גבהה");
    // Maqaf, rafe and points survive (Yiddish orthography).
    const sample = "חסד־נייעס רופֿן שאַרף";
    assert.equal(safeVoice(sample, 430, true), sample);
  });

  it("always silences Arabic (no Arabic prompts exist)", () => {
    assert.equal(safeVoice("مرحبا", 430, true), "");
  });

  it("still strips response-format breakers with the flag on", () => {
    assert.equal(safeVoice("a,b=c#d.e-f&g", 430, true), "a b c d e f g");
  });

  it("truncates to max", () => {
    assert.equal(safeVoice("x".repeat(500), 10).length, 10);
  });
});

// --- D. Login gate flash ----------------------------------------------------
describe("gate flash", () => {
  it("round-trips all three gate states", () => {
    for (const g of [
      { target: "9702" },
      { target: "9702", needId: true },
      { target: "9702", pendingUser: 123 },
      { target: GATE_TARGET_4444 },
    ]) {
      assert.deepEqual(parseGateFlash(encodeGateFlash(g)), g);
    }
  });

  it("rejects corrupt or forged gate state", () => {
    for (const bad of ["", "not json", "{}", '{"target":""}', '{"target":"12a"}',
      '{"target":"9702","needId":false}', '{"target":"9702","pendingUser":0}',
      '{"target":"9702","pendingUser":"7"}', null, undefined]) {
      assert.equal(parseGateFlash(bad as never), null, String(bad));
    }
  });

  it("gate path is 120", () => {
    assert.equal(GATE_PATH, "120");
  });
});

// --- E. Department first screens (live v117 verbatim) ----------------------
describe("department first screens", () => {
  it("covers exactly the prose departments", () => {
    assert.deepEqual(Object.keys(DEPT_FIRST_SCREEN).sort(),
      ["88", "9702", "9703", "9704", "9706", "9716"]);
  });

  it("matches the live v117 wording", () => {
    assert.ok(DEPT_FIRST_SCREEN["9702"].includes("no further approved voice messages"));
    assert.ok(DEPT_FIRST_SCREEN["9703"].includes("For your private Gavhah connections press nine"));
    assert.ok(DEPT_FIRST_SCREEN["9704"].includes("BLN: 0.00 dollars"));
    assert.ok(DEPT_FIRST_SCREEN["9704"].includes("1 people have joined the cause"));
    assert.ok(DEPT_FIRST_SCREEN["9706"].includes("no active Today's Cause"));
    assert.ok(DEPT_FIRST_SCREEN["9716"].includes("Member contact"));
    assert.ok(DEPT_FIRST_SCREEN["88"].includes("Your selection has been received"));
  });
});

// --- F. Phone tree branches -------------------------------------------------
describe("phoneTree", () => {
  const children = (path: string) => Object.keys(phoneNode(path)?.children ?? {});

  it("has every studio-mapped branch as a real branch", () => {
    for (const p of ["9702", "9703", "9704", "9706", "9708", "9716", "97190", "97193"]) {
      assert.ok(phoneNode(p), `phoneTree must contain ${p}`);
    }
  });

  it("has the right children under each new branch", () => {
    assert.deepEqual(children("9702"), ["1"]);
    assert.deepEqual(children("9703"), ["1", "9"]);
    assert.deepEqual(children("9704"), ["1", "2"]);
    assert.deepEqual(children("9706"), ["2"]);
    assert.deepEqual(children("9708"), ["1", "2", "3", "4"]);
    assert.deepEqual(children("9716"), ["1", "2"]);
    assert.deepEqual(children("97190"), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(children("97193"), ["1", "2", "3"]);
  });

  it("preserves the existing departments the new root reuses", () => {
    assert.ok(phoneNode("11")?.children, "news 11");
    assert.ok(phoneNode("12")?.children, "My Askanus 12");
    assert.ok(phoneNode("17")?.children, "minyanim 17");
    assert.deepEqual(children("17"), ["1", "2", "3"]);
    assert.deepEqual(children("159"), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    assert.ok(phoneNode("19")?.children, "Koach Harabim 19");
    assert.ok(phoneNode("182"), "profile 182");
    assert.ok(phoneNode("192"), "system center 192");
    assert.ok(phoneNode("1591"), "Tishl 1591 (path key unchanged)");
    assert.ok(phoneNode("1592"), "Calling 1592 (path key unchanged)");
    assert.ok(phoneTree["1"] && phoneTree["2"], "campaign top levels kept");
  });
});

// --- G. menuPrompt rendering -------------------------------------------------
describe("menuPrompt", () => {
  it("serves the English root by default (Yiddish only as a recording)", () => {
    assert.equal(menuPrompt("", phoneTree), TRUE_ROOT_ENGLISH);
    assert.equal(menuPrompt("999", phoneTree), TRUE_ROOT_ENGLISH);
    assert.ok(!hasHebrewScript(menuPrompt("", phoneTree)));
    // The Yiddish root text is still the recording's text (englishRoot
    // =false is a test-only reference); the engine never passes false.
    assert.equal(menuPrompt("", phoneTree, false), TRUE_ROOT_YIDDISH);
  });

  it("renders the search menu with the live option order (11->4 is minyanim)", () => {
    const text = menuPrompt("97190", phoneTree);
    assert.ok(text.includes("Press 1 for Find a published charity campaign by number"));
    assert.ok(text.includes("Press 2 for Find a public forum topic by number"));
    assert.ok(text.includes("Press 3 for Find a public group by number"));
    assert.ok(text.includes("Press 4 for Find an approved minyan by number"));
    assert.ok(text.includes("Press 5 for Gavhah account search"));
  });

  it("renders the groups and Olam listings from the tree", () => {
    assert.ok(menuPrompt("9708", phoneTree).includes("Press 1 for Groups"));
    assert.ok(menuPrompt("159", phoneTree).includes("Press 1 for Tishl"));
    assert.ok(menuPrompt("17", phoneTree).includes("Press 1 for Minyan directory"));
    assert.ok(menuPrompt("12", phoneTree).includes("Press 1 for My tasks"));
  });

  it("renders leaves as their honest details text", () => {
    assert.ok(menuPrompt("97021", phoneTree).includes("not yet available on the phone"));
  });
});

// --- H. Search aliases (live 11->4, not 11->5) ------------------------------
describe("search aliases", () => {
  it("maps the 97190 children to the same public sections as 183x", () => {
    assert.equal(canonicalPublicIdPath("971901"), "155");
    assert.equal(canonicalPublicIdPath("971902"), "166");
    assert.equal(canonicalPublicIdPath("971903"), "167");
    assert.equal(canonicalPublicIdPath("971904"), "173"); // live 11->4 = minyan
    assert.equal(canonicalPublicIdPath("1831"), "155");
    assert.equal(canonicalPublicIdPath("1834"), "173");
  });

  it("registers the new alias paths as public-by-id sections", () => {
    for (const p of ["971901", "971902", "971903", "971904"]) {
      assert.ok(publicIdSections.has(p), p);
    }
  });
});

// --- I. Yiddish spoken scoping ----------------------------------------------
// English-default rule (Yakob 2026-11-19 23:41): NO path's Yiddish text is
// ever spoken as TTS. Yiddish reaches the caller ONLY as a published
// pinchas recording. This set is therefore deliberately empty.
describe("Yiddish spoken scoping", () => {
  it("speaks Yiddish text for no path (recordings only)", () => {
    assert.deepEqual([...YIDDISH_SPOKEN_PATHS], []);
  });
});

// --- J. SignalWire root gather ------------------------------------------------
// The shared IVR detects the root by call-state path (""), NOT by prompt
// text — the old text check ("Gavhah SignalWire main menu.") can never
// match the Yiddish root. sharedRootMode=true is what lets SignalWire
// callers enter multi-digit root options (11/12/77/88/4444).
describe("SignalWire root gather", () => {
  const rootReply = "read=t-" + TRUE_ROOT_YIDDISH.slice(0, 60) + "=iv0,no,4,1,8,No,no";
  it("allows 5 digits at the root (sharedRootMode=true)", () => {
    const xml = convertGavhahReplyToCxml(rootReply, "https://example.com/cb", true);
    assert.ok(xml.includes('numDigits="5"'), xml);
  });

  it("allows only 1 digit when NOT the root (sharedRootMode=false)", () => {
    const xml = convertGavhahReplyToCxml(rootReply, "https://example.com/cb", false);
    assert.ok(xml.includes('numDigits="1"'), xml);
  });

  it("allows 16 digits at the gate (registration mode, engine maxDigits)", () => {
    const xml = convertGavhahReplyToCxml(
      "read=t-abc=rg0,no,16,1,18,No,no", "https://example.com/cb", false);
    assert.ok(xml.includes('numDigits="16"'), xml);
  });
});

// --- K. Studio publish gating (suffixed Tishl/Calling keys) -----------------
// The publish route 400s unknown paths: safePath must accept the single
// letter suffix (matching the relaxed DB CHECK) and knownPath must accept
// a suffixed key whose base (1591/1592) is a known tree path.
describe("studio publish gating", () => {
  it("safePath accepts suffixed voice-prompt keys", () => {
    assert.equal(safePath("root"), true);
    assert.equal(safePath("1591"), true);
    assert.equal(safePath("1591a"), true);
    assert.equal(safePath("1592v"), true);
    assert.equal(safePath("9702"), true);
    assert.equal(safePath("1591ab"), false);
    assert.equal(safePath("1591A"), false);
    assert.equal(safePath("0"), false);
    assert.equal(safePath(""), false);
  });

  it("knownPath accepts suffixed keys under a known base", () => {
    assert.equal(knownPath("1591"), true);
    assert.equal(knownPath("1591a"), true);
    assert.equal(knownPath("1591w"), true);
    assert.equal(knownPath("1592"), true);
    assert.equal(knownPath("1592v"), true);
    assert.equal(knownPath("9702"), true);
    assert.equal(knownPath("97190"), true);
    assert.equal(knownPath("9777"), true);
    assert.equal(knownPath("9999"), false);
    assert.equal(knownPath("9999z"), false);
    assert.equal(knownPath("1591ab"), false);
  });
});

// --- L. English-default rule (Yakob 2026-11-19 23:41) ----------------------
// REGRESSION (2026-11-19): Yakob tested the live Yemot line and heard
// HEBREW — the Yiddish root text was spoken by Yemot's Hebrew TTS engine.
// New rule: every spoken prompt is EITHER a published pinchas recording
// OR English text. No Hebrew-script text may ever reach a TTS voice.
// SignalWire's converter blanks Hebrew to spaces, so the same rule
// protects both providers.
describe("English-default rule", () => {
  it("menuPrompt serves the English root by default and on SignalWire", () => {
    assert.equal(menuPrompt("", phoneTree, true), TRUE_ROOT_ENGLISH);
    assert.equal(menuPrompt("999", phoneTree, true), TRUE_ROOT_ENGLISH);
    assert.equal(menuPrompt("", phoneTree), TRUE_ROOT_ENGLISH);
    assert.ok(!hasHebrewScript(menuPrompt("", phoneTree, true)));
    assert.ok(!hasHebrewScript(menuPrompt("", phoneTree)));
  });

  it("gateText always returns English, on both providers", () => {
    assert.equal(gateText(GATE_FIRST_YI, GATE_FIRST_EN, true), GATE_FIRST_EN);
    assert.equal(gateText(GATE_FIRST_YI, GATE_FIRST_EN, false), GATE_FIRST_EN);
    assert.equal(gateText("", GATE_FIRST_EN, true), GATE_FIRST_EN);
    assert.equal(gateText(GATE_FIRST_YI, "", false), "");
    assert.equal(gateText("", GATE_FIRST_EN, false), GATE_FIRST_EN);
    assert.equal(gateText(GATE_FIRST_YI, "", true), "");
    assert.ok(!hasHebrewScript(gateText(GATE_FIRST_YI, GATE_FIRST_EN, false)));
  });

  it("the converter blanks Hebrew (why the engine must send English)", () => {
    const xml = convertGavhahReplyToCxml(
      "read=t-" + TRUE_ROOT_YIDDISH + "=iv0,no,4,1,8,No,no",
      "https://example.com/cb", true);
    assert.ok(!/[\u0590-\u05ff]/.test(xml), xml);
    assert.ok(xml.includes("4444"), xml);
  });
});

// --- M. Root prompt resolution + gate audio keys ----------------------------
// The engine resolves the spoken root prompt through resolveRootTtsPrompt
// (a row's English tts_text when plain-ASCII, else the hardcoded English
// root) and plays gate audio through gateAudioKeyForState (120a–120j).
describe("root prompt resolution and gate audio keys", () => {
  it("resolveRootTtsPrompt never returns Hebrew-script text", () => {
    assert.equal(resolveRootTtsPrompt(null), TRUE_ROOT_ENGLISH);
    assert.equal(resolveRootTtsPrompt(""), TRUE_ROOT_ENGLISH);
    assert.equal(resolveRootTtsPrompt("   "), TRUE_ROOT_ENGLISH);
    assert.equal(resolveRootTtsPrompt("Welcome to Gavhah."), "Welcome to Gavhah.");
    // A Yiddish row text falls back to the English root, not to Yiddish.
    assert.equal(resolveRootTtsPrompt(TRUE_ROOT_YIDDISH), TRUE_ROOT_ENGLISH);
    assert.equal(resolveRootTtsPrompt("ברוכים הבאים"), TRUE_ROOT_ENGLISH);
    assert.ok(!hasHebrewScript(resolveRootTtsPrompt(TRUE_ROOT_YIDDISH)));
    assert.ok(!hasHebrewScript(resolveRootTtsPrompt("Hello ברוכים")));
  });

  it("hasHebrewScript detects Hebrew-script text", () => {
    assert.equal(hasHebrewScript(TRUE_ROOT_YIDDISH), true);
    assert.equal(hasHebrewScript("ברוכים"), true);
    assert.equal(hasHebrewScript(TRUE_ROOT_ENGLISH), false);
    assert.equal(hasHebrewScript("Welcome to Gavhah."), false);
    assert.equal(hasHebrewScript(""), false);
  });

  it("gateAudioKeyForState maps every gate state to 120a–120j", () => {
    assert.deepEqual(
      ["first", "reprompt", "wrong", "needId", "wrongId", "password",
       "locked", "welcome", "wrongReprompt", "wrongIdNeedId"]
        .map((k) => gateAudioKeyForState(k as never)),
      ["120a", "120b", "120c", "120d", "120e", "120f", "120g", "120h", "120i", "120j"]);
  });

  it("knownPath accepts the gate and its suffixed audio keys", () => {
    assert.equal(knownPath("120"), true);
    assert.equal(knownPath("120a"), true);
    assert.equal(knownPath("120j"), true);
    assert.equal(safePath("120"), true);
    assert.equal(safePath("120a"), true);
  });
});
