import {
  ema, atr, detectTrend, detectBOS,
  type Candle,
} from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 2: Continuación NY
// - Contexto H4: tendencia clara (bullish/bearish vía EMA20/EMA50)
// - Setup H1: precio hace pullback a EMA50 ± 0.6 ATR en las últimas 6 velas
// - Entrada M15: BOS a favor de la tendencia + cierre M15 alineado
// - Killzone preferente: UTC 12-16 (solape Londres-NY y apertura NY)
// - SL: bajo/sobre swing M15 reciente + buffer ATR
// - TPs: 1R / 2R / 3R (más conservador, es continuación)
export function evaluateNyContinuation(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  minScore = 65,
): Signal {
  if (h4.length < 50 || h1.length < 60 || m15.length < 25) return null;

  const trend = detectTrend(h4);
  if (trend === "ranging") return null;
  const bias: "long" | "short" = trend === "bullish" ? "long" : "short";

  // H1: pullback a EMA50
  const h1Closes = h1.map((c) => c.close);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Atr = atr(h1, 14);
  const lastAtrH1 = h1Atr[h1Atr.length - 1] || 1;
  let pulledBack = false;
  for (let i = h1.length - 6; i < h1.length; i++) {
    if (i < 0) continue;
    const c = h1[i];
    const e = h1Ema50[i];
    const tol = lastAtrH1 * 0.6;
    if (bias === "long" && c.low <= e + tol && c.low >= e - tol) { pulledBack = true; break; }
    if (bias === "short" && c.high >= e - tol && c.high <= e + tol) { pulledBack = true; break; }
  }
  if (!pulledBack) return null;

  // M15: BOS + confirmación
  const lastM15 = m15[m15.length - 1];
  const closes15 = m15.map((c) => c.close);
  const e20_15 = ema(closes15, 20);
  const lastEma15 = e20_15[e20_15.length - 1];
  const bosOk = detectBOS(m15, bias, 15);
  const m15Confirm =
    bias === "long"
      ? lastM15.close > lastM15.open && lastM15.close > lastEma15
      : lastM15.close < lastM15.open && lastM15.close < lastEma15;
  if (!m15Confirm || !bosOk) return null;

  // Killzone
  const hUTC = new Date(lastM15.time * 1000).getUTCHours();
  const inKz = hUTC >= 12 && hUTC < 16;

  // ATR M15
  const m15Atr = atr(m15, 14);
  const lastAtr = m15Atr[m15Atr.length - 1] || 1;
  const recent = m15Atr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median = recent.length ? recent[Math.floor(recent.length / 2)] : lastAtr;
  const atrRatio = median > 0 ? lastAtr / median : 1;

  // H1 EMA alignment
  const h1Ema20 = ema(h1Closes, 20);
  const h1Aligned =
    bias === "long"
      ? h1Ema20[h1Ema20.length - 1] > h1Ema50[h1Ema50.length - 1]
      : h1Ema20[h1Ema20.length - 1] < h1Ema50[h1Ema50.length - 1];

  // Scoring
  const breakdown = {
    h4Trend: 20,
    h1Sweep: pulledBack ? 25 : 0, // reusamos el slot "h1Sweep" para el pullback
    m15Fvg: 15,                    // E2 no exige FVG estricto
    m15Bos: bosOk ? 15 : 0,
    killzone: inKz ? 12 : 4,
    atr: atrRatio >= 1 ? 8 : atrRatio >= 0.7 ? 5 : 2,
    h1Alignment: h1Aligned ? 5 : 0,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;

  if (breakdown.total < minScore) return null;

  // Entry / SL / TPs
  const entry = lastM15.close;
  const swingWin = m15.slice(-12);
  const slAnchor = bias === "long"
    ? Math.min(...swingWin.map((c) => c.low))
    : Math.max(...swingWin.map((c) => c.high));
  const buffer = Math.max(lastAtr * 0.3, (lastM15.high - lastM15.low) * 0.4);
  const sl = bias === "long" ? slAnchor - buffer : slAnchor + buffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + risk : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

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
      h4Trend: `H4 ${trend === "bullish" ? "alcista" : "bajista"} (EMA20 vs EMA50)`,
      h1Liquidity: `Pullback a EMA50 en H1 detectado (tol ${(lastAtrH1 * 0.6).toFixed(2)})`,
      m15Confirmation: `M15 ${bias === "long" ? "alcista sobre" : "bajista bajo"} EMA20 + BOS`,
      notes: [
        `Killzone NY: ${inKz ? "sí" : "fuera (UTC " + hUTC + ")"}`,
        `ATR vs mediana: ${(atrRatio * 100).toFixed(0)}%`,
        `H1 EMAs ${h1Aligned ? "alineadas" : "no alineadas"} con bias`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }