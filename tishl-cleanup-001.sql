-- Tishl seed cleanup (staging ONLY — branch staging-gavhah-max-20261014).
-- DO NOT RUN until the IVR child has finished testing with the seed rows.
-- Removes every row seeded for user 9 (copy-test2@gavhah-copy.local) on
-- 2026-11-19, plus any Tishl side rows for that user, in FK-safe order.
-- The pair code row is expired by time (30 min) and is removed here too.

DELETE FROM public.gavhah_phone_pair_codes
 WHERE user_id = 9 AND redeemed_at IS NULL;
DELETE FROM public.tishl_holds WHERE user_id = 9;
DELETE FROM public.tishl_notes WHERE user_id = 9;
DELETE FROM public.tishl_reminders WHERE user_id = 9;
DELETE FROM public.tishl_done WHERE user_id = 9;
DELETE FROM public.max_return_calls
 WHERE id = 2 AND owner_user_id = 9; -- provider_call_id 'TISHL-SEED-CALL-1'
DELETE FROM public.max_call_sessions
 WHERE id = 9 AND user_id = 9; -- provider_call_id 'TISHL-SEED-SESSION-1'
DELETE FROM public.notifications WHERE id = 366 AND user_id = 9;
DELETE FROM public.askanus_cases WHERE id = 9 AND user_id = 9;
DELETE FROM public.askanus_tasks WHERE id IN (5, 6) AND user_id = 9;
DELETE FROM public.gavhah_olam_chesed_access WHERE user_id = 9 AND status = 'linked';
