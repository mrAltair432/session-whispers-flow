import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listMyScorers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("ml_scorers")
      .select("engine, features, weights, intercept, auc, trained_at")
      .eq("user_id", context.userId)
      .order("trained_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const uploadSchema = z.object({
  engine: z.string().min(1).max(64),
  features: z.array(z.string().min(1)).min(1).max(64),
  weights: z.array(z.number()).min(1).max(64),
  intercept: z.number(),
  auc: z.number().min(0).max(1).optional(),
});

export const uploadMyScorer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => uploadSchema.parse(data))
  .handler(async ({ data, context }) => {
    if (data.features.length !== data.weights.length) {
      throw new Error("features y weights deben tener el mismo largo");
    }
    const { error } = await context.supabase
      .from("ml_scorers")
      .upsert(
        {
          user_id: context.userId,
          engine: data.engine,
          features: data.features,
          weights: data.weights,
          intercept: data.intercept,
          auc: data.auc ?? null,
          trained_at: new Date().toISOString(),
        },
        { onConflict: "user_id,engine" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteMyScorer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ engine: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("ml_scorers")
      .delete()
      .eq("user_id", context.userId)
      .eq("engine", data.engine);
    if (error) throw new Error(error.message);
    return { ok: true };
  });