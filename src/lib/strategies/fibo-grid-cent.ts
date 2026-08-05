import { ema, atr, rsi, detectSwings, type Candle } from "../analysis";
import type { GridOrder, Signal } from "../signal-engine";

// Estrategia 7: Fibo 61.8 Cent (réplica optimizada del "Fibonacci 61.8 EA")
// ------------------------------------------------------------------------
// El EA original (MQL5 market 178321) es un grid/martingala que rellena hasta
// ~100 órdenes pendientes escalonadas a favor de la tendencia, con SL global
// del 20 % de la cuenta y TP global del 5 %. Su curva de equity es bonita
// hasta que llega el drawdown de 24 % (ver reporte: 19.237 trades, PF 2.80,
// equity DD 24.29 %). Aquí replicamos su MOTOR de señales:
//   - Fibo 61.8 % del último swing significativo.
//   - RSI(14) con banda 35/75 (compra sólo si RSI>35 y <75).
//   - AO (Awesome Oscillator 5/34 sobre precio medio) a favor del sesgo.
//   - Régimen ATR: ATR bajo/medio/alto → tamaño del grid (menos órdenes con
//     volatilidad alta, cero órdenes nuevas por encima del umbral alto).
//   - MA(15m) como filtro de dirección (Moving_average_timeframe = 15 Min).
// ...y lo mejoramos:
//   - SL real por operación (no sólo SL global de cuenta) en el 78.6 %.
//   - Grid FINITO y acotado (maxOrders, spacing en ATR) sin martingala:
//     todos los niveles usan el mismo lote base.
//   - Caducidad de pendientes (min_close_order_* del original) → expireMinutes.
//   - Guardrails diarios en R en vez de % de cuenta.
//
// Pensada para cuenta CENT de pruebas: por defecto está DESACTIVADA.
export type FiboGridParams = {
  minScore?: number;
  fiboLevel?: number;        // nivel de entrada (0.618 por defecto)
  maxOrders?: number;        // nº máximo de pendientes del grid (original: ~100)
  gridStepAtr?: number;      // separación entre pendientes en múltiplos de ATR(M15)
  // Régimen de volatilidad RELATIVO (ratio ATR actual / mediana de 200 barras).
  // El .set original usaba USD absolutos (2.5 / 4.5) calibrados para el oro a
  // ~1.800 USD; con el oro sobre 3.500 ese umbral bloquea el 80 % de las barras.
  atrMediumRatio?: number;   // a partir de aquí reducimos el grid a la mitad
  atrBlockRatio?: number;    // a partir de aquí no abrimos nada
  rsiLow?: number;
  rsiHigh?: number;
  expireMinutes?: number;    // caducidad de las pendientes
  dailyTargetR?: number;
  dailyLossLimitR?: number;
  // --- Réplica 1:1 del comportamiento del EA original ---
  slAtrMult?: number;        // SL "holgado" (equivale al SL_Percent=20 % de equity)
  tpAtrMult?: number;        // TP corto (equivale al TP_Percent=5 % de equity)
  longBias?: number;         // proporción buy/sell del grid (set: 60 buy / 20 sell = 3)
  requireAo?: boolean;       // si false, el AO sólo puntúa (el EA no bloquea por AO)
};

function sma(vals: number[], p: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < vals.length; i++) {
    acc += vals[i];
    if (i >= p) acc -= vals[i - p];
    out.push(i >= p - 1 ? acc / p : NaN);
  }
  return out;
}

// Awesome Oscillator (Bill Williams): SMA5(median) - SMA34(median)
function awesome(candles: Candle[]): number[] {
  const med = candles.map((c) => (c.high + c.low) / 2);
  const f = sma(med, 5);
  const s = sma(med, 34);
  return med.map((_, i) => f[i] - s[i]);
}

