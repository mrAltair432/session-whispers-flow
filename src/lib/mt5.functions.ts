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