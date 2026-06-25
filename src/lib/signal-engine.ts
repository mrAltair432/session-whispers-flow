import { ema, detectFVGs, detectRecentSweep, detectSwings, detectTrend, type Candle } from "./analysis";

export type Signal = {
  bias: "long" | "short";
  confidence: "high" | "medium";
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
} | null;

export function generateSignal(h4: Candle[], h1: Candle[], m15: Candle[]): Signal {
  if (h4.length < 50 || h1.length < 50 || m15.length < 20) return null;

  const h4Trend = detectTrend(h4);
  if (h4Trend === "ranging") return null;

  const h1Swings = detectSwings(h1, 2);
  const sweep = detectRecentSweep(h1, h1Swings);
  if (!sweep) return null;

  // Sweep debe ser contrario al bias para validar entrada (toman liquidez antes de mover)
  const expectedSweepType = h4Trend === "bullish" ? "low" : "high";
  if (sweep.type !== expectedSweepType) return null;

  const fvgs = detectFVGs(m15, 20);
  const targetBias = h4Trend === "bullish" ? "bullish" : "bearish";
  const validFvg = fvgs.reverse().find((f) => f.bias === targetBias);
  if (!validFvg) return null;

  const lastM15 = m15[m15.length - 1];
  const closes15 = m15.map((c) => c.close);
  const e20_15 = ema(closes15, 20);
  const lastEma = e20_15[e20_15.length - 1];

  // Confirmación: vela M15 cerró a favor del bias y por encima/debajo de EMA20
  const m15Bullish = lastM15.close > lastM15.open && lastM15.close > lastEma;
  const m15Bearish = lastM15.close < lastM15.open && lastM15.close < lastEma;

  if (h4Trend === "bullish" && !m15Bullish) return null;
  if (h4Trend === "bearish" && !m15Bearish) return null;

  const bias: "long" | "short" = h4Trend === "bullish" ? "long" : "short";
  const entry = lastM15.close;

  // SL: detrás del sweep + buffer
  const buffer = (lastM15.high - lastM15.low) * 0.5;
  const stopLoss = bias === "long" ? sweep.sweptPrice - buffer : sweep.sweptPrice + buffer;

  const risk = Math.abs(entry - stopLoss);
  const tp1 = bias === "long" ? entry + risk : entry - risk;
  const tp2 = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = bias === "long" ? entry + risk * 3 : entry - risk * 3;

  // Confianza: alta si EMA20 y EMA50 en H1 también alineadas
  const e1h_20 = ema(h1.map((c) => c.close), 20);
  const e1h_50 = ema(h1.map((c) => c.close), 50);
  const h1Aligned = bias === "long"
    ? e1h_20[e1h_20.length - 1] > e1h_50[e1h_50.length - 1]
    : e1h_20[e1h_20.length - 1] < e1h_50[e1h_50.length - 1];

  const confidence: "high" | "medium" = h1Aligned ? "high" : "medium";

  return {
    bias,
    confidence,
    entry: round(entry),
    stopLoss: round(stopLoss),
    tp1: round(tp1),
    tp2: round(tp2),
    tp3: round(tp3),
    reasoning: {
      h4Trend: `H4 ${h4Trend === "bullish" ? "alcista" : "bajista"} (EMA20 vs EMA50)`,
      h1Liquidity: `Liquidez ${sweep.type === "high" ? "superior" : "inferior"} barrida en ${sweep.sweptPrice.toFixed(2)}`,
      m15Confirmation: `M15 cerró ${bias === "long" ? "alcista sobre" : "bajista bajo"} EMA20`,
      notes: [
        `FVG ${validFvg.bias} válida entre ${validFvg.bottom.toFixed(2)} y ${validFvg.top.toFixed(2)}`,
        `H1 EMAs ${h1Aligned ? "alineadas" : "no alineadas"} con el bias`,
      ],
    },
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }