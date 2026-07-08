
ALTER TABLE public.mt5_signals
  ADD COLUMN IF NOT EXISTS signal_event_id UUID REFERENCES public.signal_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auto_route BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mt5_signals_event ON public.mt5_signals(signal_event_id);

ALTER TABLE public.user_config
  ADD COLUMN IF NOT EXISTS mt5_auto_route_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mt5_min_confidence TEXT NOT NULL DEFAULT 'high' CHECK (mt5_min_confidence IN ('high','medium'));
