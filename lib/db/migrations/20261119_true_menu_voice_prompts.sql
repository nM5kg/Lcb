-- True 16-department menu: voice-prompt columns + relaxed path CHECK.
--
-- WHY: the base migration (20261028_gavhah_yemot_voice_prompts.sql) has
--   path text PRIMARY KEY CHECK (path = 'root' OR path ~ '^[1-9][0-9]{0,15}$')
-- and no yiddish_text / voice / language columns. The true menu needs
-- suffixed keys (1591a, 1592a, ...) and Yiddish draft text + audio, so both
-- the CHECK and the columns must exist on the database the copy reads.
-- The columns and the relaxed CHECK were applied on STAGING only, by hand
-- (~/workspace/yiddish-tts/staging-voice-schema.sql and
-- ~/workspace/yiddish-tts/alter-tishl-path-check.js); this migration makes
-- the same change a real, idempotent repo migration.
--
-- ADDITIVE ONLY, IDEMPOTENT. Apply with the owner role (the deploy agent
-- applies it; DO NOT apply to prod by hand). Safe to run twice.
--
-- 1. Columns the Yiddish drafts need (mirrors staging-voice-schema.sql).
ALTER TABLE public.gavhah_yemot_voice_prompts
  ADD COLUMN IF NOT EXISTS yiddish_text text,
  ADD COLUMN IF NOT EXISTS voice text,
  ADD COLUMN IF NOT EXISTS language text,
  ADD COLUMN IF NOT EXISTS tts_muted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS audio_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS previous_audio_data bytea,
  ADD COLUMN IF NOT EXISTS previous_mime_type text,
  ADD COLUMN IF NOT EXISTS previous_audio_version integer,
  ADD COLUMN IF NOT EXISTS previous_voice text,
  ADD COLUMN IF NOT EXISTS pending_voice text,
  ADD COLUMN IF NOT EXISTS pending_regeneration boolean NOT NULL DEFAULT false;

-- 2. Relax the path CHECK so suffixed keys (1591a ... 1592v) are accepted.
-- The constraint was created inline in the base migration, so its name is
-- auto-generated (gavhah_yemot_voice_prompts_path_check); the DO block
-- looks up whatever CHECK constraint exists on the path column and drops
-- it, then re-adds the relaxed one. If no such constraint exists, the
-- re-add is the only change.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'gavhah_yemot_voice_prompts'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%path%'
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.gavhah_yemot_voice_prompts DROP CONSTRAINT %I', constraint_name);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'gavhah_yemot_voice_prompts'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%[a-z]%')
  THEN
    ALTER TABLE public.gavhah_yemot_voice_prompts
      ADD CONSTRAINT gavhah_yemot_voice_prompts_path_check
      CHECK (path = 'root' OR path ~ '^[1-9][0-9]{0,15}[a-z]?$');
  END IF;
END $$;

-- Notes for the deploy agent:
-- * The gate (path 120) needs NO new columns: it uses
--   gavhah_phone_member_logins / users / gavhah_yemot_call_states only.
-- * After this migration, run ~/workspace/yiddish-tts/load-true-menu-drafts.js
--   (see ~/workspace/gavhah-copy/TRUE-MENU-PUBLISH-PREP.md) to load the
--   Yiddish drafts (yiddish_text + audio, published_path NULL).
