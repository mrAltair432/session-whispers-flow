import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type EngineHealthRow = {
  engine: string;
  consecutive_losses: number;
  total_closed: number;
  total_r: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  updated_at: string;
};

export type RealTradeRow = {
  id: string;
  engine: string;
  bias: string;
  score: number;
  confidence: string;
  entry: number;
  stop_loss: number;
  tp1: number;
  status: string;
  mt5_ticket: number | null;
  fill_price: number | null;
  filled_at: string | null;
  exit_price: number | null;
  pnl_usd: number | null;
  r_multiple: number | null;
  closed_reason: string | null;
  closed_at: string | null;
  created_at: string;
};

// Devuelve el estado del token EA del usuario. No expone el token en el listado
// — sólo indica si existe y cuándo fue usado por última vez.
export const getMyEaToken = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("mt5_ea_tokens")
      .select("id, label, last_used_at, created_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

// Genera (o rota) el token del EA. Guarda un token aleatorio hex de 32 bytes.
// Devuelve el token en claro UNA sola vez para que el usuario lo copie.
export const rotateMyEaToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("mt5_ea_tokens")
      .upsert(
        { user_id: context.userId, token, label: "default" },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { token };
  });

export const deleteMyEaToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("mt5_ea_tokens")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getMyMt5Diagnostics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: token, error: tokenError } = await context.supabase
      .from("mt5_ea_tokens")
      .select("id, last_used_at, created_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (tokenError) throw new Error(tokenError.message);

    const { data: config, error: configError } = await context.supabase
      .from("user_config")
      .select("mt5_auto_route_enabled, mt5_min_confidence")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (configError) throw new Error(configError.message);

    const nowIso = new Date().toISOString();
    const { count: pendingCount, error: pendingError } = await context.supabase
      .from("mt5_signals")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("status", "pending")
      .gte("expires_at", nowIso);
    if (pendingError) throw new Error(pendingError.message);

    const { data: latestSignal, error: latestError } = await context.supabase
      .from("mt5_signals")
      .select("id, engine, bias, status, confidence, score, error_message, created_at, expires_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw new Error(latestError.message);

    return {
      token_exists: Boolean(token),
      last_used_at: token?.last_used_at ?? null,
      token_created_at: token?.created_at ?? null,
      auto_route_enabled: config?.mt5_auto_route_enabled ?? false,
      min_confidence: config?.mt5_min_confidence ?? "high",
      pending_count: pendingCount ?? 0,
      latest_signal: latestSignal ?? null,
      checked_at: nowIso,
    };
  });

export const getMyEngineHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<EngineHealthRow[]> => {
    const { data, error } = await context.supabase
      .from("engine_health")
      .select("engine, consecutive_losses, total_closed, total_r, disabled_at, disabled_reason, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as EngineHealthRow[];
  });

export const getMyRealTrades = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RealTradeRow[]> => {
    const { data, error } = await context.supabase
      .from("mt5_signals")
      .select(
        "id, engine, bias, score, confidence, entry, stop_loss, tp1, status, mt5_ticket, fill_price, filled_at, exit_price, pnl_usd, r_multiple, closed_reason, closed_at, created_at",
      )
      .eq("user_id", context.userId)
      .in("status", ["filled", "closed", "error"])
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as RealTradeRow[];
  });