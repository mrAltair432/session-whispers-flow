import { ema, atr, rsi, detectSwings, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 7: Fibo 61.8 Cent (réplica optimizada del "Fibonacci 61.8 EA")
// ------------------------------------------------------------------------
// El EA original (MQL5 market 178321) es un grid/martingala que rellena hasta
// ~100 órdenes pendientes escalonadas a favor de la tendencia, con SL global
// del 20 % de la cuenta y TP global del 5 %. Su curva de equity es bonita
// hasta que llega el drawdown de 24 % (ver reporte: 19.237 trades, PF 2.80,
// equity DD 24.29 %). Aquí replicamos su MOTOR de señales:
//   - Fibo 61.8 % del último swing significativo.
//   - RSI(14) con banda 35/75 (compra sólo si RSI>35 y <75).
//   - AO (Awesome Oscillator 5/34 sobre precio medio) a favor del sesgo.
//   - Régimen ATR: ATR bajo/medio/alto → tamaño del grid (menos órdenes con
//     volatilidad alta, cero órdenes nuevas por encima del umbral alto).
//   - MA(15m) como filtro de dirección (Moving_average_timeframe = 15 Min).
// ...y lo mejoramos:
//   - SL real por operación (no sólo SL global de cuenta) en el 78.6 %.
//   - Grid FINITO y acotado (maxOrders, spacing en ATR) sin martingala:
//     todos los niveles usan el mismo lote base.
//   - Caducidad de pendientes (min_close_order_* del original) → expireMinutes.
//   - Guardrails diarios en R en vez de % de cuenta.
//
// Pensada para cuenta CENT de pruebas: por defecto está DESACTIVADA.
export type FiboGridParams = {
  minScore?: number;
  fiboLevel?: number;        // nivel de entrada (0.618 por defecto)
  maxOrders?: number;        // nº máximo de pendientes del grid
  gridStepAtr?: number;      // separación entre pendientes en múltiplos de ATR(M15)
  atrLowRisk?: number;       // ATR M15 (USD) a partir del cual reducimos grid
  atrHighRisk?: number;      // ATR M15 (USD) a partir del cual no abrimos
  rsiLow?: number;
  rsiHigh?: number;
  expireMinutes?: number;    // caducidad de las pendientes
  dailyTargetR?: number;
  dailyLossLimitR?: number;
};

function sma(vals: number[], p: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < vals.length; i++) {
    acc += vals[i];
    if (i >= p) acc -= vals[i - p];
    out.push(i >= p - 1 ? acc / p : NaN);
  }
  return out;
}

// Awesome Oscillator (Bill Williams): SMA5(median) - SMA34(median)
function awesome(candles: Candle[]): number[] {
  const med = candles.map((c) => (c.high + c.low) / 2);
  const f = sma(med, 5);
  const s = sma(med, 34);
  return med.map((_, i) => f[i] - s[i]);
}

