/// <reference lib="webworker" />
import { runBacktest, runBacktestBars, type BacktestResult, type BacktestCosts } from "./backtest";
import type { Candle } from "./analysis";
import { STRATEGIES, type EngineKey } from "./strategies";

type BarsPayload = {
  h4?: Candle[]; h1?: Candle[]; m15?: Candle[]; m5?: Candle[]; m1?: Candle[];
};

function toBars(p: BarsPayload) {
  return {
    H4: p.h4 ?? [],
    H1: p.h1 ?? [],
    M15: p.m15 ?? [],
    M5: p.m5 ?? [],
    M1: p.m1 ?? [],
  } as const;
}

type BacktestJob = BarsPayload & {
  id: number;
  type: "backtest";
  engines: EngineKey[];
  minScore?: number;
  excludeHours: number[];
  excludeWeekdays: number[];
  autoTimeFilters: boolean;
  costs?: BacktestCosts;
};

type OptimizeJob = BarsPayload & {
  id: number;
  type: "optimize";
  engineKey: EngineKey;
  excludeWeekdays: number[];
  autoTimeFilters: boolean;
  costs?: BacktestCosts;
};

type BaselineJob = BarsPayload & {
  id: number;
  type: "optimize-baseline";
  engineKey: EngineKey;
  excludeWeekdays: number[];
  autoTimeFilters: boolean;
  costs?: BacktestCosts;
};

type OneComboJob = BarsPayload & {
  id: number;
  type: "optimize-one";
  engineKey: EngineKey;
  minScore: number;
  excludeHours: number[];
  excludeWeekdays: number[];
  autoTimeFilters: boolean;
  costs?: BacktestCosts;
};

