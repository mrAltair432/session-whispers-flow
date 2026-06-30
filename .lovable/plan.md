## Objetivo

Cuatro bloques de trabajo en este orden:

1. **Exportador MT5 → CSV** (script `.mq5` descargable + parser multi-TF).
2. **Filtros horarios automáticos** del oro (cierre semanal, gap lunes, avisos FOMC/NFP).
3. **Multi-estrategia** (tabla `strategies`, selector, comparador, optimizador por estrategia).
4. **Estrategia 2: Continuación NY** (pullback EMA50 H1 + entrada M15 en killzone NY).

## 1. Exportador MT5

- Nuevo archivo `public/mt5/XAUUSD_History_Export.mq5` descargable desde la app.
- Script MQL5 que recorre M1/M5/M15/H1/H4/D1 y escribe un CSV por TF en `MQL5/Files/` con formato:
  ```
  Date,Open,High,Low,Close,Volume
  2015.01.05 03:00,1186.45,1187.20,1186.10,1186.85,12450
  ```
- Sección "Datos históricos" en `/backtest` con instrucciones paso a paso y botón de descarga.

### Parser multi-TF

- Extender `src/lib/csv-parser.ts`: aceptar formato MT5 (`YYYY.MM.DD HH:MM`) además del actual (`MM/DD/YYYY HH:MM`).
- `detectTimeframeMinutes` ya existe; añadir helper `classifyTimeframe(mins) → "M1"|"M5"|"M15"|"H1"|"H4"|"D1"`.
- En `/backtest`: drop-zone que acepta múltiples CSV simultáneamente, los clasifica y los muestra en una tabla de "datasets cargados" (TF, rango, # velas).
- Pasar `customM15` y `customH1` además de `customH4` al backtest engine.

## 2. Filtros horarios automáticos

En `src/lib/backtest.ts` agregar antes del scoring:

- **Cierre semanal**: excluir velas con `weekday=5 && hourUTC >= 21` y `weekday=0` completo (sábado).
- **Pausa diaria**: excluir hora UTC 22 (= 17 NY, mercado cerrado).
- **Gap lunes**: excluir lunes UTC 0-2 (primeras 2h tras apertura).
- Toggles en UI para desactivarlos (default ON).

**FOMC/NFP**: hardcodear fechas conocidas 2024-2026 en `src/lib/economic-calendar.ts`, mostrar badge "⚠️ NFP hoy" en dashboard y en backtest marcar esos días en un color distinto en la gráfica por-día.

## 3. Multi-estrategia

### Tabla

```sql
CREATE TABLE public.strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  engine_key text NOT NULL,  -- 'smc_london' | 'ny_continuation' | future...
  params jsonb NOT NULL DEFAULT '{}',  -- minScore, excludeHours, etc.
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

+ GRANT + RLS por `user_id`. Seed automático al primer login con E1 y E2.

### Engine refactor

- `src/lib/strategies/index.ts` con registro `{ smc_london: smcLondonEngine, ny_continuation: nyContinuationEngine }`.
- Cada engine implementa `evaluateBar(bars, params) → Setup | null`.
- `backtest.ts` recibe `engineKey + params` en vez de tener la lógica hardcodeada.

### UI

- Nueva ruta `/strategies` para CRUD de estrategias (lista, editar nombre/descripción/params, duplicar).
- En `/backtest`: selector "¿Qué estrategia probar?" con multiselect para comparar 2-3 estrategias lado a lado.
- En `/dashboard`: badge en cada setup mostrando qué estrategia lo generó.

## 4. Estrategia 2: Continuación NY

`src/lib/strategies/ny-continuation.ts`:

- **Contexto H4**: tendencia clara (EMA20 vs EMA50, pendiente positiva/negativa).
- **Setup H1**: precio hace pullback a EMA50 ± 0.5 ATR sin romper estructura.
- **Entrada M15**: BOS a favor de la tendencia + FVG en zona de pullback.
- **Killzone**: solo UTC 13-16 (solape Londres-NY + apertura NY pura).
- **SL**: bajo último swing M15 + buffer ATR.
- **TPs**: 1R / 2R / 3R (más conservador que E1 por ser continuación).

## Sección técnica

### Archivos nuevos
- `public/mt5/XAUUSD_History_Export.mq5`
- `src/lib/economic-calendar.ts`
- `src/lib/strategies/index.ts`
- `src/lib/strategies/smc-london.ts` (extraer de signal-engine actual)
- `src/lib/strategies/ny-continuation.ts`
- `src/lib/strategies.functions.ts` (CRUD)
- `src/routes/_authenticated/strategies.tsx`
- Migración Supabase para tabla `strategies` + seed

### Archivos modificados
- `src/lib/csv-parser.ts` — formato MT5 + clasificación TF
- `src/lib/backtest.ts` y `.functions.ts` — recibir `engineKey`, filtros automáticos
- `src/routes/_authenticated/backtest.tsx` — multi-CSV, selector estrategia, comparador
- `src/lib/signal-engine.ts` — delegar al registro de strategies
- `src/routes/_authenticated/dashboard.tsx` — mostrar estrategia origen + badge FOMC/NFP

### Riesgos
- El refactor de signal-engine puede romper alertas Telegram → mantener back-compat con engine_key default `smc_london`.
- CSV grandes (M1 con 10 años ≈ 3M velas) pueden tumbar el navegador → procesar en chunks y avisar si excede 500k filas.

## Lo que NO incluye este plan
- Bots MQL5 ejecutables (esa fase viene después).
- Backtest con datos tick-by-tick (solo OHLC por vela).
- Walk-forward optimization cruzado entre estrategias.
