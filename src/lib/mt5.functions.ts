import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Devuelve el estado del token EA del usuario. No expone el token en el listado
// — sólo indica si existe y cuándo fue usado por última vez.
export const getMyEaToken = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("mt5_ea_tokens")
      .select("id, token, label, last_used_at, created_at")
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