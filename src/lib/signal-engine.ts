import {
  ema, atr, detectFVGs, detectRecentSweep, detectSwings, detectTrend, detectBOS, getKillzone,
  type Candle,
} from "./analysis";

export type SignalProfile = "full" | "h1m15" | "m15";

export type ScoreBreakdown = {
  h4Trend: number;     // /20
  h1Sweep: number;     // /25
  m15Fvg: number;      // /20
  m15Bos: number;      // /10
  killzone: number;    // /10
  atr: number;         // /10
  h1Alignment: number; // /5
  total: number;       // /100
};

export type Signal = {
  bias: "long" | "short";
  confidence: "high" | "medium";
  score: number;
  scoreBreakdown: ScoreBreakdown;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  reasoning: {
    h4Trend: string;
    h1Liquidity: string;
    m15Confirmation: string;
    notes: string[];
  };
  // Opcional: vector de features "rico" precomputado por la estrategia.
  // Si está presente, el backtest lo usa en vez del buildFeatures genérico.
  features?: number[];
  featureNames?: readonly string[];
  // Reglas de gestión opcionales que el simulador (y el EA MT5) deben
  // respetar además de SL/TP. Emitidas por la estrategia cuando quiere
  // break-even temprano o cierre por tiempo.
  management?: {
    breakEvenAtR?: number;   // mueve SL a entry cuando r no realizado >= N*R
    timeStopBars?: number;   // cierra a mercado tras N barras del trigger TF sin TP1
    // Trailing escalonado (idea portada del Fibonacci 61.8 EA, sin grid):
    // una vez que el MFE alcanza `trailAfterR` * R, el SL se arrastra por
    // pasos discretos de `trailStepAtrMult` * ATR(triggerTF, 14). Solo el
    // simulador y el EA MT5 lo usan; el engine solo declara la intención.
    trailAfterR?: number;
    trailStepAtrMult?: number;
  };
} | null;

export type EngineOptions = {
  profile?: SignalProfile;   // controls which filters apply
  minScore?: number;         // default 70
};

