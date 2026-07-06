import type { Candle } from "../analysis";
import { generateSignal as smcGenerate, type Signal } from "../signal-engine";
import { evaluateNyContinuation } from "./ny-continuation";
import { evaluateFiboScalping } from "./fibo-scalping";
import { evaluateGoldScalping } from "./gold-scalping";
import type { TfKey } from "../csv-parser";

export type EngineKey = "smc_london" | "ny_continuation" | "fibo_scalping" | "gold_scalping";

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
    name: "Continuación NY (Pullback EMA50)",
    shortName: "E2 · Continuación NY",
    description:
      "Tendencia H4 + pullback a EMA50 en H1 + BOS en M15 dentro del solape Londres-NY (UTC 12-15).",
    defaultParams: { minScore: 65 },
    killzoneHoursUTC: [12, 13, 14, 15],
    triggerTf: "M15",
    requiredTfs: ["H4", "H1", "M15"],
    evaluate: (bars, params) =>
      evaluateNyContinuation(bars.H4 ?? [], bars.H1 ?? [], bars.M15 ?? [], (params.minScore as number) ?? 65),
  },
  fibo_scalping: {
    key: "fibo_scalping",
    name: "Fibo Scalping Oro (Londres)",
    shortName: "E3 · Fibo Scalping",
    description:
      "Sesgo H4 + swing H1 + retroceso 0.5-0.786 con confirmación M15. Solo Londres (UTC 07-10), sin domingos y viernes hasta mediodía. Base para bot MT5 con grid limitado.",
    defaultParams: { minScore: 65 },
    killzoneHoursUTC: [7, 8, 9, 10],
    triggerTf: "M15",
    requiredTfs: ["H4", "H1", "M15"],
    evaluate: (bars, params) =>
      evaluateFiboScalping(bars.H4 ?? [], bars.H1 ?? [], bars.M15 ?? [], (params.minScore as number) ?? 65),
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
};

export function listStrategies(): StrategyEngine[] {
  return Object.values(STRATEGIES);
}

export function getStrategy(key: EngineKey): StrategyEngine {
  return STRATEGIES[key];
}