ALTER TABLE public.signal_events
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS r_multiple numeric,
  ADD COLUMN IF NOT EXISTS exit_price numeric,
  ADD COLUMN IF NOT EXISTS entry_time timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE public.signal_events
  DROP CONSTRAINT IF EXISTS signal_events_outcome_check;
ALTER TABLE public.signal_events
  ADD CONSTRAINT signal_events_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('tp1','tp2','tp3','sl','be','timeout','cancelled'));

CREATE INDEX IF NOT EXISTS signal_events_user_engine_created
  ON public.signal_events (user_id, engine, created_at DESC);