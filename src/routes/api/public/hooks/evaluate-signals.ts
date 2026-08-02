import { createFileRoute } from "@tanstack/react-router";
import { STRATEGIES, listStrategies, type EngineKey } from "@/lib/strategies";
import { aggregateCandles, type TfKey } from "@/lib/csv-parser";
import type { Candle } from "@/lib/analysis";
import type { Signal } from "@/lib/signal-engine";
import { fetchUpcomingEvents, findBlockingEvent } from "@/lib/economic-calendar";
import { detectRegime, isRegimeFriendly } from "@/lib/market-regime";
import { predictProb, scorerVerdict, type ScorerModel } from "@/lib/ml-scorer";

// Server-side cron: evalúa E1/E2/E3 sin necesidad de que el usuario tenga el
// dashboard abierto. Se llama cada 15 min desde pg_cron durante horario de
// mercado. Requiere header `apikey` con la publishable key de Supabase.

type TDValue = { datetime: string; open: string; high: string; low: string; close: string };

type TDInterval = "1min" | "15min" | "1h" | "4h" | "1day";

async function fetchInterval(interval: TDInterval, apiKey: string, outputsize = 200) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
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

        // --- #6 Filtro económico: cargar calendario global (cacheado 6h)
        const econEvents = await fetchUpcomingEvents().catch(() => []);

        // Multi-TF: M1, M15, H1, H4, D1. M5 se agrega desde M1.
        let bars: Partial<Record<TfKey, Candle[]>> = {};
        try {
          const [m1, m15, h1, h4, d1] = await Promise.all([
            fetchInterval("1min", twelveKey, 400).catch(() => [] as Candle[]),
            fetchInterval("15min", twelveKey, 200),
            fetchInterval("1h", twelveKey, 300),
            fetchInterval("4h", twelveKey, 240),
            fetchInterval("1day", twelveKey, 80).catch(() => [] as Candle[]),
          ]);
          const m5 = m1.length ? aggregateCandles(m1, 5) : [];
          bars = { M1: m1, M5: m5, M15: m15, H1: h1, H4: h4, D1: d1 };
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }

        // Cliente admin server-only
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Usuarios con telegram habilitado
        const { data: users, error: usersErr } = await supabaseAdmin
          .from("user_config")
          .select("user_id, telegram_chat_id, telegram_enabled, auto_alert_high_confidence, mt5_auto_route_enabled, mt5_min_confidence, mt5_enabled_engines, balance, risk_per_trade, econ_filter_enabled, econ_filter_window_min, weekend_guard_enabled, friday_cutoff_hour, monday_open_hour, weekend_flatten_enabled")
          .eq("telegram_enabled", true)
          .not("telegram_chat_id", "is", null);
        if (usersErr) return Response.json({ error: usersErr.message }, { status: 500 });

        // --- Cargar best_params por (user, engine). Si el usuario ha subido
        // un best_params.json desde Colab, esos parámetros sobreescriben los
        // defaults del motor. Si no, se usan los defaults hardcoded.
        const userIds = (users ?? []).map((u) => u.user_id);
        const paramsByUE = new Map<string, Record<string, unknown>>();
        if (userIds.length) {
          const { data: sp } = await supabaseAdmin
            .from("strategy_params")
            .select("user_id, engine_key, params")
            .in("user_id", userIds);
          for (const row of sp ?? []) {
            paramsByUE.set(`${row.user_id}:${row.engine_key}`, (row.params ?? {}) as Record<string, unknown>);
          }
        }

        // --- #2 ML scorers por (user, engine)
        const scorersByUE = new Map<string, ScorerModel>();
        if (userIds.length) {
          const { data: scs } = await supabaseAdmin
            .from("ml_scorers")
            .select("user_id, engine, features, weights, intercept, auc")
            .in("user_id", userIds);
          for (const row of scs ?? []) {
            scorersByUE.set(`${row.user_id}:${row.engine}`, {
              engine: row.engine,
              features: row.features as string[],
              weights: row.weights as number[],
              intercept: Number(row.intercept ?? 0),
              auc: row.auc ?? undefined,
            });
          }
        }

        // --- #3 Régimen actual (H1) — común a todos los usuarios
        const regimeInfo = bars.H1 && bars.H1.length >= 60 ? detectRegime(bars.H1) : null;

        // Features base para el ML re-scoring (ampliables por estrategia)
        function buildFeatures(sig: NonNullable<Signal>): Record<string, number> {
          const feats: Record<string, number> = {};
          feats.score = sig.score;
          feats.confidence_high = sig.confidence === "high" ? 1 : 0;
          feats.bias_long = sig.bias === "long" ? 1 : 0;
          if (regimeInfo) {
            feats.adx = regimeInfo.adx;
            feats.atr_pct = regimeInfo.atrPct;
            feats.ema_slope_pct = regimeInfo.emaSlopePct;
            feats.regime_trend = regimeInfo.regime === "trend_up" || regimeInfo.regime === "trend_down" ? 1 : 0;
            feats.regime_range = regimeInfo.regime === "range" ? 1 : 0;
            feats.regime_high_vol = regimeInfo.regime === "high_vol" ? 1 : 0;
          }
          feats.hour_utc = now.getUTCHours();
          feats.dow = now.getUTCDay();
          return feats;
        }

        // Bucket horario (para dedupe): truncar a la hora
        const bucketHour = new Date(Date.UTC(
          now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0,
        )).toISOString();

        // Todas las estrategias registradas, siempre que sus TFs requeridos
        // estén poblados con >=30 velas.
        const engines: EngineKey[] = listStrategies().map((s) => s.key);
        const report: Array<{ engine: string; users: number; signals: number; sent: number }> = [];

        for (const key of engines) {
          const strat = STRATEGIES[key];
          const tfsOk = strat.requiredTfs.every((tf) => (bars[tf]?.length ?? 0) >= 30);
          if (!tfsOk) {
            report.push({ engine: key, users: users?.length ?? 0, signals: 0, sent: 0 });
            continue;
          }
          const usersCount = users?.length ?? 0;
          // Cache por combinación de params: evita recomputar la señal cuando
          // varios usuarios comparten los mismos parámetros (caso común: nadie
          // ha subido best_params.json → todos usan defaults).
          const sigCache = new Map<string, Signal | null>();
          const resolveSignal = (params: Record<string, unknown>): Signal | null => {
            const k = JSON.stringify(params);
            if (sigCache.has(k)) return sigCache.get(k) ?? null;
            const s = strat.evaluate(bars, params);
            sigCache.set(k, s ?? null);
            return s ?? null;
          };

          let signalsCount = 0;
          let sent = 0;
          for (const u of users ?? []) {
            // --- Gestión de fin de semana (reglas prop-firm tipo FTMO)
            const wg = readWeekendGuard(u as unknown as Record<string, unknown>);
            if (isWeekendWindow(now, wg)) continue;

            // --- #6 Filtro económico por usuario (respeta su configuración)
            const econEnabled = (u as { econ_filter_enabled?: boolean }).econ_filter_enabled ?? true;
            const econWindow = (u as { econ_filter_window_min?: number }).econ_filter_window_min ?? 30;
            if (econEnabled && econEvents.length) {
              const blocker = findBlockingEvent(econEvents, now, econWindow);
              if (blocker) continue; // saltar señal para este usuario
            }

            const userParams = paramsByUE.get(`${u.user_id}:${key}`);
            const mergedParams = { ...strat.defaultParams, ...(userParams ?? {}) };
            const rawSignal = resolveSignal(mergedParams);
            if (!rawSignal) continue;
            // Trabajamos con un tipo NonNullable para no arrastrar `| null`
            type NonNullSignal = NonNullable<Signal>;
            let signal: NonNullSignal = rawSignal;

            // --- #3 Régimen: si el régimen no encaja con la estrategia, degradamos confianza.
            let regimeDowngrade = false;
            if (regimeInfo && !isRegimeFriendly(key, regimeInfo.regime)) {
              if (signal.confidence === "medium") continue; // ya débil + mal régimen → descartar
              signal = { ...signal, confidence: "medium" };
              regimeDowngrade = true;
            }

            // --- #2 ML re-scoring (si hay scorer entrenado para este motor)
            const scorer = scorersByUE.get(`${u.user_id}:${key}`);
            let pWin: number | null = null;
            if (scorer) {
              const feats = buildFeatures(signal);
              pWin = predictProb(scorer, feats);
              const verdict = scorerVerdict(pWin);
              if (verdict === "reject") continue;
              if (verdict === "medium" && signal.confidence === "high") {
                signal = { ...signal, confidence: "medium" };
              } else if (verdict === "high" && signal.confidence === "medium" && !regimeDowngrade) {
                signal = { ...signal, confidence: "high" };
              }
            }

            signalsCount++;
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
                metadata: {
                  regime: regimeInfo?.regime ?? null,
                  adx: regimeInfo?.adx ?? null,
                  atr_pct: regimeInfo?.atrPct ?? null,
                  regime_downgrade: regimeDowngrade,
                  p_win: pWin,
                  scorer_auc: scorer?.auc ?? null,
                } as never,
              })
              .select()
              .single();

            if (insErr) {
              // Conflicto de unicidad → ya notificamos esta hora, skip
              continue;
            }

            // --- C. Puente MT5: si el usuario tiene auto-route habilitado y
            // un token de EA registrado, encolamos la señal en mt5_signals para
            // que el EA la ejecute en su próximo poll. Idempotente por
            // (signal_event_id) — si ya existe, no reencola.
            const meetsMt5 =
              (u as { mt5_auto_route_enabled?: boolean }).mt5_auto_route_enabled &&
              ((u as { mt5_min_confidence?: string }).mt5_min_confidence === "medium" ||
                signal.confidence === "high");
            const enabledEngines = (u as { mt5_enabled_engines?: string[] | null }).mt5_enabled_engines;
            // Los motores con defaultEnabled === false (experimentales / alto
            // riesgo, p.ej. E7 Fibo Grid Cent) exigen activación explícita.
            const engineAllowed = strat.defaultEnabled === false
              ? Boolean(enabledEngines?.includes(key))
              : (!enabledEngines || enabledEngines.length === 0 || enabledEngines.includes(key));
            if (meetsMt5 && engineAllowed) {
              const { data: tok } = await supabaseAdmin
                .from("mt5_ea_tokens")
                .select("id")
                .eq("user_id", u.user_id)
                .maybeSingle();
              if (tok) {
                const bal = (u as { balance?: number }).balance ?? 1000;
                const rp = (u as { risk_per_trade?: number }).risk_per_trade ?? 0.5;
                const riskUsd = (bal * rp) / 100;
                await supabaseAdmin.from("mt5_signals").insert({
                  user_id: u.user_id,
                  signal_event_id: inserted.id,
                  auto_route: true,
                  symbol: "XAUUSD",
                  engine: key,
                  bias: signal.bias,
                  entry: signal.entry,
                  stop_loss: signal.stopLoss,
                  tp1: signal.tp1,
                  tp2: signal.tp2 ?? null,
                  tp3: signal.tp3 ?? null,
                  risk_usd: riskUsd,
                  break_even_at_r: signal.management?.breakEvenAtR ?? null,
                  time_stop_minutes: signal.management?.timeStopBars
                    ? signal.management.timeStopBars * 5
                    : null,
                  score: signal.score,
                  confidence: signal.confidence,
                  reasoning: signal.reasoning as never,
                });
              }
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
          report.push({ engine: key, users: usersCount, signals: signalsCount, sent });
        }

        return Response.json({ ok: true, bucketHour, report });
      },
    },
  },
});