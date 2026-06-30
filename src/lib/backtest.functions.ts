import { createServerFn } from "@tanstack/react-start";
import { runBacktest, type BacktestResult } from "./backtest";
import type { SignalProfile } from "./signal-engine";

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
  .inputValidator((data: { minScore?: number; profiles?: SignalProfile[] }) => ({
    minScore: typeof data.minScore === "number" ? data.minScore : 70,
    profiles: (data.profiles ?? ["full", "h1m15", "m15"]) as SignalProfile[],
  }))
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
      const [h4, h1, m15] = await Promise.all([
        fetchHistory("4h", 2000, apiKey),
        fetchHistory("1h", 5000, apiKey),
        fetchHistory("15min", 5000, apiKey),
      ]);
      const results = data.profiles.map((profile) =>
        runBacktest(h4, h1, m15, { profile, minScore: data.minScore }),
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