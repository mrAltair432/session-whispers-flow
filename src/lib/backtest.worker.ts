/// <reference lib="webworker" />
import {
  runBacktest, runBacktestBars, computeMetrics,
  type BacktestResult, type BacktestCosts, type BacktestTrade, type BacktestMetrics,
} from "./backtest";
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

function costsForEngine(engineKey: EngineKey, costs?: BacktestCosts): BacktestCosts | undefined {
  // FASE 0 — el spread/slippage/comisión se aplica a TODOS los motores.
  // Lo único que se escala es la latencia: los controles están en barras del
  // TF trigger, y 1 barra M15 serían 15 minutos de retraso (irreal). Para
  // TFs > M1 la ejecución ocurre en la apertura de la barra siguiente.
  if (!costs) return undefined;
  if (STRATEGIES[engineKey].triggerTf === "M1") return costs;
  return { ...costs, latencyBars: 0 };
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

// FASE 1 — walk-forward rodante: optimiza en una ventana y evalúa a ciegas
// en la ventana siguiente, avanzando en el tiempo.
type WalkForwardJob = BarsPayload & {
  id: number;
  type: "walkforward";
  engineKey: EngineKey;
  trainDays: number;
  testDays: number;
  excludeWeekdays: number[];
  autoTimeFilters: boolean;
  costs?: BacktestCosts;
};

type Job = BacktestJob | OptimizeJob | BaselineJob | OneComboJob | WalkForwardJob;

const DAY = 86400;

function summarize(m: BacktestMetrics) {
  return {
    trades: m.trades,
    winrate: m.winrate,
    totalR: m.totalR,
    expectancy: m.expectancy,
    profitFactor: isFinite(m.profitFactor) ? m.profitFactor : 99,
    maxDrawdownR: m.maxDrawdownR,
    sharpe: m.sharpe,
  };
}

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    if (job.type === "backtest") {
      const results: BacktestResult[] = [];
      const bars = toBars(job);
      const jobStartedAt = Date.now();
      for (let i = 0; i < job.engines.length; i++) {
        const engineKey = job.engines[i];
        const phaseStartedAt = Date.now();
        (self as unknown as Worker).postMessage({
          id: job.id,
          progress: {
            step: i, total: job.engines.length,
            label: STRATEGIES[engineKey].shortName,
            phase: "simulate",
            percent: 0, trades: 0,
            phaseStartedAt, jobStartedAt,
          },
        });
        results.push(
          runBacktestBars(bars, {
            engineKey,
            params: job.minScore !== undefined ? { minScore: job.minScore } : undefined,
            excludeHours: job.excludeHours,
            excludeWeekdays: job.excludeWeekdays,
            autoTimeFilters: job.autoTimeFilters,
            costs: costsForEngine(engineKey, job.costs),
            onProgress: (p) => {
              (self as unknown as Worker).postMessage({
                id: job.id,
                progress: {
                  step: i, total: job.engines.length,
                  label: STRATEGIES[engineKey].shortName,
                  phase: "simulate",
                  percent: p.percent, trades: p.trades,
                  phaseStartedAt, jobStartedAt,
                },
              });
            },
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
        costs: costsForEngine(job.engineKey, job.costs),
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
            costs: costsForEngine(job.engineKey, job.costs),
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
        costs: costsForEngine(job.engineKey, job.costs),
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
    } else if (job.type === "walkforward") {
      const bars = toBars(job);
      const strat = STRATEGIES[job.engineKey];
      const triggerBars = bars[strat.triggerTf] ?? [];
      if (triggerBars.length < 200) throw new Error("Historial insuficiente para walk-forward.");
      const t0 = triggerBars[0].time;
      const tEnd = triggerBars[triggerBars.length - 1].time;
      const trainSec = job.trainDays * DAY;
      const testSec = job.testDays * DAY;
      if (tEnd - t0 < trainSec + testSec) {
        throw new Error(
          `Se necesitan al menos ${job.trainDays + job.testDays} días de historial (hay ${Math.floor((tEnd - t0) / DAY)}).`,
        );
      }
      const base = (strat.defaultParams.minScore as number | undefined) ?? 70;
      const grid = Array.from(new Set([
        Math.max(45, base - 15), Math.max(45, base - 10), Math.max(45, base - 5),
        base,
        Math.min(95, base + 5), Math.min(95, base + 10),
      ])).sort((a, b) => a - b);

      const windows: Array<{ trainStart: number; trainEnd: number; testEnd: number }> = [];
      for (let s = t0; s + trainSec + testSec <= tEnd; s += testSec) {
        windows.push({ trainStart: s, trainEnd: s + trainSec, testEnd: s + trainSec + testSec });
      }
      const total = windows.length * (grid.length + 1);
      let step = 0;
      const jobStartedAt = Date.now();
      const report = (label: string) => {
        (self as unknown as Worker).postMessage({
          id: job.id,
          progress: { step, total, label, phase: "simulate", percent: total ? step / total : 0, jobStartedAt },
        });
      };

      const folds: Array<{
        trainStart: number; trainEnd: number; testEnd: number;
        minScore: number;
        train: ReturnType<typeof summarize>;
        test: ReturnType<typeof summarize>;
      }> = [];
      const oosTrades: BacktestTrade[] = [];
      const isTrades: BacktestTrade[] = [];

      for (let w = 0; w < windows.length; w++) {
        const win = windows[w];
        let best: { minScore: number; score: number; res: BacktestResult } | null = null;
        for (const ms of grid) {
          report(`Fold ${w + 1}/${windows.length} · train minScore=${ms}`);
          step++;
          const r = runBacktestBars(bars, {
            engineKey: job.engineKey,
            params: { minScore: ms },
            excludeWeekdays: job.excludeWeekdays,
            autoTimeFilters: job.autoTimeFilters,
            costs: costsForEngine(job.engineKey, job.costs),
            startTime: win.trainStart,
            endTime: win.trainEnd,
          });
          const mm = r.metrics;
          // Selección honesta: exige muestra mínima y penaliza el drawdown.
          const sc = mm.trades >= 8 ? mm.expectancy - 0.05 * mm.maxDrawdownR : -Infinity;
          if (!best || sc > best.score) best = { minScore: ms, score: sc, res: r };
        }
        const chosen = best && isFinite(best.score) ? best : null;
        const minScore = chosen?.minScore ?? base;
        const trainRes = chosen?.res ?? best!.res;
        report(`Fold ${w + 1}/${windows.length} · test OOS`);
        step++;
        const testRes = runBacktestBars(bars, {
          engineKey: job.engineKey,
          params: { minScore },
          excludeWeekdays: job.excludeWeekdays,
          autoTimeFilters: job.autoTimeFilters,
          costs: costsForEngine(job.engineKey, job.costs),
          startTime: win.trainEnd,
          endTime: win.testEnd,
        });
        oosTrades.push(...testRes.trades);
        isTrades.push(...trainRes.trades);
        folds.push({
          trainStart: win.trainStart,
          trainEnd: win.trainEnd,
          testEnd: win.testEnd,
          minScore,
          train: summarize(trainRes.metrics),
          test: summarize(testRes.metrics),
        });
      }

      oosTrades.sort((a, b) => a.openTime - b.openTime);
      const oos = computeMetrics(oosTrades);
      const is = computeMetrics(isTrades);
      (self as unknown as Worker).postMessage({
        id: job.id,
        done: true,
        engineKey: job.engineKey,
        folds,
        oos: summarize(oos),
        inSample: summarize(is),
        equityCurve: oos.equityCurve,
      });
    } else if (job.type === "optimize-one") {
      const r = runBacktestBars(toBars(job), {
        engineKey: job.engineKey,
        params: { minScore: job.minScore },
        excludeHours: job.excludeHours,
        excludeWeekdays: job.excludeWeekdays,
        autoTimeFilters: job.autoTimeFilters,
        costs: costsForEngine(job.engineKey, job.costs),
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