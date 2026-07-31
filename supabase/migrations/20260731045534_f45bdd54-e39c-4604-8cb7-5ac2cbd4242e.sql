CREATE TABLE IF NOT EXISTS public.broker_bars (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL DEFAULT 'XAUUSD',
  tf text NOT NULL,
  bar_time timestamptz NOT NULL,
  open numeric NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  close numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol, tf, bar_time)
);

CREATE INDEX IF NOT EXISTS broker_bars_lookup_idx
  ON public.broker_bars (user_id, tf, bar_time DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.broker_bars TO authenticated;
GRANT ALL ON public.broker_bars TO service_role;

ALTER TABLE public.broker_bars ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_broker_bars" ON public.broker_bars
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.broker_feed_status (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL DEFAULT 'XAUUSD',
  broker text,
  spread_usd numeric,
  last_push_at timestamptz,
  last_bar_time timestamptz,
  bars_received int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.broker_feed_status TO authenticated;
GRANT ALL ON public.broker_feed_status TO service_role;

ALTER TABLE public.broker_feed_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_broker_feed_status" ON public.broker_feed_status
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);