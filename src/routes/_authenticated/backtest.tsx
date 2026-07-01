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
import { listStrategies, STRATEGIES, type EngineKey } from "@/lib/strategies";
import { parseXauHistoricalCsv, detectTimeframeMinutes, classifyTimeframe, type TfKey } from "@/lib/csv-parser";
import { useBacktestWorker } from "@/lib/use-backtest-worker";
import { useOptimizerPool } from "@/lib/use-optimizer-pool";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Play, Loader2, Upload, Wand2, X, Download, Save, RotateCcw } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar,
} from "recharts";

export const Route = createFileRoute("/_authenticated/backtest")({
  head: () => ({ meta: [{ title: "Backtest — Trading Compass" }] }),
  component: BacktestPage,
});

type CustomData = { tf: TfKey; candles: Candle[]; fileName: string };
const REQUIRED_BACKTEST_TFS: TfKey[] = ["H4", "H1", "M15"];

type SavedConfig = { minScore: number; excludeHours: number[]; savedAt: number };
const CONFIG_KEY = "tc.backtest.appliedConfig.v1";
function loadSavedConfigs(): Partial<Record<EngineKey, SavedConfig>> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); } catch { return {}; }
}
function persistSavedConfigs(cfg: Partial<Record<EngineKey, SavedConfig>>) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

function BacktestPage() {
  const run = useServerFn(runFullBacktest);
  const opt = useServerFn(runOptimizer);
  const allStrategies = listStrategies();
  const worker = useBacktestWorker();
  const pool = useOptimizerPool();

  const [minScoreOverride, setMinScoreOverride] = useState<number | "">("");
  const [enginesSelected, setEnginesSelected] = useState<EngineKey[]>(allStrategies.map((s) => s.key));
  const [optimizerEngine, setOptimizerEngine] = useState<EngineKey>("smc_london");
  const [autoTimeFilters, setAutoTimeFilters] = useState(true);
  const [excludeHours, setExcludeHours] = useState<number[]>([]);
  const [excludeWeekdays, setExcludeWeekdays] = useState<number[]>([]);
  const [datasets, setDatasets] = useState<Record<TfKey, CustomData | undefined>>(
    {} as Record<TfKey, CustomData | undefined>,
  );
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [savedConfigs, setSavedConfigs] = useState<Partial<Record<EngineKey, SavedConfig>>>(() => loadSavedConfigs());

  // Al cambiar de estrategia a optimizar, precargar su config guardada (si existe)
  // en los controles superiores para que el próximo backtest la use.
  const applyConfigToUi = (cfg: SavedConfig) => {
    setMinScoreOverride(cfg.minScore);
    setExcludeHours(cfg.excludeHours);
  };
  const saveAndApply = (engineKey: EngineKey, minScore: number, excludeHours: number[]) => {
    const next: SavedConfig = { minScore, excludeHours, savedAt: Date.now() };
    const merged = { ...savedConfigs, [engineKey]: next };
    setSavedConfigs(merged);
    persistSavedConfigs(merged);
    applyConfigToUi(next);
  };
  const clearSavedConfig = (engineKey: EngineKey) => {
    const merged = { ...savedConfigs };
    delete merged[engineKey];
    setSavedConfigs(merged);
    persistSavedConfigs(merged);
  };

  const customH4 = datasets.H4?.candles;
  const customH1 = datasets.H1?.candles;
  const customM15 = datasets.M15?.candles;
  const hasCustom = !!(customH4?.length || customH1?.length || customM15?.length);
  const missingRequiredTfs = REQUIRED_BACKTEST_TFS.filter((tf) => !datasets[tf]?.candles.length);

  const m = useMutation<BacktestPayload, Error, void>({
    mutationFn: async () => {
      if (hasCustom) {
        if (missingRequiredTfs.length > 0 || !customH4?.length || !customH1?.length || !customM15?.length) {
          return {
            results: [],
            range: { from: 0, to: 0, m15Bars: 0, h1Bars: 0, h4Bars: 0 },
            error: `Para correr local con CSV faltan: ${missingRequiredTfs.join(", ")}. Sube H4, H1 y M15 juntos para evitar enviar datos pesados al servidor.`,
          };
        }
        // Corremos en un Web Worker: usa un core extra de CPU y no congela la UI.
        const resp = await worker.run<{ results: BacktestResult[] }>({
          type: "backtest",
          h4: customH4,
          h1: customH1,
          m15: customM15,
          engines: enginesSelected,
          minScore: minScoreOverride === "" ? undefined : Number(minScoreOverride),
          excludeHours,
          excludeWeekdays,
          autoTimeFilters,
        });
        return {
          results: resp.results,
          range: {
            from: customM15[0]?.time ?? 0,
            to: customM15[customM15.length - 1]?.time ?? 0,
            m15Bars: customM15.length,
            h1Bars: customH1.length,
            h4Bars: customH4.length,
          },
          error: null,
        };
      }
      return run({
        data: {
          minScore: minScoreOverride === "" ? undefined : Number(minScoreOverride),
          engines: enginesSelected,
          excludeHours,
          excludeWeekdays,
          autoTimeFilters,
        },
      });
    },
  });

  const o = useMutation<OptimizerPayload, Error, void>({
    mutationFn: async () => {
      if (hasCustom) {
        if (missingRequiredTfs.length > 0 || !customH4?.length || !customH1?.length || !customM15?.length) {
          return {
            rows: [],
            best: null,
            error: `Para optimizar local con CSV faltan: ${missingRequiredTfs.join(", ")}. Sube H4, H1 y M15 juntos.`,
            engineKey: optimizerEngine,
          };
        }
        // Pool de workers: paraleliza cada combo (minScore × variante) en varios núcleos.
        const resp = await pool.optimize({
          h4: customH4, h1: customH1, m15: customM15,
          engineKey: optimizerEngine,
          excludeWeekdays,
          autoTimeFilters,
        });
        return { rows: resp.rows, best: resp.best, error: null, engineKey: optimizerEngine };
      }
      return opt({
        data: {
          engineKey: optimizerEngine,
        },
      });
    },
  });

  const data = m.data;

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const errs: string[] = [];
    const updates: Partial<Record<TfKey, CustomData>> = {};
    for (const file of Array.from(files)) {
      const text = await file.text();
      const candles = parseXauHistoricalCsv(text);
      if (!candles.length) {
        errs.push(`❌ ${file.name}: 0 velas parseadas`);
        continue;
      }
      const mins = detectTimeframeMinutes(candles);
      const tf = classifyTimeframe(mins);
      if (!tf) {
        errs.push(`⚠️ ${file.name}: TF=${mins.toFixed(1)}min no reconocido`);
        continue;
      }
      if (candles.length > 200_000) {
        errs.push(`⚠️ ${file.name}: ${candles.length} velas (>200k) — puede saturar el navegador`);
      }
      updates[tf] = { tf, candles, fileName: file.name };
    }
    setDatasets((prev) => ({ ...prev, ...updates }));
    setParseErrors(errs);
  };

  const clearDataset = (tf: TfKey) =>
    setDatasets((prev) => ({ ...prev, [tf]: undefined }));

  const toggleHour = (h: number) =>
    setExcludeHours((s) => (s.includes(h) ? s.filter((x) => x !== h) : [...s, h]));
  const toggleWd = (w: number) =>
    setExcludeWeekdays((s) => (s.includes(w) ? s.filter((x) => x !== w) : [...s, w]));
  const toggleEngine = (k: EngineKey) =>
    setEnginesSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-[1600px] px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/dashboard"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
            <span className="font-semibold tracking-tight">Backtesting · XAU/USD</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="text-muted-foreground">Min score (override)</label>
            <input
              type="number"
              min={50}
              max={100}
              value={minScoreOverride}
              placeholder="auto"
              onChange={(e) => setMinScoreOverride(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-20 bg-background border border-border rounded px-2 py-1 font-mono text-sm"
            />
            <Button onClick={() => m.mutate()} disabled={m.isPending || !enginesSelected.length} size="sm">
              {m.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
              {m.isPending ? "Ejecutando..." : "Correr backtest"}
            </Button>
            <Button onClick={() => o.mutate()} disabled={o.isPending} size="sm" variant="outline">
              {o.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Wand2 className="w-4 h-4 mr-1" />}
              {o.isPending ? "Optimizando..." : `Optimizar ${STRATEGIES[optimizerEngine].shortName}`}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 space-y-6">
        {/* Strategies selector */}
        <section className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-semibold">Estrategias a comparar</h3>
            <div className="text-xs text-muted-foreground">Optimizar:&nbsp;
              <select
                value={optimizerEngine}
                onChange={(e) => setOptimizerEngine(e.target.value as EngineKey)}
                className="bg-background border border-border rounded px-2 py-1 text-xs"
              >
                {allStrategies.map((s) => (
                  <option key={s.key} value={s.key}>{s.shortName}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {allStrategies.map((s) => {
              const on = enginesSelected.includes(s.key);
              return (
                <label
                  key={s.key}
                  className={`rounded border p-3 cursor-pointer transition ${
                    on ? "border-primary/60 bg-primary/5" : "border-border hover:bg-background/50"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleEngine(s.key)}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">{s.shortName}</span>
                        <span className="text-xs text-muted-foreground font-mono">
                          minScore default: {String(s.defaultParams.minScore)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{s.description}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Killzone UTC: <span className="font-mono">{s.killzoneHoursUTC.join(", ")}</span>
                      </p>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </section>

        {/* MT5 export download + multi-TF CSV upload */}
        <section className="grid lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Download className="w-4 h-4" /> Exportar histórico desde MT5
            </div>
            <p className="text-xs text-muted-foreground">
              Descarga este script, cópialo en <code>MQL5/Scripts/</code> de tu MT5 (File &gt; Open Data Folder),
              reinicia, y arrástralo sobre un gráfico de XAUUSD. Genera CSVs en <code>MQL5/Files/</code> con
              hasta 10 años de M1/M5/M15/H1/H4/D1.
            </p>
            <a
              href="/api/public/mt5-export"
              download
              className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90"
            >
              <Download className="w-3 h-3" /> XAUUSD_History_Export.mq5
            </a>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Upload className="w-4 h-4" /> Subir CSVs (multi-timeframe)
            </div>
            <p className="text-xs text-muted-foreground">
              Acepta múltiples archivos. Detecta el timeframe automáticamente (M1/M5/M15/H1/H4/D1).
              Solo se usan H4, H1 y M15 en el backtest; los demás se ignoran por ahora.
            </p>
            <input
              type="file"
              accept=".csv"
              multiple
              onChange={(e) => handleFiles(e.target.files)}
              className="block text-xs text-muted-foreground file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer"
            />
            {(Object.keys(datasets) as TfKey[]).filter((k) => datasets[k]).length > 0 && (
              <div className="text-xs space-y-1">
                {(Object.keys(datasets) as TfKey[])
                  .filter((k) => datasets[k])
                  .map((tf) => {
                    const d = datasets[tf]!;
                    const used = tf === "H4" || tf === "H1" || tf === "M15";
                    return (
                      <div key={tf} className="flex items-center gap-2 font-mono">
                        <span className={used ? "text-emerald-400" : "text-muted-foreground"}>
                          {used ? "✓" : "·"} {tf}
                        </span>
                        <span className="text-muted-foreground truncate">{d.fileName}</span>
                        <span className="text-muted-foreground">— {d.candles.length} velas</span>
                        <button onClick={() => clearDataset(tf)} className="ml-auto text-muted-foreground hover:text-foreground">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
              </div>
            )}
            {parseErrors.length > 0 && (
              <div className="text-xs text-amber-400 space-y-0.5">
                {parseErrors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
          </div>
        </section>

        {/* Time filters */}
        <section className="grid lg:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={autoTimeFilters}
                onChange={(e) => setAutoTimeFilters(e.target.checked)}
              />
              Filtros automáticos del oro
            </label>
            <p className="text-xs text-muted-foreground">
              Excluye: sábado completo, viernes ≥21 UTC (cierre semanal), domingo &lt;22 UTC,
              lunes &lt;2 UTC (gap), y pausa diaria UTC 22 lun-jue.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="text-sm font-medium">Excluir horas UTC (manual)</div>
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
          </div>
        </section>

        {/* Optimizer results */}
        {o.data && !o.data.error && (
          <section className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" />
              <h3 className="font-semibold">
                Optimizador · {STRATEGIES[o.data.engineKey].shortName}
              </h3>
            </div>
            {o.data.best && (
              <div className="text-xs text-muted-foreground">
                Mejor combo: <span className="text-foreground font-mono">minScore={o.data.best.minScore}</span>
                {o.data.best.excludeHours.length > 0 && (
                  <> · excluir horas <span className="text-foreground font-mono">[{o.data.best.excludeHours.join(",")}]</span></>
                )}
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
          </section>
        )}
        {o.data?.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">{o.data.error}</div>
        )}

        {!data && !m.isPending && (
          <div className="rounded-lg border border-dashed border-border p-12 text-center">
            <h2 className="text-lg font-semibold mb-2">Compara estrategias lado a lado</h2>
            <p className="text-sm text-muted-foreground max-w-xl mx-auto mb-4">
              Selecciona una o varias estrategias arriba, sube tus CSVs de MT5 si quieres más historia,
              y dale "Correr backtest". La gestión simulada es 50% TP1 → SL a BE · 30% TP2 · 20% runner a TP3.
            </p>
          </div>
        )}

        {m.isPending && (
          <div className="rounded-lg border border-border bg-card p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-primary" />
            <p className="text-sm text-muted-foreground">
              {worker.progress
                ? `Procesando en Web Worker · ${worker.progress.label} (${worker.progress.step + 1}/${worker.progress.total})`
                : "Procesando histórico..."}
            </p>
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

            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-background/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-3">Estrategia</th>
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
                    <tr key={r.engineKey} className="border-t border-border">
                      <td className="px-4 py-3 font-medium">{STRATEGIES[r.engineKey].shortName}</td>
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

            {data.results.map((r) => <ProfileDetail key={r.engineKey} result={r} />)}
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
        <h3 className="font-semibold">{STRATEGIES[result.engineKey].name}</h3>
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
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="trade" stroke="var(--muted-foreground)" fontSize={11} />
                  <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                  <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }} />
                  <Line type="monotone" dataKey="equityR" stroke="var(--primary)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <h4 className="text-xs uppercase text-muted-foreground mb-2">R por hora UTC</h4>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={m.byHour}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="hour" stroke="var(--muted-foreground)" fontSize={10} />
                  <YAxis stroke="var(--muted-foreground)" fontSize={10} />
                  <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }} />
                  <Bar dataKey="totalR" fill="var(--primary)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <h4 className="text-xs uppercase text-muted-foreground mb-2">R por día de semana</h4>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={m.byWeekday.map(d => ({ ...d, name: WEEKDAYS[d.weekday] }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" stroke="var(--muted-foreground)" fontSize={10} />
                  <YAxis stroke="var(--muted-foreground)" fontSize={10} />
                  <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }} />
                  <Bar dataKey="totalR" fill="var(--primary)" />
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