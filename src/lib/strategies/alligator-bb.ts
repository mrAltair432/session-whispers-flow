import { atr, ema, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// ============================================================================
// Estrategia E2 v3: Alligator + Bollinger Breakout con RETEST (M15)
// ----------------------------------------------------------------------------
// Mejoras aplicadas sobre v2 (A+B+C+D+E) tras diagnóstico WR 41% / PF 0.97:
//
//   [A] RETEST ENTRY: el breakout debe ocurrir 1-3 velas ATRÁS y la vela
//       actual es un pullback que respeta la banda (no compramos el pico).
//   [B] BOCA ABIERTA FUERTE: gatorSpread >= 0.9×ATR (antes bastaba el orden).
//   [C] MECHA CONTRA-TENDENCIA LIMITADA: mecha opuesta ≤ 40% del rango en
//       la vela de breakout (rechaza velas de clímax con reversión).
//   [D] SL ESTRUCTURAL: mín/máx de las últimas 10 velas M15 + buffer 0.3×ATR,
//       con techo 1.8×ATR para no arriesgar demasiado en breakouts anchos.
//   [E] H1 EMA200 CON PENDIENTE: no basta con precio arriba/abajo, la EMA
//       debe estar subiendo (long) o bajando (short) las últimas 10 velas H1.
//
// Timeframes: trigger M15 · contexto H1. TPs 1R/2R/3R. BE @ 1R + timestop 12.
// ============================================================================

export function evaluateAlligatorBB(
  m15: Candle[],
  h1: Candle[],
  minScore = 65,
): Signal {
  if (m15.length < 60 || h1.length < 220) return null;

  const last = m15[m15.length - 1];
  const prev = m15[m15.length - 2];

  // --- Killzone informativa: Londres + NY (07-16 UTC) --------------------
  const dt = new Date(last.time * 1000);
  const hUTC = dt.getUTCHours();
  const inKz = hUTC >= 7 && hUTC <= 16;

  // --- Alligator (SMMA sobre precio mediano) -----------------------------
  const median = m15.map((c) => (c.high + c.low) / 2);
  const jawArr   = smma(median, 13);
  const teethArr = smma(median, 8);
  const lipsArr  = smma(median, 5);
  const i = m15.length - 1;
  // shifts: jaw 8, teeth 5, lips 3 → leemos valores retrasados
  const jaw0   = jawArr[i - 8];   const jaw1   = jawArr[i - 9];
  const teeth0 = teethArr[i - 5]; const teeth1 = teethArr[i - 6];
  const lips0  = lipsArr[i - 3];  const lips1  = lipsArr[i - 4];
  if (![jaw0, jaw1, teeth0, teeth1, lips0, lips1].every(Number.isFinite)) return null;

  const bull = lips0 > teeth0 && teeth0 > jaw0 && lips1 > teeth1 && teeth1 > jaw1;
  const bear = lips0 < teeth0 && teeth0 < jaw0 && lips1 < teeth1 && teeth1 < jaw1;
  if (!bull && !bear) return null;
  const bias: "long" | "short" = bull ? "long" : "short";

  // --- Bollinger(20, 2) para varias barras (buscar retest) --------------
  const closes = m15.map((c) => c.close);
  const bb0 = bollinger(closes, i, 20, 2);
  if (!bb0) return null;

  // [A] RETEST: buscar breakout en las últimas 3 velas (i-1, i-2, i-3),
  // y validar que la vela ACTUAL es un pullback que aún respeta la banda.
  let breakoutIdx = -1;
  let breakoutBody = 0;
  let breakoutRange = 0;
  for (let k = 1; k <= 3; k++) {
    const bIdx = i - k;
    if (bIdx < 21) break;
    const bb_b = bollinger(closes, bIdx, 20, 2);
    const bb_bPrev = bollinger(closes, bIdx - 1, 20, 2);
    if (!bb_b || !bb_bPrev) continue;
    const bBar = m15[bIdx];
    const rng = Math.max(0.01, bBar.high - bBar.low);
    const bod = Math.abs(bBar.close - bBar.open);
    const bodyPct = bod / rng;
    if (bodyPct < 0.55) continue;
    // [C] Mecha contra-tendencia limitada (≤ 40% del rango)
    const upperWick = bBar.high - Math.max(bBar.open, bBar.close);
    const lowerWick = Math.min(bBar.open, bBar.close) - bBar.low;
    const oppWick = bias === "long" ? upperWick : lowerWick;
    if (oppWick / rng > 0.40) continue;
    const brokeUp   = bias === "long"  && m15[bIdx - 1].close <= bb_bPrev.upper && bBar.close > bb_b.upper && bBar.close > bBar.open;
    const brokeDown = bias === "short" && m15[bIdx - 1].close >= bb_bPrev.lower && bBar.close < bb_b.lower && bBar.close < bBar.open;
    if (brokeUp || brokeDown) {
      breakoutIdx = bIdx;
      breakoutBody = bodyPct;
      breakoutRange = rng;
      break;
    }
  }
  if (breakoutIdx < 0) return null;

  // Vela actual = retest válido: cerca de la banda rota pero sin perderla.
  // Long: precio bajó hacia bb0.upper pero close aún > bb0.mid (no colapsó).
  // Short: precio subió hacia bb0.lower pero close aún < bb0.mid.
  const pulledBack = bias === "long"
    ? (last.low <= bb0.upper * 1.001 && last.close > bb0.mid && last.close > prev.low)
    : (last.high >= bb0.lower * 0.999 && last.close < bb0.mid && last.close < prev.high);
  if (!pulledBack) return null;

  // [E] Macro H1 EMA200 con pendiente ------------------------------------
  const h1EmaArr = ema(h1.map((c) => c.close), 200);
  const lastH1Ema = h1EmaArr[h1EmaArr.length - 1];
  const pastH1Ema = h1EmaArr[h1EmaArr.length - 11];
  const lastH1Close = h1[h1.length - 1].close;
  if (!Number.isFinite(lastH1Ema) || lastH1Ema <= 0 || !Number.isFinite(pastH1Ema)) return null;
  if (bias === "long"  && lastH1Close <= lastH1Ema) return null;
  if (bias === "short" && lastH1Close >= lastH1Ema) return null;
  const emaSlope = (lastH1Ema - pastH1Ema) / pastH1Ema;
  if (bias === "long"  && emaSlope < 0.0002) return null;   // ~0.02% en 10h
  if (bias === "short" && emaSlope > -0.0002) return null;

  // --- ATR M15 sano ------------------------------------------------------
  const atrArr = atr(m15, 14);
  const lastAtr = atrArr[atrArr.length - 1] || 0;
  if (!(lastAtr > 0)) return null;
  const recent = atrArr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median80 = recent.length ? recent[Math.floor(recent.length / 2)] : lastAtr;
  const atrRatio = median80 > 0 ? lastAtr / median80 : 1;
  if (atrRatio < 0.6 || atrRatio > 2.0) return null;

  // [B] Boca del Alligator abierta con fuerza (spread ≥ 0.9×ATR) ---------
  const gatorSpread = Math.abs(lips0 - jaw0) / lastAtr;
  if (gatorSpread < 0.9) return null;

  // --- Ancho de banda mínimo (evita squeeze) -----------------------------
  const bbWidthPct = (bb0.upper - bb0.lower) / bb0.mid;
  if (bbWidthPct < 0.004) return null;

  // --- [D] Entry / SL ESTRUCTURAL / TPs ---------------------------------
  const entry = last.close;
  const lookback = m15.slice(-10);
  const swingLow  = Math.min(...lookback.map((c) => c.low));
  const swingHigh = Math.max(...lookback.map((c) => c.high));
  const buffer = 0.3 * lastAtr;
  const structSL = bias === "long" ? swingLow - buffer : swingHigh + buffer;
  const atrCap   = bias === "long" ? entry - 1.8 * lastAtr : entry + 1.8 * lastAtr;
  // Elegimos el SL más "cercano" al entry (limita riesgo) entre estructural
  // y cap 1.8×ATR. Si el estructural queda demasiado cerca (< 0.6×ATR de
  // entry) lo relajamos a 0.6×ATR para no ser barridos por ruido.
  let sl = bias === "long"
    ? Math.max(structSL, atrCap)
    : Math.min(structSL, atrCap);
  const minRisk = 0.6 * lastAtr;
  if (Math.abs(entry - sl) < minRisk) {
    sl = bias === "long" ? entry - minRisk : entry + minRisk;
  }
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + risk     : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  // --- Score ------------------------------------------------------------
  const breakoutStrength = bias === "long"
    ? (last.close - bb0.upper) / range
    : (bb0.lower - last.close) / range;
  const range = breakoutRange; // usado sólo para el score info

  const breakdown = {
    h4Trend: emaSlope > 0.001 || emaSlope < -0.001 ? 20 : 15,           // pendiente H1
    h1Sweep: breakoutBody >= 0.75 ? 22 : breakoutBody >= 0.65 ? 18 : 14,
    m15Fvg:  gatorSpread >= 1.4 ? 15 : gatorSpread >= 1.1 ? 12 : 9,
    m15Bos:  breakoutStrength > 0.25 ? 14 : breakoutStrength > 0.1 ? 10 : 7,
    killzone: inKz ? 12 : 4,
    atr:     (atrRatio >= 0.8 && atrRatio <= 1.5) ? 10 : 7,
    h1Alignment: bbWidthPct >= 0.008 ? 5 : 3,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

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
    management: {
      breakEvenAtR: 1.0,
      timeStopBars: 12,
    },
    reasoning: {
      h4Trend: `H1 EMA200 con pendiente ${(emaSlope * 100).toFixed(2)}% · ${bias}`,
      h1Liquidity: `Alligator spread ${gatorSpread.toFixed(2)}×ATR · lips ${lips0.toFixed(2)} teeth ${teeth0.toFixed(2)} jaw ${jaw0.toFixed(2)}`,
      m15Confirmation: `Retest de banda ${bias === "long" ? "sup " + bb0.upper.toFixed(2) : "inf " + bb0.lower.toFixed(2)} tras breakout hace ${i - breakoutIdx} vela(s) · cuerpo ${(breakoutBody * 100).toFixed(0)}%`,
      notes: [
        `Killzone Lon/NY: ${inKz ? "sí" : "fuera"} (UTC ${hUTC})`,
        `BB width ${(bbWidthPct * 100).toFixed(2)}% · ATR ratio ${(atrRatio * 100).toFixed(0)}%`,
        `SL estructural (swing ± 0.3×ATR, cap 1.8×ATR) = ${risk.toFixed(2)} · TPs 1R/2R/3R`,
        `Mgmt: BE@1R + time-stop 12 velas M15`,
        `Score ${breakdown.total}/100`,
      ],
    },
  };
}

// --- Helpers ---------------------------------------------------------------

// SMMA (Smoothed MA) = Wilder's MA. Seed = SMA de los primeros `n` valores.
function smma(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  out[n - 1] = sum / n;
  for (let i = n; i < values.length; i++) {
    out[i] = (out[i - 1] * (n - 1) + values[i]) / n;
  }
  return out;
}

// Bollinger en el índice `idx` con `n` y `k` desviaciones.
function bollinger(closes: number[], idx: number, n: number, k: number):
  { upper: number; mid: number; lower: number } | null {
  if (idx < n - 1) return null;
  let sum = 0;
  for (let j = idx - n + 1; j <= idx; j++) sum += closes[j];
  const mid = sum / n;
  let varSum = 0;
  for (let j = idx - n + 1; j <= idx; j++) varSum += (closes[j] - mid) ** 2;
  const sd = Math.sqrt(varSum / n);
  return { upper: mid + k * sd, mid, lower: mid - k * sd };
}

function round(n: number) { return Math.round(n * 100) / 100; }