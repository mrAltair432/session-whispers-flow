import type { Candle } from "./analysis";

// Parses a CSV exported in the "XAUUSD Historical Data" format
// Header row 1: "XAUUSD Historical Data"
// Header row 2: Date,Open,High,Low,Close,Change(Pips),Change(%),
// Data rows:    MM/DD/YYYY HH:MM,open,high,low,close,...
// Rows are typically descending; we sort ascending by time.
export function parseXauHistoricalCsv(text: string): Candle[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Candle[] = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const dateStr = parts[0];
    // Match MM/DD/YYYY HH:MM
    const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const [, mm, dd, yyyy, hh, mi] = m;
    const open = parseFloat(parts[1]);
    const high = parseFloat(parts[2]);
    const low = parseFloat(parts[3]);
    const close = parseFloat(parts[4]);
    if ([open, high, low, close].some((v) => !Number.isFinite(v))) continue;
    const t = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, 0) / 1000;
    out.push({ time: t, open, high, low, close });
  }
  out.sort((a, b) => a.time - b.time);
  // Dedup by time
  const dedup: Candle[] = [];
  for (const c of out) {
    if (!dedup.length || dedup[dedup.length - 1].time !== c.time) dedup.push(c);
  }
  return dedup;
}

// Heuristically detect the timeframe (minutes) of a Candle array by median gap.
export function detectTimeframeMinutes(candles: Candle[]): number {
  if (candles.length < 3) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    gaps.push((candles[i].time - candles[i - 1].time) / 60);
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}