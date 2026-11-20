// Post-audio pipeline: website recordings attached to news/discussions,
// their Yiddish transcription (updates only), the system-voice re-voicing
// of phone submissions, and publishing a recording to Yemot so the hotline
// plays the actual audio (Build B). (Yakob 2026-11-20.)
//
// Recording states (gavhah_post_audio.review_status):
//  pending_staff — attached, waiting for a moderator. Never on the hotline.
//                  (Shown to the website as "pending".)
//  published — approved AND uploaded to Yemot (/897); yemot_path is set.
//              Only then does the engine play the file on Yemot.
//  rejected  — refused; the audio stays stored, yemot_path stays NULL.
// A published recording ALWAYS has a Yemot path: approve returns 502 and
// leaves the row pending when the Yemot upload fails, so the line never
// falls back to text for a recording that is supposed to play.
//
// A hotline-opened discussion carries an EMPTY audio row (byte_size 1,
// audio_data empty): its recording lives on Yemot as the voice opening,
// not as DB bytes. Approve downloads those bytes from the opening first,
// then uploads to /897 like any other recording.
import { pool, db, newsTable } from "@workspace/db";
import { transcribeAudio, speakYiddish, uploadAudioToYemot } from "./yiddish-tools-media";
import { fetchModeratedNewsAudio } from "./yemot-news-engagement";
import { resolvePublicPostingName } from "./user-display";

export type PostType = "news" | "discussion";
type PostAudioRow = {
  post_type: string;
  post_id: number;
  author_id: number | null;
  mime_type: string;
  audio_data: Buffer;
  byte_size: number;
  delivery_mode: string;
  review_status: string;
  yemot_path: string | null;
  transcript: string | null;
  transcription_status: string;
  transcription_error: string | null;
};
const loadPostAudio = async (postType: PostType, postId: number): Promise<PostAudioRow | null> => {
  const r = await pool.query(
    "SELECT post_type,post_id,author_id,mime_type,audio_data,byte_size,delivery_mode,review_status,yemot_path,transcript,transcription_status,transcription_error FROM public.gavhah_post_audio WHERE post_type=$1 AND post_id=$2",
    [postType, postId]
  );
  return r.rows[0] || null;
};

// What the website may show for a post's recording. Published recordings
// are public; a pending/rejected one is visible only to its author or to
// staff (so the author can preview it while it waits for review).
export async function recordingStatusFor(
  postType: PostType,
  postId: number,
  viewerId: number | null,
  viewerRole: string | null
): Promise<"published" | "pending" | "rejected" | null> {
  const row = await loadPostAudio(postType, postId);
  if (!row) return null;
  const status = row.review_status;
  if (status === "published") return "published";
  const isStaff = viewerRole === "admin" || viewerRole === "moderator" || viewerRole === "super_admin";
  if (viewerId !== null && (row.author_id === viewerId || isStaff)) {
    // The table stores the pending value as 'pending_staff'; the website
    // sees it as "pending".
    if (status === "pending_staff") return "pending";
    if (status === "rejected") return "rejected";
    return null;
  }
  return null;
}

// Transcribe a news recording to Yiddish text (STT) and store the
// transcript. Discussions never call this. Best effort: a failure is
// recorded (transcription_status='failed' + error) so an admin can retry
// from the transcribe endpoint; the recording itself still plays.
export async function transcribePostAudio(
  postType: PostType,
  postId: number
): Promise<{ ok: true; transcript: string } | { ok: false; error: string }> {
  const row = await loadPostAudio(postType, postId);
  if (!row) return { ok: false, error: "No recording attached" };
  if (postType !== "news") return { ok: false, error: "Discussions are not transcribed" };
  if (row.byte_size <= 0 || !row.audio_data?.length)
    return { ok: false, error: "No audio bytes stored yet" };
  const result = await transcribeAudio(Buffer.from(row.audio_data), row.mime_type);
  if (!result.ok) {
    await pool.query(
      "UPDATE public.gavhah_post_audio SET transcription_status='failed',transcription_error=$3,updated_at=now() WHERE post_type=$1 AND post_id=$2",
      [postType, postId, result.error]
    );
    return { ok: false, error: result.error };
  }
  await pool.query(
    "UPDATE public.gavhah_post_audio SET transcript=$3,transcription_status='completed',transcription_error=NULL,updated_at=now() WHERE post_type=$1 AND post_id=$2",
    [postType, postId, result.transcript]
  );
  return { ok: true, transcript: result.transcript };
}

