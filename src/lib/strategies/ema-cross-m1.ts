import { atr, ema, macd, rsi, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 5: EMA Cross Reversal M1 (base MR4ltair EMA v4)
// -----------------------------------------------------------
// Filtros simétricos y estrictos:
//   - Cruce EMA9/EMA21 sobre la última barra M1.
//   - Pendiente EMA9 con magnitud ≥ 0.10 USD en las últimas 5 M1 (misma
//     dirección del cruce). BUY: slope > +0.10; SELL: slope < -0.10.
//   - RSI(14) M1: BUY > 55 · SELL < 45 (simétrico y estricto).
//   - MACD(12,26,9) M1: histograma cruzando 0 en la dirección del bias.
//   - ATR M5 ≥ 0.4 (mercado sano) y killzone UTC 7-16.
//   - SL = 1.2 × ATR(M1) más allá del extremo de las últimas 3 velas.
//   - TPs 1R/2R/3R los gestiona el engine (aprox. 1R/1.5R/2R deseados).
export function evaluateEmaCrossM1(
  m1: Candle[],
  m5: Candle[],
  minScore = 70,
): Signal {
  if (m1.length < 60 || m5.length < 30) return null;

  const last = m1[m1.length - 1];
  const prev = m1[m1.length - 2];
  const closes = m1.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const n = closes.length - 1;

  const crossUp   = e9[n - 1] <= e21[n - 1] && e9[n] > e21[n];
  const crossDown = e9[n - 1] >= e21[n - 1] && e9[n] < e21[n];
  if (!crossUp && !crossDown) return null;
  const bias: "long" | "short" = crossUp ? "long" : "short";

  // Slope EMA9 sobre 5 velas
  const slope = e9[n] - e9[n - 5];
  const slopeOk = bias === "long" ? slope >= 0.10 : slope <= -0.10;
  if (!slopeOk) return null;

  // RSI simétrico estricto
  const r = rsi(m1, 14);
  const lastRsi = r[r.length - 1];
  const rsiOk = bias === "long" ? lastRsi > 55 : lastRsi < 45;
  if (!rsiOk) return null;

  // MACD alineado + histograma cruzando 0
  const mac = macd(closes, 12, 26, 9);
  const h0 = mac.hist[n]; const h_1 = mac.hist[n - 1];
  const macdOk = bias === "long" ? (h0 > 0 && h_1 <= 0) : (h0 < 0 && h_1 >= 0);
  if (!macdOk) return null;

  // Killzone 7-16 UTC + fines de semana bloqueados
  const d = new Date(last.time * 1000);
  const hUTC = d.getUTCHours();
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return null;
  const inKz = hUTC >= 7 && hUTC <= 16;
  if (!inKz) return null;

  // Volatilidad M5
  const m5Atr = atr(m5, 14);
  const lastM5Atr = m5Atr[m5Atr.length - 1] || 0;
  if (lastM5Atr < 0.40) return null;

  // ATR M1 para SL
  const m1Atr = atr(m1, 14);
  const lastM1Atr = m1Atr[m1Atr.length - 1] || 0.15;

  // ---- Scoring ----
  const slopeStrength = Math.min(1, Math.abs(slope) / 0.30); // 0.10 baseline, 0.30 fuerte
  const rsiStrength = bias === "long" ? Math.min(1, (lastRsi - 55) / 15) : Math.min(1, (45 - lastRsi) / 15);
  const atrScoreM5 = lastM5Atr >= 1 ? 10 : lastM5Atr >= 0.6 ? 8 : 5;
  const bodyRange = Math.max(0.01, last.high - last.low);
  const bodyPct = Math.abs(last.close - last.open) / bodyRange;

  const breakdown = {
    h4Trend: Math.round(20 * slopeStrength),   // slot: fuerza del slope EMA9
    h1Sweep: Math.round(20 * rsiStrength),      // slot: fuerza del RSI
    m15Fvg: 15,                                 // slot: cruce EMA + MACD (fijo)
    m15Bos: Math.round(10 * bodyPct),           // slot: cuerpo de la vela cruce
    killzone: 10,
    atr: atrScoreM5,
    h1Alignment: prev && ((bias === "long" && last.close > prev.close) || (bias === "short" && last.close < prev.close)) ? 5 : 2,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TPs ----
  const entry = last.close;
  const w3 = m1.slice(-3);
  const hi3 = Math.max(...w3.map((c) => c.high));
  const lo3 = Math.min(...w3.map((c) => c.low));
  const buffer = lastM1Atr * 1.2;
  const sl = bias === "long" ? lo3 - buffer : hi3 + buffer;
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
      h4Trend: `Cruce EMA9/EMA21 ${bias === "long" ? "alcista" : "bajista"} · slope 5b = ${slope.toFixed(2)}`,
      h1Liquidity: `RSI(14) M1 = ${lastRsi.toFixed(1)} (${bias === "long" ? ">55" : "<45"})`,
      m15Confirmation: `MACD hist ${h_1.toFixed(3)} → ${h0.toFixed(3)} (cruce 0)`,
      notes: [
        `Killzone UTC ${hUTC}:00 · ATR M5 ${lastM5Atr.toFixed(2)}`,
        `SL = 1.2×ATR(M1) más allá de swing 3b (${risk.toFixed(2)} USD)`,
        `Cuerpo vela cruce: ${(bodyPct * 100).toFixed(0)}% del rango`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }