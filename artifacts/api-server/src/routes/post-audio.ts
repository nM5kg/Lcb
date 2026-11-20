// Website recording box + post-audio review + system-voice pipeline.
// (Yakob 2026-11-20: recordings MUST play on the hotline; the website
// post form has an OPTIONAL recording field; updates are transcribed to
// Yiddish text; the system voice re-voices a phone recording.)
//
// Uploads are JSON base64 {mime, base64} — the same pattern the voice
// studio uses (no multipart parsing exists in this server). 4MB cap.
// A recording is stored pending; only a published recording reaches the
// hotline (the engine gate reads review_status='published'), and publish
// always uploads to Yemot /897 first, so a published recording always
// has a playable Yemot path.
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import {
  requireAuth,
  requireAdmin,
  getSessionUserId,
  getSessionUserRole,
} from "../middlewares/auth";
import {
  transcribePostAudio,
  processSystemVoiceSubmission,
  publishPostAudio,
  approvePhoneSubmission,
  type PostType,
} from "../lib/post-audio";

const router: IRouter = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (
  req: Request,
  res: Response,
  next: (error?: unknown) => void
) => {
  void fn(req, res).catch(next);
};
const isStaffRole = (role: string | null | undefined) =>
  role === "admin" || role === "moderator" || role === "super_admin";
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const ALLOWED_AUDIO = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/x-m4a",
]);
const parsePostId = (req: Request): number | null => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
};
const postAuthorId = async (postType: PostType, postId: number): Promise<number | null> => {
  const table = postType === "news" ? "public.news" : "public.discussions";
  const r = await pool.query("SELECT author_id FROM " + table + " WHERE id=$1", [postId]);
  return r.rows[0]?.author_id ?? null;
};
const readAudioBody = (req: Request): { mime: string; bytes: Buffer } | { error: string } => {
  const mime = String((req.body as { mime?: unknown })?.mime || "");
  const base64 = String((req.body as { base64?: unknown })?.base64 || "");
  if (!ALLOWED_AUDIO.has(mime)) return { error: "Unsupported audio type" };
  if (!/^[A-Za-z0-9+/=_-]{20,}$/.test(base64.replace(/\s/g, "")))
    return { error: "Missing audio data" };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return { error: "Audio data is not valid base64" };
  }
  if (bytes.length < 80 || bytes.length > MAX_AUDIO_BYTES)
    return { error: "Recording must be between 80 bytes and 4 MB" };
  return { mime, bytes };
};

// Attach (or replace) a recording on a news update or a discussion.
// The caller must be the post's author or staff. A re-upload resets the
// recording to pending — it must be approved again before it reaches
// the hotline. News recordings are transcribed in the background
// (fire-and-forget; the Worker must not wait on the STT poll).
const attachAudio = (postType: PostType) =>
  wrap(async (req, res) => {
    const postId = parsePostId(req);
    if (!postId) {
      res.status(400).json({ error: "Invalid post id" });
      return;
    }
    const authorId = await postAuthorId(postType, postId);
    if (authorId === null) {
      res.status(404).json({ error: "Post not found" });
      return;
    }
    const userId = getSessionUserId(req)!;
    if (authorId !== userId && !isStaffRole(getSessionUserRole(req))) {
      res.status(403).json({ error: "Not allowed" });
      return;
    }
    const parsed = readAudioBody(req);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const transcriptionStatus = postType === "news" ? "pending" : "not_needed";
    await pool.query(
      "INSERT INTO public.gavhah_post_audio(post_type,post_id,author_id,mime_type,audio_data,byte_size,delivery_mode,review_status,transcript,transcription_status,transcription_error,yemot_path) " +
        "VALUES($1,$2,$3,$4,$5,$6,'original','pending_staff',NULL,$7,NULL,NULL) " +
        "ON CONFLICT(post_type,post_id) DO UPDATE SET author_id=EXCLUDED.author_id,mime_type=EXCLUDED.mime_type,audio_data=EXCLUDED.audio_data,byte_size=EXCLUDED.byte_size,delivery_mode='original',review_status='pending_staff',transcript=NULL,transcription_status=EXCLUDED.transcription_status,transcription_error=NULL,yemot_path=NULL,updated_at=now()",
      [postType, postId, userId, parsed.mime, parsed.bytes, parsed.bytes.length, transcriptionStatus]
    );
    if (postType === "news")
      void transcribePostAudio(postType, postId).catch(() => {});
    res.status(201).json({
      ok: true,
      postType,
      postId,
      reviewStatus: "pending",
      transcriptionStatus,
      byteSize: parsed.bytes.length,
    });
  });
router.post("/news/:id/audio", requireAuth, attachAudio("news"));
router.post("/discussions/:id/audio", requireAuth, attachAudio("discussion"));

// Stream a post's recording back (website player). Published recordings
// are public; a pending/rejected one only to its author or staff.
const serveAudio = (postType: PostType) =>
  wrap(async (req, res) => {
    const postId = parsePostId(req);
    if (!postId) {
      res.status(400).json({ error: "Invalid post id" });
      return;
    }
    const r = await pool.query(
      "SELECT author_id,mime_type,audio_data,byte_size,review_status FROM public.gavhah_post_audio WHERE post_type=$1 AND post_id=$2",
      [postType, postId]
    );
    const row = r.rows[0];
    if (!row || row.byte_size <= 0 || !row.audio_data?.length) {
      res.status(404).json({ error: "No recording" });
      return;
    }
    if (row.review_status !== "published") {
      const viewerId = getSessionUserId(req);
      if (viewerId === null || (row.author_id !== viewerId && !isStaffRole(getSessionUserRole(req)))) {
        res.status(404).json({ error: "No recording" });
        return;
      }
    }
    res.type(row.mime_type || "audio/wav");
    res.setHeader("Content-Length", String(row.audio_data.length));
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(row.audio_data));
  });
router.get("/news/:id/audio", serveAudio("news"));
router.get("/discussions/:id/audio", serveAudio("discussion"));

// Retry / run the Yiddish transcription for a news recording (admin).
// Idempotent: a completed transcript is returned without spending
// credits again.
router.post(
  "/admin/post-audio/:postType/:postId/transcribe",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const postType = String(req.params.postType);
    const postId = parseInt(String(req.params.postId), 10);
    if (postType !== "news" || !Number.isFinite(postId) || postId <= 0) {
      res.status(400).json({ error: "Only news recordings are transcribed" });
      return;
    }
    const result = await transcribePostAudio("news", postId);
    if (!result.ok) {
      res.status(502).json({ error: result.error });
      return;
    }
    res.json({ ok: true, transcript: result.transcript });
  })
);

// Approve or reject a website recording (admin). Approve uploads the
// audio to Yemot /897 and publishes it; a failed Yemot upload is a 502
// and the recording stays pending — never published without a path.
router.post(
  "/admin/post-audio/:postType/:postId/review",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const postType = String(req.params.postType);
    const postId = parseInt(String(req.params.postId), 10);
    if ((postType !== "news" && postType !== "discussion") || !Number.isFinite(postId) || postId <= 0) {
      res.status(400).json({ error: "Invalid post" });
      return;
    }
    const action = String((req.body as { action?: unknown })?.action || "");
    if (action === "reject") {
      const r = await pool.query(
        "UPDATE public.gavhah_post_audio SET review_status='rejected',yemot_path=NULL,updated_at=now() WHERE post_type=$1 AND post_id=$2 RETURNING post_id",
        [postType, postId]
      );
      if (!r.rowCount) {
        res.status(404).json({ error: "No recording attached" });
        return;
      }
      res.json({ ok: true, reviewStatus: "rejected" });
      return;
    }
    if (action !== "approve") {
      res.status(400).json({ error: "action must be approve or reject" });
      return;
    }
    const published = await publishPostAudio(postType as PostType, postId);
    if (!published.ok) {
      res.status(502).json({ error: published.error });
      return;
    }
    res.json({ ok: true, reviewStatus: "published", yemotPath: published.yemotPath });
  })
);

// Run the system-voice pipeline for a phone submission (admin): STT the
// caller's recording to Yiddish, re-voice it with pinchas, store both.
// Synchronous; short recordings finish in seconds. Idempotent — a
// completed submission returns its stored transcript without spending
// credits again.
router.post(
  "/admin/phone-news-submissions/:id/process-system-voice",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = parsePostId(req);
    if (!id) {
      res.status(400).json({ error: "Invalid submission id" });
      return;
    }
    const result = await processSystemVoiceSubmission(id);
    if (!result.ok) {
      res.status(502).json({ error: result.error, transcript: result.transcript });
      return;
    }
    res.json({ ok: true, transcript: result.transcript, audioBytes: result.audioBytes });
  })
);

// Approve or reject a phone submission (admin). Approve creates the news
// update, attaches the audio, uploads it to Yemot /897 and publishes it
// — the update then plays on the hotline. A failed step is a 502 and
// nothing is published; the submission stays pending for a retry.
router.post(
  "/admin/phone-news-submissions/:id/review",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = parsePostId(req);
    if (!id) {
      res.status(400).json({ error: "Invalid submission id" });
      return;
    }
    const action = String((req.body as { action?: unknown })?.action || "");
    if (action === "reject") {
      const r = await pool.query(
        "UPDATE public.gavhah_phone_news_submissions SET status='rejected',reviewed_at=now() WHERE id=$1 AND status='pending_review' RETURNING id",
        [id]
      );
      if (!r.rowCount) {
        res.status(404).json({ error: "Submission not found or not awaiting review" });
        return;
      }
      res.json({ ok: true, status: "rejected" });
      return;
    }
    if (action !== "approve") {
      res.status(400).json({ error: "action must be approve or reject" });
      return;
    }
    const title = (req.body as { title?: unknown })?.title;
    const result = await approvePhoneSubmission(id, typeof title === "string" ? title : undefined);
    if (!result.ok) {
      res.status(502).json({ error: result.error, transcript: result.transcript });
      return;
    }
    res.json({ ok: true, newsId: result.newsId, yemotPath: result.yemotPath });
  })
);

export default router;
