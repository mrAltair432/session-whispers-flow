import type { Candle } from "../analysis";
import { generateSignal as smcGenerate, type Signal } from "../signal-engine";
import { evaluateHarmonics } from "./ny-continuation";
import { evaluateFiboScalping } from "./fibo-scalping";
import { evaluateGoldScalping } from "./gold-scalping";
import { evaluateEmaCrossM1 } from "./ema-cross-m1";
import { evaluateStraddleBreakout } from "./straddle-breakout";
import type { TfKey } from "../csv-parser";

export type EngineKey =
  | "smc_london"
  | "ny_continuation"
  | "fibo_scalping"
  | "gold_scalping"
  | "ema_cross_m1"
  | "straddle_breakout";

export type StrategyParams = {
  minScore?: number;
  [k: string]: unknown;
};

// Mapa de velas por timeframe. Cada estrategia declara qué TFs necesita.
export type Bars = Partial<Record<TfKey, Candle[]>>;

export type StrategyEngine = {
  key: EngineKey;
  name: string;
  shortName: string;
  description: string;
  defaultParams: StrategyParams;
  killzoneHoursUTC: number[]; // informativo
  // TF que dispara la evaluación (se itera bar por bar en el backtest y
  // define la granularidad de simulación de SL/TP).
  triggerTf: TfKey;
  // TFs que la estrategia necesita presentes (subset de M1..H4).
  requiredTfs: TfKey[];
  // Nueva API: recibe un mapa de bars ya sliced hasta el tiempo del trigger bar.
  evaluate(bars: Bars, params: StrategyParams): Signal;
};

export const STRATEGIES: Record<EngineKey, StrategyEngine> = {
  smc_london: {
    key: "smc_london",
    name: "SMC Londres (Sweep + FVG)",
    shortName: "E1 · SMC Londres",
    description:
      "Tendencia H4 + barrido de liquidez H1 + FVG y BOS en M15 dentro de la killzone de Londres (UTC 02-05).",
    defaultParams: { minScore: 70 },
    killzoneHoursUTC: [2, 3, 4],
    triggerTf: "M15",
    requiredTfs: ["H4", "H1", "M15"],
    evaluate: (bars, params) =>
      smcGenerate(bars.H4 ?? [], bars.H1 ?? [], bars.M15 ?? [], {
        profile: "full", minScore: (params.minScore as number) ?? 70,
      }),
  },
  ny_continuation: {
    key: "ny_continuation",
    name: "Patrones Armónicos XABCD (Gartley / Bat)",
    shortName: "E2 · Armónicos",
    description:
      "Detecta patrones Gartley y Bat en pivotes H1 con confirmación M15 (vela rechazo + divergencia RSI) alineados al sesgo H4. Killzones Londres/NY.",
    defaultParams: { minScore: 65 },
    killzoneHoursUTC: [7, 8, 9, 10, 12, 13, 14, 15],
    triggerTf: "M15",
    requiredTfs: ["H4", "H1", "M15"],
    evaluate: (bars, params) =>
      evaluateHarmonics(bars.H4 ?? [], bars.H1 ?? [], bars.M15 ?? [], (params.minScore as number) ?? 65),
  },
  fibo_scalping: {
    key: "fibo_scalping",
    name: "Fibo Scalping M5 Oro (Londres)",
    shortName: "E3 · Fibo Scalping M5",
    description:
      "Sesgo H4 + swing H1 + retroceso 0.5-0.786 tocado en M15, con trigger de entrada en M5 (BOS20). Solo Londres UTC 07-11, sin domingos, viernes hasta mediodía. Base directa para bot MT5.",
    defaultParams: { minScore: 65 },
    killzoneHoursUTC: [7, 8, 9, 10],
    triggerTf: "M5",
    requiredTfs: ["H4", "H1", "M15", "M5"],
    evaluate: (bars, params) =>
      evaluateFiboScalping(bars.H4 ?? [], bars.H1 ?? [], bars.M15 ?? [], bars.M5 ?? [], (params.minScore as number) ?? 65),
  },
  gold_scalping: {
    key: "gold_scalping",
    name: "VWAP Mean Reversion Oro (M1)",
    shortName: "E4 · VWAP Reversion",
    description:
      "Scalping M1 de reversión al VWAP diario. Entra cuando el precio se estira ≥1.5σ y aparece vela de rechazo. Sin killzone (solo excluye 22–05 UTC y fines de semana). TP1 en VWAP, TP2 banda opuesta.",
    defaultParams: { minScore: 65 },
    killzoneHoursUTC: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    triggerTf: "M1",
    requiredTfs: ["M1", "M5"],
    evaluate: (bars, params) =>
      evaluateGoldScalping(bars.M1 ?? [], bars.M5 ?? [], (params.minScore as number) ?? 65),
  },
  ema_cross_m1: {
    key: "ema_cross_m1",
    name: "EMA Cross Reversal M1 (simétrico)",
    shortName: "E5 · EMA Cross M1",
    description:
      "Cruce EMA9/EMA21 en M1 con filtros simétricos y estrictos: slope EMA9, RSI(14) 55/45, cruce de MACD histograma en 0 y ATR M5 sano. Killzone UTC 7-16. SL = 1.2×ATR(M1).",
    defaultParams: { minScore: 70 },
    killzoneHoursUTC: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    triggerTf: "M1",
    requiredTfs: ["M1", "M5"],
    evaluate: (bars, params) =>
      evaluateEmaCrossM1(bars.M1 ?? [], bars.M5 ?? [], (params.minScore as number) ?? 70),
  },
  straddle_breakout: {
    key: "straddle_breakout",
    name: "Straddle Breakout ATR M1",
    shortName: "E6 · Straddle Breakout",
    description:
      "Straddle ±0.6×ATR(M5) alrededor del close previo M1. Entra en ruptura con cuerpo ≥55% del rango y sesgo M5 alineado. Killzones Londres 7-10 y NY 13-15 UTC. SL = 0.8×ATR(M1), sin cierre por tiempo.",
    defaultParams: { minScore: 65 },
    killzoneHoursUTC: [7, 8, 9, 13, 14],
    triggerTf: "M1",
    requiredTfs: ["M1", "M5"],
    evaluate: (bars, params) =>
      evaluateStraddleBreakout(bars.M1 ?? [], bars.M5 ?? [], (params.minScore as number) ?? 65),
  },
};

export function listStrategies(): StrategyEngine[] {
  return Object.values(STRATEGIES);
}

export function getStrategy(key: EngineKey): StrategyEngine {
  return STRATEGIES[key];
}