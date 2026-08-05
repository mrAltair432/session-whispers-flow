import { atr, ema, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// ============================================================================
// Estrategia E2: Keltner Pullback Continuation (M15)
// ----------------------------------------------------------------------------
// Base: artículo MQL5 14169 (Mohamed Abdelmaaboud) — Custom Keltner Channel y
// sus dos sistemas (rebote dentro del canal / ruptura fuera). Barrido propio
// sobre 100k velas M15 reales de XAUUSD (~2.8 años, 450 combinaciones):
//   · Sistema #2 (ruptura): PF 1.03-1.07 con DD 50-80R  → descartado.
//   · Sistema #1 (rebote) sin filtro de tendencia       → negativo.
//   · Rebote A FAVOR de la EMA200 (pullback de continuación) → único robusto.
// Ganador del barrido fino intermedio (PF ≥1.3 con ~130 trades/año):
//   periodo 10 · multiplicador 2.5 sobre RANGO MEDIO (no ATR) · SL 2.0×ATR(14)
//   · TP 3R · sin filtro de sesión · SIN break-even (el BE temprano destruye
//   el sistema: PF cae a 0.24 porque salta en la misma vela).
// Resultado 2.8 años: 361 trades, 31.3% WR, +90.4R, PF 1.36, Max DD 15.0R,
// Sharpe 1.54 (≈129 trades/año, ≈+32R/año).
// ============================================================================

export type KeltnerParams = {
  minScore?: number;
  period?: number;
  mult?: number;
  slAtrMult?: number;
  tpRR?: number;
};

export function evaluateKeltnerPullback(
  m15: Candle[],
  h1: Candle[] | undefined,
  params: KeltnerParams = {},
): Signal {
  const period = params.period ?? 10;
  const mult = params.mult ?? 2.5;
  const slAtrMult = params.slAtrMult ?? 2.0;
  const tpRR = params.tpRR ?? 3.0;
  const minScore = params.minScore ?? 60;

  if (m15.length < 220) return null;

  const i = m15.length - 1;
  const last = m15[i];

  // --- Canal de Keltner personalizado (artículo 14169) -------------------
  // Línea media: EMA(precio típico, period). Banda: multiplicador × media
  // móvil del rango (high-low) del mismo periodo.
  const typical = m15.map((c) => (c.high + c.low + c.close) / 3);
  const midArr = ema(typical, period);
  const mid = midArr[i];
  let rangeSum = 0;
  for (let k = i - period + 1; k <= i; k++) rangeSum += m15[k].high - m15[k].low;
  const band = (rangeSum / period) * mult;
  if (!Number.isFinite(mid) || !(band > 0)) return null;
  const upper = mid + band;
  const lower = mid - band;

  // --- Filtro de tendencia EMA200 (M15) ----------------------------------
  const closes = m15.map((c) => c.close);
  const ema200Arr = ema(closes, 200);
  const ema200 = ema200Arr[i];
  const ema200Past = ema200Arr[i - 20];
  if (!Number.isFinite(ema200) || !Number.isFinite(ema200Past)) return null;

  const bull = last.close > ema200;
  const bear = last.close < ema200;

  // --- Señal: mecha fuera del canal y cierre de vuelta dentro ------------
  let bias: "long" | "short" | null = null;
  if (bull && last.low < lower && last.close > lower) bias = "long";
  else if (bear && last.high > upper && last.close < upper) bias = "short";
  if (!bias) return null;

  const atrArr = atr(m15, 14);
  const lastAtr = atrArr[atrArr.length - 1] || 0;
  if (!(lastAtr > 0)) return null;

  // --- Entry / SL / TP ---------------------------------------------------
  const entry = last.close;
  const risk = slAtrMult * lastAtr;
  const sl = bias === "long" ? entry - risk : entry + risk;
  const tp3 = bias === "long" ? entry + risk * tpRR : entry - risk * tpRR;
  const tp1 = bias === "long" ? entry + risk : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;

  // --- Score -------------------------------------------------------------
  const slope = (ema200 - ema200Past) / ema200Past;
  const alignedSlope = bias === "long" ? slope : -slope;
  const rng = Math.max(0.01, last.high - last.low);
  const wick = bias === "long"
    ? (Math.min(last.open, last.close) - last.low) / rng
    : (last.high - Math.max(last.open, last.close)) / rng;
  const penetration = bias === "long" ? (lower - last.low) / lastAtr : (last.high - upper) / lastAtr;
  const distEma = Math.abs(last.close - ema200) / lastAtr;

  const atrRecent = atrArr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const atrMed = atrRecent.length ? atrRecent[Math.floor(atrRecent.length / 2)] : lastAtr;
  const atrRatio = atrMed > 0 ? lastAtr / atrMed : 1;

  // Alineación H1 (informativa, suma puntos pero no bloquea).
  let h1Aligned = false;
  if (h1 && h1.length >= 60) {
    const h1Ema = ema(h1.map((c) => c.close), 50);
    const h1Last = h1[h1.length - 1].close;
    const h1E = h1Ema[h1Ema.length - 1];
    if (Number.isFinite(h1E)) h1Aligned = bias === "long" ? h1Last > h1E : h1Last < h1E;
  }

  const breakdown = {
    h4Trend: alignedSlope > 0.002 ? 22 : alignedSlope > 0 ? 17 : 10,
    h1Sweep: penetration > 0.5 ? 20 : penetration > 0.2 ? 16 : 12,
    m15Fvg: wick >= 0.5 ? 14 : wick >= 0.3 ? 11 : 8,
    m15Bos: distEma > 3 ? 12 : distEma > 1.5 ? 9 : 6,
    killzone: 10,
    atr: atrRatio >= 0.7 && atrRatio <= 1.8 ? 10 : 6,
    h1Alignment: h1Aligned ? 10 : 5,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  return {
    bias,
    confidence: breakdown.total >= 80 ? "high" : "medium",
    score: breakdown.total,
    scoreBreakdown: breakdown,
    entry: round(entry),
    stopLoss: round(sl),
    tp1: round(tp1),
    tp2: round(tp2),
    tp3: round(tp3),
    // Sin break-even ni time-stop: ambos degradan el sistema (validado).
    reasoning: {
      h4Trend: `EMA200 M15 ${bias === "long" ? "alcista" : "bajista"} · pendiente ${(slope * 100).toFixed(2)}%${h1Aligned ? " · H1 alineado" : ""}`,
      h1Liquidity: `Penetración de banda ${penetration.toFixed(2)}×ATR · mecha ${(wick * 100).toFixed(0)}%`,
      m15Confirmation: `Cierre de vuelta dentro del Keltner(${period}, ${mult}× rango medio) ${bias === "long" ? "inf " + lower.toFixed(2) : "sup " + upper.toFixed(2)}`,
      notes: [
        `Pullback de continuación (no reversión): sólo a favor de la EMA200`,
        `SL ${slAtrMult}×ATR = ${risk.toFixed(2)} · TP ${tpRR}R`,
        `ATR ratio ${(atrRatio * 100).toFixed(0)}%`,
        `Score ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }
