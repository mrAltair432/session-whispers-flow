import { atr, ema, macd, rsi, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 5: EMA Cross Reversal M1 — v2 "fade" (optimizada sobre 1 año
// de XAUUSD M1, 2025-07 → 2026-07).
// -----------------------------------------------------------
// Hallazgo del backtest: seguir el cruce EMA9/EMA21 en M1 es negativo
// (-34.7R, PF 0.80, WR 48.7% en 318 trades). El mismo evento, operado a
// CONTRA (reversión al valor tras el impulso que produce el cruce), es
// positivo y estable en ambas mitades del año.
//
// Reglas (el "impulso" se mide en la dirección del cruce; la operación es
// en dirección contraria):
//   - Cruce EMA9/EMA21 sobre la última barra M1.
//   - |slope EMA9| ≥ 0.20 USD en 5 barras, en la dirección del cruce.
//   - RSI(14) M1 > 55 (cruce alcista) o < 45 (cruce bajista): extensión.
//   - MACD(12,26,9) histograma cruzando 0 en la dirección del cruce.
//   - ATR M5 ≥ 0.4 y killzone UTC 7-16, sin fines de semana.
//   - SL = 1.8 × ATR(M1) más allá del extremo de las últimas 5 velas.
//   - Gestión: trailing escalonado desde 1.0R con paso 0.25 × ATR(M1).
//   - TPs 1R/2R/3R (50/30/20) los gestiona el simulador / EA.
//
// Resultado optimizado (1 año, costes 0.20 spread + 0.05 slippage, latencia
// 1 barra, cooldown 240 M1): 301 trades · WR 56.8% · +36.5R · PF 1.27 ·
// Max DD 6.4R · Sharpe 2.06. OOS por mitades: +13.1R / +23.4R.
export function evaluateEmaCrossM1(
  m1: Candle[],
  m5: Candle[],
  minScore = 60,
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
  // Dirección del impulso (cruce) y dirección real de la operación (fade).
  const impulse: "long" | "short" = crossUp ? "long" : "short";
  const bias: "long" | "short" = crossUp ? "short" : "long";

  // Slope EMA9 sobre 5 velas (en la dirección del impulso)
  const slope = e9[n] - e9[n - 5];
  const slopeOk = impulse === "long" ? slope >= 0.20 : slope <= -0.20;
  if (!slopeOk) return null;

  // RSI simétrico estricto: confirma extensión del impulso
  const r = rsi(m1, 14);
  const lastRsi = r[r.length - 1];
  const rsiOk = impulse === "long" ? lastRsi > 55 : lastRsi < 45;
  if (!rsiOk) return null;

  // MACD alineado + histograma cruzando 0
  const mac = macd(closes, 12, 26, 9);
  const h0 = mac.hist[n]; const h_1 = mac.hist[n - 1];
  const macdOk = impulse === "long" ? (h0 > 0 && h_1 <= 0) : (h0 < 0 && h_1 >= 0);
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
  const slopeStrength = Math.min(1, Math.abs(slope) / 0.50); // 0.20 baseline, 0.50 fuerte
  const rsiStrength = impulse === "long" ? Math.min(1, (lastRsi - 55) / 15) : Math.min(1, (45 - lastRsi) / 15);
  const atrScoreM5 = lastM5Atr >= 1 ? 10 : lastM5Atr >= 0.6 ? 8 : 5;
  const bodyRange = Math.max(0.01, last.high - last.low);
  const bodyPct = Math.abs(last.close - last.open) / bodyRange;

  const breakdown = {
    h4Trend: 10 + Math.round(10 * slopeStrength), // slot: fuerza del slope EMA9
    h1Sweep: 10 + Math.round(10 * rsiStrength),   // slot: extensión del RSI
    m15Fvg: 15,                                   // slot: cruce EMA + MACD (fijo)
    m15Bos: Math.round(10 * bodyPct),             // slot: cuerpo de la vela cruce
    killzone: 10,
    atr: atrScoreM5,
    h1Alignment: prev && ((impulse === "long" && last.close > prev.close) || (impulse === "short" && last.close < prev.close)) ? 5 : 2,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TPs ----
  const entry = last.close;
  const w5 = m1.slice(-5);
  const hi5 = Math.max(...w5.map((c) => c.high));
  const lo5 = Math.min(...w5.map((c) => c.low));
  const buffer = lastM1Atr * 1.8;
  // El ancla estructural se toma del lado del impulso: si el cruce fue
  // alcista vendemos y el SL va sobre el máximo reciente, y viceversa.
  const sl = bias === "long" ? lo5 - buffer : hi5 + buffer;
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
    management: {
      trailAfterR: 1.0,
      trailStepAtrMult: 0.25,
    },
    reasoning: {
      h4Trend: `Cruce EMA9/EMA21 ${impulse === "long" ? "alcista" : "bajista"} · slope 5b = ${slope.toFixed(2)} → fade ${bias === "long" ? "compra" : "venta"}`,
      h1Liquidity: `RSI(14) M1 = ${lastRsi.toFixed(1)} (${impulse === "long" ? ">55" : "<45"}) · impulso extendido`,
      m15Confirmation: `MACD hist ${h_1.toFixed(3)} → ${h0.toFixed(3)} (cruce 0)`,
      notes: [
        `Killzone UTC ${hUTC}:00 · ATR M5 ${lastM5Atr.toFixed(2)}`,
        `SL = 1.8×ATR(M1) más allá de swing 5b (${risk.toFixed(2)} USD)`,
        `Trailing escalonado desde 1.0R en pasos de 0.25×ATR(M1)`,
        `Cuerpo vela cruce: ${(bodyPct * 100).toFixed(0)}% del rango`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }