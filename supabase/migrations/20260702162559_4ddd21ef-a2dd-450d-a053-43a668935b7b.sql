CREATE TABLE public.signal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  engine text NOT NULL,
  bias text NOT NULL,
  score integer NOT NULL,
  confidence text NOT NULL,
  entry numeric NOT NULL,
  stop_loss numeric NOT NULL,
  tp1 numeric NOT NULL,
  tp2 numeric NOT NULL,
  tp3 numeric,
  reasoning jsonb NOT NULL DEFAULT '{}'::jsonb,
  telegram_sent boolean NOT NULL DEFAULT false,
  telegram_error text,
  bucket_hour timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX signal_events_dedupe
  ON public.signal_events (user_id, engine, bias, bucket_hour);

CREATE INDEX signal_events_user_created
  ON public.signal_events (user_id, created_at DESC);

GRANT SELECT ON public.signal_events TO authenticated;
GRANT ALL ON public.signal_events TO service_role;

ALTER TABLE public.signal_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own signal events read" ON public.signal_events
  FOR SELECT USING (auth.uid() = user_id);
