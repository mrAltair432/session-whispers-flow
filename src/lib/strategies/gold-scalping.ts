import { ema, atr, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 4 (v2): VWAP Band Failure — continuación tras rebote fallido
// ----------------------------------------------------------------------
// Origen: la v1 era mean-reversion pura al VWAP (comprar debajo, vender
// encima). Sobre 1 año de XAUUSD M1 (353.424 velas, jul-25 → jul-26) esa
// versión daba 3.107 trades, 17% WR y −2.028R: el SL micro (0.3×ATR) y el
// coste fijo (0.20 spread + 0.05 slippage) se comían cada operación, y el
// oro simplemente no revierte al VWAP cuando está a 3σ.
//
// v2 invierte la premisa (validada en grid search de ~700 combinaciones):
// cuando el precio se estira ≥2.9σ del VWAP diario y aparece una vela de
// rechazo CONTRA la extensión (pin bar) que no consigue arrastrar precio,
// ese rebote falla y el movimiento CONTINÚA en la dirección del estiramiento.
// Es decir: pin alcista muy por debajo del VWAP ⇒ SHORT; pin bajista muy por
// encima del VWAP ⇒ LONG.
//
// - M1 : TF trigger. M5: filtro de volatilidad (ATR ≥ 0.40).
// - VWAP anclado al día UTC (mín. 60 velas M1 de sesión).
// - Vela gatillo: mecha del lado extendido ≥45% del rango, cuerpo ≤40%.
// - SL : extremo de 3 velas ± 2.0×ATR(M1), proyectado al otro lado.
//        Riesgo aceptado 2.5–8.0 USD (por debajo, los costes dominan).
// - TP : 1R / 2R / 3R. Gestión: trailing escalonado desde 1.0R (0.3×ATR)
//        y time-stop de 180 velas M1 (3 h).
// - Horario 05:00–21:59 UTC, sin fines de semana.
//
// Resultado 1 año: 52 trades, 65.4% WR, +13.2R, PF 1.69, Max DD 4.7R,
// positivo en los 4 trimestres (vs −2.028R de la v1).
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
  if (stretchSigmas < 2.9) return null;
  // Lado de la extensión: below = precio por debajo del VWAP.
  const below = last.close < vwap;
  // Vela de rechazo CONTRA la extensión; operamos A FAVOR de la extensión.
  const bias: "long" | "short" = below ? "short" : "long";

  // ---- Vela de rechazo fallido (pin bar contra la extensión) ----
  const range = Math.max(0.01, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const closePos = (last.close - last.low) / range; // 0..1
  const wick = below ? lowerWick : upperWick;

  if (wick / range < 0.55) return null;   // mecha larga del lado extendido
  if (body / range > 0.50) return null;   // cuerpo contenido: rebote sin fuerza
  if (below) {
    if (!(last.close > last.open && closePos > 0.75)) return null;
  } else {
    if (!(last.close < last.open && closePos < 0.25)) return null;
  }

  // ---- Sesgo M5 (informativo) ----
  const m5Close = m5.map((c) => c.close);
  const e20 = ema(m5Close, 20);
  const e50 = ema(m5Close, 50);
  const m5Diff = (e20[e20.length - 1] - e50[e50.length - 1]) / e50[e50.length - 1];
  const m5BiasUp = m5Diff > 0.0002;
  const m5BiasDn = m5Diff < -0.0002;
  const m5Neutral = !m5BiasUp && !m5BiasDn;
  const m5Aligned = (bias === "long" && m5BiasUp) || (bias === "short" && m5BiasDn);

  // ---- Entry / SL / TPs ----
  const entry = last.close;
  // Distancia de riesgo tomada del extremo de 3 velas + 2.0×ATR(M1),
  // proyectada al lado contrario del trade (continuación).
  const w3 = m1.slice(-3);
  const hi3 = Math.max(...w3.map((c) => c.high));
  const lo3 = Math.min(...w3.map((c) => c.low));
  const buffer = Math.max(lastM1Atr * 2.0, 0.30);
  const anchor = below ? lo3 - buffer : hi3 + buffer;
  const risk = Math.abs(entry - anchor);
  // Filtro de coste: por debajo de 2.5 USD el spread+slippage domina el R.
  if (risk < 2.5 || risk > 8) return null;

  const distToVwap = Math.abs(vwap - entry);
  if (distToVwap < risk * 0.5) return null;

  const s = bias === "long" ? 1 : -1;
  const sl = entry - s * risk;
  const tp1 = entry + s * risk;
  const tp2 = entry + s * risk * 2;
  const tp3 = entry + s * risk * 3;

  // ---- Scoring graduado (0-100) ----
  // 1) estiramiento: 2.9σ=23, 3.5σ=28, ≥4σ=30
  const stretchScore = Math.min(30, Math.round((stretchSigmas - 1) * 12));
  // 2) mecha del lado extendido, 0-20
  const wickScore = Math.min(20, Math.round((wick / range) * 30));
  // 3) cuerpo pequeño = mejor rechazo fallido, 0-15
  const bodyScore = Math.min(15, Math.round((1 - body / range) * 18));
  // 4) volatilidad M1 sana, 0-10
  const atrScoreM1 = lastM1Atr >= 0.35 ? 10 : lastM1Atr >= 0.20 ? 7 : 4;
  // 5) ATR M5, 5-10
  const atrScoreM5 = lastM5Atr >= 1 ? 10 : lastM5Atr >= 0.6 ? 8 : 5;
  // 6) hora: solape Londres/NY (7-16 UTC) = 10, resto activo = 5
  const hourScore = (hUTC >= 7 && hUTC <= 16) ? 10 : 5;
  // 7) M5 a favor de la continuación = 5, neutral = 3, contra = 1
  const alignScore = m5Aligned ? 5 : m5Neutral ? 3 : 1;

  const breakdown = {
    h4Trend: stretchScore,   // 0-30 (slot: estiramiento σ)
    h1Sweep: wickScore,      // 0-20 (slot: mecha del rebote fallido)
    m15Fvg: bodyScore,       // 0-15 (slot: cuerpo pequeño)
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
      trailAfterR: 1.0,
      trailStepAtrMult: 0.3,
      timeStopBars: 180,
    },
    reasoning: {
      h4Trend: `Precio a ${stretchSigmas.toFixed(2)}σ ${below ? "bajo" : "sobre"} el VWAP ${vwap.toFixed(2)}`,
      h1Liquidity: `Rebote fallido: mecha ${(wick / range * 100).toFixed(0)}% del rango, cuerpo ${(body / range * 100).toFixed(0)}%`,
      m15Confirmation: `Continuación ${bias === "long" ? "alcista" : "bajista"} con SL ${risk.toFixed(2)} USD (3 velas ± 2.0×ATR)`,
      notes: [
        `Hora UTC ${hUTC}:00 (${hUTC >= 7 && hUTC <= 16 ? "activa" : "extendida"})`,
        `Distancia entry→VWAP: ${distToVwap.toFixed(2)} USD · TP 1R/2R/3R`,
        `ATR M1 ${lastM1Atr.toFixed(2)} · ATR M5 ${lastM5Atr.toFixed(2)} · σ ${sigma.toFixed(2)}`,
        `Sesgo M5: ${m5Aligned ? "a favor" : m5Neutral ? "neutral" : "contra"}`,
        `Gestión: trailing desde 1.0R (0.3×ATR) · time-stop 180 velas M1`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }
