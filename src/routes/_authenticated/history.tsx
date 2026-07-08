import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getEngineStats, getRecentSignals } from "@/lib/history.functions";
import { STRATEGIES, type EngineKey } from "@/lib/strategies";
import { Button } from "@/components/ui/button";
import { ArrowLeft, TrendingUp, TrendingDown, Minus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "Historial de Setups — Trading Compass" }] }),
  component: HistoryPage,
});

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("es-CO")} ${d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}`;
}

function engineLabel(key: string): string {
  const s = STRATEGIES[key as EngineKey];
  return s ? s.shortName : key;
}

function HistoryPage() {
  const fetchStats = useServerFn(getEngineStats);
  const fetchRecent = useServerFn(getRecentSignals);
  const statsQ = useQuery({ queryKey: ["engine-stats"], queryFn: () => fetchStats(), refetchInterval: 60_000 });
  const recentQ = useQuery({ queryKey: ["recent-signals"], queryFn: () => fetchRecent(), refetchInterval: 60_000 });

  const stats = statsQ.data ?? [];
  const recent = recentQ.data ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 sticky top-0 z-10">
        <div className="mx-auto max-w-[1400px] px-4 h-14 flex items-center gap-3">
          <Link to="/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 mr-1" />Dashboard</Button></Link>
          <h1 className="font-semibold">Historial de Setups</h1>
          <span className="ml-auto text-xs text-muted-foreground">Refresh 60s</span>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-4 space-y-6">
        {/* Cards por estrategia */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">Rendimiento por estrategia</h2>
          {stats.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay señales registradas. Se guardan automáticamente cuando el cron o el dashboard detecta un setup.</p>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
              {stats.map((s) => (
                <div key={s.engine} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-semibold text-sm">{engineLabel(s.engine)}</div>
                    <span className={`text-xs px-2 py-0.5 rounded font-mono ${s.avgR > 0 ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                      {s.avgR >= 0 ? "+" : ""}{s.avgR.toFixed(2)}R
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mb-2">
                    <div><div className="text-muted-foreground">Total</div><div className="font-mono">{s.total}</div></div>
                    <div><div className="text-muted-foreground">Cerradas</div><div className="font-mono">{s.closed}</div></div>
                    <div><div className="text-muted-foreground">Winrate</div><div className="font-mono">{(s.winrate * 100).toFixed(0)}%</div></div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mb-2">
                    <div className="text-emerald-400"><TrendingUp className="inline w-3 h-3 mr-1" />{s.wins} W</div>
                    <div className="text-red-400"><TrendingDown className="inline w-3 h-3 mr-1" />{s.losses} L</div>
                    <div className="text-muted-foreground"><Minus className="inline w-3 h-3 mr-1" />{s.breakeven} BE</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Total R: <span className="font-mono text-foreground">{s.totalR >= 0 ? "+" : ""}{s.totalR.toFixed(2)}</span> · Última: {fmtDate(s.lastSignalAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Tabla de últimas señales */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">Últimas 100 señales</h2>
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Fecha</th>
                  <th className="text-left px-3 py-2">Estrategia</th>
                  <th className="text-left px-3 py-2">Bias</th>
                  <th className="text-right px-3 py-2">Score</th>
                  <th className="text-right px-3 py-2">Entry</th>
                  <th className="text-right px-3 py-2">SL</th>
                  <th className="text-right px-3 py-2">TP1</th>
                  <th className="text-center px-3 py-2">Outcome</th>
                  <th className="text-right px-3 py-2">R</th>
                  <th className="text-center px-3 py-2">TG</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">Sin señales registradas.</td></tr>
                ) : recent.map((r) => (
                  <tr key={r.id} className="border-t border-border/60">
                    <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                    <td className="px-3 py-1.5">{engineLabel(r.engine)}</td>
                    <td className={`px-3 py-1.5 font-medium ${r.bias === "long" ? "text-emerald-400" : "text-red-400"}`}>{r.bias.toUpperCase()}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{r.score}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{Number(r.entry).toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{Number(r.stop_loss).toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{Number(r.tp1).toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-center">
                      {r.outcome ? (
                        <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                          r.outcome.startsWith("tp") ? "bg-emerald-500/20 text-emerald-400"
                          : r.outcome === "sl" ? "bg-red-500/20 text-red-400"
                          : "bg-muted text-muted-foreground"
                        }`}>{r.outcome}</span>
                      ) : <span className="text-muted-foreground">abierta</span>}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono ${r.r_multiple && Number(r.r_multiple) > 0 ? "text-emerald-400" : r.r_multiple && Number(r.r_multiple) < 0 ? "text-red-400" : ""}`}>
                      {r.r_multiple !== null ? `${Number(r.r_multiple) >= 0 ? "+" : ""}${Number(r.r_multiple).toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-center">{r.telegram_sent ? "✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}