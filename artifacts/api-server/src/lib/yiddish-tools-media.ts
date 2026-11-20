// Yiddish Tools media pipeline + Yemot media upload for post audio.
// (Yakob 2026-11-20: recordings MUST play on the hotline, and website
// recordings for UPDATES are transcribed to Yiddish text.)
//
// Yiddish Tools (same account, same key as the voice studio):
//  - Transcription: POST /api/v1/transcriptions with an audio file
//    (`audio`) or a URL (`audio_url`); async 202 with a generation id;
//    poll GET /api/v1/generations/{id} until completed. output.text is
//    the Yiddish transcript, output.language is "yi". 600 credits/hour.
//    Verified live 2026-11-20 (5.26 s sample, 1 credit, perfect Yiddish).
//  - Speech: POST /api/v1/speech {text, voice}; same polling; files.audio
//    is the MP3. Voice "pinchas" is the system voice.
// The API key comes from process.env.YIDDISH_TOOLS_API_KEY (a Worker
// secret). Without it every function returns needsApiKey=true and nothing
// is spent; callers must never crash on that.
//
// Yemot upload mirrors the voice-studio publish flow exactly (same folder
// /897, same gavhah_<32 hex>.wav name, convertAudio=1, listing verified):
// the decrypt + providerRequest helpers are duplicated here on purpose so
// the working voice-studio publish is never touched.
import { randomUUID, createDecipheriv } from "node:crypto";
import { pool } from "@workspace/db";

