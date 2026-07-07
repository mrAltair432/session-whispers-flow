import { atr, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia E2: ORB Sesión (Opening Range Breakout Londres / NY)
// -----------------------------------------------------------------------
// Referencia: Zarattini, Barbon & Aziz (2024) — "A Profitable Day Trading
// Strategy For The U.S. Equity Market" (SSRN 4729284). Adaptación a XAU/USD
// intradía usando las dos aperturas líquidas del oro:
//   - Londres  07:00 UTC (OR = 07:00-07:05)
//   - New York 13:30 UTC (OR = 13:30-13:35)  ← apertura Comex/CME
//
// Lógica (5 reglas deterministas):
//   1. La primera vela M5 de la sesión define el Opening Range (OR).
//   2. Bias: bullish si OR.close > OR.open, bearish en caso contrario.
//   3. Filtro OR: cuerpo ≥ 40% del rango (evita OR indecisas / dojis).
//   4. Trigger: primera M5 posterior cuyo close rompe OR.high (long) o
//      OR.low (short) con cuerpo ≥ 45% del rango.
//   5. Filtro ATR M15 (evita mercado muerto).
// Salidas: SL = lado opuesto del OR + 0.1×ATR(M15). TPs = 1R / 2R / 3R.
//
// Ventanas horarias (killzone):
//   - Londres: entry window 07:05-09:00 UTC
//   - NY:      entry window 13:35-15:00 UTC
export function evaluateOrbSession(
  m5: Candle[],
  m15: Candle[],
  minScore = 60,
): Signal {
  if (m5.length < 30 || m15.length < 30) return null;

  const last = m5[m5.length - 1];
  const dt = new Date(last.time * 1000);
  const hUTC = dt.getUTCHours();
  const minUTC = dt.getUTCMinutes();

  // last.time = TIMESTAMP DE INICIO de la vela M5.
  const day0 = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) / 1000;
  const londonOrOpen = day0 + 7 * 3600;              // 07:00 UTC
  const nyOrOpen     = day0 + 13 * 3600 + 30 * 60;   // 13:30 UTC

  let session: "London" | "NY" | null = null;
  let orOpenTime = 0;
  if (hUTC === 7 && minUTC >= 5)        { session = "London"; orOpenTime = londonOrOpen; }
  else if (hUTC === 8)                   { session = "London"; orOpenTime = londonOrOpen; }
  else if (hUTC === 13 && minUTC >= 35) { session = "NY";     orOpenTime = nyOrOpen; }
  else if (hUTC === 14)                  { session = "NY";     orOpenTime = nyOrOpen; }
  if (!session) return null;

  // Localizar la vela OR (empieza exactamente en orOpenTime).
  const orBar = m5.find((c) => c.time === orOpenTime);
  if (!orBar) return null;
  const orRange = Math.max(0.01, orBar.high - orBar.low);
  const orBody  = Math.abs(orBar.close - orBar.open);
  const orBodyPct = orBody / orRange;
  if (orBodyPct < 0.4) return null;

  const bias: "long" | "short" = orBar.close > orBar.open ? "long" : "short";

  // Trigger: la vela ACTUAL rompe el extremo del OR con cuerpo fuerte.
  if (last.time === orBar.time) return null;
  const range = Math.max(0.01, last.high - last.low);
  const body  = Math.abs(last.close - last.open);
  const strongBody = body / range >= 0.45;
  const breakLong  = bias === "long"  && last.close > orBar.high && last.close > last.open && strongBody;
  const breakShort = bias === "short" && last.close < orBar.low  && last.close < last.open && strongBody;
  if (!breakLong && !breakShort) return null;

  // Filtro ATR M15
  const m15Atr = atr(m15, 14);
  const lastAtr = m15Atr[m15Atr.length - 1] || 1;
  const recent = m15Atr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median = recent.length ? recent[Math.floor(recent.length / 2)] : lastAtr;
  const atrRatio = median > 0 ? lastAtr / median : 1;
  if (atrRatio < 0.6) return null;

  // Entry / SL / TPs
  const entry = last.close;
  const buffer = lastAtr * 0.1;
  const sl = bias === "long" ? orBar.low - buffer : orBar.high + buffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + risk     : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  const inKz = session === "London" ? hUTC === 7 || hUTC === 8 : hUTC === 13 || hUTC === 14;
  const breakStrength = bias === "long"
    ? (last.close - orBar.high) / range
    : (orBar.low - last.close) / range;

  const breakdown = {
    h4Trend: 15,
    h1Sweep: orBodyPct >= 0.6 ? 22 : orBodyPct >= 0.5 ? 18 : 14,
    m15Fvg: strongBody ? 15 : 8,
    m15Bos: breakStrength > 0.3 ? 14 : breakStrength > 0.15 ? 10 : 6,
    killzone: inKz ? 12 : 4,
    atr: atrRatio >= 1 ? 10 : atrRatio >= 0.85 ? 7 : 4,
    h1Alignment: 5,
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
    reasoning: {
      h4Trend: `Sesión ${session} · OR ${bias === "long" ? "alcista" : "bajista"} (${orBar.open.toFixed(2)} → ${orBar.close.toFixed(2)})`,
      h1Liquidity: `OR range ${orRange.toFixed(2)} · body ${(orBodyPct * 100).toFixed(0)}%`,
      m15Confirmation: `Ruptura ${bias === "long" ? "sobre " + orBar.high.toFixed(2) : "bajo " + orBar.low.toFixed(2)} con cuerpo ${((body / range) * 100).toFixed(0)}%`,
      notes: [
        `Killzone: ${inKz ? "sí" : "fuera"} (UTC ${hUTC}:${minUTC.toString().padStart(2, "0")})`,
        `ATR M15 ratio ${(atrRatio * 100).toFixed(0)}%`,
        `Riesgo ${risk.toFixed(2)} · TPs 1R/2R/3R`,
        `Score ${breakdown.total}/100`,
      ],
    },
  };
}

// Aliases legacy — mantienen el nombre público antiguo por compatibilidad
// con el registry (`evaluateHarmonics`) y con imports externos
// (`evaluateNyContinuation`). La firma antigua recibía (h4, h1, m15, minScore);
// la nueva ORB solo usa m15 y m5, así que aceptamos m5 como argumento extra.
export function evaluateHarmonics(
  _h4: Candle[],
  _h1: Candle[],
  m15: Candle[],
  minScore = 60,
  m5?: Candle[],
): Signal {
  return evaluateOrbSession(m5 ?? [], m15, minScore);
}
export const evaluateNyContinuation = evaluateHarmonics;

function round(n: number) { return Math.round(n * 100) / 100; }
