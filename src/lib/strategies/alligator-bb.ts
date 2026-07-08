import { atr, ema, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// ============================================================================
// Estrategia E2 (nueva): Alligator + Bollinger Bands Breakout
// ----------------------------------------------------------------------------
// Basada en el EA MQL5 `AlligatorBB_RegimeEA_v2` del usuario, con mejoras para
// aumentar el winrate y adaptar a nuestro simulador (que no maneja órdenes
// pendientes: siempre entramos a mercado en el cierre de la vela trigger).
//
// Reglas:
//   • Timeframe trigger: M15. Contexto: H1 (EMA200 macro).
//   • Alligator SMMA sobre precio mediano (h+l)/2 con periodos/shifts clásicos
//     de Bill Williams: jaw(13, s8), teeth(8, s5), lips(5, s3).
//   • Bollinger(20, 2σ) sobre close en M15.
//   • Régimen tendencial: lips > teeth > jaw (bull) o lips < teeth < jaw (bear)
//     en la vela actual Y en la anterior — evita entradas con "boca abierta"
//     naciente inestable.
//   • Trigger: cierre cruza banda superior (bull) o inferior (bear) desde el
//     lado interno de la vela previa. Cuerpo ≥ 55 % del rango de la vela.
//   • Filtros anti-basura:
//       - H1 EMA200 alineado con el bias (macro trend).
//       - ATR M15 dentro de rango sano (0.6×–2× mediana de 80 barras).
//       - Ancho de banda relativo ≥ 0.4 % del precio (evita squeeze breakouts).
//   • Salidas: SL = 1.5×ATR(M15) desde entry. TP1/TP2/TP3 = 1R/2R/3R.
//   • Management: BE tras TP1 (lo hace el motor) + time-stop 12 velas M15 (~3h).
// ============================================================================

export function evaluateAlligatorBB(
  m15: Candle[],
  h1: Candle[],
  minScore = 65,
): Signal {
  // Necesitamos histórico para EMA200 H1 + Alligator con shift jaw=8 + BB(20).
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

  // --- Bollinger(20, 2) --------------------------------------------------
  const closes = m15.map((c) => c.close);
  const bb0 = bollinger(closes, i,     20, 2);
  const bb1 = bollinger(closes, i - 1, 20, 2);
  if (!bb0 || !bb1) return null;

  // --- Trigger: breakout de banda con cuerpo fuerte ----------------------
  const range = Math.max(0.01, last.high - last.low);
  const body  = Math.abs(last.close - last.open);
  const bodyPct = body / range;
  if (bodyPct < 0.55) return null;

  const breakUp   = bias === "long"  && prev.close <= bb1.upper && last.close > bb0.upper && last.close > last.open;
  const breakDown = bias === "short" && prev.close >= bb1.lower && last.close < bb0.lower && last.close < last.open;
  if (!breakUp && !breakDown) return null;

  // --- Macro filter H1 EMA200 --------------------------------------------
  const h1EmaArr = ema(h1.map((c) => c.close), 200);
  const lastH1Ema = h1EmaArr[h1EmaArr.length - 1];
  const lastH1Close = h1[h1.length - 1].close;
  if (!Number.isFinite(lastH1Ema) || lastH1Ema <= 0) return null;
  if (bias === "long"  && lastH1Close <= lastH1Ema) return null;
  if (bias === "short" && lastH1Close >= lastH1Ema) return null;

  // --- ATR M15 sano ------------------------------------------------------
  const atrArr = atr(m15, 14);
  const lastAtr = atrArr[atrArr.length - 1] || 0;
  if (!(lastAtr > 0)) return null;
  const recent = atrArr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median80 = recent.length ? recent[Math.floor(recent.length / 2)] : lastAtr;
  const atrRatio = median80 > 0 ? lastAtr / median80 : 1;
  if (atrRatio < 0.6 || atrRatio > 2.0) return null;

  // --- Ancho de banda mínimo (evita squeeze) -----------------------------
  const bbWidthPct = (bb0.upper - bb0.lower) / bb0.mid;
  if (bbWidthPct < 0.004) return null;

  // --- Entry / SL / TPs --------------------------------------------------
  const entry = last.close;
  const sl = bias === "long" ? entry - 1.5 * lastAtr : entry + 1.5 * lastAtr;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + risk     : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  // --- Score (mismos slots que el resto de estrategias) ------------------
  const gatorSpread = Math.abs(lips0 - jaw0) / lastAtr; // "boca abierta"
  const breakoutStrength = bias === "long"
    ? (last.close - bb0.upper) / range
    : (bb0.lower - last.close) / range;

  const breakdown = {
    h4Trend: 18,                                                         // H1 EMA200 alineado
    h1Sweep: bodyPct >= 0.75 ? 22 : bodyPct >= 0.65 ? 18 : 14,
    m15Fvg:  gatorSpread >= 1.2 ? 15 : gatorSpread >= 0.8 ? 12 : 8,
    m15Bos:  breakoutStrength > 0.25 ? 14 : breakoutStrength > 0.1 ? 10 : 6,
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
      breakEvenAtR: 1.0,   // BE al alcanzar TP1
      timeStopBars: 12,    // ~3h M15
    },
    reasoning: {
      h4Trend: `H1 EMA200 alineada · bias ${bias} (H1 close ${lastH1Close.toFixed(2)} vs EMA ${lastH1Ema.toFixed(2)})`,
      h1Liquidity: `Alligator abierto (spread ${gatorSpread.toFixed(2)}×ATR) · lips ${lips0.toFixed(2)} teeth ${teeth0.toFixed(2)} jaw ${jaw0.toFixed(2)}`,
      m15Confirmation: `Cierre ${bias === "long" ? "sobre banda sup " + bb0.upper.toFixed(2) : "bajo banda inf " + bb0.lower.toFixed(2)} · cuerpo ${(bodyPct * 100).toFixed(0)}%`,
      notes: [
        `Killzone Lon/NY: ${inKz ? "sí" : "fuera"} (UTC ${hUTC})`,
        `BB width ${(bbWidthPct * 100).toFixed(2)}% · ATR ratio ${(atrRatio * 100).toFixed(0)}%`,
        `SL 1.5×ATR = ${risk.toFixed(2)} · TPs 1R/2R/3R`,
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