import { createFileRoute } from "@tanstack/react-router";
import { STRATEGIES, type EngineKey } from "@/lib/strategies";

// Server-side cron: evalúa E1/E2/E3 sin necesidad de que el usuario tenga el
// dashboard abierto. Se llama cada 15 min desde pg_cron durante horario de
// mercado. Requiere header `apikey` con la publishable key de Supabase.

type TDValue = { datetime: string; open: string; high: string; low: string; close: string };

async function fetchInterval(interval: "15min" | "1h" | "4h", apiKey: string) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", "120");
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("order", "ASC");
  const res = await fetch(url.toString());
  const json = (await res.json()) as { values?: TDValue[]; status?: string; message?: string };
  if (!json.values || json.status === "error") {
    throw new Error(json.message || `No data for ${interval}`);
  }
  return json.values.map((v) => ({
    time: Math.floor(new Date(v.datetime + "Z").getTime() / 1000),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

async function sendTelegram(
  chatId: string,
  engineName: string,
  bias: "long" | "short",
  score: number,
  confidence: string,
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
  tp3: number | null,
) {
  const lovableKey = process.env.LOVABLE_API_KEY!;
  const telegramKey = process.env.TELEGRAM_API_KEY!;
  const arrow = bias === "long" ? "🟢 LONG" : "🔴 SHORT";
  const text =
    `<b>${arrow}  XAU/USD</b> · <i>${engineName}</i>\n` +
    `Score: <b>${score}/100</b> · ${confidence.toUpperCase()}\n\n` +
    `Entrada: <code>${entry}</code>\n` +
    `SL: <code>${sl}</code>\n` +
    `TP1: <code>${tp1}</code>\n` +
    `TP2: <code>${tp2}</code>\n` +
    (tp3 ? `TP3: <code>${tp3}</code>\n` : "") +
    `\n<i>Auto-señal cron server-side</i>`;
  const res = await fetch("https://connector-gateway.lovable.dev/telegram/sendMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": telegramKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

export const Route = createFileRoute("/api/public/hooks/evaluate-signals")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Autenticación mínima: apikey debe coincidir con la publishable
        const apiKey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!expected || apiKey !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const twelveKey = process.env.TWELVE_DATA_API_KEY;
        if (!twelveKey) return Response.json({ error: "TWELVE_DATA_API_KEY missing" }, { status: 500 });

        // Ventana de trading (UTC): Lun-Vie, 00-22h. Domingo excluido.
        const now = new Date();
        const dow = now.getUTCDay(); // 0=Sun ... 6=Sat
        const hour = now.getUTCHours();
        if (dow === 0 || dow === 6 || hour < 0 || hour > 22) {
          return Response.json({ ok: true, skipped: "outside-market-hours" });
        }

        // Datos de precios (una sola vez para todos los usuarios)
        let h4, h1, m15;
        try {
          [h4, h1, m15] = await Promise.all([
            fetchInterval("4h", twelveKey),
            fetchInterval("1h", twelveKey),
            fetchInterval("15min", twelveKey),
          ]);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }

        // Cliente admin server-only
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Usuarios con telegram habilitado
        const { data: users, error: usersErr } = await supabaseAdmin
          .from("user_config")
          .select("user_id, telegram_chat_id, telegram_enabled, auto_alert_high_confidence")
          .eq("telegram_enabled", true)
          .not("telegram_chat_id", "is", null);
        if (usersErr) return Response.json({ error: usersErr.message }, { status: 500 });

        // Bucket horario (para dedupe): truncar a la hora
        const bucketHour = new Date(Date.UTC(
          now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0,
        )).toISOString();

        const engines: EngineKey[] = ["smc_london", "ny_continuation", "fibo_scalping"];
        const report: Array<{ engine: string; users: number; signals: number; sent: number }> = [];

        for (const key of engines) {
          const strat = STRATEGIES[key];
          const signal = strat.evaluate(h4, h1, m15, strat.defaultParams);
          const usersCount = users?.length ?? 0;
          if (!signal) {
            report.push({ engine: key, users: usersCount, signals: 0, sent: 0 });
            continue;
          }

          let sent = 0;
          for (const u of users ?? []) {
            // Insert dedupado: (user_id, engine, bias, bucket_hour) unique
            const { data: inserted, error: insErr } = await supabaseAdmin
              .from("signal_events")
              .insert({
                user_id: u.user_id,
                engine: key,
                bias: signal.bias,
                score: signal.score,
                confidence: signal.confidence,
                entry: signal.entry,
                stop_loss: signal.stopLoss,
                tp1: signal.tp1,
                tp2: signal.tp2,
                tp3: signal.tp3 ?? null,
                reasoning: signal.reasoning as never,
                bucket_hour: bucketHour,
              })
              .select()
              .single();

            if (insErr) {
              // Conflicto de unicidad → ya notificamos esta hora, skip
              continue;
            }

            // Enviar solo si high confidence O si auto_alert está off (siempre alta)
            const shouldSend =
              signal.confidence === "high" || !u.auto_alert_high_confidence;
            if (!shouldSend) continue;

            try {
              await sendTelegram(
                u.telegram_chat_id!,
                strat.shortName,
                signal.bias,
                signal.score,
                signal.confidence,
                signal.entry,
                signal.stopLoss,
                signal.tp1,
                signal.tp2,
                signal.tp3 ?? null,
              );
              await supabaseAdmin
                .from("signal_events")
                .update({ telegram_sent: true })
                .eq("id", inserted.id);
              sent++;
            } catch (e) {
              await supabaseAdmin
                .from("signal_events")
                .update({ telegram_error: (e as Error).message })
                .eq("id", inserted.id);
            }
          }
          report.push({ engine: key, users: usersCount, signals: 1, sent });
        }

        return Response.json({ ok: true, bucketHour, report });
      },
    },
  },
});