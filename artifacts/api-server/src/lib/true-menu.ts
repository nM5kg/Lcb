// TRUE 16-department menu (live old Worker v117, walked 2026-11-19).
// Pure data + helpers for the Gavhah hotline fix-forward. No DB, no I/O,
// so this module is unit-testable on its own.
//
// Source of truth: ~/workspace/gavhah-copy/TRUE-MENU-v117.md (entry verbatim,
// every department first screen verbatim, login gate verbatim).
// Studio rootChoices() mapping: src/routes/yemot-studio-ui.ts (rootChoices).
// Where live v117 and the studio disagree, LIVE WINS (see notes below).

// ---------------------------------------------------------------------------
// safeVoice — the live response path (moved here from yemot-api-driven-phone
// so it can be unit-tested). The old version returned "" for ANY Hebrew
// text, which silenced every Yiddish menu. Yemot reads Hebrew text, so
// Yiddish menu prompts are now allowed through when the caller opts in
// (allowHebrew=true, used only for menu/root/gate prompts). Everything else
// keeps the old behaviour: Hebrew without the flag is still silenced, and
// Arabic is always silenced (no Arabic prompts exist in this menu).
// Format-breaking characters (= , ; # . - &) are still stripped because
// they would corrupt the Yemot `read=t-...=ivN,...` response line.
// ---------------------------------------------------------------------------
export function safeVoice(input: unknown, max = 430, allowHebrew = false): string {
  const plain = String(input ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ");
  // Arabic is never spoken on this hotline (no Arabic prompts exist).
  if (/[\u0600-\u06ff]/u.test(plain)) return "";
  const hasHebrew = /[\u0590-\u05ff]/u.test(plain);
  if (hasHebrew && !allowHebrew) return "";
  return plain
    .replace(/[&=,;#.\-]/g, " ")
    .replace(allowHebrew ? /[^\x20-\x7e\u0590-\u05ff]/g : /[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// Root menu. Yiddish is the live text: the studio root sample
// (yemot-studio-ui.ts recYiddishSamples.root), extended with the two
// departments it omitted — 16 (contact a member by ID) and 88 (advanced
// My Askanus) — in live v117 order, plus the live closing line.
// English is the fallback only: it is spoken only if the Yiddish render
// is empty (it never is — the Yiddish string is a constant).
// ---------------------------------------------------------------------------
export const TRUE_ROOT_YIDDISH =
  "ברוכים הבאים צו גבהה. פאר חסד־נייעס דרוקט 1. פאר עסקנים־שמועסן דרוקט 2. " +
  "פאר פריוואטע הילף דרוקט 3. פאר התקבצו לטובה דרוקט 4. " +
  "פאר עולם החסד קאמיוניקאציע דרוקט 5. פאר היינטיגע צדקה דרוקט 6. " +
  "פאר מנינים דרוקט 7. פאר גרופעס דרוקט 8. פאר מיין עסקנות דרוקט 9. " +
  "פאר זוכן גיט אריין 11. פאר מעלדונגען 12. פאר מיינע פארבינדונגען 13. " +
  "פאר כח הרבים 14. פאר מיין פראפיל 15. " +
  "צו קאנטאקטירן א גבהה־מעמבער לויט זיין מעמבער־איי־די דרוקט 16. " +
  "פאר מער אפטיילונגען דרוקט 77. פאר פארגעשריטענע מיין עסקנות דרוקט 88. " +
  "פאר קאמפיין סענטער גיט אריין 4444. פאר גבהה־רעגיסטראציע דרוקט 0. " +
  "צו גיין צוריק צום פריערדיגן מעניו דרוקט שטערן.";

export const TRUE_ROOT_ENGLISH =
  "Welcome to Gavhah For charity news and fast updates press one " +
  "For Askanim discussions press two For private help requests press three " +
  "For Hitkabtzu Letovah press four For Olam Chesed Communications press five " +
  "For today's charity campaign press six For Minyanim press seven " +
  "For community group center press eight For My Askanus press nine " +
  "Search press eleven Notifications press twelve My Connections press thirteen " +
  "Koach Harabim Dashboard press fourteen My Profile press fifteen " +
  "To contact a Gavhah member by their member ID press sixteen " +
  "More sections and System Center press seventy seven " +
  "Advanced My Askanus press eighty eight Campaign Center enter four four four four " +
  "To become an official Gavhah member press zero To return to the previous menu press star";

// ---------------------------------------------------------------------------
// Root digit -> target. This REPLACES the old "1"+digit prefixing and the
// campaign4444 fork: the true menu is served regardless of campaign state.
// Paths are internal route keys (see "Path keys" below). Two targets are
// Yemot folder redirects, exactly as live v117 returns them:
//   4444 -> go_to_folder=/4444 (Campaign Center, gated — live v117 gates it)
//   64   -> go_to_folder=/64   (unannounced, NOT gated — live never tested
//           whether 64 is gated, so no gate is invented for it)
//   0    -> registration path 185 (live v117 0 is the registration prompt;
//           the copy's phone registration flow; see the gap note in the
//           build report — live asks for a 10-digit phone number, the copy
//           implements password-based signup).
// ---------------------------------------------------------------------------
export type RootTarget =
  | { kind: "path"; path: string; gated: boolean }
  | { kind: "folder4444" }
  | { kind: "folder64" }
  | { kind: "register" };

export const ROOT_MAP: Record<string, RootTarget> = {
  "1": { kind: "path", path: "11", gated: false }, // News (not gated, live)
  "2": { kind: "path", path: "9702", gated: true }, // Askanim discussions
  "3": { kind: "path", path: "9703", gated: true }, // Private help requests
  "4": { kind: "path", path: "9704", gated: true }, // Hitkabtzu Letovah
  "5": { kind: "path", path: "159", gated: true }, // Olam Chesed (gate 159)
  "6": { kind: "path", path: "9706", gated: true }, // Today's charity campaign
  "7": { kind: "path", path: "17", gated: true }, // Minyanim
  "8": { kind: "path", path: "9708", gated: false }, // Groups (not gated, live)
  "9": { kind: "path", path: "12", gated: true }, // My Askanus
  "11": { kind: "path", path: "97190", gated: true }, // Search
  "12": { kind: "path", path: "181", gated: true }, // Notifications (live: the
  // list itself, NOT the 97181 options submenu — live wins over the studio)
  "13": { kind: "path", path: "97193", gated: true }, // My Connections
  "14": { kind: "path", path: "19", gated: true }, // Koach Harabim Dashboard
  // (the old Management subtree 191-195 IS the live 14 submenu, verbatim)
  "15": { kind: "path", path: "182", gated: true }, // My Profile
  "16": { kind: "path", path: "9716", gated: true }, // Contact a member by ID
  // (no studio rootChoices entry existed for 16; the IVR path 9716 is new)
  "77": { kind: "path", path: "192", gated: true }, // System Center summary
  // (live: the summary itself; pressing 1 repeats it — there is NO options
  // menu behind 77 and 77->1 does NOT reach office reservations, despite
  // the old note. Live wins; the 9777 studio menu stays studio-only.)
  "88": { kind: "path", path: "88", gated: true }, // Advanced My Askanus
  // (live: generic stub only; the copy has no real submenu behind it)
  "4444": { kind: "folder4444" },
  "64": { kind: "folder64" },
  "0": { kind: "register" },
};

export function rootTargetForDigit(digit: string): RootTarget | null {
  return Object.prototype.hasOwnProperty.call(ROOT_MAP, digit) ? ROOT_MAP[digit] : null;
}

// Digits the fast root shortcut (tryFastYemotRoot) may still answer.
// Only departments whose slow-path render is exactly menuPrompt() qualify:
// 1 -> 11 (news menu), 7 -> 17 (minyanim menu), 9 -> 12 (My Askanus menu).
// All other single digits need the slow path: 2/3/4/6/8 have special
// live-verbatim first screens, and 5 -> 159 needs the Olam-access gate
// and its special render. Multi-digit roots (11, 12, ...) never take the
// fast path (it only accepts one digit).
export const FAST_PATH_DIGITS = ["1", "7", "9"];

// ---------------------------------------------------------------------------
// Path keys. The specs said Tishl 1591 / Calling 1592, built when the menu
// was 1 -> 5 -> 9. Those ARE the internal route keys and they do NOT change:
// with Olam at 5 directly the digit sequences become 5 -> 1 (Tishl) and
// 5 -> 2 (Calling), but the paths stay 159 / 1591 / 1592 and the 159 gate,
// the Tishl/Calling state machines and the Yemot no-dial rule are untouched.
// The same holds for the studio's virtual paths, which are now REAL tree
// branches (phoneTree "9" subtree): 9702, 9703, 9704, 9706, 9708, 9716,
// 97190, 97193. Re-keyed (studio virtual -> IVR real path) where live v117
// contradicts the studio:
//   root 11 Search -> 97190 (studio path, now a real branch; children
//     971901-971904 are aliases of publicIdSections 155/166/167/173, so
//     LIVE 11->4 (not 11->5) is the minyan lookup — see yemot-section-batch1)
//   root 12 Notifications -> 181 (live list, NOT the 97181 options menu)
//   root 13 Connections -> 97193 (real branch; children redirect to
//     164/153/152, the closest existing sections)
//   root 14 Koach Harabim -> 19 (existing Management subtree)
//   root 15 Profile -> 182 (existing profile leaf)
//   root 77 System Center -> 192 (live summary, NOT the 9777 menu)
//   root 88 -> 88 (live stub; no tree branch, special render)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Login gate (IVR path "120"). Live v117 gates every department EXCEPT
// 1, 8 and 0; the gate is the 6-12 digit member password, member ID only
// when required. The copy has no PIN lookup (passwords are scrypt with a
// random salt), so the gate verifies against the phone-registered members
// (gavhah_phone_member_logins — the only accounts with a phone password)
// with a bounded scan, and falls back to the 8-digit website pairing code
// (the same code path 125 redeems) for website-only members. The raw
// password is NEVER stored: on a multi-match the gate asks for the 4-digit
// member ID first and re-asks the password afterwards.
// Gate state rides in action_flash as JSON (no schema change):
//   {"target":"9702"} | {"target":"9702","needId":true} |
//   {"target":"9702","pendingUser":123}
// The campaign folder is a gate target too: target "__4444__" means
// "after login, go_to_folder=/4444".
// ---------------------------------------------------------------------------
export const GATE_PATH = "120";
export const GATE_TARGET_4444 = "__4444__";

export type GateFlash = {
  target: string;
  needId?: boolean;
  pendingUser?: number;
};

export function encodeGateFlash(gate: GateFlash): string {
  const out: GateFlash = { target: gate.target };
  if (gate.needId) out.needId = true;
  if (typeof gate.pendingUser === "number") out.pendingUser = gate.pendingUser;
  return JSON.stringify(out);
}

export function parseGateFlash(value: string | null | undefined): GateFlash | null {
  try {
    const p = JSON.parse(value || "") as GateFlash;
    if (!p || typeof p !== "object" || typeof p.target !== "string" || !p.target) return null;
    if (p.target !== GATE_TARGET_4444 && !/^[1-9][0-9]{0,15}$/.test(p.target)) return null;
    if (p.needId !== undefined && p.needId !== true) return null;
    if (p.pendingUser !== undefined && (!Number.isSafeInteger(p.pendingUser) || p.pendingUser <= 0))
      return null;
    return p;
  } catch {
    return null;
  }
}

// Gate prompts. Yiddish is composed from the live English gate text plus
// the existing 1251-1254 studio phrasing ("לייגט אריין אייער פריוואטן
// גבהה־פעסווארד...", "ברוכים הבאים צוריק..."); it is NEW text, not a
// pinchas-recorded phrase — it needs a recording before publish. English
// is the fallback only (spoken only if the Yiddish string is empty).
export const GATE_FIRST_YI =
  "דאס אפטיילונג פאדערט גבהה־מעמבערשאפט. לייגט אריין אייער פריוואטן גבהה־פעסווארד פון זעקס ביז צוועלף ציפערן, און דרוקט שארף. " +
  "מיר וועלן בעטן עקסטערע פרטים נאר ווען אייער אקאונט־זיכערהייט פאדערט עס. נייע מעמבערס דרוקט שטערן און דערנאך 0 צו רעגיסטרירן. " +
  "לייגט אריין אייער פריוואטן גבהה־פעסווארד פון זעקס ביז צוועלף ציפערן, און דרוקט שארף. " +
  "אייער מעמבער־איי־די איז נאר נויטיג ווען זיכערהייט־איינשטעלונגען אדער אן אנדערער באניצער מיטן זעלבן פעסווארד פאדערט עס. " +
  "צו גיין צוריק איין מעניו דרוקט שטערן.";
export const GATE_FIRST_EN =
  "This section needs Gavhah membership Enter only your six to twelve digit password " +
  "We will ask for extra details only when your account security requires them " +
  "New members press star and then zero to register " +
  "Enter only your six to twelve digit Gavhah password then press pound " +
  "Your member ID is required only when security settings or another user with the same PIN requires it " +
  "To go back one menu press star";
export const GATE_REPROMPT_YI =
  "לייגט אריין אייער פריוואטן גבהה־פעסווארד פון זעקס ביז צוועלף ציפערן, און דרוקט שארף. " +
  "אייער מעמבער־איי־די איז נאר נויטיג ווען זיכערהייט־איינשטעלונגען אדער אן אנדערער באניצער מיטן זעלבן פעסווארד פאדערט עס. " +
  "צו גיין צוריק איין מעניו דרוקט שטערן.";
export const GATE_REPROMPT_EN =
  "Enter only your six to twelve digit Gavhah password then pound " +
  "Enter only your six to twelve digit Gavhah password then press pound " +
  "Your member ID is required only when security settings or another user with the same PIN requires it " +
  "To go back one menu press star";
export const GATE_WRONG_YI = "דער פעסווארד איז נישט באשטעטיגט. פרובירט נאכאמאל.";
export const GATE_WRONG_EN = "Password not verified Try again";
export const GATE_NEED_ID_YI =
  "אייער מעמבער־איי־די איז נויטיג. לייגט אריין אייער פיר־ציפערדיקן גבהה־איי־די, און דרוקט שארף. " +
  "צו גיין צוריק איין מעניו דרוקט שטערן.";
export const GATE_NEED_ID_EN =
  "Your member ID is required. Enter your four digit Gavhah member ID, then press pound. " +
  "To go back one menu press star";
export const GATE_WRONG_ID_YI = "דער מעמבער־איי־די איז נישט געפונען. פרובירט נאכאמאל.";
export const GATE_WRONG_ID_EN = "Member ID not found. Try again";
export const GATE_PASSWORD_YI =
  "לייגט אריין אייער פריוואטן גבהה־פעסווארד פון זעקס ביז צוועלף ציפערן, און דרוקט שארף. " +
  "צו גיין צוריק איין מעניו דרוקט שטערן.";
export const GATE_PASSWORD_EN =
  "Enter your six to twelve digit Gavhah password then press pound. To go back one menu press star";
export const GATE_LOCKED_YI = "עס זענען געווען צו פיל אומריכטיגע פרואוון. הייבט אן נאכאמאל.";
export const GATE_LOCKED_EN = "Too many attempts. Hang up and try again later. ";
export const GATE_WELCOME_YI = "ברוכים הבאים צוריק. אייער אקאונט איז באשטעטיגט.";
export const GATE_WELCOME_EN = "Welcome back. Your account is verified. ";

// English-default rule (Yakob 2026-11-19 23:41): every spoken prompt is
// EITHER a published pinchas audio recording OR English text — never
// Hebrew-script text spoken by a TTS voice. Yemot's Hebrew TTS engine
// reads Yiddish text as Hebrew, which is what Yakob heard on the live
// line. Yiddish reaches the caller ONLY as a published recording
// (published_path -> sendRead audio branch). The third parameter is kept
// for call-site compatibility and ignored.
export function gateText(_yi: string, en: string, _englishFirst?: boolean): string {
  return en;
}

/** True when the text contains any Hebrew-script character. */
export function hasHebrewScript(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text);
}

/** True when the text is plain ASCII (safe to hand to any TTS voice). */
export function isAsciiText(text: string): boolean {
  return /^[\x00-\x7F]*$/.test(text);
}

/**
 * Resolve the spoken root prompt from a voice-prompt row: the row's
 * tts_text only when it is non-empty plain-ASCII English; otherwise the
 * hardcoded English root. Yiddish text (yiddish_text) is NEVER returned
 * here — it is the recording's text, not a TTS prompt.
 */
export function resolveRootTtsPrompt(rowTtsText: string | null | undefined): string {
  const t = typeof rowTtsText === "string" ? rowTtsText.trim() : "";
  return t && isAsciiText(t) ? t : TRUE_ROOT_ENGLISH;
}

// Gate audio keys (path 120, suffixed draft keys 120a–120j). The gate
// prompts are recorded in pinchas like every other prompt; the engine
// plays the published recording for the gate state it is in, and speaks
// the English text otherwise. Composites (120i/120j) are single recordings
// of the two English prompts spoken back-to-back, so the caller hears one
// continuous pinchas recording instead of two TTS fragments.
export type GateAudioKind =
  | "first" | "reprompt" | "wrong" | "needId" | "wrongId" | "password"
  | "locked" | "welcome" | "wrongReprompt" | "wrongIdNeedId";
export function gateAudioKeyForState(kind: GateAudioKind): string {
  switch (kind) {
    case "first": return "120a";
    case "reprompt": return "120b";
    case "wrong": return "120c";
    case "needId": return "120d";
    case "wrongId": return "120e";
    case "password": return "120f";
    case "locked": return "120g";
    case "welcome": return "120h";
    case "wrongReprompt": return "120i";
    case "wrongIdNeedId": return "120j";
  }
}

// ---------------------------------------------------------------------------
// Department first screens — live v117 VERBATIM (English). These are the
// spoken fallbacks for the new departments; the Yiddish drafts for these
// paths do not exist yet (the 38-phrase set has no 9702/9703/9704/9706/
// 9708/9716 text), so English is what callers hear until Yiddish texts
// are written and recorded for them.
// 9704 totals: the observed live values (BLN 0.00, 1 person). There is NO
// Hitkabtzu totals source in this repo — these numbers are static until
// a totals query exists. Do not present them as live data.
// 88 / 8: live returns the generic stub for these paths (see below).
// ---------------------------------------------------------------------------
export const DEPT_FIRST_SCREEN: Record<string, string> = {
  "9702":
    // Askanim talk (Yakob 2026-11-20 04:46/04:54): the same structure as
    // News — 1 = hear all discussions, 2 = by number — and only
    // discussions WITH a recording are on the phone (rule 1). The old
    // live text ("no further approved voice messages", 0 = open a new
    // discussion) is replaced: 0 is the main menu here, and opening a new
    // discussion is option 1 in the insert menu (0 inside the list).
    "Askanim talk. Only discussions with a recording are on the phone. " +
    "Press 1 to hear all discussions. Press 2 to hear a discussion by its number. " +
    "Press zero for the main menu. Press star to return",
  "9703":
    "For community projects and campaigns stay on the line For options press one " +
    "For your private Gavhah connections press nine Community project one " +
    "Project in the Gavhah community directory Read the project details on the public Gavhah account " +
    "Stay on the line for the next project",
  // Live text includes literal "..t-" fragments and double spaces; those are
  // Yemot response artifacts, NOT prompt text — the clean text is used here.
  "9704":
    "Total amount already undertaken BLN: 0.00 dollars. " +
    "Total funds actually received: not yet verified in the system. " +
    "1 people have joined the cause. " +
    "To join the cause press one. Do you know a cause deserving the spotlight? " +
    "Press two to submit a proposal for team review.",
  "9706": "There is no active Today's Cause cause at the moment. Press two to suggest one.",
  "9716":
    "Member contact To contact a Gavhah member press one To hear how it works press two Press star to return",
  "88":
    "Your selection has been received For the previous menu press star For further options press one " +
    "To go back one menu press star",
};

// Generic live stub (departments 5/8/9/15/88 on v117). Only 88 uses it in
// this build: 5 serves the copy's real Olam submenu, 9 serves real My
// Askanus (12), 15 serves the real profile leaf (182), and 8 serves the
// copy's real groups menu (9708) — all documented deviations from live,
// kept because the functionality is built and verified on the copy.
export const LIVE_STUB_TEXT =
  "Your selection has been received For the previous menu press star For further options press one " +
  "To go back one menu press star";

// ---------------------------------------------------------------------------
// Yiddish voice-prompt drafts (DB gavhah_yemot_voice_prompts.yiddish_text)
// are NEVER spoken as TTS (English-default rule, Yakob 2026-11-19 23:41):
// Yiddish reaches the caller ONLY as a published pinchas recording.
// This set is kept (empty) for import compatibility; it used to list the
// paths whose Yiddish text the engine spoke, and is now deliberately empty.
// Do NOT add paths here — adding one would re-enable Hebrew TTS.
// ---------------------------------------------------------------------------
export const YIDDISH_SPOKEN_PATHS = new Set<string>([]);
