-- Calling categories + auto-contact support (Yakob 2026-11-19 23:09 / 23:18–23:35).
--
-- ADDITIVE ONLY, IDEMPOTENT. Apply ONCE with the owner role (the deploy
-- agent applies it; DO NOT apply to prod by hand). Safe to run twice.
--
-- What the live schema already has (verified read-only 2026-11-19 via
-- prod_owner_conn.txt — do NOT re-derive from repo files):
--   * max_call_sessions ALREADY has purpose_type (text, default 'none'),
--     purpose_key (text, nullable), amount (numeric), money_kind (text).
--     The engine can persist a campaign/case/project pick on the session
--     with NO DDL for those columns.
--   * NEITHER fundraising_call_reports NOR max_call_sessions has an
--     outcome CHECK (outcome is unconstrained text), and there are ZERO
--     legacy outcome='spoke' rows in either table — so the "spoke" ->
--     "given" rename needs NO CHECK widening and NO data rewrite. New
--     code writes 'given' only; reads map 'spoke' -> 'given'
--     (normalizeReportOutcome in calling-queue.ts).
--   * money_kind on fundraising_call_reports is already CHECK-constrained
--     to ('none','received','pledged') — the pledge flow needs no change.
--   * calling_scheduled_calls already exists (case/campaign/project
--     columns included) and the tishl_* item_kind CHECKs already include
--     'scheduled_call' — a pickup scheduled via insertScheduledCall
--     surfaces on Tishl with no further DDL.
--   * communication_contacts already has postal_address + notes; the
--     auto-contact insert only needs (user_id, name, phone) — name is
--     stored as '' (blank) because the column is NOT NULL.
--
-- What this migration ADDS (all missing live):
--   1. payment_method TEXT (nullable) on both tables — the METHOD LABEL
--      only (credit_card / cash / check / tzedakah_card / voucher).
--      NEVER a card number: no card processing or secure card saving
--      exists anywhere in the system.
--   2. campaign_id / project_id INTEGER (nullable, FK, ON DELETE SET
--      NULL) on fundraising_call_reports — so the report carries the
--      campaign/project pick too (the session already carries it via
--      purpose_type/purpose_key).
--   3. pledge_amount NUMERIC NOT NULL DEFAULT 0 on both tables — what
--      was undertaken, when a pledge was (partly) paid; amount is what
--      was actually paid.
--
-- Verification queries (run after applying; expect the columns listed):
--   SELECT table_name, column_name, data_type FROM information_schema.columns
--     WHERE table_schema='public'
--     AND ((table_name='fundraising_call_reports'
--           AND column_name IN ('payment_method','campaign_id','project_id','pledge_amount'))
--        OR (table_name='max_call_sessions'
--           AND column_name IN ('payment_method','pledge_amount')));
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid='public.fundraising_call_reports'::regclass
--     AND conname LIKE '%campaign_id%' OR conname LIKE '%project_id%';
--   -- Legacy check (expect 0 rows already, and 0 after):
--   SELECT count(*) FROM public.fundraising_call_reports WHERE outcome='spoke';
--   SELECT count(*) FROM public.max_call_sessions WHERE outcome='spoke';

-- 1. Payment-method label (nullable; NULL = not asked / skipped).
ALTER TABLE public.fundraising_call_reports
  ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE public.max_call_sessions
  ADD COLUMN IF NOT EXISTS payment_method text;

-- 2. Campaign / project carried on the report (session already has
-- purpose_type/purpose_key). FKs mirror calling_scheduled_calls.
ALTER TABLE public.fundraising_call_reports
  ADD COLUMN IF NOT EXISTS campaign_id integer,
  ADD COLUMN IF NOT EXISTS project_id integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fundraising_call_reports_campaign_id_fkey') THEN
    ALTER TABLE public.fundraising_call_reports
      ADD CONSTRAINT fundraising_call_reports_campaign_id_fkey
      FOREIGN KEY (campaign_id) REFERENCES public.featured_causes(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fundraising_call_reports_project_id_fkey') THEN
    ALTER TABLE public.fundraising_call_reports
      ADD CONSTRAINT fundraising_call_reports_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.community_projects(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS fundraising_call_reports_campaign_id_idx
  ON public.fundraising_call_reports(campaign_id);
CREATE INDEX IF NOT EXISTS fundraising_call_reports_project_id_idx
  ON public.fundraising_call_reports(project_id);

-- 3. Pledge amount (what was undertaken; amount = what was paid).
ALTER TABLE public.fundraising_call_reports
  ADD COLUMN IF NOT EXISTS pledge_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE public.max_call_sessions
  ADD COLUMN IF NOT EXISTS pledge_amount numeric NOT NULL DEFAULT 0;

-- 4. Category lookups: outcome / mood / direction / purpose / amount.
CREATE INDEX IF NOT EXISTS fundraising_call_reports_user_outcome_idx
  ON public.fundraising_call_reports(user_id, outcome);
CREATE INDEX IF NOT EXISTS fundraising_call_reports_user_amount_idx
  ON public.fundraising_call_reports(user_id, amount);
CREATE INDEX IF NOT EXISTS max_call_sessions_user_outcome_idx
  ON public.max_call_sessions(user_id, outcome);
CREATE INDEX IF NOT EXISTS max_call_sessions_user_purpose_idx
  ON public.max_call_sessions(user_id, purpose_type, purpose_key);
