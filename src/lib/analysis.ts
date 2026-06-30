export type Candle = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
};

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(values[0]);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

// Detect fractal swing highs/lows (5-bar fractal)
export type Swing = { index: number; price: number; type: "high" | "low"; time: number };

export function detectSwings(candles: Candle[], lookback = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: "high", time: candles[i].time });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: "low", time: candles[i].time });
  }
  return swings;
}

// Tendencia: comparar EMA20 vs EMA50 + estructura de swings
export function detectTrend(candles: Candle[]): "bullish" | "bearish" | "ranging" {
  if (candles.length < 50) return "ranging";
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const last20 = e20[e20.length - 1];
  const last50 = e50[e50.length - 1];
  const diff = (last20 - last50) / last50;
  if (diff > 0.0005) return "bullish";
  if (diff < -0.0005) return "bearish";
  return "ranging";
}

// FVG (Fair Value Gap): 3-candle imbalance
export type FVG = { startTime: number; endTime: number; top: number; bottom: number; bias: "bullish" | "bearish" };

export function detectFVGs(candles: Candle[], maxAgeBars = 30): FVG[] {
  const fvgs: FVG[] = [];
  const start = Math.max(2, candles.length - maxAgeBars);
  for (let i = start; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c3 = candles[i];
    // Bullish FVG: low of c3 > high of c1
    if (c3.low > c1.high) {
      fvgs.push({ startTime: c1.time, endTime: c3.time, top: c3.low, bottom: c1.high, bias: "bullish" });
    }
    // Bearish FVG: high of c3 < low of c1
    if (c3.high < c1.low) {
      fvgs.push({ startTime: c1.time, endTime: c3.time, top: c1.low, bottom: c3.high, bias: "bearish" });
    }
  }
  return fvgs;
}

// Detectar barrido de liquidez: la última vela tomó un swing previo y cerró del otro lado
export type LiquiditySweep = {
  type: "high" | "low";
  sweptPrice: number;
  sweptTime: number;
  candleTime: number;
};

export function detectRecentSweep(candles: Candle[], swings: Swing[]): LiquiditySweep | null {
  if (candles.length < 3) return null;
  const last = candles[candles.length - 1];
  // Buscar swings recientes (últimas 50 velas) no rotos antes
  const recent = swings.filter((s) => s.index < candles.length - 1 && s.index > candles.length - 50);
  for (const s of recent.reverse()) {
    if (s.type === "high" && last.high > s.price && last.close < s.price) {
      return { type: "high", sweptPrice: s.price, sweptTime: s.time, candleTime: last.time };
    }
    if (s.type === "low" && last.low < s.price && last.close > s.price) {
      return { type: "low", sweptPrice: s.price, sweptTime: s.time, candleTime: last.time };
    }
  }
  return null;
}

// Calculadora de lote para XAU/USD en cuenta cents Exness
// 1 pip XAU = 0.10 USD por movimiento de precio. Tamaño de contrato 100 oz.
// Pip value por lote estándar = $10 por $1 de movimiento de oro... realmente:
// XAU/USD: 1 lote = 100 oz, valor por punto ($1 mov) = $100. Pip (0.01) = $1.
// Para cuenta cents (Exness): 1 lote cents = 0.01 lote estándar => valor pip = $0.01 por 0.01 de mov.
// Cálculo más fiel: riesgo USD / (distancia_en_dolares * 100) = lotes estándar para cuenta normal.
// Para cuenta cents, el balance está en centavos => si balance "cents" muestra 1000 = $10 reales.
// Asumimos balance en USD reales. Devuelve lote estándar.
export function calcLotSize(balance: number, riskPct: number, entry: number, stopLoss: number) {
  const riskUsd = (balance * riskPct) / 100;
  const distance = Math.abs(entry - stopLoss); // en USD por onza
  if (distance === 0) return { lot: 0, riskUsd };
  // 1 lote estándar = 100 oz => P&L = distance * 100
  const lot = riskUsd / (distance * 100);
  return { lot: Math.round(lot * 100) / 100, riskUsd: Math.round(riskUsd * 100) / 100 };
}

// ATR (Average True Range) - Wilder smoothing
export function atr(candles: Candle[], period = 14): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  if (candles.length < 2) return out;
  const trs: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let prev = 0;
  for (let i = 1; i < trs.length; i++) {
    if (i < period) {
      prev += trs[i];
      if (i === period - 1) {
        prev = prev / (period - 1);
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + trs[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

// Break of Structure (BOS): the last candle closed beyond the most recent opposite swing
// in the direction of the bias. Used as confirmation on M15 after the H1 sweep.
export function detectBOS(candles: Candle[], bias: "long" | "short", lookback = 20): boolean {
  if (candles.length < lookback + 3) return false;
  const window = candles.slice(-lookback - 1, -1);
  const last = candles[candles.length - 1];
  if (bias === "long") {
    const highestHigh = Math.max(...window.map((c) => c.high));
    return last.close > highestHigh;
  } else {
    const lowestLow = Math.min(...window.map((c) => c.low));
    return last.close < lowestLow;
  }
}

// Killzone: London 02:00-05:00 UTC, NY 12:00-15:00 UTC.
// Returns the active session or null. Gold reacts strongest in these windows.
export function getKillzone(unixSeconds: number): "london" | "ny" | null {
  const d = new Date(unixSeconds * 1000);
  const hUTC = d.getUTCHours();
  if (hUTC >= 2 && hUTC < 5) return "london";
  if (hUTC >= 12 && hUTC < 15) return "ny";
  return null;
}