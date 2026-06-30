import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { runFullBacktest, type BacktestPayload } from "@/lib/backtest.functions";
import type { BacktestResult } from "@/lib/backtest";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Play, Loader2 } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar,
} from "recharts";

export const Route = createFileRoute("/_authenticated/backtest")({
  head: () => ({ meta: [{ title: "Backtest — Trading Compass" }] }),
  component: BacktestPage,
});

const PROFILE_LABEL: Record<string, string> = {
  full: "H4 + H1 + M15 (completo)",
  h1m15: "H1 + M15",
  m15: "Solo M15",
};

function BacktestPage() {
  const run = useServerFn(runFullBacktest);
  const [minScore, setMinScore] = useState(70);
  const m = useMutation<BacktestPayload, Error, void>({
    mutationFn: () => run({ data: { minScore, profiles: ["full", "h1m15", "m15"] } }),
  });

  const data = m.data;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-[1600px] px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/dashboard"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
            <span className="font-semibold tracking-tight">Backtesting · XAU/USD</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="text-muted-foreground">Min score</label>
            <input
              type="number"
              min={50}
              max={100}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-16 bg-background border border-border rounded px-2 py-1 font-mono text-sm"
            />
            <Button onClick={() => m.mutate()} disabled={m.isPending} size="sm">
              {m.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
              {m.isPending ? "Ejecutando..." : "Correr backtest"}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 space-y-6">
        {!data && !m.isPending && (
          <div className="rounded-lg border border-dashed border-border p-12 text-center">
            <h2 className="text-lg font-semibold mb-2">Compara la estrategia por timeframes</h2>
            <p className="text-sm text-muted-foreground max-w-xl mx-auto mb-4">
              Corremos el motor sobre la historia disponible (Twelve Data, ~52 días M15) en tres modos:
              completo (H4+H1+M15), H1+M15, y solo M15. Esto te dice cuánto valor agregan los filtros multi-TF.
            </p>
            <p className="text-xs text-muted-foreground">
              Gestión simulada: 50% en TP1 → SL a BE · 30% en TP2 · 20% runner a TP3. Cooldown 4h, max hold 24h.
            </p>
          </div>
        )}

        {m.isPending && (
          <div className="rounded-lg border border-border bg-card p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-primary" />
            <p className="text-sm text-muted-foreground">Procesando histórico... esto puede tardar 10-20s</p>
          </div>
        )}

        {m.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            Error: {m.error.message}
          </div>
        )}

        {data?.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            {data.error}
          </div>
        )}

        {data && !data.error && (
          <>
            <div className="text-xs text-muted-foreground">
              Datos: {fmtDate(data.range.from)} → {fmtDate(data.range.to)} ·
              {" "}{data.range.m15Bars} velas M15, {data.range.h1Bars} H1, {data.range.h4Bars} H4
            </div>

            {/* Summary comparison table */}
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-background/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-3">Perfil</th>
                    <th className="text-right px-4 py-3">Trades</th>
                    <th className="text-right px-4 py-3">Winrate</th>
                    <th className="text-right px-4 py-3">Total R</th>
                    <th className="text-right px-4 py-3">Expectancy</th>
                    <th className="text-right px-4 py-3">Profit Factor</th>
                    <th className="text-right px-4 py-3">Max DD (R)</th>
                    <th className="text-right px-4 py-3">Racha L</th>
                    <th className="text-right px-4 py-3">Sharpe</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r) => (
                    <tr key={r.profile} className="border-t border-border">
                      <td className="px-4 py-3 font-medium">{PROFILE_LABEL[r.profile]}</td>
                      <td className="text-right px-4 py-3 font-mono">{r.metrics.trades}</td>
                      <td className="text-right px-4 py-3 font-mono">{(r.metrics.winrate * 100).toFixed(1)}%</td>
                      <td className={`text-right px-4 py-3 font-mono font-semibold ${r.metrics.totalR >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {r.metrics.totalR >= 0 ? "+" : ""}{r.metrics.totalR.toFixed(2)}R
                      </td>
                      <td className="text-right px-4 py-3 font-mono">{r.metrics.expectancy.toFixed(2)}R</td>
                      <td className="text-right px-4 py-3 font-mono">{isFinite(r.metrics.profitFactor) ? r.metrics.profitFactor.toFixed(2) : "∞"}</td>
                      <td className="text-right px-4 py-3 font-mono text-red-400">-{r.metrics.maxDrawdownR.toFixed(2)}R</td>
                      <td className="text-right px-4 py-3 font-mono">{r.metrics.longestLossStreak}</td>
                      <td className="text-right px-4 py-3 font-mono">{r.metrics.sharpe.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Per-profile detail */}
            {data.results.map((r) => <ProfileDetail key={r.profile} result={r} />)}
          </>
        )}
      </main>
    </div>
  );
}

function ProfileDetail({ result }: { result: BacktestResult }) {
  const m = result.metrics;
  return (
    <section className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold">{PROFILE_LABEL[result.profile]}</h3>
        <div className="flex gap-2 flex-wrap">
          <Badge variant="outline">TP1: {m.outcomeCounts.tp1}</Badge>
          <Badge variant="outline">TP2: {m.outcomeCounts.tp2}</Badge>
          <Badge variant="outline">TP3: {m.outcomeCounts.tp3}</Badge>
          <Badge variant="outline" className="text-emerald-400 border-emerald-500/40">BE: {m.outcomeCounts.be}</Badge>
          <Badge variant="outline" className="text-red-400 border-red-500/40">SL: {m.outcomeCounts.sl}</Badge>
          <Badge variant="outline">Timeout: {m.outcomeCounts.timeout}</Badge>
        </div>
      </div>

      {m.trades === 0 ? (
        <p className="text-sm text-muted-foreground">Sin trades en la ventana evaluada.</p>
      ) : (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-3">
            <h4 className="text-xs uppercase text-muted-foreground mb-2">Equity (R acumulado)</h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={m.equityCurve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="trade" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Line type="monotone" dataKey="equityR" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <h4 className="text-xs uppercase text-muted-foreground mb-2">R por hora UTC</h4>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={m.byHour}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={10} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Bar dataKey="totalR" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <h4 className="text-xs uppercase text-muted-foreground mb-2">R por día de semana</h4>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={m.byWeekday.map(d => ({ ...d, name: WEEKDAYS[d.weekday] }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={10} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Bar dataKey="totalR" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p><span className="text-foreground font-medium">Racha de ganadores:</span> {m.longestWinStreak}</p>
            <p><span className="text-foreground font-medium">Racha de perdedores:</span> {m.longestLossStreak}</p>
            <p><span className="text-foreground font-medium">Trades ganados:</span> {m.wins}</p>
            <p><span className="text-foreground font-medium">Trades perdidos:</span> {m.losses}</p>
            <p><span className="text-foreground font-medium">Breakeven:</span> {m.breakeven}</p>
          </div>
        </div>
      )}
    </section>
  );
}

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function fmtDate(unix: number) {
  if (!unix) return "—";
  return new Date(unix * 1000).toISOString().slice(0, 10);
}