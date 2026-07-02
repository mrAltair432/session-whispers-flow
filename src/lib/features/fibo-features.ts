// Features ricos para Fibo Scalping.
// Inspirados en los artículos MQL5 764109 (touch type, SR strength, MTF
// confluence, volatility state), 21890 (fibo level state machine),
// 20160 (swing timing) y 18078 (scaling robusto para oro).
//
// Este módulo es SOLO para el motor Fibo. No toca E1/E2.
import { ema, atr, detectSwings, type Candle } from "../analysis";

export type FiboFeaturePack = {
  features: number[];
  names: readonly string[];
};

export const FIBO_FEATURE_NAMES = [
  // Score breakdown (8)
  "f_h4Trend", "f_h1Sweep", "f_m15Fvg", "f_m15Bos",
  "f_killzone", "f_atrScore", "f_h1Align", "f_totalScore",
  // Bias + tiempo cíclico
  "biasLong",
  "hourSin", "hourCos", "weekdaySin", "weekdayCos",
  // Fibo level state (one-hot, 4)  ← art. 21890
  "state_approach", "state_touch", "state_breakout", "state_reversal",
  // Touch type (one-hot, 3)        ← art. 764109
  "touch_bounce", "touch_break", "touch_falseBreak",
  // Contexto Fibo
  "srStrength",              // # toques recientes al nivel 0.618
  "mtfConfluence",           // 1 si Fibo H1 alineado con EMA20 H4
  "distTo618Atr",            // (close - lvl618) / ATR
  "distToEma50Atr",          // (close - EMA50 M15) / ATR
  // Volatilidad y timing
  "atrRatio",                // ATR actual / mediana 80
  "volState_dead", "volState_normal", "volState_high",
  "swingAgeBars",            // barras M15 desde el último swing (normalizado /50)
  // Sesión
  "sessionLondon", "sessionNY", "sessionOverlap",
] as const;

export type FiboContext = {
  h4: Candle[];
  h1: Candle[];
  m15: Candle[];
  bias: "long" | "short";
  lvl500: number;
  lvl618: number;
  lvl786: number;
  highPrice: number;
  lowPrice: number;
  breakdown: { h4Trend: number; h1Sweep: number; m15Fvg: number; m15Bos: number; killzone: number; atr: number; h1Alignment: number; total: number };
};

function oneHot4(idx: 0 | 1 | 2 | 3) {
  const v = [0, 0, 0, 0];
  v[idx] = 1;
  return v;
}
function oneHot3(idx: 0 | 1 | 2) {
  const v = [0, 0, 0];
  v[idx] = 1;
  return v;
}

// Detecta estado del precio respecto al nivel 0.618 usando las últimas 6 M15.
// approach: acercándose sin tocar. touch: tocó y sigue cerca. breakout: cruzó
// con cierre firme. reversal: cruzó y volvió (falla del breakout).
function detectLevelState(m15: Candle[], lvl: number, bias: "long" | "short", atrVal: number): 0 | 1 | 2 | 3 {
  const recent = m15.slice(-6);
  const last = recent[recent.length - 1];
  const tol = Math.max(atrVal * 0.15, (last.high - last.low) * 0.3);

  const touchedIdx = recent.findIndex((c) => c.low - tol <= lvl && c.high + tol >= lvl);
  const closedThrough = bias === "long" ? last.close > lvl + tol : last.close < lvl - tol;
  const camePast = recent.some((c) => (bias === "long" ? c.high > lvl + tol : c.low < lvl - tol));
  const cameBack = closedThrough === false && camePast;

  if (touchedIdx === -1 && !camePast) return 0; // approach
  if (touchedIdx !== -1 && !closedThrough && !cameBack) return 1; // touch
  if (closedThrough) return 2; // breakout
  return 3; // reversal (cruzó y volvió)
}

// Touch type: rebote clásico, ruptura limpia, o falso quiebre.
// Se mide con la última vela + la penúltima.
function detectTouchType(m15: Candle[], lvl: number, bias: "long" | "short"): 0 | 1 | 2 {
  if (m15.length < 2) return 0;
  const last = m15[m15.length - 1];
  const prev = m15[m15.length - 2];
  const range = last.high - last.low || 1e-9;
  // Falso quiebre: mecha cruzó pero cierre volvió al lado opuesto
  if (bias === "long") {
    const wickBroke = last.low < lvl && last.close > lvl;
    const bodyRatio = (last.close - Math.min(last.open, last.close)) / range;
    if (wickBroke && bodyRatio > 0.3) return 2; // falseBreak / rechazo
    if (last.close > lvl && prev.close < lvl) return 1; // break neto
    return 0; // bounce (nunca cerró debajo)
  } else {
    const wickBroke = last.high > lvl && last.close < lvl;
    const bodyRatio = (Math.max(last.open, last.close) - last.close) / range;
    if (wickBroke && bodyRatio > 0.3) return 2;
    if (last.close < lvl && prev.close > lvl) return 1;
    return 0;
  }
}

