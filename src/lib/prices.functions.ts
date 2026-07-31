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
// ---------------------------------------------------------------------------
// Fuente híbrida: velas del broker (enviadas por el EA) con fallback a Twelve Data.
// El broker es la fuente preferida porque son exactamente los precios que
// ejecuta tu cuenta MT5 (mismo spread, mismo horario de sesión).
// ---------------------------------------------------------------------------

export type MarketSource = "broker" | "hybrid" | "twelvedata";

export type FetchMarketDataResult = FetchXauPricesResult & {
  source: MarketSource;
  broker: {
    available: boolean;
    fresh: boolean;
    name: string | null;
    spreadUsd: number | null;
    lastPushAt: string | null;
    lastBarTime: string | null;
    counts: Partial<Record<TfKey, number>>;
    reason: string | null;
  };
};

const BROKER_TF_LIMITS: Record<TfKey, number> = {
  M1: 1200,
  M5: 600,
  M15: 400,
  H1: 400,
  H4: 300,
  D1: 120,
};

// Minutos máximos de antigüedad de la última vela M1 para considerar el feed
// del broker "vivo". Los fines de semana el mercado está cerrado, así que
// permitimos una ventana amplia y avisamos en la UI.
const BROKER_FRESH_MAX_MIN = 15;

type FeedStatusRow = {
  broker: string | null;
  spread_usd: number | null;
  last_push_at: string | null;
  last_bar_time: string | null;
};

type BrokerBarRow = {
  bar_time: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
};

export const fetchMarketData = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FetchMarketDataResult> => {
    const bars: BarsByTf = {};
    const counts: Partial<Record<TfKey, number>> = {};
    let status: FeedStatusRow | null = null;

    try {
      const { data: st } = await context.supabase
        .from("broker_feed_status")
        .select("broker, spread_usd, last_push_at, last_bar_time")
        .eq("user_id", context.userId)
        .maybeSingle();
      status = (st as unknown as FeedStatusRow | null) ?? null;

      const tfs: TfKey[] = ["M1", "M5", "M15", "H1", "H4", "D1"];
      const results = await Promise.all(
        tfs.map((tf) =>
          context.supabase
            .from("broker_bars")
            .select("bar_time, open, high, low, close")
            .eq("user_id", context.userId)
            .eq("tf", tf)
            .order("bar_time", { ascending: false })
            .limit(BROKER_TF_LIMITS[tf]),
        ),
      );
      tfs.forEach((tf, i) => {
        const rows = (results[i].data ?? []) as unknown as BrokerBarRow[];
        const candles: Candle[] = rows
          .map((r) => ({
            time: Math.floor(new Date(r.bar_time).getTime() / 1000),
            open: Number(r.open),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.close),
          }))
          .reverse();
        bars[tf] = candles;
        counts[tf] = candles.length;
      });
    } catch {
      // Si la lectura del broker falla, seguimos con Twelve Data.
    }

    // M5 derivado de M1 si el EA no lo envía.
    if ((bars.M5?.length ?? 0) < 30 && (bars.M1?.length ?? 0) >= 60) {
      bars.M5 = aggregateCandles(bars.M1 as Candle[], 5);
      counts.M5 = bars.M5.length;
    }

    const m1 = bars.M1 ?? [];
    const lastBarTs = m1.length ? m1[m1.length - 1].time * 1000 : 0;
    const ageMin = lastBarTs ? (Date.now() - lastBarTs) / 60_000 : Infinity;
    const hasCore =
      (bars.M1?.length ?? 0) >= 120 &&
      (bars.M15?.length ?? 0) >= 60 &&
      (bars.H1?.length ?? 0) >= 60 &&
      (bars.H4?.length ?? 0) >= 60;
    const fresh = ageMin <= BROKER_FRESH_MAX_MIN;

    const brokerMeta = {
      available: (bars.M1?.length ?? 0) > 0,
      fresh,
      name: status?.broker ?? null,
      spreadUsd: status?.spread_usd != null ? Number(status.spread_usd) : null,
      lastPushAt: status?.last_push_at ?? null,
      lastBarTime: status?.last_bar_time ?? null,
      counts,
      reason: null as string | null,
    };

    if (hasCore && fresh) {
      const lastPrice = m1[m1.length - 1].close;
      return {
        bars,
        h4: bars.H4 ?? [],
        h1: bars.H1 ?? [],
        m15: bars.M15 ?? [],
        lastPrice,
        fetchedAt: Date.now(),
        error: null,
        source: "broker",
        broker: brokerMeta,
      };
    }

    brokerMeta.reason = !brokerMeta.available
      ? "El EA aún no ha enviado velas"
      : !hasCore
        ? "Historial del broker incompleto (faltan TFs)"
        : `Última vela del broker hace ${Math.round(ageMin)} min`;

    const fallback = (await fetchXauPrices()) as FetchXauPricesResult;
    return { ...fallback, source: "twelvedata", broker: brokerMeta };
  });