export function generateSignal(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  opts: EngineOptions = {},
): Signal {
  const profile: SignalProfile = opts.profile ?? "full";
  const minScore = opts.minScore ?? 70;

  if (m15.length < 25) return null;
  if (profile !== "m15" && h1.length < 50) return null;
  if (profile === "full" && h4.length < 50) return null;

  const lastM15 = m15[m15.length - 1];
  const closes15 = m15.map((c) => c.close);
  const e20_15 = ema(closes15, 20);
  const lastEma15 = e20_15[e20_15.length - 1];

  // ---- Step 1: H4 trend (or fall back to M15 EMA20/50 when profile excludes H4) ----
  let h4Trend: "bullish" | "bearish" | "ranging";
  if (profile === "full") {
    h4Trend = detectTrend(h4);
  } else {
    // Use a stricter M15-only proxy (EMA20 vs EMA50 + slope) when no H4 context
    const e50_15 = ema(closes15, 50);
    const diff = (lastEma15 - e50_15[e50_15.length - 1]) / e50_15[e50_15.length - 1];
    h4Trend = diff > 0.0005 ? "bullish" : diff < -0.0005 ? "bearish" : "ranging";
  }
  if (h4Trend === "ranging") return null;
  const bias: "long" | "short" = h4Trend === "bullish" ? "long" : "short";

  // ---- Step 2: H1 liquidity sweep (skip in m15-only profile) ----
  let sweep: ReturnType<typeof detectRecentSweep> = null;
  if (profile !== "m15") {
    const h1Swings = detectSwings(h1, 2);
    sweep = detectRecentSweep(h1, h1Swings);
    if (!sweep) return null;
    const expectedSweepType = bias === "long" ? "low" : "high";
    if (sweep.type !== expectedSweepType) return null;
  }

  // ---- Step 3: M15 FVG aligned with bias ----
  const fvgs = detectFVGs(m15, 20);
  const targetBias = bias === "long" ? "bullish" : "bearish";
  const validFvg = [...fvgs].reverse().find((f) => f.bias === targetBias);
  if (!validFvg) return null;

  // ---- Step 4: M15 candle confirmation + BOS ----
  const m15Confirm =
    bias === "long"
      ? lastM15.close > lastM15.open && lastM15.close > lastEma15
      : lastM15.close < lastM15.open && lastM15.close < lastEma15;
  if (!m15Confirm) return null;
  const bosOk = detectBOS(m15, bias, 20);

  // ---- Step 5: filters (killzone + ATR regime) ----
  const kz = getKillzone(lastM15.time);
  const atrSeries = atr(m15, 14);
  const lastAtr = atrSeries[atrSeries.length - 1];
  // ATR baseline = median of the last 80 non-zero ATR values
  const recentAtr = atrSeries.slice(-80).filter((v) => v > 0).sort((a, b) => a - b);
  const median = recentAtr.length ? recentAtr[Math.floor(recentAtr.length / 2)] : lastAtr;
  const atrRatio = median > 0 ? lastAtr / median : 1;
  // Reject dead markets in full profile
  if (profile === "full" && atrRatio < 0.6) return null;

  // ---- Step 6: H1 EMA alignment ----
  let h1Aligned = false;
  if (h1.length >= 50) {
    const e1h_20 = ema(h1.map((c) => c.close), 20);
    const e1h_50 = ema(h1.map((c) => c.close), 50);
    h1Aligned =
      bias === "long"
        ? e1h_20[e1h_20.length - 1] > e1h_50[e1h_50.length - 1]
        : e1h_20[e1h_20.length - 1] < e1h_50[e1h_50.length - 1];
  }

  // ---- Scoring ----
  const breakdown: ScoreBreakdown = {
    h4Trend: profile === "full" ? 20 : 12, // partial when no H4
    h1Sweep: profile === "m15" ? 0 : 25,
    m15Fvg: 20,
    m15Bos: bosOk ? 10 : 0,
    killzone: kz ? 10 : 3,
    atr: atrRatio >= 1 ? 10 : atrRatio >= 0.8 ? 6 : atrRatio >= 0.6 ? 3 : 0,
    h1Alignment: h1Aligned ? 5 : 0,
    total: 0,
  };
  breakdown.total =
    breakdown.h4Trend + breakdown.h1Sweep + breakdown.m15Fvg + breakdown.m15Bos +
    breakdown.killzone + breakdown.atr + breakdown.h1Alignment;

  if (breakdown.total < minScore) return null;

  // ---- Entry / SL / TPs ----
  const entry = lastM15.close;
  const buffer = Math.max((lastM15.high - lastM15.low) * 0.5, lastAtr * 0.3);
  const slAnchor = sweep
    ? sweep.sweptPrice
    : bias === "long" ? Math.min(...m15.slice(-10).map((c) => c.low))
                       : Math.max(...m15.slice(-10).map((c) => c.high));
  const stopLoss = bias === "long" ? slAnchor - buffer : slAnchor + buffer;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;
  const tp1 = bias === "long" ? entry + risk : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  const confidence: "high" | "medium" = breakdown.total >= 85 ? "high" : "medium";

  return {
    bias,
    confidence,
    score: breakdown.total,
    scoreBreakdown: breakdown,
    entry: round(entry),
    stopLoss: round(stopLoss),
    tp1: round(tp1),
    tp2: round(tp2),
    tp3: round(tp3),
    reasoning: {
      h4Trend:
        profile === "full"
          ? `H4 ${h4Trend === "bullish" ? "alcista" : "bajista"} (EMA20 vs EMA50)`
          : `Tendencia ${h4Trend} derivada de M15 EMA20/50`,
      h1Liquidity: sweep
        ? `Liquidez ${sweep.type === "high" ? "superior" : "inferior"} barrida en ${sweep.sweptPrice.toFixed(2)}`
        : "Sin filtro de liquidez H1 (perfil)",
      m15Confirmation: `M15 cerró ${bias === "long" ? "alcista sobre" : "bajista bajo"} EMA20${bosOk ? " + BOS" : ""}`,
      notes: [
        `FVG ${validFvg.bias} entre ${validFvg.bottom.toFixed(2)} y ${validFvg.top.toFixed(2)}`,
        `Killzone: ${kz ?? "fuera de ventana"}`,
        `ATR vs mediana: ${(atrRatio * 100).toFixed(0)}%`,
        `H1 EMAs ${h1Aligned ? "alineadas" : "no alineadas"} con el bias`,
        `Score: ${breakdown.total}/100`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }