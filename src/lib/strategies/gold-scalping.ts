import { ema, atr, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 4: Gold Scalping NY Open (Judas Swing) — M1
// -----------------------------------------------
// Hipótesis: en la apertura de NY (UTC 13-15) el precio barre uno de los
// extremos del rango de Londres (08-12:59 UTC) y revierte hacia el VWAP de
// sesión. Trade corto (5-20 min), SL ajustado, TP en VWAP + extensión.
//
// - M1 : TF trigger (sweep + confirmación + entrada).
// - M5 : sesgo direccional (EMA20 vs EMA50) y ATR de contexto.
// - VWAP: calculado sobre las velas M1 del día UTC en curso.
// - Killzone: UTC 13-15 (14 es apertura pura NY, 13 es solape con Londres).
// - Rango Londres: high/low de M1 entre 08:00 y 12:59 UTC del mismo día.
// - SL: 0.5 × ATR M1 más allá de la mecha del sweep.
// - TP1: VWAP (parcial 50%), TP2: 1.5×VWAP extendido (30%), runner (20%).
export function evaluateGoldScalping(
  m1: Candle[],
  m5: Candle[],
  minScore = 60,
): Signal {
  if (m1.length < 60 || m5.length < 30) return null;

  const last = m1[m1.length - 1];
  const d = new Date(last.time * 1000);
  const hUTC = d.getUTCHours();
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return null;
  // Killzone estricta: 13:00-14:59 UTC (rechazar fuera de ventana).
  if (hUTC < 13 || hUTC >= 15) return null;

  // ---- Rango de Londres (08:00-12:59 UTC del mismo día) ----
  const dayStart = Math.floor(last.time / 86400) * 86400;
  const lonStart = dayStart + 8 * 3600;
  const lonEnd = dayStart + 13 * 3600;
  let lonHigh = -Infinity, lonLow = Infinity, lonBars = 0;
  for (const c of m1) {
    if (c.time >= lonStart && c.time < lonEnd) {
      if (c.high > lonHigh) lonHigh = c.high;
      if (c.low < lonLow) lonLow = c.low;
      lonBars++;
    }
  }
  if (lonBars < 60 || !isFinite(lonHigh) || !isFinite(lonLow)) return null;
  const lonRange = lonHigh - lonLow;
  if (lonRange < 1.5) return null; // rango < 1.5 USD → mercado dormido

  // ---- VWAP de sesión (desde 13:00 UTC del día actual) ----
  const sessStart = dayStart + 13 * 3600;
  let pv = 0, vv = 0;
  const sessM1: Candle[] = [];
  for (const c of m1) {
    if (c.time >= sessStart && c.time <= last.time) {
      const typical = (c.high + c.low + c.close) / 3;
      // sin volumen real: proxy = rango (h-l+0.01) para peso proporcional
      const w = Math.max(0.01, c.high - c.low);
      pv += typical * w;
      vv += w;
      sessM1.push(c);
    }
  }
  if (sessM1.length < 3 || vv <= 0) return null;
  const vwap = pv / vv;

  // Desviación estándar del typical price vs VWAP (para bandas ±σ).
  let sqSum = 0;
  for (const c of sessM1) {
    const t = (c.high + c.low + c.close) / 3;
    sqSum += (t - vwap) ** 2;
  }
  const sigma = Math.sqrt(sqSum / sessM1.length);
  const vwapLower = vwap - sigma;
  const vwapUpper = vwap + sigma;

  // ---- Detección de sweep ----
  // El sweep debe haber ocurrido en las últimas 15 velas M1: high > lonHigh
  // (sweep alto → short) o low < lonLow (sweep bajo → long), y el precio
  // debe haber cerrado del otro lado del extremo barrido.
  const window = m1.slice(-15);
  let bias: "long" | "short" | null = null;
  let sweepPrice = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    const c = window[i];
    if (c.high > lonHigh && last.close < lonHigh) {
      bias = "short";
      sweepPrice = c.high;
      break;
    }
    if (c.low < lonLow && last.close > lonLow) {
      bias = "long";
      sweepPrice = c.low;
      break;
    }
  }
  if (!bias) return null;

  // Confirmación de reversión en la última vela M1
  const revConfirm =
    bias === "long"
      ? last.close > last.open && last.close > lonLow
      : last.close < last.open && last.close < lonHigh;
  if (!revConfirm) return null;

  // Precio debe estar en el lado "estirado" del VWAP
  const stretched = bias === "long" ? last.close < vwapLower : last.close > vwapUpper;

  // ---- Sesgo M5 (EMA20 vs EMA50) ----
  const m5Close = m5.map((c) => c.close);
  const e20 = ema(m5Close, 20);
  const e50 = ema(m5Close, 50);
  const m5Diff = (e20[e20.length - 1] - e50[e50.length - 1]) / e50[e50.length - 1];
  const m5BiasUp = m5Diff > 0.0002;
  const m5BiasDn = m5Diff < -0.0002;
  // El sweep puede ir contra tendencia M5 (Judas legítimo) — no rechazamos,
  // pero premiamos si M5 está alineado con la reversión.
  const m5Aligned = (bias === "long" && m5BiasUp) || (bias === "short" && m5BiasDn);

  // ---- ATR M5 (contexto de volatilidad) ----
  const m5Atr = atr(m5, 14);
  const lastM5Atr = m5Atr[m5Atr.length - 1] || 1;
  if (lastM5Atr < 0.5) return null; // < 0.5 USD ATR M5 → mercado muerto

  // ATR M1 para dimensionar SL
  const m1Atr = atr(m1, 14);
  const lastM1Atr = m1Atr[m1Atr.length - 1] || 0.3;

  // ---- Scoring graduado (0-100) — distribución amplia para que minScore discrimine ----
  // 1) Fuerza del sweep: cuán profundo pasó el extremo de Londres (en ATR M1). 0-15.
  const sweepDepth =
    bias === "long" ? (lonLow - sweepPrice) : (sweepPrice - lonHigh);
  const sweepAtrRatio = Math.max(0, sweepDepth) / Math.max(0.1, lastM1Atr);
  const sweepStrength = Math.min(15, Math.round(sweepAtrRatio * 10));

  // 2) Calidad del rango Londres: 1.5→3 USD = pobre, 3→6 = bueno, >6 = fuerte. 0-20.
  const rangeQuality = Math.max(0, Math.min(20, Math.round(((lonRange - 1.5) / 4.5) * 20)));

  // 3) Fuerza de la vela de reversión: body / range de la última M1. 0-15.
  const lastBody = Math.abs(last.close - last.open);
  const lastRange = Math.max(0.01, last.high - last.low);
  const revStrength = Math.min(15, Math.round((lastBody / lastRange) * 15));

  // 4) Cuán "estirado" está el precio del VWAP en σ. 0.5σ=5, 1σ=10, ≥1.5σ=15. 0-15.
  const sigmaSafe = Math.max(0.05, sigma);
  const stretchSigmas = Math.abs(last.close - vwap) / sigmaSafe;
  const stretchScore = Math.min(15, Math.round(stretchSigmas * 10));

  // 5) Killzone: 14 UTC (NY open puro) = 12, 13 UTC (solape Londres) = 7.
  const killzoneScore = hUTC === 14 ? 12 : 7;

  // 6) ATR M5: 0.5→0.8=5, 0.8→1.2=8, ≥1.2=10. 0-10.
  const atrScore = lastM5Atr >= 1.2 ? 10 : lastM5Atr >= 0.8 ? 8 : lastM5Atr >= 0.5 ? 5 : 2;

  // 7) Alineación M5: alineado=8, neutral=4, contra=1. 0-8.
  const alignScore = m5Aligned ? 8 : (Math.abs(m5Diff) < 0.0002 ? 4 : 1);

  const breakdown = {
    h4Trend: sweepStrength,   // 0-15  (slot: fuerza sweep)
    h1Sweep: rangeQuality,    // 0-20  (slot: calidad rango Londres)
    m15Fvg: revStrength,      // 0-15  (slot: fuerza reversión)
    m15Bos: stretchScore,     // 0-15  (slot: distancia VWAP en σ)
    killzone: killzoneScore,  // 7 o 12
    atr: atrScore,            // 2-10
    h1Alignment: alignScore,  // 1, 4 u 8
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TPs ----
  const entry = last.close;
  const slBuffer = Math.max(lastM1Atr * 0.5, 0.4); // mínimo 0.4 USD
  const sl = bias === "long" ? sweepPrice - slBuffer : sweepPrice + slBuffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0 || risk > lonRange * 0.5) return null; // SL absurdo

  // TPs: TP1=VWAP, TP2=1.5×distancia entry→VWAP (extensión), TP3=extremo opuesto Londres
  const distToVwap = Math.abs(vwap - entry);
  if (distToVwap < risk * 0.6) return null; // relación R:R muy pobre para valer la pena
  const tp1 = vwap;
  const tp2 = bias === "long" ? entry + distToVwap * 1.5 : entry - distToVwap * 1.5;
  const tp3 = bias === "long" ? lonHigh : lonLow;

  const confidence: "high" | "medium" = breakdown.total >= 80 ? "high" : "medium";

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
      h4Trend: `Sweep ${bias === "long" ? "de mínimo" : "de máximo"} de Londres @ ${sweepPrice.toFixed(2)}`,
      h1Liquidity: `Rango Londres ${lonLow.toFixed(2)}-${lonHigh.toFixed(2)} (${lonRange.toFixed(2)} USD)`,
      m15Confirmation: `Reversión M1 hacia VWAP ${vwap.toFixed(2)} (σ=${sigma.toFixed(2)})`,
      notes: [
        `Killzone NY UTC ${hUTC}:00`,
        `Distancia entry→VWAP: ${distToVwap.toFixed(2)} USD (SL ${risk.toFixed(2)} USD)`,
        `ATR M5: ${lastM5Atr.toFixed(2)} USD · ATR M1: ${lastM1Atr.toFixed(2)} USD`,
        `Sesgo M5: ${m5Aligned ? "alineado" : "contra o neutro"}`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }