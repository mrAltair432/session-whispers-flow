import { atr, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

type Direction = 1 | -1;
type AdaptiveSwing = { index: number; price: number; type: Direction };

export type UltraScalpFiboParams = {
  minScore?: number;
  zigZagAtrMult?: number;
  barsToScan?: number;
  minLegAtr?: number;
  maxLegAgeBars?: number;
  maxRetrace?: number;
  fibEntries?: number[];
  touchToleranceAtr?: number;
  slAtrMult?: number;
  tpRR?: number;
  breakEvenAtR?: number;
  trailAfterR?: number;
  trailStepAtrMult?: number;
  maxHoldBars?: number;
  onlyLondonNy?: boolean;
};

function adaptiveSwings(candles: Candle[], atrValues: number[], mult: number): AdaptiveSwing[] {
  if (candles.length < 3) return [];
  const out: AdaptiveSwing[] = [];
  let direction: Direction = 1;
  let extremeIndex = 0;
  let extremePrice = candles[0].high;

  for (let i = 1; i < candles.length; i++) {
    const threshold = Math.max((atrValues[i] || 0) * mult, 0.01);
    if (direction === 1) {
      if (candles[i].high >= extremePrice) {
        extremePrice = candles[i].high;
        extremeIndex = i;
      } else if (extremePrice - candles[i].low >= threshold) {
        out.push({ index: extremeIndex, price: extremePrice, type: 1 });
        direction = -1;
        extremePrice = candles[i].low;
        extremeIndex = i;
      }
    } else if (candles[i].low <= extremePrice) {
      extremePrice = candles[i].low;
      extremeIndex = i;
    } else if (candles[i].high - extremePrice >= threshold) {
      out.push({ index: extremeIndex, price: extremePrice, type: -1 });
      direction = 1;
      extremePrice = candles[i].high;
      extremeIndex = i;
    }
  }
  return out;
}

function structureTrend(swings: AdaptiveSwing[]): Direction | 0 {
  const highs = swings.filter((s) => s.type === 1).slice(-2);
  const lows = swings.filter((s) => s.type === -1).slice(-2);
  if (highs.length < 2 || lows.length < 2) return 0;
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return 1;
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return -1;
  return 0;
}

function timeframeContext(candles: Candle[], mult: number, scan: number): Direction | 0 {
  const window = candles.slice(-scan);
  return structureTrend(adaptiveSwings(window, atr(window, 14), mult));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// E8 conserva la tesis del EA (estructura H4/H1 + pierna M15 + entradas Fibo),
// pero sólo trabaja con pivotes confirmados. El código original incluía la vela
// en formación y podía borrar/recolocar órdenes por una estructura que luego
// desaparecía. Para un backtest OHLC reproducible, una entrada pendiente se
// considera activada cuando una vela M5 cerrada toca el nivel Fibo.
export function evaluateUltraScalpFiboAdaptive(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  m5: Candle[],
  params: UltraScalpFiboParams = {},
): Signal {
  const minScore = params.minScore ?? 72;
  const zigZagAtrMult = params.zigZagAtrMult ?? 1.2;
  const barsToScan = params.barsToScan ?? 600;
  const minLegAtr = params.minLegAtr ?? 2;
  const maxLegAgeBars = params.maxLegAgeBars ?? 10;
  const maxRetrace = params.maxRetrace ?? 0.72;
  const fibEntries = params.fibEntries ?? [0.618, 0.786, 0.886];
  const touchToleranceAtr = params.touchToleranceAtr ?? 0.12;
  const slAtrMult = params.slAtrMult ?? 1.8;
  const tpRR = params.tpRR ?? 2.2;
  const breakEvenAtR = params.breakEvenAtR ?? 0.8;
  const trailAfterR = params.trailAfterR ?? 1.2;
  const trailStepAtrMult = params.trailStepAtrMult ?? 0.8;
  const maxHoldBars = params.maxHoldBars ?? 36;

  if (h4.length < 60 || h1.length < 80 || m15.length < 80 || m5.length < 80) return null;
  const lastM5 = m5[m5.length - 1];
  const hour = new Date(lastM5.time * 1000).getUTCHours();
  if ((params.onlyLondonNy ?? true) && (hour < 7 || hour >= 20)) return null;

  const h4Trend = timeframeContext(h4, zigZagAtrMult, barsToScan);
  const h1Trend = timeframeContext(h1, zigZagAtrMult, barsToScan);
  if (h4Trend === 0 || h1Trend === 0 || h4Trend !== h1Trend) return null;
  const direction = h4Trend;
  const bias: "long" | "short" = direction === 1 ? "long" : "short";

  const m15Window = m15.slice(-barsToScan);
  const atr15 = atr(m15Window, 14);
  const swings15 = adaptiveSwings(m15Window, atr15, zigZagAtrMult);
  if (swings15.length < 2) return null;
  const legStart = swings15[swings15.length - 2];
  const legEnd = swings15[swings15.length - 1];
  const validLeg = direction === 1
    ? legStart.type === -1 && legEnd.type === 1
    : legStart.type === 1 && legEnd.type === -1;
  if (!validLeg) return null;

  const range = Math.abs(legEnd.price - legStart.price);
  const atr15Now = atr15[atr15.length - 1];
  if (!atr15Now || range < minLegAtr * atr15Now) return null;
  const legAge = m15Window.length - 1 - legEnd.index;
  if (legAge > maxLegAgeBars) return null;

  const retrace = direction === 1
    ? (legEnd.price - m15Window[m15Window.length - 1].close) / range
    : (m15Window[m15Window.length - 1].close - legEnd.price) / range;
  if (retrace < 0 || retrace > maxRetrace) return null;

  const atr5Values = atr(m5, 14);
  const atr5Now = atr5Values[atr5Values.length - 1];
  if (!atr5Now) return null;
  const tolerance = atr5Now * touchToleranceAtr;
  const levels = fibEntries
    .filter((f) => f > 0 && f < 1)
    .map((f) => ({
      fib: f,
      price: direction === 1 ? legEnd.price - range * f : legEnd.price + range * f,
    }));
  const touched = levels
    .filter(({ price }) => lastM5.low <= price + tolerance && lastM5.high >= price - tolerance)
    .sort((a, b) => Math.abs(a.price - lastM5.close) - Math.abs(b.price - lastM5.close))[0];
  if (!touched) return null;

  // Exige rechazo de la zona, no sólo una mecha que atraviesa el nivel.
  const rejection = direction === 1
    ? lastM5.close > touched.price && lastM5.close > lastM5.open
    : lastM5.close < touched.price && lastM5.close < lastM5.open;
  if (!rejection) return null;

  const stopDistance = Math.max(slAtrMult * atr5Now, atr5Now);
  const entry = lastM5.close;
  const stopLoss = direction === 1 ? entry - stopDistance : entry + stopDistance;
  const tp1 = direction === 1 ? entry + stopDistance * tpRR : entry - stopDistance * tpRR;
  const tp2 = direction === 1 ? entry + stopDistance * tpRR * 1.25 : entry - stopDistance * tpRR * 1.25;
  const tp3 = direction === 1 ? entry + stopDistance * tpRR * 1.5 : entry - stopDistance * tpRR * 1.5;

  const breakdown = {
    h4Trend: 20,
    h1Sweep: 25,
    m15Fvg: touched.fib >= 0.786 ? 20 : 16,
    m15Bos: rejection ? 10 : 0,
    killzone: hour >= 7 && hour < 17 ? 10 : 6,
    atr: range >= minLegAtr * atr15Now * 1.4 ? 10 : 7,
    h1Alignment: 5,
    total: 0,
  };
  breakdown.total = breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg +
    breakdown.m15Bos + breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  return {
    bias,
    confidence: breakdown.total >= 90 ? "high" : "medium",
    score: breakdown.total,
    scoreBreakdown: breakdown,
    entry: round(entry),
    stopLoss: round(stopLoss),
    tp1: round(tp1),
    tp2: round(tp2),
    tp3: round(tp3),
    reasoning: {
      h4Trend: `Estructura H4/H1 confirmada ${bias === "long" ? "alcista" : "bajista"}`,
      h1Liquidity: `Pierna M15 de ${range.toFixed(2)} USD (${(range / atr15Now).toFixed(1)}×ATR)`,
      m15Confirmation: `Rechazo M5 confirmado en Fibo ${(touched.fib * 100).toFixed(1)}% (${touched.price.toFixed(2)})`,
      notes: [
        `Pivote confirmado hace ${legAge} velas M15; sin vela en formación`,
        `SL ${slAtrMult}×ATR(M5), objetivo ${tpRR}R`,
        "Experimental: una sola exposición por setup; sin martingala ni grid infinito",
        `Score: ${breakdown.total}/100`,
      ],
    },
    management: {
      breakEvenAtR,
      timeStopBars: maxHoldBars,
      trailAfterR,
      trailStepAtrMult,
    },
  };
}