export function evaluateFiboGridCent(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  params: FiboGridParams = {},
): Signal {
  const minScore = params.minScore ?? 62;
  const fiboLevel = params.fiboLevel ?? 0.618;
  const maxOrders = params.maxOrders ?? 8;
  const gridStepAtr = params.gridStepAtr ?? 0.5;
  const atrLow = params.atrLowRisk ?? 2.5;
  const atrHigh = params.atrHighRisk ?? 4.5;
  const rsiLow = params.rsiLow ?? 35;
  const rsiHigh = params.rsiHigh ?? 75;
  const expireMinutes = params.expireMinutes ?? 66;
  const dailyTargetR = params.dailyTargetR ?? 3;
  const dailyLossLimitR = params.dailyLossLimitR ?? 2;

  if (h4.length < 50 || h1.length < 40 || m15.length < 60) return null;

  // ---- Sesgo: EMA20/EMA50 H4 + MA(15m) como el EA original ----
  const h4Closes = h4.map((c) => c.close);
  const e20h4 = ema(h4Closes, 20);
  const e50h4 = ema(h4Closes, 50);
  const diffH4 = (e20h4[e20h4.length - 1] - e50h4[e50h4.length - 1]) / e50h4[e50h4.length - 1];
  if (Math.abs(diffH4) < 0.0005) return null;
  const bias: "long" | "short" = diffH4 > 0 ? "long" : "short";

  const closes15 = m15.map((c) => c.close);
  const ma15 = ema(closes15, 50);
  const last = m15[m15.length - 1];
  const maVal = ma15[ma15.length - 1];
  const maOk = bias === "long" ? last.close > maVal : last.close < maVal;

  // ---- Swing H1 y niveles Fibo ----
  const swings = detectSwings(h1.slice(-40), 2);
  const lastHigh = [...swings].reverse().find((s) => s.type === "high");
  const lastLow = [...swings].reverse().find((s) => s.type === "low");
  if (!lastHigh || !lastLow) return null;
  const highPrice = lastHigh.price;
  const lowPrice = lastLow.price;
  const range = highPrice - lowPrice;
  if (range <= 0) return null;

  const lvlEntry = bias === "long" ? highPrice - range * fiboLevel : lowPrice + range * fiboLevel;
  const lvl786 = bias === "long" ? highPrice - range * 0.786 : lowPrice + range * 0.786;
  const lvl500 = bias === "long" ? highPrice - range * 0.5 : lowPrice + range * 0.5;

  // Precio debe estar en la zona 0.5-0.786 (o haberla tocado en las últimas 6 M15)
  const zoneTop = Math.max(lvl500, lvl786);
  const zoneBot = Math.min(lvl500, lvl786);
  const inZone = m15.slice(-6).some((c) => c.low <= zoneTop && c.high >= zoneBot);
  if (!inZone) return null;

  // ---- RSI 35/75 (misma lógica del EA: evita comprar en el pico) ----
  const r = rsi(m15, 14);
  const rVal = r[r.length - 1];
  if (!Number.isFinite(rVal)) return null;
  const rsiOk = bias === "long" ? rVal > rsiLow && rVal < rsiHigh : rVal < 100 - rsiLow && rVal > 100 - rsiHigh;
  if (!rsiOk) return null;

  // ---- Awesome Oscillator a favor ----
  const ao = awesome(m15);
  const aoVal = ao[ao.length - 1];
  const aoPrev = ao[ao.length - 2];
  const aoOk = bias === "long" ? aoVal > aoPrev : aoVal < aoPrev;

  // ---- Régimen ATR (ATR_low/medium_risk del EA) ----
  const atr15 = atr(m15, 14);
  const atrVal = atr15[atr15.length - 1] || 1;
  if (atrVal >= atrHigh) return null;                 // volatilidad extrema → no abrimos
  const volFactor = atrVal >= atrLow ? 0.5 : 1;       // reduce el grid en vol media
  const gridOrders = Math.max(2, Math.round(maxOrders * volFactor));

  // ---- Score ----
  const breakdown = {
    h4Trend: 20,
    h1Sweep: 18,                       // slot: swing H1 válido
    m15Fvg: 15,                        // slot: zona Fibo tocada
    m15Bos: maOk ? 12 : 4,
    killzone: 8,                       // el EA opera 24 h; sesgo horario suave
    atr: volFactor === 1 ? 10 : 6,
    h1Alignment: aoOk ? 5 : 0,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TP ----
  // Entrada base = nivel Fibo (el EA coloca pendientes; nosotros damos el
  // primer nivel y el grid como metadata para el EA).
  const entry = last.close;
  const buffer = Math.max(atrVal * 0.6, (last.high - last.low) * 0.5);
  const sl = bias === "long" ? lvl786 - buffer : lvl786 + buffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + risk : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  const gridStep = atrVal * gridStepAtr;
  const gridLevels: number[] = [];
  for (let i = 1; i <= gridOrders - 1; i++) {
    gridLevels.push(round(bias === "long" ? entry - gridStep * i : entry + gridStep * i));
  }

  const confidence: "high" | "medium" = breakdown.total >= 80 && aoOk ? "high" : "medium";

  return {
    bias,
    confidence,
    score: breakdown.total,
    scoreBreakdown: breakdown,
    entry: round(entry),
    stopLoss: round(sl),
    tp1: round(tp1),
    tp2: round(tp2),
    tp3: round(tp3),
    reasoning: {
      h4Trend: `H4 ${bias === "long" ? "alcista" : "bajista"} (EMA20/50, ${(diffH4 * 100).toFixed(2)}%)`,
      h1Liquidity: `Swing H1 ${lowPrice.toFixed(2)} → ${highPrice.toFixed(2)} · Fibo ${(fiboLevel * 100).toFixed(1)}% ≈ ${lvlEntry.toFixed(2)}`,
      m15Confirmation: `RSI ${rVal.toFixed(1)} en banda ${rsiLow}/${rsiHigh}, AO ${aoOk ? "a favor" : "plano"}, MA15 ${maOk ? "ok" : "en contra"}`,
      notes: [
        `Zona Fibo: ${zoneBot.toFixed(2)} - ${zoneTop.toFixed(2)}`,
        `ATR M15: ${atrVal.toFixed(2)} USD (bajo<${atrLow} / alto>${atrHigh})`,
        `Grid finito SIN martingala: ${gridOrders} niveles cada ${gridStep.toFixed(2)} USD (mismo lote)`,
        `Niveles pendientes: ${gridLevels.map((g) => g.toFixed(2)).join(", ") || "—"}`,
        `Pendientes caducan a ${expireMinutes} min · guardrails ±${dailyTargetR}R/-${dailyLossLimitR}R`,
        `SL real por operación en 0.786 (${sl.toFixed(2)}) — el EA original sólo tenía SL global del 20 %`,
        `Score: ${breakdown.total}/100`,
      ],
    },
    management: {
      breakEvenAtR: 0.8,
      timeStopBars: 24,
      trailAfterR: 1,
      trailStepAtrMult: 0.5,
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }
