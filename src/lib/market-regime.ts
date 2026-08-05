// Detector ligero de régimen de mercado. Usa H1 como TF principal
// (suficientemente estable para etiquetar el contexto) y devuelve una
// etiqueta cualitativa + métricas crudas por si otros módulos quieren
// afinar los umbrales.

import { ema, atr, type Candle } from "./analysis";

export type Regime = "trend_up" | "trend_down" | "range" | "high_vol" | "low_vol" | "unknown";

export type RegimeInfo = {
  regime: Regime;
  adx: number;
  atrPct: number;      // ATR(14) / close, en %
  atrPctP80: number;   // percentil 80 histórico
  atrPctP20: number;   // percentil 20 histórico
  emaSlopePct: number; // pendiente EMA200 relativa (%)
};

function adx(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const upMove = c.high - p.high;
    const dnMove = p.low - c.low;
    plusDM.push(upMove > dnMove && upMove > 0 ? upMove : 0);
    minusDM.push(dnMove > upMove && dnMove > 0 ? dnMove : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const smooth = (arr: number[]): number[] => {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i < period) { sum += arr[i]; if (i === period - 1) out.push(sum); continue; }
      const prev = out[out.length - 1];
      out.push(prev - prev / period + arr[i]);
    }
    return out;
  };
  const trS = smooth(trs);
  const pS = smooth(plusDM);
  const mS = smooth(minusDM);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const tr = trS[i] || 1e-9;
    const pdi = (100 * pS[i]) / tr;
    const mdi = (100 * mS[i]) / tr;
    dx.push((100 * Math.abs(pdi - mdi)) / (pdi + mdi || 1e-9));
  }
  if (dx.length < period) return dx[dx.length - 1] ?? 0;
  // Wilder smoothing sobre DX
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
  }
  return adxVal;
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function detectRegime(h1: Candle[]): RegimeInfo {
  if (!h1 || h1.length < 60) {
    return { regime: "unknown", adx: 0, atrPct: 0, atrPctP80: 0, atrPctP20: 0, emaSlopePct: 0 };
  }
  const closes = h1.map((c) => c.close);
  const last = closes[closes.length - 1];
  const e200 = ema(closes, Math.min(200, closes.length - 1));
  const eLast = e200[e200.length - 1];
  const ePrev = e200[Math.max(0, e200.length - 10)];
  const slopePct = ePrev ? ((eLast - ePrev) / ePrev) * 100 : 0;

  const atrSeries = atr(h1, 14);
  const atrPctSeries = atrSeries.map((v, i) => (v / (closes[i] || 1)) * 100).filter((v) => v > 0);
  const atrPct = atrPctSeries[atrPctSeries.length - 1] ?? 0;
  const window = atrPctSeries.slice(-200);
  const p80 = percentile(window, 80);
  const p20 = percentile(window, 20);

  const adxVal = adx(h1, 14);

  let regime: Regime;
  if (adxVal >= 22 && slopePct > 0.05) regime = "trend_up";
  else if (adxVal >= 22 && slopePct < -0.05) regime = "trend_down";
  else if (adxVal < 18 && atrPct < p20 * 1.05) regime = "range";
  else if (atrPct >= p80) regime = "high_vol";
  else if (atrPct <= p20) regime = "low_vol";
  else regime = "range";

  return { regime, adx: adxVal, atrPct, atrPctP80: p80, atrPctP20: p20, emaSlopePct: slopePct };
}

// Regímenes preferidos por estrategia. Si la señal cae fuera → downgrade.
export const ENGINE_REGIME_WHITELIST: Record<string, Regime[]> = {
  smc_london: ["trend_up", "trend_down", "high_vol"],
  keltner_pullback: ["trend_up", "trend_down"],
  fibo_scalping: ["range", "trend_up", "trend_down"],
  ema_cross_m1: ["trend_up", "trend_down", "high_vol"],
  vwap_reversal: ["range", "low_vol"],
  gold_scalping: ["range", "trend_up", "trend_down"],
  straddle_breakout: ["high_vol"],
  fibo_grid_cent: ["trend_up", "trend_down", "range"],
  ultrascalp_fibo_adaptive: ["trend_up", "trend_down"],
};

/** true si la estrategia normalmente rinde bien en ese régimen. */
export function isRegimeFriendly(engine: string, regime: Regime): boolean {
  const wl = ENGINE_REGIME_WHITELIST[engine];
  if (!wl || regime === "unknown") return true; // sin datos → no bloqueamos
  return wl.includes(regime);
}