// System-voice pipeline for a phone submission (insert menu option 2,
// updates only): fetch the caller's Yemot recording, transcribe it to
// Yiddish text, re-voice it with pinchas TTS, and store the transcript +
// the re-voiced MP3 on the submission. Idempotent: a completed submission
// returns its stored transcript without spending credits again.
export async function processSystemVoiceSubmission(
  submissionId: number
): Promise<
  | { ok: true; transcript: string; audioBytes: number }
  | { ok: false; error: string; transcript?: string }
> {
  const sub = await pool.query(
    "SELECT id,delivery_mode,status,provider_recording_path,transcript,system_voice_status,audio_data FROM public.gavhah_phone_news_submissions WHERE id=$1",
    [submissionId]
  );
  const row = sub.rows[0];
  if (!row) return { ok: false, error: "Submission not found" };
  if (row.delivery_mode !== "system_voice")
    return { ok: false, error: "Only system-voice submissions can be re-voiced" };
  if (row.system_voice_status === "completed" && row.transcript && row.audio_data?.length)
    return { ok: true, transcript: row.transcript, audioBytes: row.audio_data.length };
  if (!row.provider_recording_path)
    return { ok: false, error: "Submission has no recording" };
  await pool.query(
    "UPDATE public.gavhah_phone_news_submissions SET system_voice_status='pending' WHERE id=$1",
    [submissionId]
  );
  let recording: Buffer;
  try {
    recording = Buffer.from(await fetchModeratedNewsAudio(row.provider_recording_path));
  } catch {
    await pool.query(
      "UPDATE public.gavhah_phone_news_submissions SET system_voice_status='failed' WHERE id=$1",
      [submissionId]
    );
    return { ok: false, error: "Could not fetch the recording from Yemot" };
  }
  const stt = await transcribeAudio(recording, "audio/wav");
  if (!stt.ok) {
    await pool.query(
      "UPDATE public.gavhah_phone_news_submissions SET system_voice_status='failed' WHERE id=$1",
      [submissionId]
    );
    return { ok: false, error: stt.error };
  }
  await pool.query(
    "UPDATE public.gavhah_phone_news_submissions SET transcript=$2 WHERE id=$1",
    [submissionId, stt.transcript]
  );
  const tts = await speakYiddish(stt.transcript, "pinchas");
  if (!tts.ok) {
    await pool.query(
      "UPDATE public.gavhah_phone_news_submissions SET system_voice_status='failed' WHERE id=$1",
      [submissionId]
    );
    return { ok: false, error: tts.error, transcript: stt.transcript };
  }
  await pool.query(
    "UPDATE public.gavhah_phone_news_submissions SET audio_data=$2,audio_mime='audio/mpeg',system_voice_status='completed' WHERE id=$1",
    [submissionId, tts.audio]
  );
  return { ok: true, transcript: stt.transcript, audioBytes: tts.audio.length };
}

// Approve a website recording: make sure the transcript is attempted
// (news only, best effort), then upload the audio to Yemot /897 and mark
// it published with the Yemot path. Returns 502-style failure (ok:false)
// when the Yemot upload fails — the row stays pending, never published
// without a playable path.
export async function publishPostAudio(
  postType: PostType,
  postId: number
): Promise<{ ok: true; yemotPath: string } | { ok: false; error: string }> {
  const row = await loadPostAudio(postType, postId);
  if (!row) return { ok: false, error: "No recording attached" };
  let bytes = Buffer.from(row.audio_data || []);
  // A hotline-opened discussion stores no DB bytes: its recording lives on
  // Yemot as the voice opening. Download it now so the canonical /897
  // upload below has bytes to work with.
  if (bytes.length <= 0 && postType === "discussion") {
    const opening = await pool.query(
      "SELECT title_audio_path FROM public.gavhah_discussion_voice_openings WHERE discussion_id=$1",
      [postId]
    );
    const path = opening.rows[0]?.title_audio_path;
    if (!path) return { ok: false, error: "No audio stored for this discussion" };
    try {
      bytes = Buffer.from(await fetchModeratedNewsAudio(path));
    } catch {
      return { ok: false, error: "Could not fetch the discussion recording from Yemot" };
    }
    await pool.query(
      "UPDATE public.gavhah_post_audio SET audio_data=$3,byte_size=$4,mime_type='audio/wav',updated_at=now() WHERE post_type=$1 AND post_id=$2",
      [postType, postId, bytes, bytes.length]
    );
  }
  if (bytes.length <= 0) return { ok: false, error: "No audio stored for this recording" };
  if (postType === "news" && row.transcription_status === "pending")
    await transcribePostAudio(postType, postId);
  const uploaded = await uploadAudioToYemot(bytes, row.mime_type);
  if (!uploaded.ok) return { ok: false, error: uploaded.error };
  await pool.query(
    "UPDATE public.gavhah_post_audio SET review_status='published',yemot_path=$3,updated_at=now() WHERE post_type=$1 AND post_id=$2",
    [postType, postId, uploaded.yemotPath]
  );
  return { ok: true, yemotPath: uploaded.yemotPath };
}