const YIDDISH_TOOLS = "https://yiddish.tools/api/v1";
const yiddishToolsHeaders = () => ({
  Authorization: "Bearer " + (process.env.YIDDISH_TOOLS_API_KEY || ""),
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
const hasYiddishKey = () => !!(process.env.YIDDISH_TOOLS_API_KEY || "").trim();
const generationIdOf = (payload: unknown): string => {
  const d = (payload as { data?: { id?: unknown; generation_id?: unknown }; id?: unknown; generation_id?: unknown }) || {};
  const id = d?.data?.id ?? d?.data?.generation_id ?? d?.id ?? d?.generation_id;
  return typeof id === "string" ? id : "";
};
type GenData = {
  status?: string;
  output?: { text?: string; language?: string };
  files?: { audio?: string };
  credits_used?: number;
  error?: string;
};
async function pollGeneration(id: string, timeoutMs = 120000): Promise<GenData | null> {
  const started = Date.now();
  for (;;) {
    const checked = await fetch(YIDDISH_TOOLS + "/generations/" + id, {
      headers: yiddishToolsHeaders(),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!checked.ok) return null;
    const gen = (await checked.json()) as { data?: GenData };
    const state = String(gen?.data?.status || "");
    if (state === "completed") return gen.data || {};
    if (state === "failed" || state === "error") return gen.data || { status: state };
    if (Date.now() - started > timeoutMs) return { status: "timeout" };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Transcribe audio bytes to Yiddish text (STT). Updates only — discussions
// never call this. Returns the transcript on success.
export async function transcribeAudio(
  bytes: Buffer,
  mime: string
): Promise<
  | { ok: true; transcript: string; creditsUsed: number | null }
  | { ok: false; error: string; needsApiKey?: boolean }
> {
  if (!hasYiddishKey())
    return { ok: false, needsApiKey: true, error: "Yiddish Tools API key is not configured on this Worker" };
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array(bytes)], { type: mime || "audio/webm" }), "recording.wav");
  let created: Response;
  try {
    created = await fetch(YIDDISH_TOOLS + "/transcriptions", {
      method: "POST",
      headers: yiddishToolsHeaders(),
      body: form,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return { ok: false, error: "Could not reach the transcription service" };
  }
  if (created.status !== 202 && !created.ok)
    return { ok: false, error: "Transcription service did not accept the audio" };
  const generationId = generationIdOf(await created.json().catch(() => null));
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(generationId))
    return { ok: false, error: "Transcription service returned no generation id" };
  const done = await pollGeneration(generationId);
  if (!done) return { ok: false, error: "Could not check the transcription" };
  if (done.status === "timeout") return { ok: false, error: "Transcription timed out; retry later" };
  if (done.status === "failed" || done.status === "error")
    return { ok: false, error: done.error || "Transcription failed" };
  const text = String(done.output?.text || "").trim();
  if (!text) return { ok: false, error: "Transcription returned no text" };
  return { ok: true, transcript: text, creditsUsed: done.credits_used ?? null };
}

// Speak Yiddish text with the system voice (pinchas) and return the MP3
// bytes. Used by the system-voice pipeline: transcript -> pinchas audio.
export async function speakYiddish(
  text: string,
  voice = "pinchas"
): Promise<
  | { ok: true; audio: Buffer; creditsUsed: number | null }
  | { ok: false; error: string; needsApiKey?: boolean }
> {
  if (!hasYiddishKey())
    return { ok: false, needsApiKey: true, error: "Yiddish Tools API key is not configured on this Worker" };
  const form = new URLSearchParams({ text, voice });
  let created: Response;
  try {
    created = await fetch(YIDDISH_TOOLS + "/speech", {
      method: "POST",
      headers: { ...yiddishToolsHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { ok: false, error: "Could not reach the speech service" };
  }
  if (!created.ok) return { ok: false, error: "Speech service did not accept the text" };
  const generationId = generationIdOf(await created.json().catch(() => null));
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(generationId))
    return { ok: false, error: "Speech service returned no generation id" };
  const done = await pollGeneration(generationId);
  if (!done) return { ok: false, error: "Could not check the speech generation" };
  if (done.status === "timeout") return { ok: false, error: "Speech generation timed out; retry later" };
  if (done.status === "failed" || done.status === "error")
    return { ok: false, error: done.error || "Speech generation failed" };
  const audioUrl = String(done.files?.audio || "");
  if (!audioUrl) return { ok: false, error: "Speech generation completed without an audio file" };
  const audio = await fetch(audioUrl, {
    headers: yiddishToolsHeaders(),
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!audio.ok) return { ok: false, error: "Could not download the generated audio" };
  const audioBytes = Buffer.from(await audio.arrayBuffer());
  if (audioBytes.length < 80 || audioBytes.length > 4 * 1024 * 1024)
    return { ok: false, error: "Generated audio has an unexpected size" };
  return { ok: true, audio: audioBytes, creditsUsed: done.credits_used ?? null };
}

// ---- Yemot media upload (mirrors the voice-studio publish flow) ----
const decryptYemotToken = (row: { token_nonce: string; token_ciphertext: string; token_tag: string }) => {
  const configured = process.env.YEMOT_ENCRYPTION_KEY || "";
  const key = Buffer.from(configured, "base64");
  if (key.length !== 32 || key.toString("base64") !== configured)
    throw Error("Yemot encryption key unavailable");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.token_nonce, "base64"));
  decipher.setAAD(Buffer.from("gavhah:yemot:platform:v1"));
  decipher.setAuthTag(Buffer.from(row.token_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.token_ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
};
const providerRequest = async (token: string, operation: string, values: Record<string, string>) => {
  const body = new URLSearchParams({ token, ...values });
  const response = await fetch("https://www.call2all.co.il/ym/api/" + operation, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("Yemot API unavailable");
  const result = (await response.json()) as { responseStatus?: string; files?: unknown[] };
  if (result?.responseStatus !== "OK") throw Error("Yemot declined " + operation);
  return result;
};

// Upload audio bytes to the approved Yemot media folder (/897) as a unique
// gavhah_<uuid>.wav (convertAudio=1) and verify the listing. Returns the
// ivr2: path the hotline plays (read=f-). On any failure returns ok:false
// and NOTHING is written to the database — callers must not mark a
// recording published without a Yemot path, or the line would fall back
// to text instead of playing the recording.
export async function uploadAudioToYemot(
  bytes: Buffer,
  mime: string
): Promise<{ ok: true; yemotPath: string } | { ok: false; error: string }> {
  try {
    const [installed, global, savedFolder] = await Promise.all([
      pool.query("SELECT state FROM public.gavhah_yemot_ivr_install WHERE id=1"),
      pool.query(
        "SELECT token_nonce,token_ciphertext,token_tag,enabled,last_verified_at FROM public.gavhah_yemot_global WHERE id=1"
      ),
      pool.query("SELECT media_folder FROM public.gavhah_yemot_voice_storage WHERE id=1"),
    ]);
    const mediaFolder = String(savedFolder.rows[0]?.media_folder || "");
    if (installed.rows[0]?.state !== "live" || !/^\/[0-9]{2,3}$/.test(mediaFolder))
      return { ok: false, error: "A verified add-only Yemot extension must be live first" };
    const conn = global.rows[0];
    if (!conn?.enabled || !conn?.last_verified_at)
      return { ok: false, error: "Central Yemot connection is not active" };
    const token = decryptYemotToken(conn);
    const directory = "ivr2:" + mediaFolder;
    const before = await providerRequest(token, "GetIVR2Dir", { path: directory });
    if (!Array.isArray(before.files)) return { ok: false, error: "Cannot verify approved Yemot media folder" };
    const file = "gavhah_" + randomUUID().replace(/-/g, "") + ".wav";
    const basename = file.slice(0, -4);
    const fileName = (x: unknown) =>
      typeof x === "string"
        ? x
        : typeof x === "object" && x !== null
          ? String(
              (x as { name?: string; fileName?: string; path?: string }).name ||
                (x as { fileName?: string }).fileName ||
                (x as { path?: string }).path ||
                ""
            )
          : "";
    if (before.files.some((x) => fileName(x).endsWith("/" + file) || fileName(x) === file))
      return { ok: false, error: "Yemot media name collision" };
    const form = new FormData();
    form.set("token", token);
    form.set("path", directory + "/" + file);
    form.set("convertAudio", "1");
    form.set("autoNumbering", "false");
    form.set("tts", "0");
    form.set("qqfile", new Blob([new Uint8Array(bytes)], { type: mime || "audio/wav" }), file);
    const up = await fetch("https://www.call2all.co.il/ym/api/UploadFile", {
      method: "POST",
      body: form,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
    if (!up.ok) return { ok: false, error: "Yemot media upload failed" };
    const result = (await up.json()) as { responseStatus?: string };
    if (result.responseStatus !== "OK") return { ok: false, error: "Yemot did not accept media" };
    const after = await providerRequest(token, "GetIVR2Dir", { path: directory });
    if (!Array.isArray(after.files) || !after.files.some((x) => fileName(x).includes(basename)))
      return { ok: false, error: "Yemot did not confirm the uploaded file" };
    return { ok: true, yemotPath: directory + "/" + file };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Yemot upload failed" };
  }
}
