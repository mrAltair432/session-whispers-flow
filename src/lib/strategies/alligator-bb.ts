import { atr, ema, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// ============================================================================
// Estrategia E2 v4: Alligator + BB + TTM-Squeeze + AO + ADX (M15)
// ----------------------------------------------------------------------------
// Objetivo: WR ≥ 60%. Diagnóstico v3 (WR 47%): entramos en breakouts sin
// régimen (chop), sin momentum confirmado y contra el macro-macro (H4).
//
// Nuevos filtros basados en literatura (Bill Williams "Trading Chaos",
// John Carter TTM-Squeeze, Wilder ADX):
//
//   [F] TTM-SQUEEZE: BB(20,2) tiene que haber estado DENTRO del Keltner
//       Channel(20, 1.5×ATR) en las últimas 6-20 velas y AHORA expandirse
//       fuera. Filtra rangos y solo dispara cuando arranca volatilidad real.
//   [G] AWESOME OSCILLATOR (Bill Williams): SMA(median,5)−SMA(median,34).
//       Long: AO > 0 y subiendo 2 velas. Short: AO < 0 y bajando 2 velas.
//       (compañero natural del Alligator).
//   [H] ADX(14) ≥ 22 en M15: régimen tendencial confirmado. Sin trend, no
//       tradeamos — el Alligator pierde en chop, y ADX lo detecta.
//   [I] DOBLE ALINEACIÓN H1 + H4 (EMA200): precio y pendiente en ambos TFs.
//   [J] SESIÓN OVERLAP ESTRICTA: solo 12-17 UTC (Londres-NY overlap), la
//       ventana de mayor liquidez en XAUUSD.
//   [K] CALIDAD DE BREAKOUT: body ≥ 65%, mecha opuesta ≤ 30% (era 55/40).
//
// Se mantiene la lógica v3 (retest, SL estructural, Alligator spread).
// TPs 1R/2R/3R · BE @ 0.7R · time-stop 10 velas M15.
// ============================================================================

export function evaluateAlligatorBB(
  m15: Candle[],
  h1: Candle[],
  minScore = 70,
  h4?: Candle[],
): Signal {
  if (m15.length < 60 || h1.length < 220) return null;

  const last = m15[m15.length - 1];
  const prev = m15[m15.length - 2];

  // --- [J] Sesión overlap Londres-NY (12-17 UTC) — filtro DURO ----------
  const dt = new Date(last.time * 1000);
  const hUTC = dt.getUTCHours();
  const inOverlap = hUTC >= 12 && hUTC <= 17;
  if (!inOverlap) return null;

  // --- Alligator (SMMA sobre precio mediano) -----------------------------
  const median = m15.map((c) => (c.high + c.low) / 2);
  const jawArr   = smma(median, 13);
  const teethArr = smma(median, 8);
  const lipsArr  = smma(median, 5);
  const i = m15.length - 1;
  const jaw0   = jawArr[i - 8];   const jaw1   = jawArr[i - 9];
  const teeth0 = teethArr[i - 5]; const teeth1 = teethArr[i - 6];
  const lips0  = lipsArr[i - 3];  const lips1  = lipsArr[i - 4];
  if (![jaw0, jaw1, teeth0, teeth1, lips0, lips1].every(Number.isFinite)) return null;

  const bull = lips0 > teeth0 && teeth0 > jaw0 && lips1 > teeth1 && teeth1 > jaw1;
  const bear = lips0 < teeth0 && teeth0 < jaw0 && lips1 < teeth1 && teeth1 < jaw1;
  if (!bull && !bear) return null;
  const bias: "long" | "short" = bull ? "long" : "short";

  // --- Bollinger(20, 2) y ATR M15 ---------------------------------------
  const closes = m15.map((c) => c.close);
  const bb0 = bollinger(closes, i, 20, 2);
  if (!bb0) return null;

  const atrArr = atr(m15, 14);
  const lastAtr = atrArr[atrArr.length - 1] || 0;
  if (!(lastAtr > 0)) return null;

  // --- [F] TTM-SQUEEZE: BB dentro de Keltner en pasado reciente, fuera hoy
  // Keltner(20, 1.5×ATR) sobre mid=SMA(20). Squeeze = upperBB<upperKC && lowerBB>lowerKC
  const kMult = 1.5;
  const kcUp0 = bb0.mid + kMult * lastAtr;
  const kcLo0 = bb0.mid - kMult * lastAtr;
  const releasedNow = bb0.upper > kcUp0 && bb0.lower < kcLo0;
  if (!releasedNow) return null;
  let hadSqueeze = false;
  for (let k = 2; k <= 20; k++) {
    const idx = i - k;
    if (idx < 20) break;
    const bbk = bollinger(closes, idx, 20, 2);
    const atrk = atrArr[idx];
    if (!bbk || !Number.isFinite(atrk) || atrk <= 0) continue;
    const kcU = bbk.mid + kMult * atrk;
    const kcL = bbk.mid - kMult * atrk;
    if (bbk.upper < kcU && bbk.lower > kcL) { hadSqueeze = true; break; }
  }
  if (!hadSqueeze) return null;

  // [A] RETEST: breakout en i-1..i-3, con calidad reforzada ---------------
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
    if (bodyPct < 0.65) continue; // [K] body más estricto
    const upperWick = bBar.high - Math.max(bBar.open, bBar.close);
    const lowerWick = Math.min(bBar.open, bBar.close) - bBar.low;
    const oppWick = bias === "long" ? upperWick : lowerWick;
    if (oppWick / rng > 0.30) continue; // [K] mecha opuesta más estricta
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

  const pulledBack = bias === "long"
    ? (last.low <= bb0.upper * 1.001 && last.close > bb0.mid && last.close > prev.low)
    : (last.high >= bb0.lower * 0.999 && last.close < bb0.mid && last.close < prev.high);
  if (!pulledBack) return null;

  // --- [G] Awesome Oscillator (Bill Williams) ---------------------------
  // AO = SMA(median,5) − SMA(median,34); confirmación de momentum.
  const aoArr = ao(median, 5, 34);
  const ao0 = aoArr[i], ao1 = aoArr[i - 1], ao2 = aoArr[i - 2];
  if (![ao0, ao1, ao2].every(Number.isFinite)) return null;
  if (bias === "long"  && !(ao0 > 0 && ao0 > ao1 && ao1 > ao2)) return null;
  if (bias === "short" && !(ao0 < 0 && ao0 < ao1 && ao1 < ao2)) return null;

  // --- [H] ADX(14) ≥ 22 en M15 ------------------------------------------
  const adxVal = adxLast(m15, 14);
  if (!Number.isFinite(adxVal) || adxVal < 22) return null;

  // [I] Macro H1 EMA200 con pendiente ------------------------------------
  const h1EmaArr = ema(h1.map((c) => c.close), 200);
  const lastH1Ema = h1EmaArr[h1EmaArr.length - 1];
  const pastH1Ema = h1EmaArr[h1EmaArr.length - 11];
  const lastH1Close = h1[h1.length - 1].close;
  if (!Number.isFinite(lastH1Ema) || lastH1Ema <= 0 || !Number.isFinite(pastH1Ema)) return null;
  if (bias === "long"  && lastH1Close <= lastH1Ema) return null;
  if (bias === "short" && lastH1Close >= lastH1Ema) return null;
  const emaSlope = (lastH1Ema - pastH1Ema) / pastH1Ema;
  if (bias === "long"  && emaSlope < 0.0002) return null;
  if (bias === "short" && emaSlope > -0.0002) return null;

  // [I] H4 EMA200 alineado (si viene) ------------------------------------
  if (h4 && h4.length >= 210) {
    const h4Ema = ema(h4.map((c) => c.close), 200);
    const lastH4 = h4[h4.length - 1].close;
    const lastH4Ema = h4Ema[h4Ema.length - 1];
    if (Number.isFinite(lastH4Ema) && lastH4Ema > 0) {
      if (bias === "long"  && lastH4 <= lastH4Ema) return null;
      if (bias === "short" && lastH4 >= lastH4Ema) return null;
    }
  }

  // --- ATR M15 sano ------------------------------------------------------
  const recent = atrArr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median80 = recent.length ? recent[Math.floor(recent.length / 2)] : lastAtr;
  const atrRatio = median80 > 0 ? lastAtr / median80 : 1;
  if (atrRatio < 0.6 || atrRatio > 2.0) return null;

  // [B] Boca del Alligator abierta con fuerza (spread ≥ 0.9×ATR) ---------
  const gatorSpread = Math.abs(lips0 - jaw0) / lastAtr;
  if (gatorSpread < 0.9) return null;

  const bbWidthPct = (bb0.upper - bb0.lower) / bb0.mid;
  if (bbWidthPct < 0.004) return null;

  // --- [D] Entry / SL estructural / TPs ---------------------------------
  const entry = last.close;
  const lookback = m15.slice(-10);
  const swingLow  = Math.min(...lookback.map((c) => c.low));
  const swingHigh = Math.max(...lookback.map((c) => c.high));
  const buffer = 0.3 * lastAtr;
  const structSL = bias === "long" ? swingLow - buffer : swingHigh + buffer;
  const atrCap   = bias === "long" ? entry - 1.8 * lastAtr : entry + 1.8 * lastAtr;
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
  const range = breakoutRange;
  const breakoutStrength = bias === "long"
    ? (last.close - bb0.upper) / range
    : (bb0.lower - last.close) / range;

  const breakdown = {
    h4Trend: adxVal >= 30 ? 22 : adxVal >= 25 ? 18 : 14,                 // fuerza tendencia
    h1Sweep: breakoutBody >= 0.80 ? 20 : breakoutBody >= 0.70 ? 16 : 12,
    m15Fvg:  gatorSpread >= 1.4 ? 14 : gatorSpread >= 1.1 ? 11 : 8,
    m15Bos:  breakoutStrength > 0.25 ? 12 : breakoutStrength > 0.1 ? 9 : 6,
    killzone: 12,                                                        // ya filtramos overlap
    atr:     (atrRatio >= 0.8 && atrRatio <= 1.5) ? 10 : 7,
    h1Alignment: emaSlope > 0.001 || emaSlope < -0.001 ? 10 : 6,
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
      breakEvenAtR: 0.7,
      timeStopBars: 10,
    },
    reasoning: {
      h4Trend: `ADX ${adxVal.toFixed(1)} · H1 EMA200 slope ${(emaSlope * 100).toFixed(2)}%${h4 ? " · H4 alineado" : ""}`,
      h1Liquidity: `AO ${ao0.toFixed(2)} (rising) · Alligator spread ${gatorSpread.toFixed(2)}×ATR`,
      m15Confirmation: `Squeeze release + retest banda ${bias === "long" ? "sup " + bb0.upper.toFixed(2) : "inf " + bb0.lower.toFixed(2)} · breakout ${i - breakoutIdx} vela(s) atrás · cuerpo ${(breakoutBody * 100).toFixed(0)}%`,
      notes: [
        `Overlap Londres-NY 12-17 UTC (h=${hUTC})`,
        `BB width ${(bbWidthPct * 100).toFixed(2)}% · ATR ratio ${(atrRatio * 100).toFixed(0)}%`,
        `SL estructural (swing ± 0.3×ATR, cap 1.8×ATR) = ${risk.toFixed(2)} · TPs 1R/2R/3R`,
        `Mgmt: BE@0.7R + time-stop 10 velas M15`,
        `Score ${breakdown.total}/100`,
      ],
    },
  };
}

