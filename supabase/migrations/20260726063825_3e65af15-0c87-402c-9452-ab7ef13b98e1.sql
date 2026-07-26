ALTER TABLE public.user_config
  ADD COLUMN IF NOT EXISTS econ_filter_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS econ_filter_window_min int NOT NULL DEFAULT 30;

ALTER TABLE public.signal_events
  ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE TABLE IF NOT EXISTS public.ml_scorers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  engine text NOT NULL,
  weights jsonb NOT NULL,
  features text[] NOT NULL,
  intercept numeric NOT NULL DEFAULT 0,
  auc numeric,
  trained_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, engine)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ml_scorers TO authenticated;
GRANT ALL ON public.ml_scorers TO service_role;

ALTER TABLE public.ml_scorers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_ml_scorers" ON public.ml_scorers
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER ml_scorers_touch_updated_at
  BEFORE UPDATE ON public.ml_scorers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();