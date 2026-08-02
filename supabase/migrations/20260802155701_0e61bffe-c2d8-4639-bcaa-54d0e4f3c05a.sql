ALTER TABLE public.user_config
  ADD COLUMN IF NOT EXISTS weekend_guard_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS friday_cutoff_hour smallint NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS monday_open_hour smallint NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS weekend_flatten_enabled boolean NOT NULL DEFAULT true;