type Job = BacktestJob | OptimizeJob | BaselineJob | OneComboJob;

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    if (job.type === "backtest") {
      const results: BacktestResult[] = [];
      const bars = toBars(job);
      for (let i = 0; i < job.engines.length; i++) {
        const engineKey = job.engines[i];
        (self as unknown as Worker).postMessage({
          id: job.id,
          progress: { step: i, total: job.engines.length, label: STRATEGIES[engineKey].shortName },
        });
        results.push(
          runBacktestBars(bars, {
            engineKey,
            params: job.minScore !== undefined ? { minScore: job.minScore } : undefined,
            excludeHours: job.excludeHours,
            excludeWeekdays: job.excludeWeekdays,
            autoTimeFilters: job.autoTimeFilters,
            costs: job.costs,
          }),
        );
      }
      (self as unknown as Worker).postMessage({ id: job.id, done: true, results });
    } else if (job.type === "optimize") {
      const bars = toBars(job);
      const base = (STRATEGIES[job.engineKey].defaultParams.minScore as number | undefined) ?? 70;
      const minScores = Array.from(new Set([
        Math.max(50, base - 15), Math.max(50, base - 10), Math.max(50, base - 5),
        base,
        Math.min(95, base + 5), Math.min(95, base + 10), Math.min(95, base + 15),
      ])).sort((a, b) => a - b);
      const baseline = runBacktestBars(bars, {
        engineKey: job.engineKey,
        excludeWeekdays: job.excludeWeekdays,
        autoTimeFilters: job.autoTimeFilters,
        costs: job.costs,
      });
      const worstHours = baseline.metrics.byHour
        .filter((h) => h.trades >= 2 && h.totalR < 0)
        .sort((a, b) => a.totalR - b.totalR)
        .slice(0, 3)
        .map((h) => h.hour);
      const variants = [
        { excludeHours: [] as number[] },
        { excludeHours: worstHours },
      ];
      const rows: Array<{
        minScore: number; excludeHours: number[]; trades: number; winrate: number; totalR: number;
        expectancy: number; profitFactor: number; maxDrawdownR: number; sharpe: number; score: number;
      }> = [];
      const total = minScores.length * variants.length;
      let step = 0;
      for (const ms of minScores) {
        for (const v of variants) {
          (self as unknown as Worker).postMessage({
            id: job.id,
            progress: { step, total, label: `minScore=${ms}` },
          });
          const r = runBacktestBars(bars, {
            engineKey: job.engineKey,
            params: { minScore: ms },
            excludeHours: v.excludeHours,
            excludeWeekdays: job.excludeWeekdays,
            autoTimeFilters: job.autoTimeFilters,
            costs: job.costs,
          });
          const mm = r.metrics;
          const sampleWeight = Math.sqrt(Math.min(mm.trades, 100) / 100);
          const composite = mm.trades >= 10 ? mm.expectancy * sampleWeight - 0.1 * mm.maxDrawdownR : -Infinity;
          rows.push({
            minScore: ms,
            excludeHours: v.excludeHours,
            trades: mm.trades,
            winrate: mm.winrate,
            totalR: mm.totalR,
            expectancy: mm.expectancy,
            profitFactor: isFinite(mm.profitFactor) ? mm.profitFactor : 99,
            maxDrawdownR: mm.maxDrawdownR,
            sharpe: mm.sharpe,
            score: composite,
          });
          step++;
        }
      }
      rows.sort((a, b) => b.score - a.score);
      (self as unknown as Worker).postMessage({
        id: job.id, done: true, rows, best: rows[0] ?? null, engineKey: job.engineKey,
      });
    } else if (job.type === "optimize-baseline") {
      const baseline = runBacktestBars(toBars(job), {
        engineKey: job.engineKey,
        excludeWeekdays: job.excludeWeekdays,
        autoTimeFilters: job.autoTimeFilters,
        costs: job.costs,
      });
      const worstHours = baseline.metrics.byHour
        .filter((h) => h.trades >= 2 && h.totalR < 0)
        .sort((a, b) => a.totalR - b.totalR)
        .slice(0, 5)
        .map((h) => h.hour);
      const positiveHours = baseline.metrics.byHour
        .filter((h) => h.trades >= 2 && h.totalR > 0)
        .map((h) => h.hour);
      // hours to EXCLUDE if we keep only positive hours = everything not in positiveHours
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const keepOnlyPositive = positiveHours.length > 0
        ? allHours.filter((h) => !positiveHours.includes(h))
        : [];
      (self as unknown as Worker).postMessage({
        id: job.id, done: true, worstHours, keepOnlyPositive,
      });
    } else if (job.type === "optimize-one") {
      const r = runBacktestBars(toBars(job), {
        engineKey: job.engineKey,
        params: { minScore: job.minScore },
        excludeHours: job.excludeHours,
        excludeWeekdays: job.excludeWeekdays,
        autoTimeFilters: job.autoTimeFilters,
        costs: job.costs,
      });
      const mm = r.metrics;
      const sampleWeight = Math.sqrt(Math.min(mm.trades, 100) / 100);
      const pf = isFinite(mm.profitFactor) ? mm.profitFactor : 3;
      // Objetivo: maximizar Profit Factor con muestra suficiente y drawdown controlado.
      const composite = mm.trades >= 10
        ? pf * sampleWeight - 0.05 * mm.maxDrawdownR
        : -Infinity;
      (self as unknown as Worker).postMessage({
        id: job.id, done: true, row: {
          minScore: job.minScore,
          excludeHours: job.excludeHours,
          trades: mm.trades,
          winrate: mm.winrate,
          totalR: mm.totalR,
          expectancy: mm.expectancy,
          profitFactor: isFinite(mm.profitFactor) ? mm.profitFactor : 99,
          maxDrawdownR: mm.maxDrawdownR,
          sharpe: mm.sharpe,
          score: composite,
        },
      });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: job.id,
      done: true,
      error: err instanceof Error ? err.message : "Worker error",
    });
  }
};

export {};

// Fuerza el bundler a no tree-shakear el wrapper legacy.
export const __legacyBacktest = runBacktest;