CREATE TABLE public.engine_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  engine text NOT NULL,
  consecutive_losses integer NOT NULL DEFAULT 0,
  total_closed integer NOT NULL DEFAULT 0,
  total_r numeric NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  disabled_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, engine)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.engine_health TO authenticated;
GRANT ALL ON public.engine_health TO service_role;

ALTER TABLE public.engine_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own engine health"
ON public.engine_health
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.mt5_signals ADD COLUMN IF NOT EXISTS closed_reason text;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER update_engine_health_updated_at
BEFORE UPDATE ON public.engine_health
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();