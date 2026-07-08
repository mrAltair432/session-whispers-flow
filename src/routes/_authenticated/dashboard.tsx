import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { fetchXauPrices } from "@/lib/prices.functions";
import { getMyConfig, getDailyStats } from "@/lib/config.functions";
import { generateSignal } from "@/lib/signal-engine";
import { detectTrend } from "@/lib/analysis";
import { PriceChart } from "@/components/PriceChart";
import { SetupCard } from "@/components/SetupCard";
import { RiskPanel } from "@/components/RiskPanel";
import { SessionClock } from "@/components/SessionClock";
import { Button } from "@/components/ui/button";
import { Settings, LogOut, RefreshCw, BarChart3, AlertTriangle, History } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getTodayEvents, getNextEvent } from "@/lib/economic-calendar";
import { listStrategies, STRATEGIES } from "@/lib/strategies";
import type { Signal } from "@/lib/signal-engine";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Trading Compass" }] }),
  component: Dashboard,
});

function Dashboard() {
  const navigate = useNavigate();
  const fetchPrices = useServerFn(fetchXauPrices);
  const fetchConfig = useServerFn(getMyConfig);
  const fetchStats = useServerFn(getDailyStats);

  const pricesQ = useQuery({
    queryKey: ["xau-prices"],
    queryFn: () => fetchPrices(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const configQ = useQuery({ queryKey: ["my-config"], queryFn: () => fetchConfig() });
  const statsQ = useQuery({ queryKey: ["daily-stats"], queryFn: () => fetchStats(), refetchInterval: 60_000 });

  const data = pricesQ.data;
  const config = configQ.data;
  const stats = statsQ.data;

  const signal = useMemo(() => {
    if (!data || !data.h4.length) return null;
    return generateSignal(data.h4, data.h1, data.m15);
  }, [data]);

  // Evaluación LIVE de las 6 estrategias con multi-TF (M1..D1).
  const strategySignals = useMemo(() => {
    if (!data || !data.bars) return [] as Array<{ key: string; name: string; signal: Signal }>;
    const bars = data.bars;
    const out: Array<{ key: string; name: string; signal: Signal }> = [];
    for (const strat of listStrategies()) {
      // Verificar que estén los TFs requeridos con al menos 30 velas
      const ok = strat.requiredTfs.every((tf) => (bars[tf]?.length ?? 0) >= 30);
      if (!ok) {
        out.push({ key: strat.key, name: strat.shortName, signal: null });
        continue;
      }
      try {
        const sig = strat.evaluate(bars, strat.defaultParams);
        out.push({ key: strat.key, name: strat.shortName, signal: sig });
      } catch {
        out.push({ key: strat.key, name: strat.shortName, signal: null });
      }
    }
    return out;
  }, [data]);

  const h4Trend = data && data.h4.length ? detectTrend(data.h4) : "ranging";
  const h1Trend = data && data.h1.length ? detectTrend(data.h1) : "ranging";
  const m15Trend = data && data.m15.length ? detectTrend(data.m15) : "ranging";

  const todayEvents = useMemo(() => getTodayEvents(), []);
  const nextEvent = useMemo(() => getNextEvent(), []);

  const setupHighlights = signal ? [
    { price: signal.entry, color: "#f0b929", label: "Entry" },
    { price: signal.stopLoss, color: "#ef4444", label: "SL" },
    { price: signal.tp1, color: "#3ecf8e", label: "TP1" },
    { price: signal.tp2, color: "#3ecf8e", label: "TP2" },
  ] : undefined;

  async function logout() {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-[1600px] px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded bg-primary flex items-center justify-center text-xs font-bold text-primary-foreground">TC</div>
              <span className="font-semibold tracking-tight">Trading Compass</span>
            </div>
            <div className="hidden md:flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">XAU/USD</span>
              {data?.lastPrice ? (
                <span className="font-mono font-semibold text-primary tabular-nums">
                  {data.lastPrice.toFixed(2)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SessionClock />
            <Button variant="ghost" size="icon" onClick={() => pricesQ.refetch()} title="Actualizar">
              <RefreshCw className={`w-4 h-4 ${pricesQ.isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Link to="/backtest"><Button variant="ghost" size="icon" title="Backtest"><BarChart3 className="w-4 h-4" /></Button></Link>
            <Link to="/history"><Button variant="ghost" size="icon" title="Historial"><History className="w-4 h-4" /></Button></Link>
            <Link to="/settings"><Button variant="ghost" size="icon"><Settings className="w-4 h-4" /></Button></Link>
            <Button variant="ghost" size="icon" onClick={logout} title="Salir"><LogOut className="w-4 h-4" /></Button>
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="mx-auto max-w-[1600px] px-4 py-4 space-y-4">
        {data?.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive-foreground px-4 py-3 text-sm">
            <strong>Datos no disponibles:</strong> {data.error}
          </div>
        )}

        {/* Economic calendar warning */}
        {todayEvents.length > 0 ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <strong className="text-amber-300">Hoy:</strong>
            <span>{todayEvents.map((e) => `${e.label} (~${e.timeUTC} UTC)`).join(" · ")}</span>
            <span className="text-xs text-muted-foreground ml-auto">Evitar entradas 1h antes y 30min después.</span>
          </div>
        ) : nextEvent ? (
          <div className="text-xs text-muted-foreground">
            Próximo evento macro: <strong className="text-foreground">{nextEvent.label}</strong> el {nextEvent.date} (~{nextEvent.timeUTC} UTC)
          </div>
        ) : null}

        {/* Daily limits bar */}
        {config && stats && (
          <DailyBar
            tradesCount={stats.trades_count}
            maxTrades={config.max_trades_per_day}
            lossUsd={stats.loss_usd}
            maxLossUsd={(config.balance * config.max_daily_loss_pct) / 100}
            pnl={stats.pnl_usd}
          />
        )}

        <div className="grid xl:grid-cols-[1fr_380px] gap-4">
          {/* Charts column */}
          <div className="grid lg:grid-cols-3 gap-3">
            <PriceChart
              candles={data?.h4 ?? []}
              title="H4 — Contexto"
              trendLabel={trendLabel(h4Trend)}
              highlights={setupHighlights}
            />
            <PriceChart
              candles={data?.h1 ?? []}
              title="H1 — Estructura"
              trendLabel={trendLabel(h1Trend)}
              highlights={setupHighlights}
            />
            <PriceChart
              candles={data?.m15 ?? []}
              title="M15 — Entrada"
              trendLabel={trendLabel(m15Trend)}
              highlights={setupHighlights}
            />
          </div>

          {/* Right column */}
          <div className="space-y-4">
            <SetupCard
              signal={signal}
              balance={config?.balance ?? 1000}
              riskPct={config?.risk_per_trade ?? 0.5}
              telegramEnabled={!!config?.telegram_enabled}
            />
            <RiskPanel
              balance={config?.balance ?? 1000}
              riskPct={config?.risk_per_trade ?? 0.5}
              currentPrice={data?.lastPrice ?? null}
            />
          </div>
        </div>

        {/* Estrategias en vivo (E1..E6) */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">Estrategias en vivo · Multi-TF (M1 · M5 · M15 · H1 · H4 · D1)</h3>
            <span className="text-xs text-muted-foreground">
              {data?.bars ? (
                <>M1:{data.bars.M1?.length ?? 0} · M5:{data.bars.M5?.length ?? 0} · M15:{data.bars.M15?.length ?? 0} · H1:{data.bars.H1?.length ?? 0} · H4:{data.bars.H4?.length ?? 0} · D1:{data.bars.D1?.length ?? 0}</>
              ) : "cargando…"}
            </span>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
            {strategySignals.map(({ key, name, signal: s }) => {
              const strat = STRATEGIES[key as keyof typeof STRATEGIES];
              const tfsOk = data?.bars ? strat.requiredTfs.every((tf) => (data.bars[tf]?.length ?? 0) >= 30) : false;
              return (
                <div key={key} className="rounded-md border border-border/70 bg-background/40 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium">{name}</span>
                    {!tfsOk ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">sin datos</span>
                    ) : s ? (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${s.bias === "long" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                        {s.bias.toUpperCase()} · {s.score}
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">sin señal</span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Necesita: {strat.requiredTfs.join(" · ")}
                  </div>
                  {s && (
                    <div className="mt-1 text-[11px] font-mono tabular-nums text-muted-foreground">
                      E {s.entry.toFixed(2)} · SL {s.stopLoss.toFixed(2)} · TP1 {s.tp1.toFixed(2)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <footer className="text-center text-xs text-muted-foreground pt-6 pb-4">
          Datos cada 60s · Twelve Data · Solo análisis — la ejecución real va en MT5.
        </footer>
      </main>
    </div>
  );
}

function trendLabel(t: "bullish" | "bearish" | "ranging") {
  if (t === "bullish") return "↑ Alcista";
  if (t === "bearish") return "↓ Bajista";
  return "↔ Rango";
}

function DailyBar({ tradesCount, maxTrades, lossUsd, maxLossUsd, pnl }: { tradesCount: number; maxTrades: number; lossUsd: number; maxLossUsd: number; pnl: number }) {
  const tradesPct = Math.min(100, (tradesCount / maxTrades) * 100);
  const lossPct = Math.min(100, (lossUsd / maxLossUsd) * 100);
  const blocked = tradesCount >= maxTrades || lossUsd >= maxLossUsd;
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-wrap items-center gap-6 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Ops hoy</span>
        <div className="w-24 h-1.5 bg-background rounded-full overflow-hidden">
          <div className="h-full bg-primary" style={{ width: `${tradesPct}%` }} />
        </div>
        <span className="font-mono tabular-nums">{tradesCount}/{maxTrades}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Pérdida</span>
        <div className="w-24 h-1.5 bg-background rounded-full overflow-hidden">
          <div className="h-full bg-red-500" style={{ width: `${lossPct}%` }} />
        </div>
        <span className="font-mono tabular-nums">${lossUsd.toFixed(0)} / ${maxLossUsd.toFixed(0)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">P&L</span>
        <span className={`font-mono font-semibold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
        </span>
      </div>
      {blocked && (
        <span className="ml-auto text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 border border-red-500/40">
          🚫 Día bloqueado
        </span>
      )}
    </div>
  );
}