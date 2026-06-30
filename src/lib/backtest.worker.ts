/// <reference lib="webworker" />
import { runBacktest, type BacktestResult } from "./backtest";
import type { Candle } from "./analysis";
import { STRATEGIES, type EngineKey } from "./strategies";

type BacktestJob = {
  id: number;
  type: "backtest";
  h4: Candle[];
  h1: Candle[];
  m15: Candle[];
  engines: EngineKey[];
  minScore?: number;
  excludeHours: number[];
  excludeWeekdays: number[];
  autoTimeFilters: boolean;
};

type OptimizeJob = {
  id: number;
  type: "optimize";
  h4: Candle[];
  h1: Candle[];
  m15: Candle[];
  engineKey: EngineKey;
  excludeWeekdays: number[];
  autoTimeFilters: boolean;
};

type Job = BacktestJob | OptimizeJob;

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    if (job.type === "backtest") {
      const results: BacktestResult[] = [];
      for (let i = 0; i < job.engines.length; i++) {
        const engineKey = job.engines[i];
        (self as unknown as Worker).postMessage({
          id: job.id,
          progress: { step: i, total: job.engines.length, label: STRATEGIES[engineKey].shortName },
        });
        results.push(
          runBacktest(job.h4, job.h1, job.m15, {
            engineKey,
            params: job.minScore !== undefined ? { minScore: job.minScore } : undefined,
            excludeHours: job.excludeHours,
            excludeWeekdays: job.excludeWeekdays,
            autoTimeFilters: job.autoTimeFilters,
          }),
        );
      }
      (self as unknown as Worker).postMessage({ id: job.id, done: true, results });
    } else if (job.type === "optimize") {
      const base = (STRATEGIES[job.engineKey].defaultParams.minScore as number | undefined) ?? 70;
      const minScores = Array.from(new Set([
        Math.max(50, base - 15), Math.max(50, base - 10), Math.max(50, base - 5),
        base,
        Math.min(95, base + 5), Math.min(95, base + 10), Math.min(95, base + 15),
      ])).sort((a, b) => a - b);
      const baseline = runBacktest(job.h4, job.h1, job.m15, {
        engineKey: job.engineKey,
        excludeWeekdays: job.excludeWeekdays,
        autoTimeFilters: job.autoTimeFilters,
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
          const r = runBacktest(job.h4, job.h1, job.m15, {
            engineKey: job.engineKey,
            params: { minScore: ms },
            excludeHours: v.excludeHours,
            excludeWeekdays: job.excludeWeekdays,
            autoTimeFilters: job.autoTimeFilters,
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