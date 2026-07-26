import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const getMyConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_config")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

const updateSchema = z.object({
  balance: z.number().min(1).max(10_000_000),
  risk_per_trade: z.number().min(0.05).max(5),
  max_daily_loss_pct: z.number().min(0.1).max(10),
  max_trades_per_day: z.number().int().min(1).max(10),
  telegram_chat_id: z.string().nullable(),
  telegram_enabled: z.boolean(),
  auto_alert_high_confidence: z.boolean(),
  mt5_auto_route_enabled: z.boolean().optional(),
  mt5_min_confidence: z.enum(["high", "medium"]).optional(),
  mt5_enabled_engines: z.array(z.string()).nullable().optional(),
});

export const updateMyConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("user_config")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getDailyStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await context.supabase
      .from("daily_stats")
      .select("*")
      .eq("user_id", context.userId)
      .eq("trade_date", today)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? { trade_date: today, trades_count: 0, pnl_usd: 0, loss_usd: 0, blocked: false };
  });