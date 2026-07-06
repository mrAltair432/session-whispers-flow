import { atr, ema, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 6: Straddle Breakout ATR (base Thunder v8)
// -------------------------------------------------
// Idea: define un straddle ±D alrededor del close de la vela previa M1.
// D = 0.6 × ATR(M5). Si la vela M1 actual rompe con cuerpo hacia arriba
// → LONG; hacia abajo → SHORT. Restringido a killzones de máxima liquidez:
//   - Londres 07-10 UTC
//   - NY 13-15 UTC
// SL = 0.8 × ATR(M1), sin cierre por tiempo (el engine aplica maxHold).
export function evaluateStraddleBreakout(
  m1: Candle[],
  m5: Candle[],
  minScore = 65,
): Signal {
  if (m1.length < 40 || m5.length < 20) return null;

  const last = m1[m1.length - 1];
  const prev = m1[m1.length - 2];

  // Killzone estricta
  const d = new Date(last.time * 1000);
  const hUTC = d.getUTCHours();
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return null;
  const inLondon = hUTC >= 7 && hUTC < 10;
  const inNY = hUTC >= 13 && hUTC < 15;
  if (!inLondon && !inNY) return null;

  // Volatilidad
  const m5Atr = atr(m5, 14);
  const lastM5Atr = m5Atr[m5Atr.length - 1] || 0;
  if (lastM5Atr < 0.35) return null;
  const m1Atr = atr(m1, 14);
  const lastM1Atr = m1Atr[m1Atr.length - 1] || 0.15;

  // Niveles straddle
  const D = 0.6 * lastM5Atr;
  const upper = prev.close + D;
  const lower = prev.close - D;

  const range = Math.max(0.01, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const bodyPct = body / range;

  const breakUp = last.close > upper && last.close > last.open && bodyPct >= 0.55;
  const breakDn = last.close < lower && last.close < last.open && bodyPct >= 0.55;
  if (!breakUp && !breakDn) return null;
  const bias: "long" | "short" = breakUp ? "long" : "short";

  // Filtro extra: sesgo M5 EMA20/EMA50 alineado con la ruptura (evita mecha
  // contra tendencia grande — falencia principal del Thunder v8).
  const closes5 = m5.map((c) => c.close);
  const e20 = ema(closes5, 20);
  const e50 = ema(closes5, 50);
  const m5Bias = e20[e20.length - 1] - e50[e50.length - 1];
  const m5Aligned = bias === "long" ? m5Bias > 0 : m5Bias < 0;

  // Scoring
  const stretch = Math.abs(last.close - prev.close) / Math.max(0.05, D); // ≥1 = ruptura clara
  const stretchScore = Math.min(25, Math.round(stretch * 15));
  const bodyScore = Math.min(20, Math.round(bodyPct * 25));
  const atrScoreM5 = lastM5Atr >= 1 ? 10 : lastM5Atr >= 0.6 ? 8 : 5;

  const breakdown = {
    h4Trend: stretchScore,     // slot: fuerza de la ruptura vs D
    h1Sweep: bodyScore,         // slot: cuerpo de la vela
    m15Fvg: 15,                 // fijo: setup válido
    m15Bos: m5Aligned ? 10 : 3, // slot: alineación M5
    killzone: inLondon ? 12 : 10,
    atr: atrScoreM5,
    h1Alignment: 5,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // Entry / SL / TPs
  const entry = last.close;
  const buffer = lastM1Atr * 0.8;
  const sl = bias === "long" ? entry - buffer : entry + buffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0.1) return null;
  const tp1 = bias === "long" ? entry + risk : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  const confidence: "high" | "medium" = breakdown.total >= 82 ? "high" : "medium";

  return {
    bias, confidence,
    score: breakdown.total,
    scoreBreakdown: breakdown,
    entry: round(entry),
    stopLoss: round(sl),
    tp1: round(tp1), tp2: round(tp2), tp3: round(tp3),
    reasoning: {
      h4Trend: `Ruptura ${bias === "long" ? "sobre" : "bajo"} straddle ±${D.toFixed(2)} (D=0.6×ATR M5)`,
      h1Liquidity: `Nivel ${bias === "long" ? "superior" : "inferior"} = ${(bias === "long" ? upper : lower).toFixed(2)}`,
      m15Confirmation: `Cuerpo ${(bodyPct * 100).toFixed(0)}% del rango · stretch ${stretch.toFixed(2)}D`,
      notes: [
        `Killzone: ${inLondon ? "Londres 07-10" : "NY 13-15"} UTC`,
        `ATR M1 ${lastM1Atr.toFixed(2)} · ATR M5 ${lastM5Atr.toFixed(2)}`,
        `Sesgo M5 (EMA20-EMA50) = ${m5Bias.toFixed(2)} → ${m5Aligned ? "alineado" : "contra"}`,
        `SL 0.8×ATR M1 · sin cierre por tiempo`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }