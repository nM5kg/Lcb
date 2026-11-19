-- Tishl queue support tables (Gavhah COPY / staging only).
-- Applied to staging branch staging-gavhah-max-20261014 via syncdb.js --write.
-- Add-only: no existing table or row is touched.
-- item_kind is one of 'task' | 'case' | 'missed_call' | 'message'.
-- item_id is the source row id (askanus_tasks.id / askanus_cases.id /
-- max_return_calls.id / notifications.id).

CREATE TABLE IF NOT EXISTS public.tishl_done(
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('task','case','missed_call','message')),
  item_id bigint NOT NULL,
  done_at timestamptz NOT NULL DEFAULT now(),
  done_via text NOT NULL DEFAULT 'tishl' CHECK (char_length(done_via) <= 40),
  PRIMARY KEY (user_id, item_kind, item_id)
);

CREATE TABLE IF NOT EXISTS public.tishl_reminders(
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('task','case','missed_call','message')),
  item_id bigint NOT NULL,
  remind_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','surfaced','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tishl_reminders_user_due_idx
  ON public.tishl_reminders(user_id, status, remind_at);

CREATE TABLE IF NOT EXISTS public.tishl_notes(
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('task','case','missed_call','message')),
  item_id bigint NOT NULL,
  note text NOT NULL CHECK (char_length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tishl_notes_user_item_idx
  ON public.tishl_notes(user_id, item_kind, item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.tishl_holds(
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('task','case','missed_call','message')),
  item_id bigint NOT NULL,
  held_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_kind, item_id)
);
