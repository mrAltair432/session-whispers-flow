ALTER TABLE public.user_config
  ADD COLUMN IF NOT EXISTS ftmo_mode_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ftmo_profit_target_pct numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS ftmo_daily_loss_pct numeric NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS ftmo_max_loss_pct numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS ftmo_min_days integer NOT NULL DEFAULT 4;