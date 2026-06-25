import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const saveSchema = z.object({
  bias: z.enum(["long", "short"]),
  confidence: z.enum(["high", "medium"]),
  entry: z.number(),
  stop_loss: z.number(),
  tp1: z.number(),
  tp2: z.number(),
  tp3: z.number().nullable(),
  lot_size: z.number(),
  risk_usd: z.number(),
  reasoning: z.record(z.string(), z.unknown()),
  send_telegram: z.boolean().optional(),
});

export const saveSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { send_telegram, ...row } = data;
    const { data: inserted, error } = await context.supabase
      .from("setups")
      .insert({
        ...row,
        reasoning: row.reasoning as never,
        user_id: context.userId,
        status: send_telegram ? "sent" : "pending",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    if (send_telegram) {
      try {
        await sendTelegramAlert(context.userId, inserted.id, data);
        await context.supabase
          .from("setups")
          .update({ telegram_sent_at: new Date().toISOString() })
          .eq("id", inserted.id);
      } catch (e) {
        console.error("Telegram send failed:", e);
      }
    }
    return inserted;
  });

async function sendTelegramAlert(userId: string, setupId: string, s: z.infer<typeof saveSchema>) {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const telegramKey = process.env.TELEGRAM_API_KEY;
  if (!lovableKey || !telegramKey) {
    throw new Error("Telegram no está conectado todavía");
  }
  // Get chat_id from config
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: cfg } = await supabaseAdmin
    .from("user_config")
    .select("telegram_chat_id, telegram_enabled")
    .eq("user_id", userId)
    .single();
  if (!cfg?.telegram_enabled || !cfg.telegram_chat_id) throw new Error("Telegram no configurado");

  const arrow = s.bias === "long" ? "🟢 LONG" : "🔴 SHORT";
  const conf = s.confidence === "high" ? "🔥 ALTA" : "✋ MEDIA";
  const text = `<b>${arrow}  XAU/USD</b>\nConfianza: ${conf}\n\n` +
    `Entrada: <code>${s.entry}</code>\n` +
    `SL: <code>${s.stop_loss}</code>\n` +
    `TP1: <code>${s.tp1}</code> (1R)\n` +
    `TP2: <code>${s.tp2}</code> (2R)\n` +
    (s.tp3 ? `TP3: <code>${s.tp3}</code> (3R)\n` : "") +
    `\nLote: <b>${s.lot_size}</b>   Riesgo: <b>$${s.risk_usd}</b>\n\n` +
    `<i>Plan:</i> cerrar 50% en TP1 + SL a BE, 30% en TP2, 20% runner.\n\n` +
    `ID: ${setupId.slice(0, 8)}`;

  const res = await fetch("https://connector-gateway.lovable.dev/telegram/sendMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": telegramKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chat_id: cfg.telegram_chat_id, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram error ${res.status}: ${body}`);
  }
}

export const getRecentSetups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("setups")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    return data;
  });