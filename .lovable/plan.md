Voy a implementar los tres ingredientes en un mismo bloque, cuidando el orden de dependencias (régimen alimenta ML, ML y calendario filtran señales en `signal-engine`).

## #6 · Filtro económico automático (feed gratuito)

**Fuente:** Trading Economics calendar (endpoint público JSON, sin API key para high-impact). Fallback: mantiene la lista hardcodeada de FOMC/NFP que ya tenemos.

- Nueva ruta `src/routes/api/public/econ-calendar.ts` que hace fetch al feed cada llamada con caché en memoria de 6h. Devuelve eventos USD de alto impacto próximos 7 días.
- Nueva tabla `econ_events_cache` (opcional) para persistir el último snapshot y evitar depender de la red en cada request. Si no se puede refrescar, se usa la caché + los eventos hardcodeados.
- `src/lib/economic-calendar.ts`: agrego `fetchUpcomingEvents()` (server) y `isBlockedWindow(now, windowMinutes=30)`.
- `signal-engine.ts`: si `now` está dentro de ±30 min de un evento high-impact USD → señal descartada con motivo `blocked_econ_event`. Configurable con `user_config.econ_filter_enabled` (default true) y `econ_filter_window_min` (default 30).
- UI en `/settings`: toggle + slider (15/30/60 min) + tabla con próximos 5 eventos.

## #3 · Régimen de mercado

Detección liviana en tiempo real (sin depender de nueva tabla).

- Nuevo módulo `src/lib/market-regime.ts` con `detectRegime(candles)` que devuelve `{ regime: "trend_up" | "trend_down" | "range" | "high_vol" | "low_vol", adx, atrPct, emaSlope }`.
  - **trend_up/down**: ADX(14) ≥ 22 + pendiente EMA200 H1 clara.
  - **range**: ADX < 18 y ancho BB relativo < 0.35%.
  - **high_vol**: ATR%(14) > percentil 80 histórico.
  - **low_vol**: ATR%(14) < percentil 20.
- Se ejecuta en el flujo de `evaluate-signals` y se anexa al `signal_events.metadata` (JSON) para futura correlación.
- Cada estrategia obtiene una whitelist de regímenes preferidos (config estática):
  - E1 SMC → trend + high_vol
  - E2 Alligator → trend
  - E3 Fibo → range o trend suave
  - E4 VWAP → range
  - E6 Straddle → high_vol
- Si la señal se genera en un régimen no whitelisted → downgrade de confidence (`high`→`medium`, `medium`→descartada si `mt5_min_confidence=high`).

## #2 · ML re-scoring online

Cimientos ahora, "online" real cuando haya ≥30 trades cerrados por motor.

- Nueva tabla `ml_scorers` (`user_id, engine, weights jsonb, features text[], auc numeric, trained_at`). El notebook Python ya exporta `ml_filters_*.json`; agrego endpoint `POST /api/public/ml-scorers/upload` (token EA-style, opcional) + botón "Subir ml_filters.json" en `/settings` para cargarlo desde el dashboard.
- `src/lib/ml-scorer.ts`: `scoreSignal(features, weights)` con regresión logística (mismos coeficientes del notebook). Devuelve probabilidad 0-1.
- En `evaluate-signals`, para cada señal generada:
  1. Extraer features del candle actual (ATR%, cuerpo%, distancia a EMA200, régimen, hora).
  2. Si hay scorer entrenado para el motor → calcular `p_win`. Si `p_win < 0.5` → señal descartada; si `0.5 ≤ p_win < 0.6` → downgrade a `medium`; `≥ 0.6` → sube a `high`.
  3. Guardar `p_win` y `regime` en `signal_events.metadata`.
- El "loop online" se ejecuta cuando el kill-switch registra un cierre: si la estrategia tiene ≥30 trades cerrados, encola una re-optimización (por ahora sólo emite alerta Telegram "toca re-entrenar en Kaggle"). El re-entrenamiento real sigue viviendo en el notebook — no reentrenamos en el edge worker.

## Migraciones DB

```sql
ALTER TABLE user_config
  ADD COLUMN econ_filter_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN econ_filter_window_min int NOT NULL DEFAULT 30;

ALTER TABLE signal_events
  ADD COLUMN metadata jsonb;

CREATE TABLE public.ml_scorers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  engine text NOT NULL,
  weights jsonb NOT NULL,
  features text[] NOT NULL,
  auc numeric,
  trained_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, engine)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ml_scorers TO authenticated;
GRANT ALL ON public.ml_scorers TO service_role;
ALTER TABLE public.ml_scorers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own scorers" ON public.ml_scorers FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

## Archivos a tocar

- `supabase migration` (bloque SQL arriba)
- `src/lib/economic-calendar.ts` (+fetch remoto)
- `src/routes/api/public/econ-calendar.ts` (nuevo)
- `src/lib/market-regime.ts` (nuevo)
- `src/lib/ml-scorer.ts` (nuevo)
- `src/lib/ml-scorers.functions.ts` (upload/list scorers desde UI)
- `src/routes/api/public/hooks/evaluate-signals.ts` (integrar los 3 filtros)
- `src/lib/config.functions.ts` (nuevos campos)
- `src/routes/_authenticated/settings.tsx` (UI: econ toggle + upload scorer + tabla eventos)
- Sin cambios en el EA (todo pasa antes de crear el `mt5_signals`)

## Fuera de alcance ahora
- Re-entrenamiento automático en producción (queda en Kaggle).
- Kelly / position sizing adaptativo (#5) — más adelante.
- Walk-forward automático (#7) — más adelante.

¿Le doy?
