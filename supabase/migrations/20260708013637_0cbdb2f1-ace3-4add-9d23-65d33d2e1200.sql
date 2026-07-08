
CREATE TABLE public.mt5_signals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  engine TEXT NOT NULL,
  bias TEXT NOT NULL CHECK (bias IN ('long','short')),
  entry NUMERIC NOT NULL,
  stop_loss NUMERIC NOT NULL,
  tp1 NUMERIC NOT NULL,
  tp2 NUMERIC,
  tp3 NUMERIC,
  risk_usd NUMERIC,
  lot_size NUMERIC,
  break_even_at_r NUMERIC,
  time_stop_minutes INTEGER,
  score INTEGER,
  confidence TEXT,
  reasoning JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','filled','closed','cancelled','error')),
  mt5_ticket BIGINT,
  fill_price NUMERIC,
  filled_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  exit_price NUMERIC,
  pnl_usd NUMERIC,
  r_multiple NUMERIC,
  error_message TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mt5_signals_user_status ON public.mt5_signals (user_id, status, created_at DESC);
CREATE INDEX idx_mt5_signals_pending ON public.mt5_signals (status, expires_at) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mt5_signals TO authenticated;
GRANT ALL ON public.mt5_signals TO service_role;

ALTER TABLE public.mt5_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own mt5 signals" ON public.mt5_signals
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER touch_mt5_signals_updated_at
  BEFORE UPDATE ON public.mt5_signals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Tabla de tokens del EA (uno por usuario). El EA envía este token en cada request.
CREATE TABLE public.mt5_ea_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  label TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mt5_ea_tokens TO authenticated;
GRANT ALL ON public.mt5_ea_tokens TO service_role;

ALTER TABLE public.mt5_ea_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own ea tokens" ON public.mt5_ea_tokens
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER touch_mt5_ea_tokens_updated_at
  BEFORE UPDATE ON public.mt5_ea_tokens
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
