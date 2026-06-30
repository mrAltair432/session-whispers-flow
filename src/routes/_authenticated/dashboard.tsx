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
import { Settings, LogOut, RefreshCw, BarChart3 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

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

  const h4Trend = data && data.h4.length ? detectTrend(data.h4) : "ranging";
  const h1Trend = data && data.h1.length ? detectTrend(data.h1) : "ranging";
  const m15Trend = data && data.m15.length ? detectTrend(data.m15) : "ranging";

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