// SR strength = cuántas velas M15 (últimas 60) tocaron el nivel 0.618.
// Escalado a [0,1] dividiendo por 10 (más de 10 toques = nivel muy visitado).
function computeSrStrength(m15: Candle[], lvl: number, atrVal: number): number {
  const window = m15.slice(-60);
  const tol = atrVal * 0.2;
  let n = 0;
  for (const c of window) if (c.low - tol <= lvl && c.high + tol >= lvl) n++;
  return Math.min(n / 10, 1);
}

// MTF confluence: ¿el nivel 0.618 cae cerca de la EMA20 H4 o del último swing H1?
function computeMtfConfluence(h4: Candle[], h1: Candle[], lvl618: number, atrVal: number): number {
  const h4Ema = ema(h4.map((c) => c.close), 20);
  const h4Val = h4Ema[h4Ema.length - 1];
  const nearH4 = Math.abs(lvl618 - h4Val) < atrVal * 3;
  const h1Swings = detectSwings(h1.slice(-40), 2);
  const nearH1Swing = h1Swings.some((s) => Math.abs(s.price - lvl618) < atrVal * 2);
  const score = (nearH4 ? 0.6 : 0) + (nearH1Swing ? 0.4 : 0);
  return score;
}

function computeSwingAgeBars(m15: Candle[]): number {
  const window = m15.slice(-50);
  const swings = detectSwings(window, 2);
  if (!swings.length) return 1; // muy viejo
  const last = swings[swings.length - 1];
  const barsAgo = window.length - 1 - last.index;
  return Math.min(barsAgo / 50, 1);
}

export function buildFiboFeatures(ctx: FiboContext): FiboFeaturePack {
  const { h4, h1, m15, bias, lvl618, breakdown } = ctx;
  const last = m15[m15.length - 1];
  const atrArr = atr(m15, 14);
  const atrVal = atrArr[atrArr.length - 1] || 1;
  const atrHist = atrArr.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median = atrHist.length ? atrHist[Math.floor(atrHist.length / 2)] : atrVal;
  const atrRatio = median > 0 ? atrVal / median : 1;
  const volState =
    atrRatio < 0.7 ? "dead" : atrRatio > 1.4 ? "high" : "normal";

  const closes15 = m15.map((c) => c.close);
  const ema50 = ema(closes15, 50);
  const ema50Val = ema50[ema50.length - 1];

  const levelState = detectLevelState(m15, lvl618, bias, atrVal);
  const touchType = detectTouchType(m15, lvl618, bias);
  const srStrength = computeSrStrength(m15, lvl618, atrVal);
  const mtfConfluence = computeMtfConfluence(h4, h1, lvl618, atrVal);
  const swingAge = computeSwingAgeBars(m15);

  const d = new Date(last.time * 1000);
  const hourUTC = d.getUTCHours();
  const weekday = d.getUTCDay();
  const twoPi = Math.PI * 2;
  const sessionLondon = hourUTC >= 7 && hourUTC < 16 ? 1 : 0;
  const sessionNY = hourUTC >= 12 && hourUTC < 21 ? 1 : 0;
  const sessionOverlap = hourUTC >= 12 && hourUTC < 16 ? 1 : 0;

  const features = [
    breakdown.h4Trend / 20,
    breakdown.h1Sweep / 25,
    breakdown.m15Fvg / 20,
    breakdown.m15Bos / 15,
    breakdown.killzone / 12,
    breakdown.atr / 10,
    breakdown.h1Alignment / 5,
    breakdown.total / 100,
    bias === "long" ? 1 : 0,
    Math.sin((twoPi * hourUTC) / 24),
    Math.cos((twoPi * hourUTC) / 24),
    Math.sin((twoPi * weekday) / 7),
    Math.cos((twoPi * weekday) / 7),
    ...oneHot4(levelState),
    ...oneHot3(touchType),
    srStrength,
    mtfConfluence,
    (last.close - lvl618) / atrVal,
    (last.close - ema50Val) / atrVal,
    Math.min(atrRatio, 3) / 3,
    volState === "dead" ? 1 : 0,
    volState === "normal" ? 1 : 0,
    volState === "high" ? 1 : 0,
    swingAge,
    sessionLondon,
    sessionNY,
    sessionOverlap,
  ];

  return { features, names: FIBO_FEATURE_NAMES };
}