// Approve a phone submission and put it on the line as a news update:
// creates the news article, attaches the audio (the re-voiced pinchas MP3
// for system-voice, the caller's Yemot recording for own-voice), uploads
// it to Yemot /897, and publishes it. The submission is marked approved
// with the new article id. Nothing is published when the Yemot upload
// fails — the article and the pending recording stay, for a retry.
export async function approvePhoneSubmission(
  submissionId: number,
  title: string | undefined
): Promise<
  | { ok: true; newsId: number; yemotPath: string }
  | { ok: false; error: string; transcript?: string }
> {
  const sub = await pool.query(
    "SELECT id,delivery_mode,status,member_id,provider_recording_path,transcript,system_voice_status,audio_data,audio_mime FROM public.gavhah_phone_news_submissions WHERE id=$1",
    [submissionId]
  );
  const row = sub.rows[0];
  if (!row) return { ok: false, error: "Submission not found" };
  if (row.status !== "pending_review") return { ok: false, error: "Submission is not awaiting review" };
  if (!row.member_id) return { ok: false, error: "Submission has no member" };
  let transcript: string | null = row.transcript || null;
  let bytes: Buffer;
  let mime: string;
  if (row.delivery_mode === "system_voice") {
    if (row.system_voice_status !== "completed" || !row.audio_data?.length) {
      const voiced = await processSystemVoiceSubmission(submissionId);
      if (!voiced.ok) return { ok: false, error: voiced.error, transcript: voiced.transcript };
      transcript = voiced.transcript;
      // The row was loaded before the pipeline ran; re-read the stored
      // re-voiced audio (never trust the stale snapshot).
      const fresh = await pool.query(
        "SELECT audio_data,audio_mime FROM public.gavhah_phone_news_submissions WHERE id=$1",
        [submissionId]
      );
      row.audio_data = fresh.rows[0]?.audio_data;
      row.audio_mime = fresh.rows[0]?.audio_mime;
    }
    bytes = Buffer.from(row.audio_data);
    mime = row.audio_mime || "audio/mpeg";
  } else {
    if (!row.provider_recording_path)
      return { ok: false, error: "Submission has no recording" };
    try {
      bytes = Buffer.from(await fetchModeratedNewsAudio(row.provider_recording_path));
    } catch {
      return { ok: false, error: "Could not fetch the recording from Yemot" };
    }
    mime = "audio/wav";
  }
  const member = await pool.query("SELECT name FROM public.users WHERE id=$1", [row.member_id]);
  const authorName = await resolvePublicPostingName(row.member_id, member.rows[0]?.name || "Phone member");
  const cleanTitle = String(title || "").trim().slice(0, 300) || "Phone update";
  const [article] = await db
    .insert(newsTable)
    .values({
      title: cleanTitle,
      content: transcript || "",
      summary: null,
      imageUrl: null,
      category: "announcement",
      urgency: "normal",
      deadline: null,
      organization: null,
      isFeatured: false,
      authorId: row.member_id,
      authorName,
    })
    .returning({ id: newsTable.id });
  await pool.query(
    "INSERT INTO public.gavhah_post_audio(post_type,post_id,author_id,mime_type,audio_data,byte_size,delivery_mode,review_status,transcript,transcription_status) VALUES('news',$1,$2,$3,$4,$5,$6,'pending_staff',$7,$8) ON CONFLICT(post_type,post_id) DO UPDATE SET author_id=EXCLUDED.author_id,mime_type=EXCLUDED.mime_type,audio_data=EXCLUDED.audio_data,byte_size=EXCLUDED.byte_size,delivery_mode=EXCLUDED.delivery_mode,review_status='pending_staff',transcript=EXCLUDED.transcript,transcription_status=EXCLUDED.transcription_status,yemot_path=NULL,updated_at=now()",
    [article.id, row.member_id, mime, bytes, bytes.length, row.delivery_mode, transcript, transcript ? "completed" : "pending"]
  );
  const published = await publishPostAudio("news", article.id);
  if (!published.ok) return { ok: false, error: published.error, transcript: transcript || undefined };
  await pool.query(
    "UPDATE public.gavhah_phone_news_submissions SET status='approved',news_id=$2,reviewed_at=now() WHERE id=$1",
    [submissionId, article.id]
  );
  return { ok: true, newsId: article.id, yemotPath: published.yemotPath };
}
