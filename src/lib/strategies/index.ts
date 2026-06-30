import type { Candle } from "../analysis";
import { generateSignal as smcGenerate, type Signal } from "../signal-engine";
import { evaluateNyContinuation } from "./ny-continuation";

export type EngineKey = "smc_london" | "ny_continuation";

export type StrategyParams = {
  minScore?: number;
  [k: string]: unknown;
};

export type StrategyEngine = {
  key: EngineKey;
  name: string;
  shortName: string;
  description: string;
  defaultParams: StrategyParams;
  killzoneHoursUTC: number[]; // informativo
  evaluate(h4: Candle[], h1: Candle[], m15: Candle[], params: StrategyParams): Signal;
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
    evaluate: (h4, h1, m15, params) =>
      smcGenerate(h4, h1, m15, { profile: "full", minScore: (params.minScore as number) ?? 70 }),
  },
  ny_continuation: {
    key: "ny_continuation",
    name: "Continuación NY (Pullback EMA50)",
    shortName: "E2 · Continuación NY",
    description:
      "Tendencia H4 + pullback a EMA50 en H1 + BOS en M15 dentro del solape Londres-NY (UTC 12-15).",
    defaultParams: { minScore: 65 },
    killzoneHoursUTC: [12, 13, 14, 15],
    evaluate: (h4, h1, m15, params) =>
      evaluateNyContinuation(h4, h1, m15, (params.minScore as number) ?? 65),
  },
};

export function listStrategies(): StrategyEngine[] {
  return Object.values(STRATEGIES);
}

export function getStrategy(key: EngineKey): StrategyEngine {
  return STRATEGIES[key];
}