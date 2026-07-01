import { ema, atr, detectSwings, detectBOS, type Candle } from "../analysis";
import type { Signal } from "../signal-engine";

// Estrategia 3: Fibo Scalping (Londres)
// -----------------------------------------------
// Idea: replicar la lógica de los bots de Fibonacci del market de MT5 pero
// controlada. Sin grid abierto: el motor entrega UNA señal por swing y
// deja al bot de MT5 la gestión (en MT5 sí habrá grid limitado a 3
// posiciones con SL global; en el backtest simulamos 1 posición para
// medir el edge real del setup).
//
// - H4  : filtra sesgo (tendencia EMA20/EMA50).
// - H1  : identifica el último swing significativo. Trazamos Fibo desde
//         el swing extremo hasta el opuesto en la dirección del sesgo.
// - M15 : espera a que el precio entre en la zona 0.5-0.786 del retroceso
//         y cierre a favor (proxy de la entrada M5 del bot real).
// - Killzone Londres: UTC 07-11.
// - Restricciones: no operar domingos, viernes solo hasta UTC 12
//   (se aplican también en runBacktest vía autoTimeFilters + excludeHours;
//   aquí las reforzamos para que la señal en vivo también las respete).
// - SL: pasado el nivel 0.786 con buffer ATR M15.
// - TPs: 1R / 2R / 3R (el bot MT5 los reemplaza por niveles Fibo internos).
export function evaluateFiboScalping(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  minScore = 65,
): Signal {
  if (h4.length < 50 || h1.length < 40 || m15.length < 25) return null;

  // ---- H4 bias ----
  const h4Closes = h4.map((c) => c.close);
  const h4Ema20 = ema(h4Closes, 20);
  const h4Ema50 = ema(h4Closes, 50);
  const diffH4 = (h4Ema20[h4Ema20.length - 1] - h4Ema50[h4Ema50.length - 1]) / h4Ema50[h4Ema50.length - 1];
  if (Math.abs(diffH4) < 0.0005) return null;
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

  // ---- M15: precio debe haber tocado la zona en las últimas 6 velas ----
  const recent = m15.slice(-6);
  const touched = recent.some((c) => c.low <= zoneTop && c.high >= zoneBot);
  if (!touched) return null;

  // Confirmación en la última vela: cierre a favor del bias dentro/encima de la zona
  const lastM15 = m15[m15.length - 1];
  const closes15 = m15.map((c) => c.close);
  const e20_15 = ema(closes15, 20);
  const lastEma15 = e20_15[e20_15.length - 1];
  const m15Confirm =
    bias === "long"
      ? lastM15.close > lastM15.open && lastM15.close >= lvl618 && lastM15.close > lastEma15
      : lastM15.close < lastM15.open && lastM15.close <= lvl618 && lastM15.close < lastEma15;
  if (!m15Confirm) return null;
  const bosOk = detectBOS(m15, bias, 15);

  // ---- Killzone Londres UTC 07-11 (apertura + primeras horas) ----
  const d = new Date(lastM15.time * 1000);
  const hUTC = d.getUTCHours();
  const wd = d.getUTCDay();
  const inKz = hUTC >= 7 && hUTC < 11;
  // Restricciones adicionales para scalping en oro
  if (wd === 0) return null;                 // domingo no
  if (wd === 5 && hUTC >= 12) return null;   // viernes solo hasta mediodía UTC

  // ---- ATR check (scalping requiere volatilidad mínima) ----
  const m15Atr = atr(m15, 14);
  const lastAtr = m15Atr[m15Atr.length - 1] || 1;
  const recentAtr = m15Atr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median = recentAtr.length ? recentAtr[Math.floor(recentAtr.length / 2)] : lastAtr;
  const atrRatio = median > 0 ? lastAtr / median : 1;
  if (atrRatio < 0.7) return null; // mercado muerto → scalping no rinde

  // H1 alignment
  const h1Closes = h1.map((c) => c.close);
  const h1Ema20 = ema(h1Closes, 20);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Aligned =
    bias === "long"
      ? h1Ema20[h1Ema20.length - 1] > h1Ema50[h1Ema50.length - 1]
      : h1Ema20[h1Ema20.length - 1] < h1Ema50[h1Ema50.length - 1];

  // ---- Scoring (mismos slots que el motor SMC para reusar features IA) ----
  const breakdown = {
    h4Trend: 20,
    h1Sweep: 20,                     // reusamos slot: aquí = "swing H1 identificado"
    m15Fvg: 15,                      // reusamos slot: aquí = "confirmación en zona Fibo"
    m15Bos: bosOk ? 15 : 5,
    killzone: inKz ? 12 : 0,
    atr: atrRatio >= 1 ? 10 : atrRatio >= 0.85 ? 7 : 4,
    h1Alignment: h1Aligned ? 5 : 0,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TPs ----
  const entry = lastM15.close;
  // SL: pasado 0.786 con buffer ATR (limita pérdida por vela larga)
  const buffer = Math.max(lastAtr * 0.4, (lastM15.high - lastM15.low) * 0.4);
  const sl = bias === "long" ? lvl786 - buffer : lvl786 + buffer;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + risk : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  const confidence: "high" | "medium" = breakdown.total >= 82 ? "high" : "medium";

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
      h4Trend: `H4 ${bias === "long" ? "alcista" : "bajista"} (EMA20 vs EMA50)`,
      h1Liquidity: `Swing H1 ${lowPrice.toFixed(2)} → ${highPrice.toFixed(2)} (rango ${range.toFixed(2)})`,
      m15Confirmation: `Cierre M15 en zona Fibo 0.5-0.786 (0.618 ≈ ${lvl618.toFixed(2)})${bosOk ? " + BOS" : ""}`,
      notes: [
        `Zona: ${zoneBot.toFixed(2)} - ${zoneTop.toFixed(2)}`,
        `Killzone Londres: ${inKz ? "sí" : "fuera (UTC " + hUTC + ")"}`,
        `ATR vs mediana: ${(atrRatio * 100).toFixed(0)}%`,
        `H1 EMAs ${h1Aligned ? "alineadas" : "no alineadas"}`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }