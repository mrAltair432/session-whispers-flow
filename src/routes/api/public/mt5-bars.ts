import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Ingesta de velas del broker enviadas por el EA (LovableBridge v0.14+).
// Autenticación por token del EA (X-EA-Token o ?token=).
//
// POST body:
// {
//   "symbol": "XAUUSD",
//   "spread": 0.18,
//   "broker": "Exness-MT5Real",
//   "tf": "M1",
//   "bars": [[epochSeconds, open, high, low, close], ...]   // orden ascendente
// }
//
// El EA envía un TF por petición (MQL5 no maneja bien payloads gigantes).
// El servidor hace upsert por (user_id, symbol, tf, bar_time) y poda lo viejo.

const TF_RETENTION_MIN: Record<string, number> = {
  M1: 60 * 30,        // 30 h de M1
  M5: 60 * 96,        // 4 días
  M15: 60 * 24 * 10,  // 10 días
  H1: 60 * 24 * 30,   // 30 días
  H4: 60 * 24 * 120,  // 120 días
  D1: 60 * 24 * 400,  // ~13 meses
};

const schema = z.object({
  symbol: z.string().max(24).default("XAUUSD"),
  broker: z.string().max(64).optional(),
  spread: z.number().optional(),
  tf: z.enum(["M1", "M5", "M15", "H1", "H4", "D1"]),
  bars: z
    .array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]))
    .max(3000),
});

export const Route = createFileRoute("/api/public/mt5-bars")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = extractToken(request);
        if (!token) return json({ error: "missing token" }, 401);

        let body: unknown;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const parsed = schema.safeParse(body);
        if (!parsed.success) return json({ error: "invalid payload", details: parsed.error.flatten() }, 400);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: tok } = await supabaseAdmin
          .from("mt5_ea_tokens")
          .select("user_id")
          .eq("token", token)
          .maybeSingle();
        if (!tok) return json({ error: "invalid token" }, 401);

        const { symbol, tf, bars } = parsed.data;
        const nowIso = new Date().toISOString();

        const rows = bars
          .filter(([t, o, h, l, c]) => t > 0 && o > 0 && h > 0 && l > 0 && c > 0)
          .map(([t, o, h, l, c]) => ({
            user_id: tok.user_id,
            symbol,
            tf,
            bar_time: new Date(t * 1000).toISOString(),
            open: o,
            high: h,
            low: l,
            close: c,
            updated_at: nowIso,
          }));

        if (rows.length) {
          // chunks para no reventar el límite de payload de PostgREST
          for (let i = 0; i < rows.length; i += 500) {
            const { error } = await supabaseAdmin
              .from("broker_bars")
              .upsert(rows.slice(i, i + 500), { onConflict: "user_id,symbol,tf,bar_time" });
            if (error) return json({ error: error.message }, 500);
          }
        }

        // Poda: mantiene solo la ventana útil por TF.
        const retention = TF_RETENTION_MIN[tf] ?? 60 * 24;
        const cutoff = new Date(Date.now() - retention * 60_000).toISOString();
        await supabaseAdmin
          .from("broker_bars")
          .delete()
          .eq("user_id", tok.user_id)
          .eq("symbol", symbol)
          .eq("tf", tf)
          .lt("bar_time", cutoff);

        const lastBarTime = rows.length ? rows[rows.length - 1].bar_time : null;
        await supabaseAdmin.from("broker_feed_status").upsert(
          {
            user_id: tok.user_id,
            symbol,
            broker: parsed.data.broker ?? null,
            spread_usd: parsed.data.spread ?? null,
            last_push_at: nowIso,
            last_bar_time: lastBarTime,
            bars_received: rows.length,
            updated_at: nowIso,
          },
          { onConflict: "user_id" },
        );

        await supabaseAdmin
          .from("mt5_ea_tokens")
          .update({ last_used_at: nowIso })
          .eq("token", token);

        return json({ ok: true, tf, stored: rows.length });
      },
    },
  },
});

function extractToken(req: Request): string | null {
  const h = req.headers.get("x-ea-token") ?? req.headers.get("X-EA-Token");
  if (h) return h.trim();
  const q = new URL(req.url).searchParams.get("token");
  return q ? q.trim() : null;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
