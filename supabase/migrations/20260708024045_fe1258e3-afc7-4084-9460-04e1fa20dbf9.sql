CREATE TABLE IF NOT EXISTS public.strategy_params (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  engine_key text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'colab',
  generated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, engine_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_params TO authenticated;
GRANT ALL ON public.strategy_params TO service_role;

ALTER TABLE public.strategy_params ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_strategy_params_select" ON public.strategy_params
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own_strategy_params_insert" ON public.strategy_params
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "own_strategy_params_update" ON public.strategy_params
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "own_strategy_params_delete" ON public.strategy_params
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE TRIGGER strategy_params_touch_updated_at
  BEFORE UPDATE ON public.strategy_params
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();