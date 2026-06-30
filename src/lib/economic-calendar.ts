// Eventos macroeconómicos de alto impacto para XAU/USD.
// Fechas en formato YYYY-MM-DD (UTC). FOMC = decisión de tasas Fed.
// NFP = primer viernes del mes (Non-Farm Payrolls) a las 12:30 UTC.
// Lista verificada para 2025-2026. Actualizar manualmente al inicio de cada año.

export type EconEvent = {
  date: string;        // YYYY-MM-DD UTC
  type: "FOMC" | "NFP" | "CPI";
  label: string;
  timeUTC?: string;    // HH:MM aproximado
};

// FOMC oficial Fed (decisión de tasas)
const FOMC: string[] = [
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

const NFP: string[] = [...buildNFPs(2025), ...buildNFPs(2026)];

export const ECON_EVENTS: EconEvent[] = [
  ...FOMC.map((date) => ({ date, type: "FOMC" as const, label: "FOMC (Fed)", timeUTC: "18:00" })),
  ...NFP.map((date) => ({ date, type: "NFP" as const, label: "NFP (Empleo USA)", timeUTC: "12:30" })),
];

const EVENT_MAP = new Map<string, EconEvent[]>();
for (const e of ECON_EVENTS) {
  const arr = EVENT_MAP.get(e.date) ?? [];
  arr.push(e);
  EVENT_MAP.set(e.date, arr);
}

export function getEventsForDate(d: Date): EconEvent[] {
  const key = d.toISOString().slice(0, 10);
  return EVENT_MAP.get(key) ?? [];
}

export function getTodayEvents(): EconEvent[] {
  return getEventsForDate(new Date());
}

export function getNextEvent(from: Date = new Date()): EconEvent | null {
  const today = from.toISOString().slice(0, 10);
  const upcoming = ECON_EVENTS
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  return upcoming[0] ?? null;
}