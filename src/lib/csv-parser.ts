import type { Candle } from "./analysis";

// Acepta dos formatos:
//  - Investing/Web: "MM/DD/YYYY HH:MM,open,high,low,close,..."
//  - MT5 (script propio): "YYYY.MM.DD HH:MM,open,high,low,close,volume"
// Devuelve velas ordenadas ascendentemente por tiempo y deduplicadas.
export function parseXauHistoricalCsv(text: string): Candle[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Candle[] = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const dateStr = parts[0].replace(/"/g, "");
    let yyyy: string, mm: string, dd: string, hh: string, mi: string;
    const mtMt5 = dateStr.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
    const mtUs  = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (mtMt5) {
      [, yyyy, mm, dd, hh, mi] = mtMt5;
    } else if (mtUs) {
      [, mm, dd, yyyy, hh, mi] = mtUs;
    } else {
      continue;
    }
    const open  = parseFloat(parts[1]);
    const high  = parseFloat(parts[2]);
    const low   = parseFloat(parts[3]);
    const close = parseFloat(parts[4]);
    if ([open, high, low, close].some((v) => !Number.isFinite(v))) continue;
    const t = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, 0) / 1000;
    out.push({ time: t, open, high, low, close });
  }
  out.sort((a, b) => a.time - b.time);
  const dedup: Candle[] = [];
  for (const c of out) {
    if (!dedup.length || dedup[dedup.length - 1].time !== c.time) dedup.push(c);
  }
  return dedup;
}

export function detectTimeframeMinutes(candles: Candle[]): number {
  if (candles.length < 3) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    gaps.push((candles[i].time - candles[i - 1].time) / 60);
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

export type TfKey = "M1" | "M5" | "M15" | "H1" | "H4" | "D1";

export function classifyTimeframe(mins: number): TfKey | null {
  if (mins >= 0.9 && mins <= 1.5) return "M1";
  if (mins >= 4 && mins <= 6) return "M5";
  if (mins >= 13 && mins <= 20) return "M15";
  if (mins >= 55 && mins <= 75) return "H1";
  if (mins >= 220 && mins <= 260) return "H4";
  if (mins >= 1300 && mins <= 1500) return "D1";
  return null;
}

export const TF_MINUTES: Record<TfKey, number> = {
  M1: 1, M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440,
};

// Agrega velas OHLC de un TF pequeño a uno mayor. Alinea buckets al epoch UTC
// (Math.floor(time/bucket)*bucket) — coincide con el corte que MT5 usa para
// cerrar velas H1/H4/D1 en tiempo servidor UTC.
export function aggregateCandles(source: Candle[], targetMinutes: number): Candle[] {
  if (!source.length || targetMinutes <= 0) return [];
  const bucketSec = targetMinutes * 60;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curBucket = -1;
  for (const c of source) {
    const b = Math.floor(c.time / bucketSec) * bucketSec;
    if (b !== curBucket) {
      if (cur) out.push(cur);
      cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close };
      curBucket = b;
    } else if (cur) {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}