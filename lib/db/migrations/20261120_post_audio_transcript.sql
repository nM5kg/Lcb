-- Post-audio transcription + system-voice pipeline (Yakob 2026-11-20).
-- Website recordings for UPDATES are transcribed to Yiddish text
-- (Yiddish Tools STT, POST /api/v1/transcriptions); discussions never
-- get a transcript. Phone system-voice submissions store their Yiddish
-- transcript and their re-voiced (pinchas TTS) status here.
-- Additive only: new nullable columns + status columns with defaults.
-- No existing rows or constraints are changed.
ALTER TABLE public.gavhah_post_audio
  ADD COLUMN IF NOT EXISTS transcript text;
ALTER TABLE public.gavhah_post_audio
  ADD COLUMN IF NOT EXISTS transcription_status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.gavhah_post_audio
  ADD COLUMN IF NOT EXISTS transcription_error text;
ALTER TABLE public.gavhah_phone_news_submissions
  ADD COLUMN IF NOT EXISTS transcript text;
ALTER TABLE public.gavhah_phone_news_submissions
  ADD COLUMN IF NOT EXISTS system_voice_status text NOT NULL DEFAULT 'not_needed';
-- Existing system-voice submissions (if any) are waiting to be voiced.
UPDATE public.gavhah_phone_news_submissions
  SET system_voice_status='pending'
  WHERE delivery_mode='system_voice' AND system_voice_status='not_needed';