// --- Helpers ---------------------------------------------------------------

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

// Awesome Oscillator = SMA(median, fast) − SMA(median, slow), Bill Williams.
function ao(median: number[], fast = 5, slow = 34): number[] {
  const out = new Array<number>(median.length).fill(NaN);
  if (median.length < slow) return out;
  let sf = 0, ss = 0;
  for (let i = 0; i < slow; i++) { ss += median[i]; if (i >= slow - fast) sf += median[i]; }
  out[slow - 1] = sf / fast - ss / slow;
  for (let i = slow; i < median.length; i++) {
    ss += median[i] - median[i - slow];
    sf += median[i] - median[i - fast];
    out[i] = sf / fast - ss / slow;
  }
  return out;
}

// ADX(14) de Wilder — devuelve el último valor.
function adxLast(c: Candle[], n = 14): number {
  if (c.length < n * 2 + 1) return NaN;
  const tr: number[] = [], plusDM: number[] = [], minusDM: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high;
    const dn = c[i - 1].low - c[i].low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    const t = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low  - c[i - 1].close),
    );
    tr.push(t);
  }
  const wilder = (arr: number[]): number[] => {
    const out = new Array<number>(arr.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i];
    out[n - 1] = sum;
    for (let i = n; i < arr.length; i++) out[i] = out[i - 1] - out[i - 1] / n + arr[i];
    return out;
  };
  const trS = wilder(tr), pS = wilder(plusDM), mS = wilder(minusDM);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    if (!Number.isFinite(trS[i]) || trS[i] === 0) { dx.push(NaN); continue; }
    const pDI = 100 * pS[i] / trS[i];
    const mDI = 100 * mS[i] / trS[i];
    const denom = pDI + mDI;
    dx.push(denom === 0 ? 0 : 100 * Math.abs(pDI - mDI) / denom);
  }
  // ADX = Wilder-smoothed DX
  const start = dx.findIndex((v) => Number.isFinite(v));
  if (start < 0 || dx.length - start < n) return NaN;
  let adx = 0;
  for (let i = start; i < start + n; i++) adx += dx[i];
  adx /= n;
  for (let i = start + n; i < dx.length; i++) {
    if (!Number.isFinite(dx[i])) continue;
    adx = (adx * (n - 1) + dx[i]) / n;
  }
  return adx;
}

function round(n: number) { return Math.round(n * 100) / 100; }