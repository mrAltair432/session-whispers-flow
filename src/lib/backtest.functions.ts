import { createServerFn } from "@tanstack/react-start";
import { runBacktest, type BacktestResult } from "./backtest";
import type { SignalProfile } from "./signal-engine";
import type { Candle } from "./analysis";

type TDValue = { datetime: string; open: string; high: string; low: string; close: string };
type TDResponse = { values?: TDValue[]; status?: string; message?: string };

type Interval = "15min" | "1h" | "4h";

async function fetchHistory(interval: Interval, outputsize: number, apiKey: string) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("order", "ASC");
  const res = await fetch(url.toString());
  const json = (await res.json()) as TDResponse;
  if (!json.values || json.status === "error") {
    throw new Error(json.message || `No history for ${interval}`);
  }
  return json.values.map((v) => ({
    time: Math.floor(new Date(v.datetime + "Z").getTime() / 1000),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

export type BacktestPayload = {
  results: BacktestResult[]; // one per profile
  range: { from: number; to: number; m15Bars: number; h1Bars: number; h4Bars: number };
  error: string | null;
};

export const runFullBacktest = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      minScore?: number;
      profiles?: SignalProfile[];
      excludeHours?: number[];
      excludeWeekdays?: number[];
      customH4?: Candle[];
    }) => ({
      minScore: typeof data.minScore === "number" ? data.minScore : 70,
      profiles: (data.profiles ?? ["full", "h1m15", "m15"]) as SignalProfile[],
      excludeHours: Array.isArray(data.excludeHours) ? data.excludeHours : [],
      excludeWeekdays: Array.isArray(data.excludeWeekdays) ? data.excludeWeekdays : [],
      customH4: Array.isArray(data.customH4) ? data.customH4 : undefined,
    }),
  )
  .handler(async ({ data }): Promise<BacktestPayload> => {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
      return {
        results: [],
        range: { from: 0, to: 0, m15Bars: 0, h1Bars: 0, h4Bars: 0 },
        error: "TWELVE_DATA_API_KEY no está configurada",
      };
    }
    try {
      const [h4Fetched, h1, m15] = await Promise.all([
        data.customH4 ? Promise.resolve([] as Candle[]) : fetchHistory("4h", 2000, apiKey),
        fetchHistory("1h", 5000, apiKey),
        fetchHistory("15min", 5000, apiKey),
      ]);
      const h4 = data.customH4 && data.customH4.length ? data.customH4 : h4Fetched;
      const results = data.profiles.map((profile) =>
        runBacktest(h4, h1, m15, {
          profile,
          minScore: data.minScore,
          excludeHours: data.excludeHours,
          excludeWeekdays: data.excludeWeekdays,
        }),
      );
      return {
        results,
        range: {
          from: m15[0]?.time ?? 0,
          to: m15[m15.length - 1]?.time ?? 0,
          m15Bars: m15.length,
          h1Bars: h1.length,
          h4Bars: h4.length,
        },
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backtest error";
      return {
        results: [],
        range: { from: 0, to: 0, m15Bars: 0, h1Bars: 0, h4Bars: 0 },
        error: message,
      };
    }
  });

// ---------- Optimizer: grid search over minScore + auto hour exclusion ----------

export type OptimizerRow = {
  minScore: number;
  excludeHours: number[];
  trades: number;
  winrate: number;
  totalR: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownR: number;
  sharpe: number;
  score: number; // composite ranking score
};

export type OptimizerPayload = {
  rows: OptimizerRow[];
  best: OptimizerRow | null;
  error: string | null;
};

export const runOptimizer = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { profile?: SignalProfile; customH4?: Candle[] }) => ({
      profile: (data.profile ?? "full") as SignalProfile,
      customH4: Array.isArray(data.customH4) ? data.customH4 : undefined,
    }),
  )
  .handler(async ({ data }): Promise<OptimizerPayload> => {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
      return { rows: [], best: null, error: "TWELVE_DATA_API_KEY no está configurada" };
    }
    try {
      const [h4Fetched, h1, m15] = await Promise.all([
        data.customH4 ? Promise.resolve([] as Candle[]) : fetchHistory("4h", 2000, apiKey),
        fetchHistory("1h", 5000, apiKey),
        fetchHistory("15min", 5000, apiKey),
      ]);
      const h4 = data.customH4 && data.customH4.length ? data.customH4 : h4Fetched;

      const minScores = [60, 65, 70, 75, 80, 85];
      // Two hour-exclusion strategies: none, and auto (drop bottom-3 negative hours from baseline)
      // First baseline run with minScore=70 to find worst hours.
      const baseline = runBacktest(h4, h1, m15, { profile: data.profile, minScore: 70 });
      const worstHours = baseline.metrics.byHour
        .filter((h) => h.trades >= 2 && h.totalR < 0)
        .sort((a, b) => a.totalR - b.totalR)
        .slice(0, 3)
        .map((h) => h.hour);

      const variants: { label: string; excludeHours: number[] }[] = [
        { label: "all-hours", excludeHours: [] },
        { label: "no-worst-3", excludeHours: worstHours },
      ];

      const rows: OptimizerRow[] = [];
      for (const ms of minScores) {
        for (const v of variants) {
          const r = runBacktest(h4, h1, m15, {
            profile: data.profile,
            minScore: ms,
            excludeHours: v.excludeHours,
          });
          const m = r.metrics;
          // Composite score: favors expectancy*sqrt(trades), penalizes drawdown
          const sampleWeight = Math.sqrt(Math.min(m.trades, 100) / 100);
          const composite =
            m.trades >= 10
              ? m.expectancy * sampleWeight - 0.1 * m.maxDrawdownR
              : -Infinity;
          rows.push({
            minScore: ms,
            excludeHours: v.excludeHours,
            trades: m.trades,
            winrate: m.winrate,
            totalR: m.totalR,
            expectancy: m.expectancy,
            profitFactor: isFinite(m.profitFactor) ? m.profitFactor : 99,
            maxDrawdownR: m.maxDrawdownR,
            sharpe: m.sharpe,
            score: composite,
          });
        }
      }
      rows.sort((a, b) => b.score - a.score);
      return { rows, best: rows[0] ?? null, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Optimizer error";
      return { rows: [], best: null, error: message };
    }
  });