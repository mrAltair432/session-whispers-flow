import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TfKey } from "./csv-parser";
import { aggregateCandles } from "./csv-parser";

type TDValue = { datetime: string; open: string; high: string; low: string; close: string };
type TDResponse = { values?: TDValue[]; status?: string; message?: string };

// Intervalos de Twelve Data que soportamos. M5 lo derivamos agregando M1
// para ahorrar una llamada al plan free (rate limit ~8 req/min).
export type TDInterval = "1min" | "15min" | "1h" | "4h" | "1day";

const intervalToOutputSize: Record<TDInterval, number> = {
  "1min": 400,   // ~6.5h de M1 → suficiente para VWAP diario y agregación M5
  "15min": 200,  // ~50h
  "1h": 300,     // ~12 días
  "4h": 240,     // ~40 días
  "1day": 80,    // ~4 meses (contracción Crabel)
};

async function fetchInterval(interval: TDInterval, apiKey: string) {
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

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type BarsByTf = Partial<Record<TfKey, Candle[]>>;

export type FetchXauPricesResult = {
  bars: BarsByTf;
  // Aliases legacy para componentes que aún leen h4/h1/m15 directo
  h4: Candle[];
  h1: Candle[];
  m15: Candle[];
  lastPrice: number | null;
  fetchedAt: number;
  error: string | null;
};

function emptyResult(error: string | null): FetchXauPricesResult {
  return { bars: {}, h4: [], h1: [], m15: [], lastPrice: null, fetchedAt: Date.now(), error };
}

export const fetchXauPrices = createServerFn({ method: "GET" }).handler(async () => {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return emptyResult("TWELVE_DATA_API_KEY no está configurada");
  }
  try {
    // 5 llamadas en paralelo. M5 se deriva de M1 (agregado 5m) para no gastar
    // otra llamada. Si M1 falla, M5 quedará vacío pero el resto sigue.
    const [m1, m15, h1, h4, d1] = await Promise.all([
      fetchInterval("1min", apiKey).catch(() => [] as Candle[]),
      fetchInterval("15min", apiKey),
      fetchInterval("1h", apiKey),
      fetchInterval("4h", apiKey),
      fetchInterval("1day", apiKey).catch(() => [] as Candle[]),
    ]);
    const m5 = m1.length ? aggregateCandles(m1, 5) : [];
    const lastPrice = m1.length
      ? m1[m1.length - 1].close
      : m15.length
        ? m15[m15.length - 1].close
        : null;
    const bars: BarsByTf = { M1: m1, M5: m5, M15: m15, H1: h1, H4: h4, D1: d1 };
    return { bars, h4, h1, m15, lastPrice, fetchedAt: Date.now(), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error fetching prices";
    return emptyResult(message);
  }
});