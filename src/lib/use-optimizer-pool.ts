import { useEffect, useRef, useState } from "react";
import type { Candle } from "./analysis";
import { STRATEGIES, type EngineKey } from "./strategies";

export type OptRow = {
  minScore: number; excludeHours: number[]; trades: number; winrate: number; totalR: number;
  expectancy: number; profitFactor: number; maxDrawdownR: number; sharpe: number; score: number;
};
export type OptResp = { rows: OptRow[]; best: OptRow | null; engineKey: EngineKey };
export type PoolProgress = { done: number; total: number; workers: number };

function spawnWorker() {
  return new Worker(new URL("./backtest.worker.ts", import.meta.url), { type: "module" });
}

export function useOptimizerPool() {
  const [progress, setProgress] = useState<PoolProgress | null>(null);
  const poolRef = useRef<Worker[]>([]);

  useEffect(() => () => { poolRef.current.forEach((w) => w.terminate()); poolRef.current = []; }, []);

  async function optimize(params: {
    h4: Candle[]; h1: Candle[]; m15: Candle[];
    m5?: Candle[]; m1?: Candle[];
    engineKey: EngineKey;
    excludeWeekdays: number[]; autoTimeFilters: boolean;
  }): Promise<OptResp> {
    poolRef.current.forEach((w) => w.terminate());
    const hw = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 4) : 4;
    const size = Math.max(2, Math.min(hw - 1, 8));
    const pool = Array.from({ length: size }, spawnWorker);
    poolRef.current = pool;

    const run = <T,>(w: Worker, msg: Record<string, unknown>, id: number) =>
      new Promise<T>((resolve, reject) => {
        const onMsg = (e: MessageEvent<{ id: number; done?: boolean; error?: string } & Record<string, unknown>>) => {
          if (e.data.id !== id) return;
          if (!e.data.done) return;
          w.removeEventListener("message", onMsg);
          if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data as unknown as T);
        };
        w.addEventListener("message", onMsg);
        w.postMessage({ id, ...msg });
      });

    let idc = 1;
    setProgress({ done: 0, total: 1, workers: size });
    // 1) baseline (worst hours + keep-only-positive) on worker[0]
    const baseline = await run<{ worstHours: number[]; keepOnlyPositive: number[] }>(pool[0], {
      type: "optimize-baseline",
      h4: params.h4, h1: params.h1, m15: params.m15, m5: params.m5, m1: params.m1,
      engineKey: params.engineKey,
      excludeWeekdays: params.excludeWeekdays,
      autoTimeFilters: params.autoTimeFilters,
    }, idc++);

    // 2) build combos
    const base = (STRATEGIES[params.engineKey].defaultParams.minScore as number | undefined) ?? 70;
    const rawScores: number[] = [];
    for (let d = -20; d <= 20; d += 4) {
      const s = Math.min(95, Math.max(50, base + d));
      rawScores.push(s);
    }
    const minScores = Array.from(new Set(rawScores)).sort((a, b) => a - b);
    const wh = baseline.worstHours ?? [];
    const variants: number[][] = [
      [],
      wh.slice(0, 1),
      wh.slice(0, 2),
      wh.slice(0, 3),
      wh.slice(0, 5),
    ];
    if (baseline.keepOnlyPositive?.length) variants.push(baseline.keepOnlyPositive);
    // dedupe variants
    const seen = new Set<string>();
    const uniqVariants = variants.filter((v) => {
      const k = v.slice().sort((a, b) => a - b).join(",");
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    const combos: Array<{ minScore: number; excludeHours: number[] }> = [];
    for (const ms of minScores) for (const v of uniqVariants) combos.push({ minScore: ms, excludeHours: v });

    // 3) dispatch across pool
    setProgress({ done: 0, total: combos.length, workers: size });
    const rows: OptRow[] = [];
    let done = 0;
    let idx = 0;
    const dispatchNext = async (w: Worker): Promise<void> => {
      while (idx < combos.length) {
        const my = combos[idx++];
        const resp = await run<{ row: OptRow }>(w, {
          type: "optimize-one",
          h4: params.h4, h1: params.h1, m15: params.m15, m5: params.m5, m1: params.m1,
          engineKey: params.engineKey,
          minScore: my.minScore,
          excludeHours: my.excludeHours,
          excludeWeekdays: params.excludeWeekdays,
          autoTimeFilters: params.autoTimeFilters,
        }, idc++);
        rows.push(resp.row);
        done++;
        setProgress({ done, total: combos.length, workers: size });
      }
    };
    await Promise.all(pool.map(dispatchNext));

    pool.forEach((w) => w.terminate());
    poolRef.current = [];
    rows.sort((a, b) => b.score - a.score);
    setProgress(null);
    return { rows, best: rows[0] ?? null, engineKey: params.engineKey };
  }

  return { optimize, progress };
}