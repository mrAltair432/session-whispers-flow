import { ema, atr, detectSwings, detectBOS, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";
import { buildFiboFeatures } from "../features/fibo-features";

// Estrategia 3: Fibo Scalping M5 (Londres)
// -----------------------------------------------
// Scalping estándar Fibo con trigger M5 (equivale al granular del bot MT5):
// - H4  : filtra sesgo (EMA20/EMA50).
// - H1  : identifica el último swing significativo (rango XA).
// - M15 : el precio debe haber tocado la zona 0.5-0.786 en las últimas 6 M15.
// - M5  : trigger de entrada — cierre en zona + a favor del bias (+ BOS 20).
// - Killzone Londres UTC 07-11, sin domingos, viernes hasta UTC 12.
// - SL: pasado 0.786 con buffer ATR M5.
// - TPs: 1R / 2R / 3R gestionados por el engine.
export function evaluateFiboScalping(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  m5: Candle[],
  minScore = 72,
): Signal {
  if (h4.length < 50 || h1.length < 40 || m15.length < 25 || m5.length < 60) return null;

  // ---- H4 bias ----
  const h4Closes = h4.map((c) => c.close);
  const h4Ema20 = ema(h4Closes, 20);
  const h4Ema50 = ema(h4Closes, 50);
  const diffH4 = (h4Ema20[h4Ema20.length - 1] - h4Ema50[h4Ema50.length - 1]) / h4Ema50[h4Ema50.length - 1];
  // Umbral de tendencia H4 más estricto (0.08 %): evita entrar en H4 planos
  // donde el retroceso Fibo se queda oscilando en la zona.
  if (Math.abs(diffH4) < 0.0008) return null;
  const bias: "long" | "short" = diffH4 > 0 ? "long" : "short";

  // ---- H1 swing (últimas ~40 velas) ----
  const h1Window = h1.slice(-40);
  const swings = detectSwings(h1Window, 2);
  if (swings.length < 2) return null;
  const lastHigh = [...swings].reverse().find((s) => s.type === "high");
  const lastLow = [...swings].reverse().find((s) => s.type === "low");
  if (!lastHigh || !lastLow) return null;

  // El swing "vigente" es el que va desde el extremo previo al reciente
  // en la dirección del bias. Para long: swing de low anterior → high reciente,
  // el retroceso se mide desde el high hacia abajo.
  const highPrice = lastHigh.price;
  const lowPrice = lastLow.price;
  const range = highPrice - lowPrice;
  if (range <= 0) return null;

  // Niveles Fibonacci
  const lvl500 = bias === "long" ? highPrice - range * 0.500 : lowPrice + range * 0.500;
  const lvl618 = bias === "long" ? highPrice - range * 0.618 : lowPrice + range * 0.618;
  const lvl786 = bias === "long" ? highPrice - range * 0.786 : lowPrice + range * 0.786;
  // Zona de entrada: entre 0.5 y 0.786
  const zoneTop = bias === "long" ? lvl500 : lvl786;
  const zoneBot = bias === "long" ? lvl786 : lvl500;

  // ---- M15: precio debe haber tocado la zona en las últimas 4 velas ----
  // Ventana más corta → toque "fresco" y evita reentrar en zonas ya sobre-explotadas.
  const recent = m15.slice(-4);
  const touched = recent.some((c) => c.low <= zoneTop && c.high >= zoneBot);
  if (!touched) return null;

  // ---- Confirmación M5 (trigger real de entrada) ----
  const lastM5 = m5[m5.length - 1];
  const closes5 = m5.map((c) => c.close);
  const e20_5 = ema(closes5, 20);
  const lastEma5 = e20_5[e20_5.length - 1];
  const m5Confirm =
    bias === "long"
      ? lastM5.close > lastM5.open && lastM5.close >= lvl618 && lastM5.close > lastEma5
      : lastM5.close < lastM5.open && lastM5.close <= lvl618 && lastM5.close < lastEma5;
  if (!m5Confirm) return null;
  const bosOk = detectBOS(m5, bias, 20);

  // ---- Killzone Londres UTC 07-11 (apertura + primeras horas) ----
  const d = new Date(lastM5.time * 1000);
  const hUTC = d.getUTCHours();
  const wd = d.getUTCDay();
  const inKz = hUTC >= 7 && hUTC < 11;
  // Restricciones adicionales para scalping en oro
  if (wd === 0) return null;                 // domingo no
  if (wd === 5 && hUTC >= 12) return null;   // viernes solo hasta mediodía UTC

  // ---- ATR check M5 ----
  const m5Atr = atr(m5, 14);
  const lastAtr = m5Atr[m5Atr.length - 1] || 1;
  const recentAtr = m5Atr.slice(-120).filter((v) => v > 0).sort((a, b) => a - b);
  const median = recentAtr.length ? recentAtr[Math.floor(recentAtr.length / 2)] : lastAtr;
  const atrRatio = median > 0 ? lastAtr / median : 1;
  if (atrRatio < 0.7) return null;

  // H1 alignment
  const h1Closes = h1.map((c) => c.close);
  const h1Ema20 = ema(h1Closes, 20);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Aligned =
    bias === "long"
      ? h1Ema20[h1Ema20.length - 1] > h1Ema50[h1Ema50.length - 1]
      : h1Ema20[h1Ema20.length - 1] < h1Ema50[h1Ema50.length - 1];
  // Alineación H1 ahora es obligatoria (viene del EA Fibonacci 61.8, que exige
  // confluencia multi-TF antes de disparar el grid). Sin martingala, esta
  // confluencia es lo que sostiene el winrate.
  if (!h1Aligned) return null;

  // ---- Confluencia Fibo H4 (idea del Fibonacci 61.8 EA, sin martingala) ----
  // Detectamos el último swing H4 (últimas ~40 velas) y comprobamos si el
  // 0.618 H4 cae cerca del 0.5-0.786 H1 (misma dirección del bias). Cuando
  // hay confluencia MTF la probabilidad histórica del rebote sube.
  let h4Confluence = false;
  const h4Window = h4.slice(-40);
  const h4Swings = detectSwings(h4Window, 2);
  const h4High = [...h4Swings].reverse().find((s) => s.type === "high");
  const h4Low = [...h4Swings].reverse().find((s) => s.type === "low");
  if (h4High && h4Low) {
    const h4Range = h4High.price - h4Low.price;
    if (h4Range > 0) {
      const h4_618 = bias === "long" ? h4High.price - h4Range * 0.618 : h4Low.price + h4Range * 0.618;
      // Confluencia si el 0.618 H4 está dentro de la zona Fibo H1.
      h4Confluence = h4_618 >= Math.min(zoneBot, zoneTop) && h4_618 <= Math.max(zoneBot, zoneTop);
    }
  }

  // ---- Scoring (mismos slots que el motor SMC para reusar features IA) ----
  const breakdown = {
    h4Trend: 20,
    h1Sweep: 20,                     // slot: swing H1 identificado
    m15Fvg: 15,                      // slot: zona Fibo tocada en M15
    m15Bos: bosOk ? 15 : 5,
    killzone: inKz ? 12 : 0,
    atr: atrRatio >= 1 ? 10 : atrRatio >= 0.85 ? 7 : 4,
    // H1 ya es obligatoria (3) + bonus fuerte por confluencia Fibo H4 (4).
    h1Alignment: 3 + (h4Confluence ? 4 : 0),
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TPs ----
  const entry = lastM5.close;
  // SL: pasado 0.786 con buffer ATR M5 (SL más ceñido → mejor R:R en scalping).
  const buffer = Math.max(lastAtr * 0.5, (lastM5.high - lastM5.low) * 0.4);
  const sl = bias === "long" ? lvl786 - buffer : lvl786 + buffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + risk : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  const confidence: "high" | "medium" = breakdown.total >= 82 ? "high" : "medium";

  // Features ricos (art. 764109/21890/20160): opcional para el clasificador IA.
  const rich = buildFiboFeatures({
    h4, h1, m15, bias,
    lvl500, lvl618, lvl786,
    highPrice, lowPrice,
    breakdown,
  });

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
    features: rich.features,
    featureNames: rich.names,
    reasoning: {
      h4Trend: `H4 ${bias === "long" ? "alcista" : "bajista"} (EMA20 vs EMA50)`,
      h1Liquidity: `Swing H1 ${lowPrice.toFixed(2)} → ${highPrice.toFixed(2)} (rango ${range.toFixed(2)})`,
      m15Confirmation: `Cierre M5 en zona Fibo 0.5-0.786 (0.618 ≈ ${lvl618.toFixed(2)})${bosOk ? " + BOS20" : ""}`,
      notes: [
        `Zona: ${zoneBot.toFixed(2)} - ${zoneTop.toFixed(2)}`,
        `Killzone Londres: ${inKz ? "sí" : "fuera (UTC " + hUTC + ")"}`,
        `ATR M5 vs mediana: ${(atrRatio * 100).toFixed(0)}%`,
        `H1 EMAs ${h1Aligned ? "alineadas" : "no alineadas"}`,
        `Confluencia Fibo H4: ${h4Confluence ? "sí (0.618 H4 dentro de zona H1)" : "no"}`,
        `Score: ${breakdown.total}/100`,
      ],
    },
    // Gestión heredada del Fibonacci 61.8 EA, adaptada sin grid:
    // BE temprano en 0.8R, cierre por tiempo si no llega a TP1 en 24 M5 (~2h)
    // y trailing escalonado tras 1R en pasos de 0.5·ATR(M5). El daily target
    // se configura al invocar el backtest / EA (2.0R / -2.0R por defecto).
    // Gestión optimizada: BE más temprano protege el capital antes de la
    // reversión típica de scalping M5, time-stop más corto libera el runner
    // y el trailing arranca antes con pasos más finos.
    management: {
      breakEvenAtR: 0.6,
      timeStopBars: 20,
      trailAfterR: 0.8,
      trailStepAtrMult: 0.4,
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }