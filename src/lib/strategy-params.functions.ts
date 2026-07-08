import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
type Json = Database["public"]["Tables"]["strategy_params"]["Insert"]["params"];

const ENGINE_KEYS = [
  "smc_london",
  "ny_continuation",
  "fibo_scalping",
  "gold_scalping",
  "ema_cross_m1",
  "straddle_breakout",
] as const;

export const listMyStrategyParams = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("strategy_params")
      .select("engine_key, params, metrics, source, generated_at, updated_at")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

// Sube el JSON generado por Colab (export_best_params). Formato esperado:
//   { version:1, generated_at:ISO, engines:{ <key>:{ params:{}, metrics:{} } } }
// Se hace upsert por (user_id, engine_key). Ignora engines desconocidos.
const uploadSchema = z.object({
  version: z.number().optional(),
  generated_at: z.string().optional(),
  engines: z.record(
    z.string(),
    z.object({
      params: z.record(z.string(), z.unknown()).default({}),
      metrics: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
});

export const uploadBestParams = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => uploadSchema.parse(data))
  .handler(async ({ data, context }) => {
    const rows = Object.entries(data.engines)
      .filter(([key]) => (ENGINE_KEYS as readonly string[]).includes(key))
      .map(([key, v]) => ({
        user_id: context.userId,
        engine_key: key,
        params: v.params as Json,
        metrics: v.metrics as Json,
        source: "colab",
        generated_at: data.generated_at ?? null,
      }));
    if (!rows.length) return { upserted: 0, skipped: Object.keys(data.engines).length };
    const { error } = await context.supabase
      .from("strategy_params")
      .upsert(rows, { onConflict: "user_id,engine_key" });
    if (error) throw new Error(error.message);
    return { upserted: rows.length, skipped: Object.keys(data.engines).length - rows.length };
  });

export const deleteStrategyParams = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ engine_key: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("strategy_params")
      .delete()
      .eq("user_id", context.userId)
      .eq("engine_key", data.engine_key);
    if (error) throw new Error(error.message);
    return { ok: true };
  });