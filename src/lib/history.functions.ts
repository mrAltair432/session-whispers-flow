import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type EngineHistoryStats = {
  engine: string;
  total: number;
  closed: number;
  wins: number;
  losses: number;
  breakeven: number;
  winrate: number;
  totalR: number;
  avgR: number;
  lastSignalAt: string | null;
};

export type SignalEventRow = {
  id: string;
  engine: string;
  bias: string;
  score: number;
  confidence: string;
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp3: number | null;
  outcome: string | null;
  r_multiple: number | null;
  exit_price: number | null;
  entry_time: string | null;
  closed_at: string | null;
  telegram_sent: boolean;
  created_at: string;
};

export const getEngineStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<EngineHistoryStats[]> => {
    const { data, error } = await context.supabase
      .from("signal_events")
      .select("engine, outcome, r_multiple, created_at")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    const byEngine = new Map<string, EngineHistoryStats>();
    for (const row of data ?? []) {
      const key = row.engine;
      const cur = byEngine.get(key) ?? {
        engine: key,
        total: 0, closed: 0, wins: 0, losses: 0, breakeven: 0,
        winrate: 0, totalR: 0, avgR: 0, lastSignalAt: null,
      };
      cur.total += 1;
      if (!cur.lastSignalAt || row.created_at > cur.lastSignalAt) cur.lastSignalAt = row.created_at;
      if (row.outcome && row.r_multiple !== null) {
        cur.closed += 1;
        const r = Number(row.r_multiple);
        cur.totalR += r;
        if (r > 0.05) cur.wins += 1;
        else if (r < -0.05) cur.losses += 1;
        else cur.breakeven += 1;
      }
      byEngine.set(key, cur);
    }
    return Array.from(byEngine.values()).map((s) => ({
      ...s,
      winrate: s.closed > 0 ? s.wins / s.closed : 0,
      avgR: s.closed > 0 ? s.totalR / s.closed : 0,
    }));
  });

export const getRecentSignals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SignalEventRow[]> => {
    const { data, error } = await context.supabase
      .from("signal_events")
      .select("id, engine, bias, score, confidence, entry, stop_loss, tp1, tp2, tp3, outcome, r_multiple, exit_price, entry_time, closed_at, telegram_sent, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as SignalEventRow[];
  });