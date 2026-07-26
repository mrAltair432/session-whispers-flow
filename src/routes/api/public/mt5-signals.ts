import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Endpoint puente entre el dashboard/EA y MT5.
// Autenticación por token del EA (tabla public.mt5_ea_tokens), enviado en
// el header `X-EA-Token` o como query `?token=...`.
//
// GET  → devuelve la señal pending más reciente (o null) para el usuario dueño
//        del token, y la marca como 'sent'. Si viene `?diag=1`, solo prueba
//        conexión/token y NO entrega señales ni abre operaciones.
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
        const url = new URL(request.url);
        const diagnosticOnly = url.searchParams.get("diag") === "1";
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: tok, error: tokErr } = await supabaseAdmin
          .from("mt5_ea_tokens")
          .select("user_id, last_used_at")
          .eq("token", token)
          .maybeSingle();
        if (tokErr || !tok) return json({ error: "invalid token" }, 401);

        // touch last_used_at (best-effort)
        await supabaseAdmin
          .from("mt5_ea_tokens")
          .update({ last_used_at: new Date().toISOString() })
          .eq("token", token);

        const nowIso = new Date().toISOString();

        if (diagnosticOnly) {
          const { count: pendingCount } = await supabaseAdmin
            .from("mt5_signals")
            .select("id", { count: "exact", head: true })
            .eq("user_id", tok.user_id)
            .eq("status", "pending")
            .gte("expires_at", nowIso);

          const { data: latest } = await supabaseAdmin
            .from("mt5_signals")
            .select("id, engine, bias, status, confidence, score, error_message, created_at, expires_at")
            .eq("user_id", tok.user_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          return json({
            ok: true,
            mode: "diagnostic",
            token: "valid",
            server_time: nowIso,
            pending_count: pendingCount ?? 0,
            latest_signal: latest ?? null,
          });
        }

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
          closed_reason: z.enum(["tp1", "tp2", "tp3", "sl", "manual", "time", "margin", "error"]).optional(),
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
          .select("id, user_id, status, signal_event_id, engine, entry, stop_loss, bias, risk_usd")
          .eq("id", parsed.data.signal_id)
          .maybeSingle();
        if (!sig || sig.user_id !== tok.user_id) return json({ error: "signal not found" }, 404);

        const nowIso = new Date().toISOString();
        const patch: {
          status?: string;
          filled_at?: string;
          closed_at?: string;
          mt5_ticket?: number;
          fill_price?: number;
          exit_price?: number;
          pnl_usd?: number;
          r_multiple?: number;
          closed_reason?: string;
          error_message?: string;
        } = {};
        if (parsed.data.action === "filled") {
          patch.status = "filled";
          patch.filled_at = nowIso;
          if (parsed.data.mt5_ticket !== undefined) patch.mt5_ticket = parsed.data.mt5_ticket;
          if (parsed.data.fill_price !== undefined) patch.fill_price = parsed.data.fill_price;
        } else if (parsed.data.action === "closed") {
          patch.status = "closed";
          patch.closed_at = nowIso;
          if (parsed.data.exit_price !== undefined) patch.exit_price = parsed.data.exit_price;
          if (parsed.data.pnl_usd !== undefined) patch.pnl_usd = parsed.data.pnl_usd;
          if (parsed.data.r_multiple !== undefined) patch.r_multiple = parsed.data.r_multiple;
          if (parsed.data.closed_reason !== undefined) patch.closed_reason = parsed.data.closed_reason;
        } else {
          patch.status = "error";
          patch.error_message = parsed.data.error_message ?? "unknown";
        }

        await supabaseAdmin.from("mt5_signals").update(patch).eq("id", sig.id);

        // --- D. R efectivo del cierre (usado en signal_events y en kill-switch).
        let effectiveR = parsed.data.r_multiple ?? 0;
        if (effectiveR === 0 && typeof parsed.data.pnl_usd === "number" && sig.risk_usd && Number(sig.risk_usd) > 0) {
          effectiveR = parsed.data.pnl_usd / Number(sig.risk_usd);
        }
        const isLoss = (typeof parsed.data.r_multiple === "number" && parsed.data.r_multiple < -0.05)
          || (typeof parsed.data.pnl_usd === "number" && parsed.data.pnl_usd < 0);

        // --- E. Reflejar el cierre nativo del EA en signal_events para que
        // el historial / winrate del dashboard se actualice sin intervención.
        if (parsed.data.action === "closed" && sig.signal_event_id) {
          let outcome: "win" | "loss" | "breakeven" = "breakeven";
          if (effectiveR > 0.05) outcome = "win";
          else if (effectiveR < -0.05) outcome = "loss";
          await supabaseAdmin
            .from("signal_events")
            .update({
              outcome,
              r_multiple: effectiveR,
              exit_price: parsed.data.exit_price ?? null,
              closed_at: nowIso,
            })
            .eq("id", sig.signal_event_id);
        }

        // --- F. Kill-switch automático: si el cierre es una pérdida,
        // evaluamos salud de la estrategia y la desactivamos si es necesario.
        if (parsed.data.action === "closed" && sig.engine) {
          let r = effectiveR;

          // Recompute health from last 20 closed real trades for this engine
          const { data: recentClosed } = await supabaseAdmin
            .from("mt5_signals")
            .select("r_multiple")
            .eq("user_id", tok.user_id)
            .eq("engine", sig.engine)
            .eq("status", "closed")
            .not("r_multiple", "is", null)
            .order("closed_at", { ascending: false })
            .limit(20);

          let totalR = 0;
          let consecutiveLosses = 0;
          for (const row of recentClosed ?? []) {
            const rowR = Number(row.r_multiple ?? 0);
            totalR += rowR;
          }
          // Count consecutive losses from most recent
          for (const row of recentClosed ?? []) {
            const rowR = Number(row.r_multiple ?? 0);
            if (rowR < -0.05) consecutiveLosses += 1;
            else break;
          }

          const totalClosed = recentClosed?.length ?? 0;
          const disabled = totalR <= -3 || consecutiveLosses >= 5;

          await supabaseAdmin
            .from("engine_health")
            .upsert({
              user_id: tok.user_id,
              engine: sig.engine,
              consecutive_losses: consecutiveLosses,
              total_closed: totalClosed,
              total_r: totalR,
              updated_at: nowIso,
            }, { onConflict: "user_id, engine" });

          if (disabled) {
            const reason = totalR <= -3
              ? `−${Math.abs(totalR).toFixed(2)}R en últimos ${totalClosed} trades`
              : `${consecutiveLosses} SL consecutivos`;

            await supabaseAdmin
              .from("engine_health")
              .update({ disabled_at: nowIso, disabled_reason: reason, updated_at: nowIso })
              .eq("user_id", tok.user_id)
              .eq("engine", sig.engine);

            // Remove engine from enabled list
            const { data: cfg } = await supabaseAdmin
              .from("user_config")
              .select("mt5_enabled_engines")
              .eq("user_id", tok.user_id)
              .maybeSingle();
            const enabled = (cfg?.mt5_enabled_engines ?? []) as string[];
            const next = enabled.filter((k) => k !== sig.engine);
            if (next.length !== enabled.length) {
              await supabaseAdmin
                .from("user_config")
                .update({ mt5_enabled_engines: next, updated_at: nowIso })
                .eq("user_id", tok.user_id);
            }

            // Notify via Telegram
            try {
              const { sendTelegramToUser } = await import("@/lib/telegram.server");
              await sendTelegramToUser(
                tok.user_id,
                `<b>🛡️ Kill-switch activado</b>\n\n` +
                `La estrategia <b>${sig.engine}</b> ha sido desconectada del EA automáticamente.\n` +
                `Motivo: ${reason}.\n\n` +
                `Revisa Settings → MT5 si quieres volver a activarla manualmente.`,
              );
            } catch (e) {
              console.error("Kill-switch telegram failed:", e);
            }
          }
        }

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