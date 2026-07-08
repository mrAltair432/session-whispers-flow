import { atr, ema, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia E2: ORB Sesión (Opening Range Breakout Londres / NY)
// -----------------------------------------------------------------------
// Referencia: Zarattini et al. 2024 (SSRN 4729284). Adaptación a XAU/USD.
// Ventanas: Londres 07:00 UTC (OR 07:00-07:05) · NY 13:30 UTC (OR 13:30-13:35).
//
// v2 con filtros A+B+C para mejorar winrate:
//   A. Tendencia macro — sólo longs si close M15 > EMA200(M15); shorts si close < EMA200.
//   B. Retest confirmado — no se entra en la vela que rompe: se exige un breakout
//      previo + un pullback al nivel del OR + un nuevo cierre fuera del rango.
//   C. OR sano — el rango del OR debe estar entre 0.3× y 1.5× del ATR(M15) medio.
// Salidas: SL = lado opuesto del OR + 0.1×ATR(M15). TPs = 1R / 2R / 3R.
export function evaluateOrbSession(
  m5: Candle[],
  m15: Candle[],
  minScore = 60,
): Signal {
  if (m5.length < 30 || m15.length < 210) return null;

  const last = m5[m5.length - 1];
  const dt = new Date(last.time * 1000);
  const hUTC = dt.getUTCHours();
  const minUTC = dt.getUTCMinutes();

  const day0 = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) / 1000;
  const londonOrOpen = day0 + 7 * 3600;
  const nyOrOpen     = day0 + 13 * 3600 + 30 * 60;

  let session: "London" | "NY" | null = null;
  let orOpenTime = 0;
  if (hUTC === 7 && minUTC >= 5)         { session = "London"; orOpenTime = londonOrOpen; }
  else if (hUTC === 8)                    { session = "London"; orOpenTime = londonOrOpen; }
  else if (hUTC === 13 && minUTC >= 35)  { session = "NY";     orOpenTime = nyOrOpen; }
  else if (hUTC === 14)                   { session = "NY";     orOpenTime = nyOrOpen; }
  if (!session) return null;

  const orBar = m5.find((c) => c.time === orOpenTime);
  if (!orBar) return null;
  const orRange = Math.max(0.01, orBar.high - orBar.low);
  const orBody  = Math.abs(orBar.close - orBar.open);
  const orBodyPct = orBody / orRange;
  if (orBodyPct < 0.4) return null;

  const bias: "long" | "short" = orBar.close > orBar.open ? "long" : "short";

  // Necesitamos al menos una vela intermedia (breakout previo + retest).
  if (last.time <= orBar.time + 5 * 60) return null;

  // --- A. Filtro de tendencia macro (EMA200 M15) --------------------------
  const emaArr = ema(m15.map((c) => c.close), 200);
  const lastEma = emaArr[emaArr.length - 1];
  if (!Number.isFinite(lastEma) || lastEma <= 0) return null;
  const lastM15Close = m15[m15.length - 1].close;
  if (bias === "long"  && lastM15Close <= lastEma) return null;
  if (bias === "short" && lastM15Close >= lastEma) return null;

  // Trigger: cierre fuera del OR con cuerpo fuerte, en la dirección del bias.
  const range = Math.max(0.01, last.high - last.low);
  const body  = Math.abs(last.close - last.open);
  const strongBody = body / range >= 0.45;
  const breakLong  = bias === "long"  && last.close > orBar.high && last.close > last.open && strongBody;
  const breakShort = bias === "short" && last.close < orBar.low  && last.close < last.open && strongBody;
  if (!breakLong && !breakShort) return null;

  // --- B. Retest confirmado -----------------------------------------------
  // Requiere: (1) alguna vela previa cerró fuera del OR (breakout inicial)
  //           (2) alguna vela posterior a ese breakout tocó de vuelta el OR
  //           (3) la vela actual vuelve a cerrar fuera del OR (nuestra entrada).
  const orIdx = m5.findIndex((c) => c.time === orBar.time);
  const mid = m5.slice(orIdx + 1, m5.length - 1);
  let breakoutIdx = -1;
  for (let i = 0; i < mid.length; i++) {
    const c = mid[i];
    if (bias === "long"  && c.close > orBar.high) { breakoutIdx = i; break; }
    if (bias === "short" && c.close < orBar.low)  { breakoutIdx = i; break; }
  }
  if (breakoutIdx < 0) return null;
  let retested = false;
  for (let i = breakoutIdx + 1; i < mid.length; i++) {
    const c = mid[i];
    if (bias === "long"  && c.low  <= orBar.high) { retested = true; break; }
    if (bias === "short" && c.high >= orBar.low)  { retested = true; break; }
  }
  if (!retested) return null;

  // --- Filtro ATR M15 + C. OR sano ---------------------------------------
  const m15Atr = atr(m15, 14);
  const lastAtr = m15Atr[m15Atr.length - 1] || 1;
  const recent = m15Atr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median = recent.length ? recent[Math.floor(recent.length / 2)] : lastAtr;
  const atrRatio = median > 0 ? lastAtr / median : 1;
  if (atrRatio < 0.6) return null;
  const orRangeRatio = median > 0 ? orRange / median : 1;
  if (orRangeRatio < 0.3 || orRangeRatio > 1.5) return null;

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
    h4Trend: 18,                                                       // A
    h1Sweep: orBodyPct >= 0.6 ? 22 : orBodyPct >= 0.5 ? 18 : 14,
    m15Fvg: 15,                                                        // B (retest)
    m15Bos: breakStrength > 0.3 ? 14 : breakStrength > 0.15 ? 10 : 6,
    killzone: inKz ? 12 : 4,
    atr: (orRangeRatio >= 0.5 && orRangeRatio <= 1.2) ? 10 : 7,        // C
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
      h4Trend: `Sesión ${session} · bias ${bias} · EMA200 M15 alineada (${lastM15Close.toFixed(2)} vs ${lastEma.toFixed(2)})`,
      h1Liquidity: `OR range ${orRange.toFixed(2)} · body ${(orBodyPct * 100).toFixed(0)}% · OR/ATR ${(orRangeRatio * 100).toFixed(0)}%`,
      m15Confirmation: `Breakout + retest confirmado · cierre ${bias === "long" ? "sobre " + orBar.high.toFixed(2) : "bajo " + orBar.low.toFixed(2)} con cuerpo ${((body / range) * 100).toFixed(0)}%`,
      notes: [
        `Killzone: ${inKz ? "sí" : "fuera"} (UTC ${hUTC}:${minUTC.toString().padStart(2, "0")})`,
        `ATR M15 ratio ${(atrRatio * 100).toFixed(0)}%`,
        `Riesgo ${risk.toFixed(2)} · TPs 1R/2R/3R`,
        `Score ${breakdown.total}/100`,
      ],
    },
  };
}

// Aliases legacy — compatibilidad con imports antiguos.
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