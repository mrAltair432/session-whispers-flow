// Calendario económico de alto impacto para XAU/USD.
// Combina dos fuentes:
//   1. Feed gratuito ForexFactory (https://nfs.faireconomy.media/ff_calendar_thisweek.json).
//   2. Fallback hardcodeado (FOMC/NFP) por si el feed no responde.
// Los eventos se filtran a USD + impacto alto (los que mueven Gold).

export type EconEvent = {
  /** ISO 8601 UTC de cuando ocurre el evento (con hora si el feed la da). */
  timeISO: string;
  /** YYYY-MM-DD UTC (derivado, para búsquedas por día). */
  date: string;
  type: "FOMC" | "NFP" | "CPI" | "OTHER";
  label: string;
  impact: "high" | "medium" | "low";
  country: string;
  source: "forexfactory" | "fallback";
};

// FOMC oficial Fed (decisión de tasas)
const FOMC_DATES: string[] = [
  // 2025
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18",
  "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
  // 2026
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
];

// NFP = primer viernes del mes, salvo casos especiales. Calculado.
function firstFridayOfMonth(year: number, month0: number): string {
  const d = new Date(Date.UTC(year, month0, 1));
  const dow = d.getUTCDay(); // 0=Sun
  const offset = (5 - dow + 7) % 7;
  d.setUTCDate(1 + offset);
  return d.toISOString().slice(0, 10);
}

function buildNFPs(year: number): string[] {
  const out: string[] = [];
  for (let m = 0; m < 12; m++) out.push(firstFridayOfMonth(year, m));
  return out;
}

const NFP_DATES: string[] = [...buildNFPs(2025), ...buildNFPs(2026)];

function fallbackEvents(): EconEvent[] {
  const out: EconEvent[] = [];
  for (const date of FOMC_DATES) {
    out.push({
      timeISO: `${date}T18:00:00Z`,
      date,
      type: "FOMC",
      label: "FOMC (Fed)",
      impact: "high",
      country: "USD",
      source: "fallback",
    });
  }
  for (const date of NFP_DATES) {
    out.push({
      timeISO: `${date}T12:30:00Z`,
      date,
      type: "NFP",
      label: "NFP (Empleo USA)",
      impact: "high",
      country: "USD",
      source: "fallback",
    });
  }
  return out;
}

// ------------- Feed remoto (ForexFactory JSON gratuito) -------------

type FFEntry = {
  title: string;
  country: string;
  date: string;      // ISO con offset (ej: "2024-01-05T08:30:00-05:00")
  impact: string;    // "High" | "Medium" | "Low" | "Holiday"
};

const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

type CacheEntry = { at: number; events: EconEvent[] };
let CACHE: CacheEntry | null = null;

function classify(title: string): EconEvent["type"] {
  const t = title.toLowerCase();
  if (t.includes("fomc") || t.includes("federal funds") || t.includes("fed chair")) return "FOMC";
  if (t.includes("non-farm") || t.includes("nonfarm") || t.includes("nfp")) return "NFP";
  if (t.includes("cpi") || t.includes("consumer price")) return "CPI";
  return "OTHER";
}

async function fetchForexFactory(): Promise<EconEvent[]> {
  const res = await fetch(FF_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (Lovable Trading Compass)" },
  });
  if (!res.ok) throw new Error(`FF ${res.status}`);
  const raw = (await res.json()) as FFEntry[];
  return raw
    .filter((e) => e.country === "USD" && e.impact?.toLowerCase() === "high")
    .map((e) => {
      const d = new Date(e.date);
      const iso = d.toISOString();
      return {
        timeISO: iso,
        date: iso.slice(0, 10),
        type: classify(e.title),
        label: e.title,
        impact: "high" as const,
        country: "USD",
        source: "forexfactory" as const,
      };
    });
}

/** Devuelve el calendario combinado (feed remoto + fallback). Cachea 6h. */
export async function fetchUpcomingEvents(): Promise<EconEvent[]> {
  const now = Date.now();
  if (CACHE && now - CACHE.at < CACHE_TTL_MS) return CACHE.events;
  const fallback = fallbackEvents();
  try {
    const remote = await fetchForexFactory();
    // dedupe por (date + type + label)
    const seen = new Set<string>();
    const merged: EconEvent[] = [];
    for (const e of [...remote, ...fallback]) {
      const k = `${e.date}|${e.type}|${e.label}`;
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(e);
    }
    merged.sort((a, b) => a.timeISO.localeCompare(b.timeISO));
    CACHE = { at: now, events: merged };
    return merged;
  } catch (err) {
    console.warn("[econ-calendar] feed failed, using fallback:", (err as Error).message);
    const sorted = [...fallback].sort((a, b) => a.timeISO.localeCompare(b.timeISO));
    // caché corta para reintentar antes
    CACHE = { at: now - (CACHE_TTL_MS - 15 * 60 * 1000), events: sorted };
    return sorted;
  }
}

/** Sync: sólo fallback. Útil para UI o casos donde no queremos await. */
export function getFallbackEvents(): EconEvent[] {
  return fallbackEvents().sort((a, b) => a.timeISO.localeCompare(b.timeISO));
}

/**
 * ¿`now` cae dentro de ±`windowMinutes` de algún evento high-impact USD?
 * Devuelve el evento en cuestión o null.
 */
export function findBlockingEvent(
  events: EconEvent[],
  now: Date,
  windowMinutes: number,
): EconEvent | null {
  const nowMs = now.getTime();
  const win = windowMinutes * 60 * 1000;
  for (const e of events) {
    if (e.impact !== "high") continue;
    const t = new Date(e.timeISO).getTime();
    if (Math.abs(t - nowMs) <= win) return e;
  }
  return null;
}

export function getNextEvent(events: EconEvent[], from: Date = new Date()): EconEvent | null {
  const nowMs = from.getTime();
  for (const e of events) {
    if (new Date(e.timeISO).getTime() >= nowMs) return e;
  }
  return null;
}

// ---- Compat helpers (browser-friendly, sólo fallback) ----
// Firmas antiguas que el dashboard sigue usando; no dependen del feed remoto.

export function getTodayEvents(): EconEvent[] {
  const today = new Date().toISOString().slice(0, 10);
  return getFallbackEvents().filter((e) => e.date === today);
}

export function getNextFallbackEvent(from: Date = new Date()): EconEvent | null {
  return getNextEvent(getFallbackEvents(), from);
}