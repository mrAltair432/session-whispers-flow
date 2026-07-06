import { ema, atr, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 4: VWAP Mean Reversion (M1) — sin killzone
// -------------------------------------------------
// Hipótesis: cuando el precio se estira ≥1.5σ del VWAP del día UTC y aparece
// una vela de rechazo (mecha larga hacia el extremo, cuerpo hacia VWAP), la
// probabilidad de retorno al VWAP es alta. Sin filtro de hora rígido (solo
// se descarta la ventana muerta 22:00–05:00 UTC y fines de semana).
//
// - M1 : TF trigger.
// - M5 : filtro de volatilidad (ATR ≥ 0.4 USD).
// - VWAP: anclado al inicio del día UTC (min 60 velas M1 acumuladas).
// - SL : más allá de la mecha extrema de las últimas 3 velas + 0.3×ATR M1.
// - TP1: VWAP; TP2: banda opuesta (+1σ); TP3: overshoot 1.5×dist a VWAP.
export function evaluateGoldScalping(
  m1: Candle[],
  m5: Candle[],
  minScore = 60,
): Signal {
  if (m1.length < 90 || m5.length < 20) return null;

  const last = m1[m1.length - 1];
  const d = new Date(last.time * 1000);
  const hUTC = d.getUTCHours();
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return null;
  // Ventana muerta 22:00–05:00 UTC: baja participación, VWAP ruidoso.
  if (hUTC >= 22 || hUTC < 5) return null;

  // ---- VWAP anclado al inicio del día UTC ----
  const dayStart = Math.floor(last.time / 86400) * 86400;
  let pv = 0, vv = 0;
  const sessM1: Candle[] = [];
  for (const c of m1) {
    if (c.time >= dayStart && c.time <= last.time) {
      const typical = (c.high + c.low + c.close) / 3;
      const w = Math.max(0.01, c.high - c.low); // proxy de volumen = rango
      pv += typical * w;
      vv += w;
      sessM1.push(c);
    }
  }
  if (sessM1.length < 60 || vv <= 0) return null;
  const vwap = pv / vv;

  // σ del typical vs VWAP.
  let sq = 0;
  for (const c of sessM1) {
    const t = (c.high + c.low + c.close) / 3;
    sq += (t - vwap) ** 2;
  }
  const sigma = Math.sqrt(sq / sessM1.length);
  const sigmaSafe = Math.max(0.05, sigma);

  // ---- ATR M1 y M5 (filtros de volatilidad) ----
  const m1Atr = atr(m1, 14);
  const lastM1Atr = m1Atr[m1Atr.length - 1] || 0.15;
  if (lastM1Atr < 0.10) return null;
  const m5Atr = atr(m5, 14);
  const lastM5Atr = m5Atr[m5Atr.length - 1] || 0.4;
  if (lastM5Atr < 0.4) return null;

  // ---- Estiramiento vs VWAP ----
  const stretchSigmas = Math.abs(last.close - vwap) / sigmaSafe;
  if (stretchSigmas < 1.5) return null;
  const bias: "long" | "short" = last.close < vwap ? "long" : "short";

  // ---- Vela de rechazo ----
  // long : mecha inferior larga, cuerpo alcista, close en tercio superior.
  // short: mecha superior larga, cuerpo bajista, close en tercio inferior.
  const range = Math.max(0.01, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const closePos = (last.close - last.low) / range; // 0..1

  const rejectLong  = bias === "long"  && last.close > last.open && lowerWick > body && closePos > 0.6;
  const rejectShort = bias === "short" && last.close < last.open && upperWick > body && closePos < 0.4;
  if (!rejectLong && !rejectShort) return null;

  // ---- Sesgo M5 (informativo, no bloqueante) ----
  const m5Close = m5.map((c) => c.close);
  const e20 = ema(m5Close, 20);
  const e50 = ema(m5Close, 50);
  const m5Diff = (e20[e20.length - 1] - e50[e50.length - 1]) / e50[e50.length - 1];
  const m5BiasUp = m5Diff > 0.0002;
  const m5BiasDn = m5Diff < -0.0002;
  // "Contra" tendencia M5 es esperable en mean-reversion; no penalizamos duro.
  const m5Neutral = !m5BiasUp && !m5BiasDn;
  const m5WithReversion = (bias === "long" && m5BiasUp) || (bias === "short" && m5BiasDn);

  // ---- Scoring graduado (0-100) ----
  // 1) stretch: 1.5σ=15, 2σ=22, 2.5σ=28, ≥3σ=30
  const stretchScore = Math.min(30, Math.round((stretchSigmas - 1) * 12));
  // 2) wick rejection: wick/range en el lado extendido, 0-20
  const wick = bias === "long" ? lowerWick : upperWick;
  const wickScore = Math.min(20, Math.round((wick / range) * 25));
  // 3) body strength, 0-15
  const bodyScore = Math.min(15, Math.round((body / range) * 20));
  // 4) volatilidad M1 sana (0.15–0.5 USD ATR M1), 0-10
  const atrScoreM1 = lastM1Atr >= 0.35 ? 10 : lastM1Atr >= 0.20 ? 7 : 4;
  // 5) ATR M5 (0.4→0.6=5, 0.6→1=8, ≥1=10), 0-10
  const atrScoreM5 = lastM5Atr >= 1 ? 10 : lastM5Atr >= 0.6 ? 8 : 5;
  // 6) hora: solapes Londres/NY (7-16 UTC) = 10, resto activo = 5
  const hourScore = (hUTC >= 7 && hUTC <= 16) ? 10 : 5;
  // 7) M5 alignment: a favor de reversión = 5, neutral = 3, contra = 1
  const alignScore = m5WithReversion ? 5 : m5Neutral ? 3 : 1;

  const breakdown = {
    h4Trend: stretchScore,   // 0-30 (slot: estiramiento σ)
    h1Sweep: wickScore,      // 0-20 (slot: rechazo mecha)
    m15Fvg: bodyScore,       // 0-15 (slot: cuerpo vela)
    m15Bos: atrScoreM1,      // 0-10 (slot: ATR M1)
    killzone: hourScore,     // 5 o 10
    atr: atrScoreM5,         // 5-10
    h1Alignment: alignScore, // 1, 3 o 5
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TPs ----
  const entry = last.close;
  // SL: extremo de las últimas 3 velas + buffer 0.3×ATR M1.
  const w3 = m1.slice(-3);
  const hi3 = Math.max(...w3.map((c) => c.high));
  const lo3 = Math.min(...w3.map((c) => c.low));
  const buffer = Math.max(lastM1Atr * 0.3, 0.15);
  const sl = bias === "long" ? lo3 - buffer : hi3 + buffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0.1) return null;

  const distToVwap = Math.abs(vwap - entry);
  if (distToVwap < risk * 0.8) return null; // R:R pobre

  const tp1 = vwap; // 1R aprox
  const tp2 = bias === "long" ? vwap + sigmaSafe : vwap - sigmaSafe; // banda opuesta
  const tp3 = bias === "long" ? entry + distToVwap * 1.5 : entry - distToVwap * 1.5;

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
      h4Trend: `Precio a ${stretchSigmas.toFixed(2)}σ del VWAP ${vwap.toFixed(2)}`,
      h1Liquidity: `Rechazo con mecha ${(wick / range * 100).toFixed(0)}% del rango (bias ${bias})`,
      m15Confirmation: `Cuerpo ${(body / range * 100).toFixed(0)}% del rango, close en ${(closePos * 100).toFixed(0)}%`,
      notes: [
        `Hora UTC ${hUTC}:00 (${hUTC >= 7 && hUTC <= 16 ? "activa" : "extendida"})`,
        `Distancia entry→VWAP: ${distToVwap.toFixed(2)} USD · SL ${risk.toFixed(2)} USD`,
        `ATR M1 ${lastM1Atr.toFixed(2)} · ATR M5 ${lastM5Atr.toFixed(2)} · σ ${sigma.toFixed(2)}`,
        `Sesgo M5: ${m5WithReversion ? "a favor de reversión" : m5Neutral ? "neutral" : "contra (esperable)"}`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }