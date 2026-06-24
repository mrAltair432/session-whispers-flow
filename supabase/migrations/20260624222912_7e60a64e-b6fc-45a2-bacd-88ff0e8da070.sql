
-- USER CONFIG
CREATE TABLE public.user_config (
  user_id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  balance NUMERIC NOT NULL DEFAULT 1000,
  risk_per_trade NUMERIC NOT NULL DEFAULT 0.5,
  max_daily_loss_pct NUMERIC NOT NULL DEFAULT 1.5,
  max_trades_per_day INT NOT NULL DEFAULT 2,
  telegram_chat_id TEXT,
  telegram_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_alert_high_confidence BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_config TO authenticated;
GRANT ALL ON public.user_config TO service_role;
ALTER TABLE public.user_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own config" ON public.user_config FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- SETUPS
CREATE TABLE public.setups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  symbol TEXT NOT NULL DEFAULT 'XAU/USD',
  bias TEXT NOT NULL CHECK (bias IN ('long','short')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium')),
  entry NUMERIC NOT NULL,
  stop_loss NUMERIC NOT NULL,
  tp1 NUMERIC NOT NULL,
  tp2 NUMERIC NOT NULL,
  tp3 NUMERIC,
  lot_size NUMERIC NOT NULL,
  risk_usd NUMERIC NOT NULL,
  reasoning JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','executed','skipped','expired')),
  telegram_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.setups TO authenticated;
GRANT ALL ON public.setups TO service_role;
ALTER TABLE public.setups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own setups" ON public.setups FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX setups_user_created_idx ON public.setups (user_id, created_at DESC);

-- DAILY STATS
CREATE TABLE public.daily_stats (
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  trade_date DATE NOT NULL,
  trades_count INT NOT NULL DEFAULT 0,
  pnl_usd NUMERIC NOT NULL DEFAULT 0,
  loss_usd NUMERIC NOT NULL DEFAULT 0,
  blocked BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, trade_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_stats TO authenticated;
GRANT ALL ON public.daily_stats TO service_role;
ALTER TABLE public.daily_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own stats" ON public.daily_stats FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- JOURNAL TRADES
CREATE TABLE public.journal_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  setup_id UUID REFERENCES public.setups ON DELETE SET NULL,
  bias TEXT NOT NULL CHECK (bias IN ('long','short')),
  entry NUMERIC NOT NULL,
  exit NUMERIC,
  stop_loss NUMERIC NOT NULL,
  lot_size NUMERIC NOT NULL,
  result TEXT CHECK (result IN ('win','loss','breakeven','open')),
  r_multiple NUMERIC,
  pnl_usd NUMERIC,
  notes TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_trades TO authenticated;
GRANT ALL ON public.journal_trades TO service_role;
ALTER TABLE public.journal_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trades" ON public.journal_trades FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX journal_user_opened_idx ON public.journal_trades (user_id, opened_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER touch_user_config BEFORE UPDATE ON public.user_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Auto-create user_config on signup
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_config (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
