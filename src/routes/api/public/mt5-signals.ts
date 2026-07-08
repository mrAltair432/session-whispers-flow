import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Endpoint puente entre el dashboard/EA y MT5.
// Autenticación por token del EA (tabla public.mt5_ea_tokens), enviado en
// el header `X-EA-Token` o como query `?token=...`.
//
// GET  → devuelve la señal pending más reciente (o null) para el usuario dueño
//        del token, y la marca como 'sent'.
// POST → el EA reporta fills / cierres / errores.
//
// Este endpoint es "tonto": no evalúa estrategias ni decide nada; solo mueve
// filas entre estados. Toda la inteligencia vive en el dashboard/Colab.

export const Route = createFileRoute("/api/public/mt5-signals")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = extractToken(request);
        if (!token) return json({ error: "missing token" }, 401);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: tok, error: tokErr } = await supabaseAdmin
          .from("mt5_ea_tokens")
          .select("user_id")
          .eq("token", token)
          .maybeSingle();
        if (tokErr || !tok) return json({ error: "invalid token" }, 401);

        // touch last_used_at (best-effort)
        await supabaseAdmin
          .from("mt5_ea_tokens")
          .update({ last_used_at: new Date().toISOString() })
          .eq("token", token);

        const nowIso = new Date().toISOString();
        // 1. Marcar como expiradas las pending vencidas
        await supabaseAdmin
          .from("mt5_signals")
          .update({ status: "cancelled", error_message: "expired" })
          .eq("user_id", tok.user_id)
          .eq("status", "pending")
          .lt("expires_at", nowIso);

        // 2. Traer la pending más reciente vigente
        const { data: sig } = await supabaseAdmin
          .from("mt5_signals")
          .select("*")
          .eq("user_id", tok.user_id)
          .eq("status", "pending")
          .gte("expires_at", nowIso)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!sig) return json({ signal: null });

        // 3. Marcarla como enviada al EA
        await supabaseAdmin
          .from("mt5_signals")
          .update({ status: "sent" })
          .eq("id", sig.id);

        return json({ signal: sig });
      },

      POST: async ({ request }) => {
        const token = extractToken(request);
        if (!token) return json({ error: "missing token" }, 401);
        let body: unknown;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }

        const schema = z.object({
          signal_id: z.string().uuid(),
          action: z.enum(["filled", "closed", "error"]),
          mt5_ticket: z.number().int().optional(),
          fill_price: z.number().optional(),
          exit_price: z.number().optional(),
          pnl_usd: z.number().optional(),
          r_multiple: z.number().optional(),
          error_message: z.string().max(500).optional(),
        });
        const parsed = schema.safeParse(body);
        if (!parsed.success) return json({ error: "invalid payload", details: parsed.error.flatten() }, 400);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: tok } = await supabaseAdmin
          .from("mt5_ea_tokens")
          .select("user_id")
          .eq("token", token)
          .maybeSingle();
        if (!tok) return json({ error: "invalid token" }, 401);

        // Verifica pertenencia
        const { data: sig } = await supabaseAdmin
          .from("mt5_signals")
          .select("id, user_id, status")
          .eq("id", parsed.data.signal_id)
          .maybeSingle();
        if (!sig || sig.user_id !== tok.user_id) return json({ error: "signal not found" }, 404);

        const patch: Record<string, unknown> = {};
        if (parsed.data.action === "filled") {
          patch.status = "filled";
          patch.filled_at = new Date().toISOString();
          if (parsed.data.mt5_ticket !== undefined) patch.mt5_ticket = parsed.data.mt5_ticket;
          if (parsed.data.fill_price !== undefined) patch.fill_price = parsed.data.fill_price;
        } else if (parsed.data.action === "closed") {
          patch.status = "closed";
          patch.closed_at = new Date().toISOString();
          if (parsed.data.exit_price !== undefined) patch.exit_price = parsed.data.exit_price;
          if (parsed.data.pnl_usd !== undefined) patch.pnl_usd = parsed.data.pnl_usd;
          if (parsed.data.r_multiple !== undefined) patch.r_multiple = parsed.data.r_multiple;
        } else {
          patch.status = "error";
          patch.error_message = parsed.data.error_message ?? "unknown";
        }

        await supabaseAdmin.from("mt5_signals").update(patch).eq("id", sig.id);
        return json({ ok: true });
      },
    },
  },
});

function extractToken(req: Request): string | null {
  const h = req.headers.get("x-ea-token") ?? req.headers.get("X-EA-Token");
  if (h) return h.trim();
  const url = new URL(req.url);
  const q = url.searchParams.get("token");
  return q ? q.trim() : null;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}