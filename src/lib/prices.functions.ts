import { createServerFn } from "@tanstack/react-start";

type TDValue = { datetime: string; open: string; high: string; low: string; close: string };
type TDResponse = { values?: TDValue[]; status?: string; message?: string };

export type Interval = "15min" | "1h" | "4h";

const intervalToOutputSize: Record<Interval, number> = {
  "15min": 120,
  "1h": 120,
  "4h": 120,
};

async function fetchInterval(interval: Interval, apiKey: string) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(intervalToOutputSize[interval]));
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("order", "ASC");

  const res = await fetch(url.toString());
  const json = (await res.json()) as TDResponse;
  if (!json.values || json.status === "error") {
    throw new Error(json.message || `No data for ${interval}`);
  }
  return json.values.map((v) => ({
    time: Math.floor(new Date(v.datetime + "Z").getTime() / 1000),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

export const fetchXauPrices = createServerFn({ method: "GET" }).handler(async () => {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return {
      error: "TWELVE_DATA_API_KEY no está configurada",
      h4: [], h1: [], m15: [], lastPrice: null as number | null, fetchedAt: Date.now(),
    };
  }
  try {
    const [h4, h1, m15] = await Promise.all([
      fetchInterval("4h", apiKey),
      fetchInterval("1h", apiKey),
      fetchInterval("15min", apiKey),
    ]);
    const lastPrice = m15.length ? m15[m15.length - 1].close : null;
    return { h4, h1, m15, lastPrice, fetchedAt: Date.now(), error: null as string | null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error fetching prices";
    return { h4: [], h1: [], m15: [], lastPrice: null as number | null, fetchedAt: Date.now(), error: message };
  }
});