import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export async function sendTelegramToUser(
  userId: string,
  text: string,
  opts: { parse_mode?: "HTML" | "Markdown" } = {},
) {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const telegramKey = process.env.TELEGRAM_API_KEY;
  if (!lovableKey || !telegramKey) {
    throw new Error("Telegram connector not configured");
  }

  const supabase = createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: cfg } = await supabase
    .from("user_config")
    .select("telegram_chat_id, telegram_enabled")
    .eq("user_id", userId)
    .maybeSingle();

  if (!cfg?.telegram_enabled || !cfg.telegram_chat_id) {
    throw new Error("Telegram not enabled for user");
  }

  const res = await fetch("https://connector-gateway.lovable.dev/telegram/sendMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": telegramKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: cfg.telegram_chat_id,
      text,
      parse_mode: opts.parse_mode ?? "HTML",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram error ${res.status}: ${body}`);
  }

  return { ok: true };
}
