import { atr, detectSwings, detectTrend, ema, rsi, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 2: Patrones Armónicos XABCD (Gartley / Bat / Butterfly / Crab)
// -----------------------------------------------------------------------
// Referencias: Carney "Harmonic Trading" Vol.1-2, Pesavento, MQL5 art. 19442.
// Idea: identificar 5 pivotes (X-A-B-C-D) en H1 y validar los ratios Fibonacci
// canónicos. El punto D marca la PRZ (Potential Reversal Zone). Se emite
// señal cuando el precio ya llegó a D y aparece una vela M15 de confirmación
// contraria al último tramo CD, alineada con el sesgo H4.
//
// Filtros críticos (por evidencia empírica — ver research previo):
//  - Sesgo H4 debe coincidir con la dirección del patrón (bullish/bearish).
//  - RSI M15 debe mostrar divergencia (proxy: RSI del extremo D vs C).
//  - Killzone Londres/NY (evita rangos nocturnos donde el edge desaparece).
//  - Solo Gartley y Bat: ratios profundos (0.786/0.886) → SL más ceñido.
//    Butterfly/Crab operan como "reversión extrema" pero fallan en oro
//    intradía, así que quedan fuera del engine base.
export function evaluateHarmonics(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  minScore = 65,
): Signal {
  if (h4.length < 50 || h1.length < 60 || m15.length < 30) return null;

  // --- Contexto H4 (bias direccional) ---
  const h4Trend = detectTrend(h4);
  if (h4Trend === "ranging") return null;
  const h4Bias: "long" | "short" = h4Trend === "bullish" ? "long" : "short";

  // --- Pivotes H1 alternados (X-A-B-C-D) ---
  // detectSwings devuelve highs y lows entrelazados temporalmente. Filtramos
  // los últimos 5 alternando tipo para evitar dos highs seguidos.
  const rawSwings = detectSwings(h1, 3);
  if (rawSwings.length < 6) return null;
  const alt: typeof rawSwings = [];
  for (const s of rawSwings) {
    const prev = alt[alt.length - 1];
    if (!prev || prev.type !== s.type) alt.push(s);
    else if (s.type === "high" ? s.price > prev.price : s.price < prev.price) alt[alt.length - 1] = s;
  }
  if (alt.length < 5) return null;
  const [X, A, B, C, D] = alt.slice(-5);

  // Un patrón bullish requiere X=high, A=low, B=high, C=low, D=low (o simétrico).
  // Mapeo canónico: bullish si D es low y A es low (misma familia).
  // Bearish: D es high y A es high.
  const bullish = X.type === "high" && A.type === "low" && B.type === "high" && C.type === "low" && D.type === "low";
  const bearish = X.type === "low"  && A.type === "high" && B.type === "low"  && C.type === "high" && D.type === "high";
  if (!bullish && !bearish) return null;
  const bias: "long" | "short" = bullish ? "long" : "short";
  if (bias !== h4Bias) return null;

  // --- Ratios XABCD ---
  const XA = Math.abs(A.price - X.price);
  const AB = Math.abs(B.price - A.price);
  const BC = Math.abs(C.price - B.price);
  const CD = Math.abs(D.price - C.price);
  const AD = Math.abs(D.price - A.price);
  if (XA === 0 || AB === 0 || BC === 0) return null;
  const rAB = AB / XA;    // retroceso XA
  const rBC = BC / AB;    // retroceso AB
  const rCD = CD / BC;    // extensión BC (leg CD)
  const rAD = AD / XA;    // proyección total (define el tipo de patrón)

  const tol = 0.10; // ±10% (aflojado desde 6% Carney standard para más señales)
  const near = (v: number, target: number) => Math.abs(v - target) <= tol;
  const inRange = (v: number, lo: number, hi: number) => v >= lo - tol && v <= hi + tol;

  // --- Matching Gartley y Bat (los dos con mejor edge histórico) ---
  let pattern: "Gartley" | "Bat" | null = null;
  if (near(rAB, 0.618) && inRange(rBC, 0.382, 0.886) && inRange(rCD, 1.13, 1.618) && near(rAD, 0.786)) {
    pattern = "Gartley";
  } else if (inRange(rAB, 0.382, 0.500) && inRange(rBC, 0.382, 0.886) && inRange(rCD, 1.618, 2.618) && near(rAD, 0.886)) {
    pattern = "Bat";
  }
  if (!pattern) return null;

  // --- El precio actual debe estar en la PRZ (a ±0.4 ATR H1 de D) ---
  const h1Atr = atr(h1, 14);
  const lastAtrH1 = h1Atr[h1Atr.length - 1] || 1;
  const lastH1 = h1[h1.length - 1];
  const distToD = Math.abs(lastH1.close - D.price);
  if (distToD > lastAtrH1 * 1.2) return null;

  // --- Confirmación M15 (vela de reversión + RSI divergencia) ---
  const lastM15 = m15[m15.length - 1];
  const m15Range = Math.max(0.01, lastM15.high - lastM15.low);
  const m15Body = Math.abs(lastM15.close - lastM15.open);
  const m15ConfirmLong  = bias === "long"  && lastM15.close > lastM15.open && (lastM15.close - lastM15.low)  / m15Range > 0.6 && m15Body / m15Range > 0.35;
  const m15ConfirmShort = bias === "short" && lastM15.close < lastM15.open && (lastM15.high - lastM15.close) / m15Range > 0.6 && m15Body / m15Range > 0.35;
  if (!m15ConfirmLong && !m15ConfirmShort) return null;

  const m15Rsi = rsi(m15, 14);
  const lastRsi = m15Rsi[m15Rsi.length - 1];
  const rsiDivergence = bias === "long" ? lastRsi < 45 : lastRsi > 55;

  // --- Killzone (Londres o solape NY) ---
  const hUTC = new Date(lastM15.time * 1000).getUTCHours();
  const inKz = (hUTC >= 7 && hUTC < 11) || (hUTC >= 12 && hUTC < 16);

  // --- ATR M15 (evita mercados muertos) ---
  const m15Atr = atr(m15, 14);
  const lastAtr = m15Atr[m15Atr.length - 1] || 1;
  const recent = m15Atr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median = recent.length ? recent[Math.floor(recent.length / 2)] : lastAtr;
  const atrRatio = median > 0 ? lastAtr / median : 1;
  if (atrRatio < 0.6) return null;

  // --- H1 EMA alignment (extra confluencia) ---
  const h1Closes = h1.map((c) => c.close);
  const h1Ema20 = ema(h1Closes, 20);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Aligned = bias === "long"
    ? h1Ema20[h1Ema20.length - 1] > h1Ema50[h1Ema50.length - 1]
    : h1Ema20[h1Ema20.length - 1] < h1Ema50[h1Ema50.length - 1];

  // --- Scoring (mismos slots que el motor SMC para reutilizar features IA) ---
  const patternScore = pattern === "Bat" ? 22 : 20; // Bat ratios más restrictivos
  const breakdown = {
    h4Trend: 15,                                     // /20
    h1Sweep: patternScore,                            // slot: identificación patrón
    m15Fvg: 15,                                       // slot: confirmación vela D
    m15Bos: rsiDivergence ? 12 : 4,                   // slot: divergencia RSI
    killzone: inKz ? 12 : 0,
    atr: atrRatio >= 1 ? 10 : atrRatio >= 0.85 ? 7 : 4,
    h1Alignment: h1Aligned ? 5 : 0,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // --- Entry / SL / TPs ---
  const entry = lastM15.close;
  // SL: pasado D + buffer ATR (0.3 × ATR M15). Carney recomienda 0.3-0.5 ATR
  // más allá del punto D como zona invalidada.
  const buffer = Math.max(lastAtr * 0.3, m15Range * 0.4);
  const sl = bias === "long" ? D.price - buffer : D.price + buffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  // TPs parciales sugeridos por Carney en fibos AD (0.382 / 0.618 / 1.0),
  // pero el engine backtest usa 1R/2R/3R para comparabilidad. Los dejamos así.
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
      h4Trend: `H4 ${h4Trend === "bullish" ? "alcista" : "bajista"} (confluencia bias)`,
      h1Liquidity: `Patrón ${pattern} ${bias === "long" ? "alcista" : "bajista"} · AB/XA=${rAB.toFixed(3)}, AD/XA=${rAD.toFixed(3)}`,
      m15Confirmation: `M15 rechazo con RSI ${lastRsi.toFixed(1)}${rsiDivergence ? " (divergencia)" : ""}`,
      notes: [
        `Pivotes H1: X=${X.price.toFixed(2)}, A=${A.price.toFixed(2)}, B=${B.price.toFixed(2)}, C=${C.price.toFixed(2)}, D=${D.price.toFixed(2)}`,
        `Ratios BC/AB=${rBC.toFixed(3)}, CD/BC=${rCD.toFixed(3)}`,
        `PRZ: distancia a D = ${distToD.toFixed(2)} (ATR H1 ${lastAtrH1.toFixed(2)})`,
        `Killzone: ${inKz ? "sí" : "fuera (UTC " + hUTC + ")"} · ATR ratio ${(atrRatio * 100).toFixed(0)}%`,
        `H1 EMAs ${h1Aligned ? "alineadas" : "no alineadas"} · Score ${breakdown.total}/100`,
      ],
    },
  };
}

// Alias legacy — la UI y el registry siguen llamando evaluateNyContinuation.
// Preserva la API pública sin romper imports existentes.
export const evaluateNyContinuation = evaluateHarmonics;

function round(n: number) { return Math.round(n * 100) / 100; }