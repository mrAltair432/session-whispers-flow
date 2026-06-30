import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  runFullBacktest,
  runOptimizer,
  type BacktestPayload,
  type OptimizerPayload,
} from "@/lib/backtest.functions";
import type { BacktestResult } from "@/lib/backtest";
import type { Candle } from "@/lib/analysis";
import { parseXauHistoricalCsv, detectTimeframeMinutes } from "@/lib/csv-parser";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Play, Loader2, Upload, Wand2, X } from "lucide-react";
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
  const opt = useServerFn(runOptimizer);
  const [minScore, setMinScore] = useState(70);
  const [excludeHours, setExcludeHours] = useState<number[]>([]);
  const [excludeWeekdays, setExcludeWeekdays] = useState<number[]>([]);
  const [customH4, setCustomH4] = useState<Candle[] | null>(null);
  const [csvInfo, setCsvInfo] = useState<string | null>(null);

  const m = useMutation<BacktestPayload, Error, void>({
    mutationFn: () =>
      run({
        data: {
          minScore,
          profiles: ["full", "h1m15", "m15"],
          excludeHours,
          excludeWeekdays,
          customH4: customH4 ?? undefined,
        },
      }),
  });

  const o = useMutation<OptimizerPayload, Error, void>({
    mutationFn: () => opt({ data: { profile: "full", customH4: customH4 ?? undefined } }),
  });

  const data = m.data;

  const handleCsv = async (file: File) => {
    const text = await file.text();
    const candles = parseXauHistoricalCsv(text);
    if (!candles.length) {
      setCsvInfo(`❌ ${file.name}: no se pudieron parsear velas`);
      return;
    }
    const tf = detectTimeframeMinutes(candles);
    if (tf < 60 || tf > 360) {
      setCsvInfo(`⚠️ ${file.name}: ${candles.length} velas, TF=${tf}min (esperado 240min H4)`);
      return;
    }
    setCustomH4(candles);
    const from = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
    const to = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);
    setCsvInfo(`✓ ${file.name}: ${candles.length} velas H4, ${from} → ${to}`);
  };

  const toggleHour = (h: number) =>
    setExcludeHours((s) => (s.includes(h) ? s.filter((x) => x !== h) : [...s, h]));
  const toggleWd = (w: number) =>
    setExcludeWeekdays((s) => (s.includes(w) ? s.filter((x) => x !== w) : [...s, w]));

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
            <Button onClick={() => o.mutate()} disabled={o.isPending} size="sm" variant="outline">
              {o.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Wand2 className="w-4 h-4 mr-1" />}
              {o.isPending ? "Optimizando..." : "Optimizar"}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 space-y-6">
        {/* Controls: CSV upload + filters */}
        <section className="grid lg:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Upload className="w-4 h-4" /> H4 extendido (CSV opcional)
            </div>
            <p className="text-xs text-muted-foreground">
              Sube tu CSV de H4 (formato MT5/MQL5: <code>Date,Open,High,Low,Close,...</code>) para extender la historia más allá de los ~5 meses que da Twelve Data.
            </p>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => e.target.files?.[0] && handleCsv(e.target.files[0])}
              className="block text-xs text-muted-foreground file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer"
            />
            {csvInfo && (
              <div className="flex items-center gap-2 text-xs font-mono">
                <span>{csvInfo}</span>
                {customH4 && (
                  <button onClick={() => { setCustomH4(null); setCsvInfo(null); }} className="text-muted-foreground hover:text-foreground">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="text-sm font-medium">Excluir horas UTC</div>
            <div className="grid grid-cols-12 gap-1">
              {Array.from({ length: 24 }, (_, h) => (
                <button
                  key={h}
                  onClick={() => toggleHour(h)}
                  className={`text-xs py-1 rounded font-mono border ${
                    excludeHours.includes(h)
                      ? "bg-red-500/20 border-red-500/40 text-red-300 line-through"
                      : "border-border hover:bg-background/50"
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Click para excluir. Tip: horas con R negativo en el backtest anterior.</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="text-sm font-medium">Excluir días</div>
            <div className="grid grid-cols-7 gap-1">
              {["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"].map((label, w) => (
                <button
                  key={w}
                  onClick={() => toggleWd(w)}
                  className={`text-xs py-1 rounded font-mono border ${
                    excludeWeekdays.includes(w)
                      ? "bg-red-500/20 border-red-500/40 text-red-300 line-through"
                      : "border-border hover:bg-background/50"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Sáb/Dom suelen tener gaps; Lun puede ser ruidoso.</p>
          </div>
        </section>

        {/* Optimizer results */}
        {o.data && !o.data.error && (
          <section className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" />
              <h3 className="font-semibold">Optimizador (grid search · perfil completo)</h3>
            </div>
            {o.data.best && (
              <div className="text-xs text-muted-foreground">
                Mejor combo: <span className="text-foreground font-mono">minScore={o.data.best.minScore}</span>
                {o.data.best.excludeHours.length > 0 && (
                  <> · excluir horas <span className="text-foreground font-mono">[{o.data.best.excludeHours.join(",")}]</span></>
                )}
                {" "}→ aplica los valores arriba y vuelve a correr backtest.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground uppercase">
                  <tr>
                    <th className="text-left py-2">Min Score</th>
                    <th className="text-left py-2">Horas excl.</th>
                    <th className="text-right py-2">Trades</th>
                    <th className="text-right py-2">WR</th>
                    <th className="text-right py-2">Total R</th>
                    <th className="text-right py-2">Expect.</th>
                    <th className="text-right py-2">PF</th>
                    <th className="text-right py-2">Max DD</th>
                    <th className="text-right py-2">Sharpe</th>
                    <th className="text-right py-2">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {o.data.rows.slice(0, 12).map((r, i) => (
                    <tr key={i} className={`border-t border-border ${i === 0 ? "bg-emerald-500/5" : ""}`}>
                      <td className="py-2 font-mono">{r.minScore}</td>
                      <td className="py-2 font-mono text-muted-foreground">
                        {r.excludeHours.length ? `[${r.excludeHours.join(",")}]` : "—"}
                      </td>
                      <td className="text-right py-2 font-mono">{r.trades}</td>
                      <td className="text-right py-2 font-mono">{(r.winrate * 100).toFixed(1)}%</td>
                      <td className={`text-right py-2 font-mono ${r.totalR >= 0 ? "text-emerald-400" : "text-red-400"}`}>{r.totalR.toFixed(2)}</td>
                      <td className="text-right py-2 font-mono">{r.expectancy.toFixed(2)}</td>
                      <td className="text-right py-2 font-mono">{r.profitFactor.toFixed(2)}</td>
                      <td className="text-right py-2 font-mono text-red-400">-{r.maxDrawdownR.toFixed(2)}</td>
                      <td className="text-right py-2 font-mono">{r.sharpe.toFixed(2)}</td>
                      <td className="text-right py-2 font-mono">{isFinite(r.score) ? r.score.toFixed(2) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              ⚠️ El score compuesto es: <code>expectancy × √(min(trades,100)/100) − 0.1 × maxDD</code>. Penaliza pocos trades y drawdowns altos.
            </p>
          </section>
        )}
        {o.data?.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">{o.data.error}</div>
        )}

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