export function evaluateFiboGridCent(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  m1: Candle[] | undefined,
  params: FiboGridParams = {},
): Signal {
  const minScore = params.minScore ?? 45;
  const fiboLevel = params.fiboLevel ?? 0.618;
  const maxOrders = params.maxOrders ?? 30;
  const gridStepAtr = params.gridStepAtr ?? 1.6;
  const atrMediumRatio = params.atrMediumRatio ?? 1.3;
  const atrBlockRatio = params.atrBlockRatio ?? 2.4;
  const rsiLow = params.rsiLow ?? 35;
  const rsiHigh = params.rsiHigh ?? 75;
  const expireMinutes = params.expireMinutes ?? 66;
  const dailyTargetR = params.dailyTargetR ?? 3;
  const dailyLossLimitR = params.dailyLossLimitR ?? 2;
  const slAtrMult = params.slAtrMult ?? 3;
  const tpAtrMult = params.tpAtrMult ?? 1.2;
  const longBias = params.longBias ?? 3;
  const requireAo = params.requireAo ?? false;

  if (h4.length < 50 || h1.length < 40 || m15.length < 60) return null;

  // ---- Sesgo: EMA20/EMA50 H4 + MA(15m) como el EA original ----
  // El EA original opera 24 h y NO exige tendencia fuerte: sólo dirección.
  const h4Closes = h4.map((c) => c.close);
  const e20h4 = ema(h4Closes, 20);
  const e50h4 = ema(h4Closes, 50);
  const diffH4 = (e20h4[e20h4.length - 1] - e50h4[e50h4.length - 1]) / e50h4[e50h4.length - 1];
  const bias: "long" | "short" = diffH4 >= 0 ? "long" : "short";

  const closes15 = m15.map((c) => c.close);
  const ma15 = ema(closes15, 50);
  // El precio de referencia es la última vela del TF de disparo (M1 si está
  // disponible): el EA re-evalúa y recoloca las pendientes cada minuto.
  const last = m1 && m1.length ? m1[m1.length - 1] : m15[m15.length - 1];
  const maVal = ma15[ma15.length - 1];
  const maOk = bias === "long" ? last.close > maVal : last.close < maVal;

  // ---- Swing H1 y niveles Fibo ----
  const swings = detectSwings(h1.slice(-40), 2);
  const lastHigh = [...swings].reverse().find((s) => s.type === "high");
  const lastLow = [...swings].reverse().find((s) => s.type === "low");
  if (!lastHigh || !lastLow) return null;
  const highPrice = lastHigh.price;
  const lowPrice = lastLow.price;
  const range = highPrice - lowPrice;
  if (range <= 0) return null;

  const lvlEntry = bias === "long" ? highPrice - range * fiboLevel : lowPrice + range * fiboLevel;
  const lvl786 = bias === "long" ? highPrice - range * 0.786 : lowPrice + range * 0.786;
  const lvl500 = bias === "long" ? highPrice - range * 0.5 : lowPrice + range * 0.5;

  // El EA re-mide el fibo constantemente y siembra pendientes por encima y por
  // debajo (limit + stop), así que no exigimos estar dentro de la zona: la zona
  // 0.5-0.786 sólo puntúa.
  const zoneTop = Math.max(lvl500, lvl786);
  const zoneBot = Math.min(lvl500, lvl786);
  const recent = m1 && m1.length >= 60 ? m1.slice(-90) : m15.slice(-12);
  const inZone = recent.some((c) => c.low <= zoneTop && c.high >= zoneBot);

  // ---- RSI 35/75 (misma lógica del EA: evita comprar en el pico) ----
  const r = rsi(m15, 14);
  const rVal = r[r.length - 1];
  if (!Number.isFinite(rVal)) return null;
  const rsiOk = bias === "long" ? rVal > rsiLow && rVal < rsiHigh : rVal < 100 - rsiLow && rVal > 100 - rsiHigh;
  if (!rsiOk) return null;

  // ---- Awesome Oscillator a favor ----
  const ao = awesome(m15);
  const aoVal = ao[ao.length - 1];
  const aoPrev = ao[ao.length - 2];
  const aoOk = bias === "long" ? aoVal > aoPrev : aoVal < aoPrev;
  if (requireAo && !aoOk) return null;

  // ---- Régimen ATR relativo (equivalente a ATR_low/medium_risk del EA) ----
  const atr15 = atr(m15, 14);
  const atrVal = atr15[atr15.length - 1] || 1;
  const hist = atr15.slice(-200).filter((v) => v > 0).sort((a, b) => a - b);
  const atrMedian = hist.length ? hist[Math.floor(hist.length / 2)] : atrVal;
  const atrRatio = atrMedian > 0 ? atrVal / atrMedian : 1;
  if (atrRatio >= atrBlockRatio) return null;              // volatilidad extrema
  const volFactor = atrRatio >= atrMediumRatio ? 0.5 : 1;  // vol media → medio grid
  const gridOrders = Math.max(4, Math.round(maxOrders * volFactor));

  // ---- Score ----
  const breakdown = {
    h4Trend: Math.abs(diffH4) >= 0.0005 ? 20 : 12,
    h1Sweep: 18,                       // slot: swing H1 válido
    m15Fvg: inZone ? 15 : 6,           // slot: zona Fibo tocada
    m15Bos: maOk ? 12 : 4,
    killzone: 8,                       // el EA opera 24 h; sesgo horario suave
    atr: volFactor === 1 ? 10 : 6,
    h1Alignment: aoOk ? 5 : 0,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;
  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TP (perfil del EA original) ----
  // SL_Percent=20 % vs TP_Percent=5 % ⇒ stop MUY holgado y objetivo corto:
  // muchas ganancias pequeñas, pérdidas raras y grandes. Aquí lo traducimos a
  // múltiplos de ATR(M15) para que el precio "respire".
  const entry = last.close;
  const slDist = atrVal * slAtrMult;
  const tpDist = atrVal * tpAtrMult;
  const sl = bias === "long" ? entry - slDist : entry + slDist;
  const risk = slDist;
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + tpDist : entry - tpDist;
  const tp2 = bias === "long" ? entry + tpDist * 1.5 : entry - tpDist * 1.5;
  const tp3 = bias === "long" ? entry + tpDist * 2 : entry - tpDist * 2;

  // ---- Grid: mezcla de limit (a favor del retroceso) y stop (a favor del
  // impulso), sesgado al lado del bias igual que el .set original
  // (30+30 buy vs 10+10 sell = 3:1). El EA los borra y recoloca cada minuto.
  const gridStep = atrVal * gridStepAtr;
  const proBias = Math.max(2, Math.round((gridOrders * longBias) / (longBias + 1)));
  const counterBias = Math.max(1, gridOrders - proBias);
  const limits: number[] = [];
  const stops: number[] = [];
  for (let i = 1; i <= Math.ceil(proBias / 2); i++) {
    limits.push(round(bias === "long" ? entry - gridStep * i : entry + gridStep * i));
    stops.push(round(bias === "long" ? entry + gridStep * i : entry - gridStep * i));
  }
  const counterLevels: number[] = [];
  for (let i = 1; i <= Math.ceil(counterBias / 2); i++) {
    counterLevels.push(round(bias === "long" ? entry + gridStep * i : entry - gridStep * i));
  }
  // Cesto real que ejecutará el simulador: mismas pendientes que el EA
  // original (LIMIT a favor del retroceso, STOP a favor del impulso y
  // cobertura contraria), todas con el mismo lote y SL/TP individuales.
  const counterSide: "long" | "short" = bias === "long" ? "short" : "long";
  const gridOrdersPlan: GridOrder[] = [
    ...limits.map((p): GridOrder => ({ price: p, side: bias, kind: "limit" })),
    ...stops.map((p): GridOrder => ({ price: p, side: bias, kind: "stop" })),
    ...counterLevels.map((p): GridOrder => ({
      price: p,
      side: counterSide,
      // para el lado contrario, un precio por encima (long bias) es un SELL LIMIT
      kind: "limit",
    })),
  ];

  const confidence: "high" | "medium" = breakdown.total >= 80 && aoOk ? "high" : "medium";

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
      h4Trend: `H4 ${bias === "long" ? "alcista" : "bajista"} (EMA20/50, ${(diffH4 * 100).toFixed(2)}%)`,
      h1Liquidity: `Swing H1 ${lowPrice.toFixed(2)} → ${highPrice.toFixed(2)} · Fibo ${(fiboLevel * 100).toFixed(1)}% ≈ ${lvlEntry.toFixed(2)}`,
      m15Confirmation: `RSI ${rVal.toFixed(1)} en banda ${rsiLow}/${rsiHigh}, AO ${aoOk ? "a favor" : "plano"}, MA15 ${maOk ? "ok" : "en contra"}`,
      notes: [
        `Zona Fibo 0.5-0.786: ${zoneBot.toFixed(2)} - ${zoneTop.toFixed(2)} ${inZone ? "(tocada)" : "(no tocada, sólo puntúa)"}`,
        `ATR M15: ${atrVal.toFixed(2)} USD · régimen ${(atrRatio * 100).toFixed(0)}% de la mediana (medio≥${atrMediumRatio} / bloqueo≥${atrBlockRatio})`,
        `SL holgado ${slAtrMult}×ATR = ${slDist.toFixed(2)} USD · TP corto ${tpAtrMult}×ATR = ${tpDist.toFixed(2)} USD (≈${(tpDist / slDist).toFixed(2)}R, perfil 20 %/5 % del EA)`,
        `Grid ${gridOrders} niveles cada ${gridStep.toFixed(2)} USD, mismo lote (sin martingala) · sesgo ${longBias}:1 a favor`,
        `Pendientes ${bias === "long" ? "BUY" : "SELL"} LIMIT: ${limits.map((g) => g.toFixed(2)).join(", ") || "—"}`,
        `Pendientes ${bias === "long" ? "BUY" : "SELL"} STOP: ${stops.map((g) => g.toFixed(2)).join(", ") || "—"}`,
        `Cobertura contraria: ${counterLevels.map((g) => g.toFixed(2)).join(", ") || "—"}`,
        `Se recalculan y recolocan en cada barra · caducan a ${expireMinutes} min · guardrails ±${dailyTargetR}R/-${dailyLossLimitR}R`,
        `Score: ${breakdown.total}/100`,
      ],
    },
    management: {
      // Deja respirar: BE tardío y sin cierre por tiempo agresivo. En M1 el
      // time-stop equivale a ~24 h de mercado.
      breakEvenAtR: 0.35,
      timeStopBars: m1 && m1.length ? 1440 : 96,
      trailAfterR: 0.2,
      trailStepAtrMult: 8,
    },
    grid: {
      orders: gridOrdersPlan,
      slDist,
      tpDist,
      expireBars: m1 && m1.length ? expireMinutes : Math.max(4, Math.round(expireMinutes / 15)),
      maxOpenPositions: gridOrders,
      includeMarketEntry: true,
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }
