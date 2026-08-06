import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  runFullBacktest,
  runOptimizer,
  type BacktestPayload,
  type OptimizerPayload,
} from "@/lib/backtest.functions";
import {
  listMyStrategyParams,
  uploadBestParams,
  deleteStrategyParams,
} from "@/lib/strategy-params.functions";
import type { BacktestResult } from "@/lib/backtest";
import type { Candle } from "@/lib/analysis";
import { listStrategies, STRATEGIES, type EngineKey } from "@/lib/strategies";
import { parseXauHistoricalCsv, detectTimeframeMinutes, classifyTimeframe, aggregateCandles, TF_MINUTES, type TfKey } from "@/lib/csv-parser";
import { useBacktestWorker } from "@/lib/use-backtest-worker";
import { useOptimizerPool, type OptRow } from "@/lib/use-optimizer-pool";
import { useAiTrainer, loadModel, saveModel, deleteModel, isMlpModel, type AnyModel } from "@/lib/ai/use-trainer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  simulateChallenge,
  suggestRiskPct,
  simulateRollingChallenges,
  optimizeRiskForWindow,
  DEFAULT_FTMO_RULES,
  type ChallengeResult,
} from "@/lib/ftmo";
import { ArrowLeft, Play, Loader2, Upload, Wand2, X, Download, Save, RotateCcw, Brain, Trash2, Split } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar,
  ComposedChart, Area, ReferenceLine,
} from "recharts";

export const Route = createFileRoute("/_authenticated/backtest")({
  head: () => ({ meta: [{ title: "Backtest — Trading Compass" }] }),
  component: BacktestPage,
});

type CustomData = { tf: TfKey; candles: Candle[]; fileName: string };
// TFs candidatos que se auto-agregan desde M1 si están vacíos.
const AGGREGATABLE_TFS: TfKey[] = ["M5", "M15", "H1", "H4"];

type WfCombo = { minScore: number; excludeHours: number[] };
type WfWindowMetrics = {
  trades: number; winrate: number; totalR: number; expectancy: number;
  profitFactor: number; maxDrawdownR: number; sharpe: number;
};
type WfResult = {
  engineKey: EngineKey;
  chosen: WfCombo;
  train: WfWindowMetrics;
  test: WfWindowMetrics;
  splitTime: number;
  trainRange: { from: number; to: number };
  testRange: { from: number; to: number };
};

type SavedConfig = { minScore: number; excludeHours: number[]; savedAt: number };

// Fase 1 — walk-forward rodante (varias ventanas train→test encadenadas).
type WfRollFold = {
  trainStart: number; trainEnd: number; testEnd: number; minScore: number;
  train: WfWindowMetrics; test: WfWindowMetrics;
};
type WfRollRow = {
  engineKey: EngineKey;
  folds: WfRollFold[];
  oos: WfWindowMetrics;
  inSample: WfWindowMetrics;
  error?: string;
};
function wfVerdict(r: WfRollRow): { label: string; cls: string } {
  if (r.error) return { label: "ERROR", cls: "bg-muted text-muted-foreground" };
  if (r.oos.trades >= 100 && r.oos.profitFactor >= 1.25)
    return { label: "PASA", cls: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40" };
  if (r.oos.trades >= 30 && r.oos.profitFactor >= 1.05)
    return { label: "DUDOSO", cls: "bg-amber-500/20 text-amber-300 border border-amber-500/40" };
  return { label: "DESCARTAR", cls: "bg-red-500/20 text-red-300 border border-red-500/40" };
}
const CONFIG_KEY = "tc.backtest.appliedConfig.v1";
function loadSavedConfigs(): Partial<Record<EngineKey, SavedConfig>> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); } catch { return {}; }
}
function persistSavedConfigs(cfg: Partial<Record<EngineKey, SavedConfig>>) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

function BacktestPage() {
  // Tick para poder mostrar cronómetros en vivo mientras corre el worker.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const run = useServerFn(runFullBacktest);
  const opt = useServerFn(runOptimizer);
  const listParams = useServerFn(listMyStrategyParams);
  const uploadParams = useServerFn(uploadBestParams);
  const deleteParams = useServerFn(deleteStrategyParams);
  const qc = useQueryClient();
  const savedParamsQ = useQuery({
    queryKey: ["strategy-params"],
    queryFn: () => listParams(),
  });
  const [paramsUploadMsg, setParamsUploadMsg] = useState<string | null>(null);
  const uploadParamsMut = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      const json = JSON.parse(text);
      return uploadParams({ data: json });
    },
    onSuccess: (r) => {
      setParamsUploadMsg(`✓ ${r.upserted} estrategias guardadas${r.skipped ? ` · ${r.skipped} ignoradas` : ""}`);
      qc.invalidateQueries({ queryKey: ["strategy-params"] });
    },
    onError: (e: unknown) => setParamsUploadMsg(`Error: ${e instanceof Error ? e.message : String(e)}`),
  });
  const deleteParamsMut = useMutation({
    mutationFn: (engine_key: string) => deleteParams({ data: { engine_key } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["strategy-params"] }),
  });
  const allStrategies = listStrategies();
  const worker = useBacktestWorker();
  const pool = useOptimizerPool();

  const [minScoreOverride, setMinScoreOverride] = useState<number | "">("");
  const [enginesSelected, setEnginesSelected] = useState<EngineKey[]>(
    allStrategies.filter((s) => s.defaultEnabled !== false).map((s) => s.key),
  );
  const [optimizerEngine, setOptimizerEngine] = useState<EngineKey>("smc_london");
  const [autoTimeFilters, setAutoTimeFilters] = useState(true);
  const [excludeHours, setExcludeHours] = useState<number[]>([]);
  const [excludeWeekdays, setExcludeWeekdays] = useState<number[]>([]);
  // Simulación de costos de ejecución (oro retail). Defaults calibrados
  // para scalping M1: spread 0.20 USD, slippage 0.05 USD por lado,
  // sin comisión, latencia 1 barra (60s señal→fill).
  const [costsEnabled, setCostsEnabled] = useState(true);
  const [spreadUsd, setSpreadUsd] = useState(0.20);
  const [slippageUsd, setSlippageUsd] = useState(0.05);
  const [commissionUsd, setCommissionUsd] = useState(0);
  const [latencyBars, setLatencyBars] = useState(1);
  // Fase 0: slippage extra en ejecuciones a mercado (SL, stops, time-stop) y
  // spread variable por sesión (Asia/rollover más caro que Londres).
  const [stopSlippageUsd, setStopSlippageUsd] = useState(0.08);
  const [sessionSpread, setSessionSpread] = useState(true);
  const costsPayload = costsEnabled
    ? { spreadUsd, slippageUsd, commissionUsd, latencyBars, stopSlippageUsd, sessionSpread }
    : {
        spreadUsd: 0, slippageUsd: 0, commissionUsd: 0, latencyBars: 0,
        stopSlippageUsd: 0, sessionSpread: false,
      };
  const [datasets, setDatasets] = useState<Record<TfKey, CustomData | undefined>>(
    {} as Record<TfKey, CustomData | undefined>,
  );
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [parseInfo, setParseInfo] = useState<{ ms: number; files: number; rows: number } | null>(null);
  // Fase de walk-forward: para mostrar en qué paso vamos ("train"/"test").
  const [wfPhase, setWfPhase] = useState<"idle" | "train" | "test">("idle");
  const [wfPhaseStartedAt, setWfPhaseStartedAt] = useState<number>(0);
  const [savedConfigs, setSavedConfigs] = useState<Partial<Record<EngineKey, SavedConfig>>>(() => loadSavedConfigs());

  // Ventana temporal: presets de últimos N meses aplicados a TODOS los CSVs
  // antes de correr backtest/optimizer/walk-forward. Útil para iterar rápido
  // sobre 10 años de M1 sin esperar la corrida completa.
  type MonthsWindow = 3 | 6 | 12 | 24 | "all";
  const [monthsWindow, setMonthsWindow] = useState<MonthsWindow>("all");

  // Walk-forward simple (single split 70/30 cronológico).
  const [wfPending, setWfPending] = useState(false);
  const [wfError, setWfError] = useState<string | null>(null);
  const [wfResult, setWfResult] = useState<WfResult | null>(null);
  // Fase 1 — walk-forward rodante sobre todos los motores seleccionados.
  const [trainDays, setTrainDays] = useState(180);
  const [testDays, setTestDays] = useState(60);
  const [wfRollPending, setWfRollPending] = useState(false);
  const [wfRollCurrent, setWfRollCurrent] = useState<string | null>(null);
  const [wfRollRows, setWfRollRows] = useState<WfRollRow[]>([]);
  const [wfRollError, setWfRollError] = useState<string | null>(null);

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

  // Aplicamos la ventana temporal a partir del último tick disponible en cualquier TF.
  const rawH4 = datasets.H4?.candles;
  const rawH1 = datasets.H1?.candles;
  const rawM15 = datasets.M15?.candles;
  const rawM5 = datasets.M5?.candles;
  const rawM1 = datasets.M1?.candles;
  const latestTime = Math.max(
    rawM1?.[rawM1.length - 1]?.time ?? 0,
    rawM5?.[rawM5.length - 1]?.time ?? 0,
    rawM15?.[rawM15.length - 1]?.time ?? 0,
    rawH1?.[rawH1.length - 1]?.time ?? 0,
    rawH4?.[rawH4.length - 1]?.time ?? 0,
  );
  const windowSecs = monthsWindow === "all" ? 0 : monthsWindow * 30 * 24 * 3600;
  const windowFrom = windowSecs > 0 && latestTime > 0 ? latestTime - windowSecs : 0;
  const sliceWindow = (arr: Candle[] | undefined): Candle[] | undefined => {
    if (!arr || !arr.length || windowFrom <= 0) return arr;
    // Búsqueda binaria del primer índice con time >= windowFrom
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].time < windowFrom) lo = mid + 1; else hi = mid;
    }
    return lo === 0 ? arr : arr.slice(lo);
  };
  const customH4 = sliceWindow(rawH4);
  const customH1 = sliceWindow(rawH1);
  const customM15 = sliceWindow(rawM15);
  const customM5 = sliceWindow(rawM5);
  const customM1 = sliceWindow(rawM1);
  // Conteo de velas efectivo tras aplicar ventana (para el badge de UI).
  const windowedCounts: Partial<Record<TfKey, number>> = {
    M1: customM1?.length, M5: customM5?.length, M15: customM15?.length,
    H1: customH1?.length, H4: customH4?.length,
  };
  const hasCustom = !!(customH4?.length || customH1?.length || customM15?.length || customM1?.length);
  // Los TFs requeridos dependen de las estrategias seleccionadas.
  const requiredTfs = Array.from(new Set(
    enginesSelected.flatMap((k) => STRATEGIES[k].requiredTfs),
  )) as TfKey[];
  const missingRequiredTfs = requiredTfs.filter((tf) => !datasets[tf]?.candles.length);

  const m = useMutation<BacktestPayload, Error, void>({
    mutationFn: async () => {
      if (hasCustom) {
        if (missingRequiredTfs.length > 0) {
          return {
            results: [],
            range: { from: 0, to: 0, m15Bars: 0, h1Bars: 0, h4Bars: 0 },
            error: `Para correr local con CSV faltan: ${missingRequiredTfs.join(", ")}. Tip: si subes M1 el sistema deriva M5/M15/H1/H4 automáticamente.`,
          };
        }
        // Corremos en un Web Worker: usa un core extra de CPU y no congela la UI.
        const resp = await worker.run<{ results: BacktestResult[] }>({
          type: "backtest",
          h4: customH4, h1: customH1, m15: customM15, m5: customM5, m1: customM1,
          engines: enginesSelected,
          minScore: minScoreOverride === "" ? undefined : Number(minScoreOverride),
          excludeHours,
          excludeWeekdays,
          autoTimeFilters,
          costs: costsPayload,
        });
        const refTf = customM1?.length ? customM1 : (customM15 ?? customH1 ?? customH4 ?? []);
        return {
          results: resp.results,
          range: {
            from: refTf[0]?.time ?? 0,
            to: refTf[refTf.length - 1]?.time ?? 0,
            m15Bars: customM15?.length ?? 0,
            h1Bars: customH1?.length ?? 0,
            h4Bars: customH4?.length ?? 0,
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
        const optReqTfs = STRATEGIES[optimizerEngine].requiredTfs;
        const optMissing = optReqTfs.filter((tf) => !datasets[tf]?.candles.length);
        if (optMissing.length > 0) {
          return {
            rows: [],
            best: null,
            error: `Para optimizar ${STRATEGIES[optimizerEngine].shortName} faltan: ${optMissing.join(", ")}.`,
            engineKey: optimizerEngine,
          };
        }
        // Pool de workers: paraleliza cada combo (minScore × variante) en varios núcleos.
        const resp = await pool.optimize({
          h4: customH4 ?? [], h1: customH1 ?? [], m15: customM15 ?? [],
          m5: customM5, m1: customM1,
          engineKey: optimizerEngine,
          excludeWeekdays,
          autoTimeFilters,
          costs: costsPayload,
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
    const t0 = performance.now();
    const errs: string[] = [];
    const updates: Partial<Record<TfKey, CustomData>> = {};
    let totalRows = 0;
    for (const file of Array.from(files)) {
      const text = await file.text();
      const candles = parseXauHistoricalCsv(text);
      if (!candles.length) {
        errs.push(`❌ ${file.name}: 0 velas parseadas`);
        continue;
      }
      totalRows += candles.length;
      const mins = detectTimeframeMinutes(candles);
      const tf = classifyTimeframe(mins);
      if (!tf) {
        errs.push(`⚠️ ${file.name}: TF=${mins.toFixed(1)}min no reconocido`);
        continue;
      }
      if (candles.length > 500_000) {
        errs.push(`⚠️ ${file.name}: ${candles.length} velas (>500k) — puede saturar el navegador`);
      }
      updates[tf] = { tf, candles, fileName: file.name };
    }
    // Auto-agregar: si se cargó M1, generar M5/M15/H1/H4 automáticamente
    // (solo si el usuario no subió esos TFs manualmente).
    const m1Data = updates.M1?.candles;
    if (m1Data?.length) {
      for (const tf of AGGREGATABLE_TFS) {
        if (updates[tf] || datasets[tf]?.candles.length) continue;
        const agg = aggregateCandles(m1Data, TF_MINUTES[tf]);
        if (agg.length) {
          updates[tf] = { tf, candles: agg, fileName: `↳ derivado de M1` };
        }
      }
    }
    setDatasets((prev) => ({ ...prev, ...updates }));
    setParseErrors(errs);
    setParseInfo({ ms: performance.now() - t0, files: files.length, rows: totalRows });
  };

  const clearDataset = (tf: TfKey) =>
    setDatasets((prev) => ({ ...prev, [tf]: undefined }));

  const toggleHour = (h: number) =>
    setExcludeHours((s) => (s.includes(h) ? s.filter((x) => x !== h) : [...s, h]));
  const toggleWd = (w: number) =>
    setExcludeWeekdays((s) => (s.includes(w) ? s.filter((x) => x !== w) : [...s, w]));
  const toggleEngine = (k: EngineKey) =>
    setEnginesSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  // ---- Walk-forward (single split 70/30) ----
  const sliceByTime = (arr: Candle[] | undefined, tSplit: number) => {
    if (!arr || !arr.length) return { train: [] as Candle[], test: [] as Candle[] };
    let i = 0;
    while (i < arr.length && arr[i].time <= tSplit) i++;
    return { train: arr.slice(0, i), test: arr.slice(i) };
  };
  const runWalkForward = async () => {
    setWfError(null);
    setWfResult(null);
    setWfPhase("idle");
    const strat = STRATEGIES[optimizerEngine];
    const triggerBars = datasets[strat.triggerTf]?.candles ?? [];
    if (!hasCustom || triggerBars.length < 200) {
      setWfError(`Sube un CSV con al menos 200 velas ${strat.triggerTf} para hacer walk-forward.`);
      return;
    }
    const optReqTfs = strat.requiredTfs;
    const optMissing = optReqTfs.filter((tf) => !datasets[tf]?.candles.length);
    if (optMissing.length > 0) {
      setWfError(`Faltan TFs para ${strat.shortName}: ${optMissing.join(", ")}.`);
      return;
    }
    setWfPending(true);
    try {
      const splitIdx = Math.floor(triggerBars.length * 0.7);
      const tSplit = triggerBars[splitIdx].time;
      const sH4 = sliceByTime(customH4, tSplit);
      const sH1 = sliceByTime(customH1, tSplit);
      const sM15 = sliceByTime(customM15, tSplit);
      const sM5 = sliceByTime(customM5, tSplit);
      const sM1 = sliceByTime(customM1, tSplit);
      // 1) Optimizar en TRAIN
      setWfPhase("train");
      setWfPhaseStartedAt(Date.now());
      const optResp = await pool.optimize({
        h4: sH4.train, h1: sH1.train, m15: sM15.train,
        m5: sM5.train, m1: sM1.train,
        engineKey: optimizerEngine,
        excludeWeekdays, autoTimeFilters,
        costs: costsPayload,
      });
      if (!optResp.best) {
        setWfError("El optimizador no encontró un combo con muestra suficiente en TRAIN.");
        return;
      }
      const best = optResp.best;
      // 2) Backtest en TEST con combo fijado
      setWfPhase("test");
      setWfPhaseStartedAt(Date.now());
      const testResp = await worker.run<{ results: BacktestResult[] }>({
        type: "backtest",
        h4: sH4.test, h1: sH1.test, m15: sM15.test,
        m5: sM5.test, m1: sM1.test,
        engines: [optimizerEngine],
        minScore: best.minScore,
        excludeHours: best.excludeHours,
        excludeWeekdays, autoTimeFilters,
        costs: costsPayload,
      });
      const testR = testResp.results[0];
      if (!testR) {
        setWfError("Backtest de TEST vacío.");
        return;
      }
      const tm = testR.metrics;
      const trainBars = sH4.train.length + sH1.train.length + sM15.train.length + sM1.train.length;
      const testBars = sH4.test.length + sH1.test.length + sM15.test.length + sM1.test.length;
      void trainBars; void testBars;
      setWfResult({
        engineKey: optimizerEngine,
        chosen: { minScore: best.minScore, excludeHours: best.excludeHours },
        train: {
          trades: best.trades, winrate: best.winrate, totalR: best.totalR,
          expectancy: best.expectancy, profitFactor: best.profitFactor,
          maxDrawdownR: best.maxDrawdownR, sharpe: best.sharpe,
        },
        test: {
          trades: tm.trades, winrate: tm.winrate, totalR: tm.totalR,
          expectancy: tm.expectancy,
          profitFactor: isFinite(tm.profitFactor) ? tm.profitFactor : 99,
          maxDrawdownR: tm.maxDrawdownR, sharpe: tm.sharpe,
        },
        splitTime: tSplit,
        trainRange: { from: triggerBars[0].time, to: tSplit },
        testRange: { from: tSplit, to: triggerBars[triggerBars.length - 1].time },
      });
    } catch (err) {
      setWfError(err instanceof Error ? err.message : "Error en walk-forward");
    } finally {
      setWfPending(false);
      setWfPhase("idle");
    }
  };

  // ---- FASE 1: walk-forward rodante sobre los motores seleccionados ----
  const runRollingWalkForward = async () => {
    setWfRollError(null);
    setWfRollRows([]);
    if (!hasCustom) {
      setWfRollError("Sube un CSV (idealmente M1 de 12 meses) para correr el walk-forward.");
      return;
    }
    if (!enginesSelected.length) {
      setWfRollError("Selecciona al menos un motor.");
      return;
    }
    setWfRollPending(true);
    const rows: WfRollRow[] = [];
    try {
      for (const key of enginesSelected) {
        const strat = STRATEGIES[key];
        setWfRollCurrent(strat.shortName);
        const missing = strat.requiredTfs.filter((tf) => !datasets[tf]?.candles.length);
        const empty: WfWindowMetrics = {
          trades: 0, winrate: 0, totalR: 0, expectancy: 0,
          profitFactor: 0, maxDrawdownR: 0, sharpe: 0,
        };
        if (missing.length) {
          rows.push({ engineKey: key, folds: [], oos: empty, inSample: empty, error: `Faltan TFs: ${missing.join(", ")}` });
          setWfRollRows([...rows]);
          continue;
        }
        try {
          const resp = await worker.run<{
            folds: WfRollFold[]; oos: WfWindowMetrics; inSample: WfWindowMetrics;
          }>({
            type: "walkforward",
            h4: customH4, h1: customH1, m15: customM15, m5: customM5, m1: customM1,
            engineKey: key,
            trainDays, testDays,
            excludeWeekdays,
            autoTimeFilters,
            costs: costsPayload,
          });
          rows.push({ engineKey: key, folds: resp.folds, oos: resp.oos, inSample: resp.inSample });
        } catch (err) {
          rows.push({
            engineKey: key, folds: [], oos: empty, inSample: empty,
            error: err instanceof Error ? err.message : "Error",
          });
        }
        setWfRollRows([...rows]);
      }
    } finally {
      setWfRollPending(false);
      setWfRollCurrent(null);
    }
  };

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
            <Button onClick={runWalkForward} disabled={wfPending || o.isPending} size="sm" variant="outline">
              {wfPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Split className="w-4 h-4 mr-1" />}
              {wfPending ? "Walk-forward..." : "Walk-forward 70/30"}
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
            <div className="pt-2 border-t border-border mt-2">
              <div className="text-xs font-medium mb-1">EA Fibo Scalping (E3) para MT5</div>
              <p className="text-xs text-muted-foreground mb-2">
                Expert Advisor con las mismas reglas que E3 (sin IA). Cópialo en{" "}
                <code>MQL5/Experts/</code>, compila (F7) y arrástralo sobre un gráfico
                M15 de XAUUSD. Prueba en cuenta demo antes de real.
              </p>
              <a
                href="/api/public/mt5-fibo-ea"
                download
                className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90"
              >
                <Download className="w-3 h-3" /> TradingCompass_FiboScalping.mq5
              </a>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Upload className="w-4 h-4" /> Subir CSVs (multi-timeframe)
            </div>
            <p className="text-xs text-muted-foreground">
              Acepta múltiples archivos. Detecta el timeframe automáticamente (M1/M5/M15/H1/H4/D1).
              <strong className="text-foreground"> Si subes M1</strong>, el sistema deriva M5/M15/H1/H4
              automáticamente — con un solo archivo puedes correr todas las estrategias (incluida E4 Gold Scalping).
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
                    const used = requiredTfs.includes(tf);
                    const eff = windowedCounts[tf];
                    const trimmed = monthsWindow !== "all" && typeof eff === "number" && eff < d.candles.length;
                    return (
                      <div key={tf} className="flex items-center gap-2 font-mono">
                        <span className={used ? "text-emerald-400" : "text-muted-foreground"}>
                          {used ? "✓" : "·"} {tf}
                        </span>
                        <span className="text-muted-foreground truncate">{d.fileName}</span>
                        <span className="text-muted-foreground">
                          — {d.candles.length} velas{trimmed ? ` (usando ${eff})` : ""}
                        </span>
                        <button onClick={() => clearDataset(tf)} className="ml-auto text-muted-foreground hover:text-foreground">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
              </div>
            )}
            {/* Ventana temporal (presets de últimos N meses) */}
            <div className="pt-2 border-t border-border mt-2">
              <div className="text-xs font-medium mb-1.5">Ventana de datos (últimos N meses)</div>
              <div className="flex flex-wrap gap-1.5">
                {([3, 6, 12, 24, "all"] as MonthsWindow[]).map((w) => {
                  const active = monthsWindow === w;
                  const label = w === "all" ? "Todo" : `${w}m`;
                  return (
                    <button
                      key={String(w)}
                      onClick={() => setMonthsWindow(w)}
                      className={`text-xs px-2.5 py-1 rounded font-mono border ${
                        active
                          ? "bg-primary/20 border-primary/60 text-foreground"
                          : "border-border hover:bg-background/50 text-muted-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Recorta desde la última vela hacia atrás. Aplica a backtest, optimizador y walk-forward por igual.
              </p>
            </div>
            {parseErrors.length > 0 && (
              <div className="text-xs text-amber-400 space-y-0.5">
                {parseErrors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
            {parseInfo && (
              <div className="text-xs text-muted-foreground">
                Parseo: <span className="font-mono">{(parseInfo.ms / 1000).toFixed(2)}s</span>
                {" · "}<span className="font-mono">{parseInfo.rows.toLocaleString()}</span> velas
                {" · "}<span className="font-mono">{parseInfo.files}</span> archivo(s)
              </div>
            )}
          </div>
        </section>

        {/* Upload best_params.json (Colab → Dashboard) */}
        <section className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Upload className="w-4 h-4" /> Cargar best_params.json (Colab)
          </div>
          <p className="text-xs text-muted-foreground">
            Sube el JSON que exporta el notebook de Colab (<code>lb.export_best_params(...)</code>).
            Los parámetros quedan guardados por estrategia y se usan como override sobre los defaults del motor.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadParamsMut.mutate(f);
                e.currentTarget.value = "";
              }}
              className="block text-xs text-muted-foreground file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer"
            />
            {uploadParamsMut.isPending && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> subiendo…
              </span>
            )}
            {paramsUploadMsg && (
              <span className={`text-xs ${paramsUploadMsg.startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
                {paramsUploadMsg}
              </span>
            )}
          </div>
          {savedParamsQ.data && savedParamsQ.data.length > 0 && (
            <div className="pt-2 border-t border-border mt-2 space-y-1">
              <div className="text-xs font-medium mb-1">Parámetros guardados</div>
              {savedParamsQ.data.map((row) => {
                const strat = STRATEGIES[row.engine_key as EngineKey];
                const name = strat ? strat.shortName : row.engine_key;
                const p = row.params as Record<string, unknown>;
                const m = row.metrics as Record<string, unknown>;
                return (
                  <div key={row.engine_key} className="flex items-start gap-2 text-xs font-mono">
                    <span className="text-emerald-400 shrink-0">✓ {name}</span>
                    <span className="text-muted-foreground truncate">
                      {Object.entries(p).map(([k, v]) => `${k}=${String(v)}`).join("  ")}
                      {typeof m.avg_r === "number" && `  · avgR=${(m.avg_r as number).toFixed(3)}`}
                      {typeof m.trades === "number" && `  · n=${m.trades as number}`}
                    </span>
                    <button
                      onClick={() => deleteParamsMut.mutate(row.engine_key)}
                      className="ml-auto text-muted-foreground hover:text-foreground"
                      title="Eliminar"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground pt-1">
                Fuente: <span className="font-mono">Colab</span>. Actualízalo cuando corras un nuevo grid/walk-forward.
              </p>
            </div>
          )}
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

        {/* Cost simulation */}
        <section className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={costsEnabled}
                onChange={(e) => setCostsEnabled(e.target.checked)}
              />
              Simular costos de ejecución
            </label>
            <p className="text-xs text-muted-foreground">
              Se aplica únicamente a estrategias M1. E1/E2 M15 conservan la ejecución calibrada de su versión optimizada. Coste por lado = <span className="font-mono">spread/2 + slippage + comisión</span>.
              Se descuenta en cada fill (entrada + parciales + cierre).
            </p>
          </div>
          <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 ${costsEnabled ? "" : "opacity-50 pointer-events-none"}`}>
            <label className="text-xs space-y-1">
              <div className="text-muted-foreground">Spread (USD)</div>
              <input
                type="number" step="0.01" min="0" value={spreadUsd}
                onChange={(e) => setSpreadUsd(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-2 py-1 rounded border border-border bg-background font-mono text-sm"
              />
            </label>
            <label className="text-xs space-y-1">
              <div className="text-muted-foreground">Slippage/lado (USD)</div>
              <input
                type="number" step="0.01" min="0" value={slippageUsd}
                onChange={(e) => setSlippageUsd(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-2 py-1 rounded border border-border bg-background font-mono text-sm"
              />
            </label>
            <label className="text-xs space-y-1">
              <div className="text-muted-foreground">Comisión/lado (USD)</div>
              <input
                type="number" step="0.01" min="0" value={commissionUsd}
                onChange={(e) => setCommissionUsd(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-2 py-1 rounded border border-border bg-background font-mono text-sm"
              />
            </label>
            <label className="text-xs space-y-1">
              <div className="text-muted-foreground">Latencia (barras TF trigger)</div>
              <input
                type="number" step="1" min="0" max="10" value={latencyBars}
                onChange={(e) => setLatencyBars(Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0))))}
                className="w-full px-2 py-1 rounded border border-border bg-background font-mono text-sm"
              />
            </label>
          </div>
          {costsEnabled && (
            <p className="text-xs text-muted-foreground">
              Coste por lado actual: <span className="font-mono text-foreground">{(spreadUsd/2 + slippageUsd + commissionUsd).toFixed(3)} USD</span>
              {" "}· Ida y vuelta simple: <span className="font-mono text-foreground">{(spreadUsd + 2*slippageUsd + 2*commissionUsd).toFixed(3)} USD</span>
              {" "}· Latencia: <span className="font-mono text-foreground">{latencyBars}</span> {latencyBars === 1 ? "barra" : "barras"} tras la señal
            </p>
          )}
        </section>

        {/* Optimizer results */}
        {o.data && !o.data.error && (
          <section className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" />
              <h3 className="font-semibold">
                Optimizador · {STRATEGIES[o.data.engineKey].shortName}
              </h3>
              {o.data.best && (
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => saveAndApply(o.data!.engineKey, o.data!.best!.minScore, o.data!.best!.excludeHours)}
                  >
                    <Save className="w-3.5 h-3.5 mr-1" /> Aplicar como config base
                  </Button>
                  {savedConfigs[o.data.engineKey] && (
                    <Button size="sm" variant="ghost" onClick={() => clearSavedConfig(o.data!.engineKey)}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1" /> Restaurar default
                    </Button>
                  )}
                </div>
              )}
            </div>
            {o.data.best && (
              <div className="text-xs text-muted-foreground">
                Mejor combo: <span className="text-foreground font-mono">minScore={o.data.best.minScore}</span>
                {o.data.best.excludeHours.length > 0 && (
                  <> · excluir horas <span className="text-foreground font-mono">[{o.data.best.excludeHours.join(",")}]</span></>
                )}
                <span className="ml-2 text-muted-foreground">
                  Guardar aplica <em>minScore</em> y <em>excluir horas</em> a los controles de arriba y persiste en este navegador.
                  Vuelve a correr el backtest para verificar, y re-optimiza para iterar sobre esa base.
                </span>
              </div>
            )}
            {Object.keys(savedConfigs).length > 0 && (
              <div className="text-xs flex flex-wrap gap-2 pt-1 border-t border-border">
                <span className="text-muted-foreground">Configs guardadas:</span>
                {(Object.keys(savedConfigs) as EngineKey[]).map((k) => {
                  const c = savedConfigs[k]!;
                  return (
                    <button
                      key={k}
                      onClick={() => { setOptimizerEngine(k); applyConfigToUi(c); }}
                      className="font-mono px-2 py-0.5 rounded border border-border hover:bg-background/50"
                      title="Cargar en los controles"
                    >
                      {STRATEGIES[k].shortName}: minScore={c.minScore}
                      {c.excludeHours.length ? ` · excl [${c.excludeHours.join(",")}]` : ""}
                    </button>
                  );
                })}
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
                    <th className="text-right py-2"></th>
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
                      <td className="text-right py-2">
                        <button
                          onClick={() => saveAndApply(o.data!.engineKey, r.minScore, r.excludeHours)}
                          className="text-xs px-2 py-0.5 rounded border border-border hover:bg-background/50"
                          title="Aplicar esta fila como config base"
                        >
                          Aplicar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PfHeatmap rows={o.data.rows} onPick={(ms, hrs) => saveAndApply(o.data!.engineKey, ms, hrs)} />
            {o.isPending && pool.progress && (
              <div className="text-xs text-muted-foreground">
                Pool de {pool.progress.workers} workers · {pool.progress.done}/{pool.progress.total} combos
              </div>
            )}
          </section>
        )}
        {o.data?.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">{o.data.error}</div>
        )}

        {wfError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">{wfError}</div>
        )}
        {wfPending && (
          <div className="rounded-lg border border-primary/30 bg-card p-4 text-sm flex items-start gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-primary mt-0.5" />
            <div className="space-y-1">
              <div>
                Walk-forward · fase:{" "}
                <span className="font-mono text-primary">
                  {wfPhase === "train" ? "1/2 Optimizando TRAIN (70%)"
                    : wfPhase === "test" ? "2/2 Backtest TEST (30%)"
                    : "preparando"}
                </span>
                {" · "}<span className="font-mono">{formatElapsed(Date.now() - wfPhaseStartedAt)}</span>
              </div>
              {wfPhase === "train" && pool.progress && (
                <div className="text-xs text-muted-foreground">
                  Pool <span className="font-mono">{pool.progress.workers}</span> workers · combos <span className="font-mono">{pool.progress.done}/{pool.progress.total}</span>
                </div>
              )}
              {wfPhase === "test" && worker.progress && (
                <div className="text-xs text-muted-foreground">
                  {formatWorkerProgress(worker.progress)}
                </div>
              )}
            </div>
          </div>
        )}
        {wfResult && !wfPending && (
          <WalkForwardPanel wf={wfResult} onApply={(ms, hrs) => saveAndApply(wfResult.engineKey, ms, hrs)} />
        )}

        {o.isPending && (
          <div className="rounded-lg border border-primary/30 bg-card p-4 text-sm flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            {pool.progress ? (
              <span>
                Optimizando en paralelo · combos{" "}
                <span className="font-mono">{pool.progress.done}/{pool.progress.total}</span>
                {" · "}<span className="font-mono">{pool.progress.workers} workers</span>
                {" · "}<span className="font-mono">
                  {formatElapsed(Date.now() - (pool.progress.startedAt ?? Date.now()))}
                </span>
                {pool.progress.done > 0 && (
                  <>
                    {" · ETA "}
                    <span className="font-mono">
                      {formatElapsed(
                        ((Date.now() - (pool.progress.startedAt ?? Date.now())) / pool.progress.done)
                        * (pool.progress.total - pool.progress.done),
                      )}
                    </span>
                  </>
                )}
              </span>
            ) : "Optimizando..."}
          </div>
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
          <div className="rounded-lg border border-border bg-card p-8 text-center space-y-3">
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
            {worker.progress ? (
              <div className="space-y-1.5">
                <div className="text-sm">
                  Web Worker · estrategia{" "}
                  <span className="font-mono text-primary">
                    {worker.progress.step + 1}/{worker.progress.total}
                  </span>{" "}
                  · <span className="font-mono">{worker.progress.label}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatWorkerProgress(worker.progress)}
                </div>
                {typeof worker.progress.percent === "number" && (
                  <div className="max-w-md mx-auto h-1.5 bg-muted rounded overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.round(worker.progress.percent * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Procesando histórico...</p>
            )}
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

            <ChallengePanel results={data.results} />

            {data.results
              .filter((r) => r.trades.length >= 40 && r.trades[0].features?.length)
              .map((r) => <AiPanel key={"ai-" + r.engineKey} result={r} />)}
          </>
        )}
      </main>
    </div>
  );
}

function ProfileDetail({ result }: { result: BacktestResult }) {
  return <ProfileDetailInner result={result} />;
}

// --- #5 Simulador de reto (FTMO) --------------------------------------
function ChallengePanel({ results: allResults }: { results: BacktestResult[] }) {
  const [balance, setBalance] = useState(DEFAULT_FTMO_RULES.balance);
  const [riskPct, setRiskPct] = useState(DEFAULT_FTMO_RULES.riskPerTradePct);
  const [target, setTarget] = useState(DEFAULT_FTMO_RULES.profitTargetPct);
  const [dailyLoss, setDailyLoss] = useState(DEFAULT_FTMO_RULES.dailyLossPct);
  const [maxLoss, setMaxLoss] = useState(DEFAULT_FTMO_RULES.maxLossPct);
  const [minDays, setMinDays] = useState(DEFAULT_FTMO_RULES.minTradingDays);
  const [dailyStop, setDailyStop] = useState(true);
  const [windowDays, setWindowDays] = useState(28);
  // Motores de alto riesgo (E7/E8): fuera del reto salvo activación manual.
  const [includeHighRisk, setIncludeHighRisk] = useState(false);
  const highRisk = allResults.filter((r) => STRATEGIES[r.engineKey].ftmoEligible === false);
  const results = includeHighRisk
    ? allResults
    : allResults.filter((r) => STRATEGIES[r.engineKey].ftmoEligible !== false);

  const rules = {
    balance, riskPerTradePct: riskPct, profitTargetPct: target,
    dailyLossPct: dailyLoss, maxLossPct: maxLoss, minTradingDays: minDays,
    enforceDailyStop: dailyStop,
  };

  const rows: Array<{ label: string; res: ChallengeResult }> = [];
  const portfolioTrades = results.flatMap((r) => r.trades);
  if (portfolioTrades.length) {
    rows.push({ label: "Cartera (todas)", res: simulateChallenge(portfolioTrades, rules) });
  }
  for (const r of results) {
    if (!r.trades.length) continue;
    rows.push({ label: STRATEGIES[r.engineKey].shortName, res: simulateChallenge(r.trades, rules) });
  }
  if (!rows.length) return null;

  const worstDd = Math.max(...results.map((r) => r.metrics.maxDrawdownR), 0);
  const suggested = suggestRiskPct(worstDd, maxLoss);

  // Ventanas rodantes: ¿se logra el reto dentro de 2-4 semanas?
  const rollingRows = rows.map(({ label }, i) => ({
    label,
    summary: simulateRollingChallenges(
      i === 0 && portfolioTrades.length ? portfolioTrades : results.find((r) => STRATEGIES[r.engineKey].shortName === label)?.trades ?? [],
      rules,
      windowDays,
      1,
    ),
  }));
  const riskSweep = portfolioTrades.length
    ? optimizeRiskForWindow(portfolioTrades, rules, windowDays)
    : [];
  const bestRisk = riskSweep.length
    ? [...riskSweep].sort(
        (a, b) =>
          b.summary.passRate - a.summary.passRate ||
          a.summary.failRate - b.summary.failRate ||
          a.riskPct - b.riskPct,
      )[0]!
    : null;

  return (
    <section className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-semibold">Simulador de reto (FTMO)</h3>
          <p className="text-xs text-muted-foreground">
            Convierte los R del backtest a USD con riesgo fijo por operación y aplica las
            reglas del reto: objetivo, pérdida diaria y pérdida total (flotante incluido).
          </p>
        </div>
        <Badge variant="outline">Riesgo sugerido: {suggested}% / trade</Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">Balance (USD)</span>
          <Input type="number" value={balance} onChange={(e) => setBalance(parseFloat(e.target.value) || 0)} />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">Riesgo / trade (%)</span>
          <Input type="number" step="0.05" value={riskPct} onChange={(e) => setRiskPct(parseFloat(e.target.value) || 0)} />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">Objetivo (%)</span>
          <Input type="number" step="0.5" value={target} onChange={(e) => setTarget(parseFloat(e.target.value) || 0)} />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">Pérdida diaria (%)</span>
          <Input type="number" step="0.5" value={dailyLoss} onChange={(e) => setDailyLoss(parseFloat(e.target.value) || 0)} />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">Pérdida total (%)</span>
          <Input type="number" step="0.5" value={maxLoss} onChange={(e) => setMaxLoss(parseFloat(e.target.value) || 0)} />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">Días mínimos</span>
          <Input type="number" step="1" value={minDays} onChange={(e) => setMinDays(parseInt(e.target.value) || 0)} />
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={dailyStop} onChange={(e) => setDailyStop(e.target.checked)} />
        Aplicar stop diario (deja de operar al 80% del límite diario) — así opera el Modo FTMO en vivo
      </label>

      {highRisk.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeHighRisk}
            onChange={(e) => setIncludeHighRisk(e.target.checked)}
          />
          Incluir motores de alto riesgo ({highRisk.map((r) => STRATEGIES[r.engineKey].shortName).join(", ")}) — desactivados por defecto en modo FTMO
        </label>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-background/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Estrategia</th>
              <th className="text-left px-3 py-2">Resultado</th>
              <th className="text-right px-3 py-2">Neto</th>
              <th className="text-right px-3 py-2">Equity final</th>
              <th className="text-right px-3 py-2">Peor día</th>
              <th className="text-right px-3 py-2">Max DD</th>
              <th className="text-right px-3 py-2">Días op.</th>
              <th className="text-right px-3 py-2">Días al objetivo</th>
              <th className="text-right px-3 py-2">Trades</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, res }) => (
              <tr key={label} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{label}</td>
                <td className="px-3 py-2">
                  {res.status === "passed" && <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">PASA fase 1</Badge>}
                  {res.status === "failed" && <Badge className="bg-red-500/15 text-red-400 border-red-500/30">NO pasa</Badge>}
                  {res.status === "in_progress" && <Badge variant="outline">Sin llegar al objetivo</Badge>}
                  {res.failReason && <div className="text-[11px] text-red-400 mt-1">{res.failReason}</div>}
                  {res.status === "in_progress" && res.tradingDays < minDays && (
                    <div className="text-[11px] text-muted-foreground mt-1">Faltan días mínimos ({res.tradingDays}/{minDays})</div>
                  )}
                </td>
                <td className={`text-right px-3 py-2 font-mono ${res.netPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {res.netPct >= 0 ? "+" : ""}{res.netPct.toFixed(2)}%
                </td>
                <td className="text-right px-3 py-2 font-mono">{res.finalEquity.toFixed(0)}</td>
                <td className="text-right px-3 py-2 font-mono text-red-400">-{res.worstDailyDdPct.toFixed(2)}%</td>
                <td className="text-right px-3 py-2 font-mono text-red-400">-{Math.max(0, res.maxDdPct).toFixed(2)}%</td>
                <td className="text-right px-3 py-2 font-mono">{res.tradingDays}</td>
                <td className="text-right px-3 py-2 font-mono">{res.daysToTarget ?? "—"}</td>
                <td className="text-right px-3 py-2 font-mono">
                  {res.tradesTaken}{res.tradesSkipped ? ` (+${res.tradesSkipped} omitidos)` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        El drawdown usa la peor excursión flotante (MAE) de cada operación, así que refleja el
        criterio real de FTMO (equity, no balance). Baja el riesgo por operación hasta que
        &quot;Max DD&quot; quede holgadamente por debajo del límite total.
      </p>

      {/* --- Ventanas rodantes de 2-4 semanas ------------------------------ */}
      <div className="pt-4 border-t border-border space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h4 className="font-semibold text-sm">Reto en ventana corta (2-4 semanas)</h4>
            <p className="text-xs text-muted-foreground">
              Simula el reto empezando en cada día del backtest y lo evalúa sólo durante la
              duración elegida. La tasa de éxito es la probabilidad real de superarlo a tiempo.
            </p>
          </div>
          <div className="flex gap-1">
            {[14, 21, 28, 42].map((d) => (
              <Button
                key={d}
                size="sm"
                variant={windowDays === d ? "default" : "outline"}
                onClick={() => setWindowDays(d)}
              >
                {d}d
              </Button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-background/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Estrategia</th>
                <th className="text-right px-3 py-2">Ventanas</th>
                <th className="text-right px-3 py-2">% éxito</th>
                <th className="text-right px-3 py-2">% quiebre</th>
                <th className="text-right px-3 py-2">Neto medio</th>
                <th className="text-right px-3 py-2">Mejor ventana</th>
                <th className="text-right px-3 py-2">Peor ventana</th>
                <th className="text-right px-3 py-2">Días al objetivo (mediana)</th>
                <th className="text-right px-3 py-2">Peor DD</th>
              </tr>
            </thead>
            <tbody>
              {rollingRows.map(({ label, summary }) => (
                <tr key={label} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{label}</td>
                  <td className="text-right px-3 py-2 font-mono">{summary.windows}</td>
                  <td className={`text-right px-3 py-2 font-mono ${summary.passRate > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {summary.passRate.toFixed(1)}%
                  </td>
                  <td className="text-right px-3 py-2 font-mono text-red-400">{summary.failRate.toFixed(1)}%</td>
                  <td className={`text-right px-3 py-2 font-mono ${summary.avgNetPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {summary.avgNetPct >= 0 ? "+" : ""}{summary.avgNetPct.toFixed(2)}%
                  </td>
                  <td className="text-right px-3 py-2 font-mono">
                    +{summary.bestNetPct.toFixed(2)}%
                    {summary.best && <div className="text-[10px] text-muted-foreground">{summary.best.start}</div>}
                  </td>
                  <td className="text-right px-3 py-2 font-mono text-red-400">
                    {summary.worstNetPct.toFixed(2)}%
                    {summary.worst && <div className="text-[10px] text-muted-foreground">{summary.worst.start}</div>}
                  </td>
                  <td className="text-right px-3 py-2 font-mono">{summary.medianDaysToTarget ?? "—"}</td>
                  <td className="text-right px-3 py-2 font-mono text-red-400">-{summary.worstMaxDdPct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {riskSweep.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h5 className="text-xs uppercase text-muted-foreground">
                Barrido de riesgo por operación · cartera · ventana {windowDays}d
              </h5>
              {bestRisk && (
                <Badge variant="outline">
                  Mejor: {bestRisk.riskPct}% / trade → {bestRisk.summary.passRate.toFixed(1)}% éxito
                </Badge>
              )}
            </div>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-background/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Riesgo / trade</th>
                    <th className="text-right px-3 py-2">% éxito</th>
                    <th className="text-right px-3 py-2">% quiebre</th>
                    <th className="text-right px-3 py-2">Neto medio</th>
                    <th className="text-right px-3 py-2">Peor DD</th>
                    <th className="text-right px-3 py-2">Días al objetivo</th>
                  </tr>
                </thead>
                <tbody>
                  {riskSweep.map(({ riskPct: rp, summary }) => (
                    <tr
                      key={rp}
                      className={`border-t border-border ${bestRisk?.riskPct === rp ? "bg-emerald-500/5" : ""}`}
                    >
                      <td className="px-3 py-2 font-mono">
                        {rp}%
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-2 h-6 px-2 text-[11px]"
                          onClick={() => setRiskPct(rp)}
                        >
                          usar
                        </Button>
                      </td>
                      <td className={`text-right px-3 py-2 font-mono ${summary.passRate > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                        {summary.passRate.toFixed(1)}%
                      </td>
                      <td className="text-right px-3 py-2 font-mono text-red-400">{summary.failRate.toFixed(1)}%</td>
                      <td className={`text-right px-3 py-2 font-mono ${summary.avgNetPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {summary.avgNetPct >= 0 ? "+" : ""}{summary.avgNetPct.toFixed(2)}%
                      </td>
                      <td className="text-right px-3 py-2 font-mono text-red-400">-{summary.worstMaxDdPct.toFixed(2)}%</td>
                      <td className="text-right px-3 py-2 font-mono">{summary.medianDaysToTarget ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Sube el riesgo hasta que el objetivo entre en la ventana, pero manteniendo el
              % de quiebre en 0 y el peor DD por debajo del límite total.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function ProfileDetailInner({ result }: { result: BacktestResult }) {
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
            <h4 className="text-xs uppercase text-muted-foreground mb-2">
              Equity (R acumulado) · <span className="text-primary">balance</span> vs{" "}
              <span className="text-emerald-400">flotante (peor/mejor)</span>
            </h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={m.equityCurve.map((p) => ({
                    ...p,
                    floatingBand: [p.floatingLowR, p.floatingHighR] as [number, number],
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="trade" stroke="var(--muted-foreground)" fontSize={11} />
                  <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                  <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }} />
                  <Area
                    type="monotone"
                    dataKey="floatingBand"
                    name="Rango flotante"
                    stroke="#34d399"
                    strokeWidth={1}
                    fill="#34d399"
                    fillOpacity={0.28}
                    isAnimationActive={false}
                  />
                  <Line type="monotone" dataKey="equityR" name="Balance" stroke="var(--primary)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <h4 className="text-xs uppercase text-muted-foreground mt-4 mb-2">
              Flotante por trade (R) · <span className="text-emerald-400">MFE máx</span> /{" "}
              <span className="text-red-400">MAE peor</span>
            </h4>
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={result.trades.map((t, i) => ({ trade: i + 1, mfeR: t.mfeR ?? 0, maeR: t.maeR ?? 0 }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="trade" stroke="var(--muted-foreground)" fontSize={11} />
                  <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                  <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }} />
                  <ReferenceLine y={0} stroke="var(--border)" />
                  <Bar dataKey="mfeR" name="MFE" fill="#34d399" isAnimationActive={false} />
                  <Bar dataKey="maeR" name="MAE" fill="#f87171" isAnimationActive={false} />
                </BarChart>
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

function AiPanel({ result }: { result: BacktestResult }) {
  const engineKey = result.engineKey;
  const trainer = useAiTrainer();
  const [model, setModel] = useState<AnyModel | null>(() => loadModel(engineKey));
  const [error, setError] = useState<string | null>(null);
  const [training, setTraining] = useState(false);
  // Fibo Scalping trae features ricos → default MLP. Los demás motores → logistic.
  const defaultType: "logistic" | "mlp" = engineKey === "fibo_scalping" ? "mlp" : "logistic";
  const [modelType, setModelType] = useState<"logistic" | "mlp">(defaultType);

  const startTraining = async () => {
    setError(null);
    setTraining(true);
    try {
      const features = result.trades.map((t) => t.features);
      const labels = result.trades.map((t) => (t.rMultiple > 0 ? 1 : 0));
      const rMultiples = result.trades.map((t) => t.rMultiple);
      const featureNames = (result.trades[0] as { featureNames?: readonly string[] } | undefined)?.featureNames;
      const m = await trainer.train({
        features, labels, rMultiples,
        epochs: modelType === "mlp" ? 300 : 250,
        modelType,
        featureNames,
      });
      setModel(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error entrenando");
    } finally {
      setTraining(false);
    }
  };

  const persist = () => {
    if (!model) return;
    saveModel(engineKey, model);
    setModel({ ...model });
  };
  const remove = () => { deleteModel(engineKey); setModel(null); };

  const wins = result.trades.filter((t) => t.rMultiple > 0).length;
  const baselineWr = result.trades.length ? wins / result.trades.length : 0;
  const positiveClassRatio = baselineWr;
  const hasSaved = typeof window !== "undefined" && !!localStorage.getItem("tc.ai.model." + engineKey);
  const currentModelType = isMlpModel(model) ? "MLP" : "Logistic";
  const featureCount = result.trades[0]?.features.length ?? 0;

  return (
    <section className="rounded-lg border border-primary/40 bg-card p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">IA · Filtro sobre {STRATEGIES[engineKey].shortName}</h3>
          <Badge variant="outline" className="text-xs">
            {model ? currentModelType : (modelType === "mlp" ? "MLP 32→16" : "Logistic")} · {featureCount} features
          </Badge>
        </div>
        <div className="flex gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setModelType("logistic")}
              className={`px-2 py-1 ${modelType === "logistic" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
              disabled={training}
            >Logistic</button>
            <button
              type="button"
              onClick={() => setModelType("mlp")}
              className={`px-2 py-1 ${modelType === "mlp" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
              disabled={training}
            >MLP</button>
          </div>
          <Button size="sm" onClick={startTraining} disabled={training}>
            {training ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Brain className="w-3.5 h-3.5 mr-1" />}
            {training ? "Entrenando..." : model ? "Reentrenar" : "Entrenar modelo"}
          </Button>
          {model && (
            <>
              <Button size="sm" variant="secondary" onClick={persist}>
                <Save className="w-3.5 h-3.5 mr-1" /> Guardar modelo
              </Button>
              {hasSaved && (
                <Button size="sm" variant="ghost" onClick={remove}>
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Borrar
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Entrena un clasificador local con los <span className="font-mono text-foreground">{result.trades.length}</span> trades
        del backtest (70% entrenamiento, 30% validación cronológica). Corre en un Web Worker aparte, no bloquea la UI.
        Baseline WR: <span className="font-mono text-foreground">{(positiveClassRatio * 100).toFixed(1)}%</span>.
      </p>

      {trainer.progress && (
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Epoch <span className="font-mono">{trainer.progress.epoch}/{trainer.progress.total}</span> ·
          loss <span className="font-mono">{trainer.progress.loss.toFixed(4)}</span>
        </div>
      )}
      {error && <div className="text-xs text-destructive">{error}</div>}

      {model && (
        <>
          <div className="grid md:grid-cols-4 gap-3 text-xs">
            <Metric label="AUC validación" value={model.metrics.valAuc.toFixed(3)}
              hint={model.metrics.valAuc >= 0.6 ? "modelo útil" : model.metrics.valAuc >= 0.55 ? "señal leve" : "no aporta"} />
            <Metric label="Log-loss val" value={model.metrics.valLogLoss.toFixed(3)} />
            <Metric label="Train / Val" value={`${model.metrics.trainSize} / ${model.metrics.valSize}`} />
            <Metric label="Umbral sugerido" value={`P ≥ ${(model.metrics.threshold * 100).toFixed(0)}%`} />
          </div>

          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-background/50 text-muted-foreground uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Escenario en validación</th>
                  <th className="text-right px-3 py-2">Trades</th>
                  <th className="text-right px-3 py-2">Winrate</th>
                  <th className="text-right px-3 py-2">Expectancy</th>
                  <th className="text-right px-3 py-2">Total R</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border">
                  <td className="px-3 py-2">Sin IA (baseline)</td>
                  <td className="text-right px-3 py-2 font-mono">{model.metrics.valSize}</td>
                  <td className="text-right px-3 py-2 font-mono">{(model.metrics.baselineWinrate * 100).toFixed(1)}%</td>
                  <td className="text-right px-3 py-2 font-mono">{model.metrics.expectancyBase.toFixed(2)}R</td>
                  <td className={`text-right px-3 py-2 font-mono ${model.metrics.totalRBase >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {model.metrics.totalRBase >= 0 ? "+" : ""}{model.metrics.totalRBase.toFixed(2)}R
                  </td>
                </tr>
                <tr className="border-t border-border bg-emerald-500/5">
                  <td className="px-3 py-2">
                    Con IA (P ≥ {(model.metrics.threshold * 100).toFixed(0)}%)
                    <span className="ml-2 text-muted-foreground">· conserva {(model.metrics.keptRatio * 100).toFixed(0)}% de setups</span>
                  </td>
                  <td className="text-right px-3 py-2 font-mono">{Math.round(model.metrics.valSize * model.metrics.keptRatio)}</td>
                  <td className="text-right px-3 py-2 font-mono">{(model.metrics.winrateAtThreshold * 100).toFixed(1)}%</td>
                  <td className="text-right px-3 py-2 font-mono">{model.metrics.expectancyFiltered.toFixed(2)}R</td>
                  <td className={`text-right px-3 py-2 font-mono ${model.metrics.totalRFiltered >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {model.metrics.totalRFiltered >= 0 ? "+" : ""}{model.metrics.totalRFiltered.toFixed(2)}R
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              <span className="text-foreground font-medium">Delta:</span>{" "}
              Winrate <span className="font-mono">
                {((model.metrics.winrateAtThreshold - model.metrics.baselineWinrate) * 100).toFixed(1)} pp
              </span> · Expectancy{" "}
              <span className="font-mono">
                {(model.metrics.expectancyFiltered - model.metrics.expectancyBase).toFixed(2)}R
              </span>
            </p>
            <p>
              Modelo entrenado {new Date(model.trainedAt).toLocaleString()}. Guardar lo persiste en este navegador para
              usarlo como filtro en el dashboard/Telegram (próximo paso: cablearlo al motor en vivo y exportarlo a ONNX para MT5).
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-3 py-2">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function fmtDate(unix: number) {
  if (!unix) return "—";
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function WalkForwardPanel({ wf, onApply }: { wf: WfResult; onApply: (ms: number, hrs: number[]) => void }) {
  const ratio = (a: number, b: number) => {
    if (!isFinite(a) || !isFinite(b) || b === 0) return null;
    return a / b;
  };
  const pfRatio = ratio(wf.test.profitFactor, wf.train.profitFactor);
  const expRatio = ratio(wf.test.expectancy, wf.train.expectancy);
  // Robustness: PF test vs train.
  const robust = pfRatio == null
    ? { label: "—", cls: "text-muted-foreground" }
    : pfRatio >= 0.8
    ? { label: "🟢 Robusto (≥80%)", cls: "text-emerald-400" }
    : pfRatio >= 0.5
    ? { label: "🟡 Aceptable (50–80%)", cls: "text-amber-400" }
    : { label: "🔴 Overfit (<50%)", cls: "text-red-400" };
  const sameSign = wf.train.totalR >= 0 && wf.test.totalR >= 0;
  return (
    <section className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Split className="w-4 h-4 text-primary" />
        <h3 className="font-semibold">
          Walk-forward 70/30 · {STRATEGIES[wf.engineKey].shortName}
        </h3>
        <Badge variant="outline" className="text-xs font-mono">
          minScore={wf.chosen.minScore}
          {wf.chosen.excludeHours.length ? ` · excl [${wf.chosen.excludeHours.join(",")}]` : ""}
        </Badge>
        <span className={`text-xs font-medium ${robust.cls}`}>{robust.label}</span>
        <div className="ml-auto">
          <Button size="sm" variant="outline" onClick={() => onApply(wf.chosen.minScore, wf.chosen.excludeHours)}>
            <Save className="w-3.5 h-3.5 mr-1" /> Aplicar combo
          </Button>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        TRAIN <span className="font-mono text-foreground">{fmtDate(wf.trainRange.from)} → {fmtDate(wf.trainRange.to)}</span>
        {" "}· TEST <span className="font-mono text-foreground">{fmtDate(wf.testRange.from)} → {fmtDate(wf.testRange.to)}</span>
        {" "}· Split UTC <span className="font-mono">{new Date(wf.splitTime * 1000).toISOString().slice(0, 16).replace("T", " ")}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground uppercase">
            <tr>
              <th className="text-left py-2">Ventana</th>
              <th className="text-right py-2">Trades</th>
              <th className="text-right py-2">WR</th>
              <th className="text-right py-2">Total R</th>
              <th className="text-right py-2">Expect.</th>
              <th className="text-right py-2">PF</th>
              <th className="text-right py-2">Max DD</th>
              <th className="text-right py-2">Sharpe</th>
            </tr>
          </thead>
          <tbody>
            <Row label="TRAIN (70% · in-sample)" m={wf.train} />
            <Row label="TEST (30% · out-of-sample)" m={wf.test} highlight />
          </tbody>
        </table>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          <span className="text-foreground font-medium">Degradación PF:</span>{" "}
          {pfRatio == null ? "—" : `${(pfRatio * 100).toFixed(0)}% del TRAIN`}
          {" · "}
          <span className="text-foreground font-medium">Expectancy test/train:</span>{" "}
          {expRatio == null ? "—" : `${(expRatio * 100).toFixed(0)}%`}
          {" · "}
          <span className={sameSign ? "text-emerald-400" : "text-red-400"}>
            {sameSign ? "Ambas ventanas positivas" : "Signo distinto entre ventanas"}
          </span>
        </p>
        <p>
          Regla: si PF test ≥ 80% del train y totalR test &gt; 0, la combo es candidata para paper-trading.
          Si &lt; 50%, hay overfitting: no la lleves a FTMO.
        </p>
      </div>
    </section>
  );
}

function Row({ label, m, highlight }: { label: string; m: WfWindowMetrics; highlight?: boolean }) {
  return (
    <tr className={`border-t border-border ${highlight ? "bg-emerald-500/5" : ""}`}>
      <td className="py-2">{label}</td>
      <td className="text-right py-2 font-mono">{m.trades}</td>
      <td className="text-right py-2 font-mono">{(m.winrate * 100).toFixed(1)}%</td>
      <td className={`text-right py-2 font-mono ${m.totalR >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        {m.totalR >= 0 ? "+" : ""}{m.totalR.toFixed(2)}
      </td>
      <td className="text-right py-2 font-mono">{m.expectancy.toFixed(2)}</td>
      <td className="text-right py-2 font-mono">{m.profitFactor.toFixed(2)}</td>
      <td className="text-right py-2 font-mono text-red-400">-{m.maxDrawdownR.toFixed(2)}</td>
      <td className="text-right py-2 font-mono">{m.sharpe.toFixed(2)}</td>
    </tr>
  );
}

function PfHeatmap({ rows, onPick }: { rows: OptRow[]; onPick: (ms: number, hrs: number[]) => void }) {
  if (!rows.length) return null;
  const scoresSet = new Set<number>();
  const variantsMap = new Map<string, number[]>();
  for (const r of rows) {
    scoresSet.add(r.minScore);
    const key = r.excludeHours.slice().sort((a, b) => a - b).join(",");
    if (!variantsMap.has(key)) variantsMap.set(key, r.excludeHours);
  }
  const scores = Array.from(scoresSet).sort((a, b) => a - b);
  const variants = Array.from(variantsMap.entries()); // [key, hours[]]

  const cellKey = (ms: number, key: string) => `${ms}|${key}`;
  const cells = new Map<string, OptRow>();
  for (const r of rows) {
    const k = cellKey(r.minScore, r.excludeHours.slice().sort((a, b) => a - b).join(","));
    // keep row with more trades (best-sampled) if duplicates arise
    const cur = cells.get(k);
    if (!cur || r.trades > cur.trades) cells.set(k, r);
  }

  const pfs = rows.map((r) => (isFinite(r.profitFactor) ? Math.min(r.profitFactor, 3) : 3));
  const minPf = Math.min(0.5, ...pfs);
  const maxPf = Math.max(1.5, ...pfs);

  const color = (pf: number) => {
    // 1.0 = neutral; below → red, above → green. Clamp to [minPf, maxPf].
    const p = Math.max(minPf, Math.min(maxPf, pf));
    if (p >= 1) {
      const t = (p - 1) / Math.max(0.01, maxPf - 1); // 0..1
      const alpha = 0.15 + 0.55 * t;
      return `rgba(16, 185, 129, ${alpha.toFixed(2)})`; // emerald
    }
    const t = (1 - p) / Math.max(0.01, 1 - minPf);
    const alpha = 0.15 + 0.55 * t;
    return `rgba(239, 68, 68, ${alpha.toFixed(2)})`; // red
  };

  const labelForVariant = (hrs: number[]) => (hrs.length ? `[${hrs.join(",")}]` : "sin excl.");

  return (
    <div className="mt-4 rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground mb-2">
        Heatmap Profit Factor · filas = <span className="text-foreground font-mono">minScore</span> · columnas = variantes de horas excluidas.
        Verde ≥ 1, rojo &lt; 1. Click en una celda para aplicarla como config.
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left px-2 py-1 sticky left-0 bg-card">minScore \ excl.</th>
              {variants.map(([key, hrs]) => (
                <th key={key} className="px-2 py-1 font-mono whitespace-nowrap text-center min-w-[90px]">
                  {labelForVariant(hrs)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scores.map((ms) => (
              <tr key={ms}>
                <td className="px-2 py-1 font-mono sticky left-0 bg-card">{ms}</td>
                {variants.map(([key, hrs]) => {
                  const r = cells.get(cellKey(ms, key));
                  if (!r || !isFinite(r.profitFactor) || r.trades < 1) {
                    return <td key={key} className="px-2 py-1 text-center text-muted-foreground border border-border/40">—</td>;
                  }
                  const pf = r.profitFactor;
                  return (
                    <td
                      key={key}
                      style={{ backgroundColor: color(pf) }}
                      className="px-2 py-1 text-center border border-border/40 cursor-pointer hover:outline hover:outline-1 hover:outline-primary"
                      title={`minScore=${ms} · excl=${labelForVariant(hrs)}\nPF=${pf.toFixed(2)} · trades=${r.trades} · WR=${(r.winrate * 100).toFixed(1)}% · totalR=${r.totalR.toFixed(2)}`}
                      onClick={() => onPick(ms, hrs)}
                    >
                      <div className="font-mono">{pf.toFixed(2)}</div>
                      <div className="text-[10px] text-muted-foreground">{r.trades}t</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>PF:</span>
        <span className="px-2 py-0.5 rounded" style={{ backgroundColor: "rgba(239,68,68,0.6)" }}>&lt; 1</span>
        <span className="px-2 py-0.5 rounded" style={{ backgroundColor: "rgba(148,163,184,0.2)" }}>≈ 1</span>
        <span className="px-2 py-0.5 rounded" style={{ backgroundColor: "rgba(16,185,129,0.6)" }}>&gt; 1</span>
      </div>
    </div>
  );
}

// Formatea milisegundos como mm:ss (o hh:mm:ss si >1h).
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

// Renderiza los detalles de una fase de simulación del worker: barra %, trades, elapsed, ETA.
function formatWorkerProgress(p: {
  phase?: string; percent?: number; trades?: number;
  phaseStartedAt?: number; jobStartedAt?: number;
}): string {
  const parts: string[] = [];
  if (p.phase) parts.push(`fase: ${p.phase}`);
  if (typeof p.percent === "number") parts.push(`${Math.round(p.percent * 100)}%`);
  if (typeof p.trades === "number") parts.push(`${p.trades} trades`);
  if (p.phaseStartedAt) {
    const el = Date.now() - p.phaseStartedAt;
    parts.push(`${formatElapsed(el)}`);
    if (p.percent && p.percent > 0.02) {
      const eta = (el / p.percent) * (1 - p.percent);
      parts.push(`ETA ${formatElapsed(eta)}`);
    }
  }
  return parts.join(" · ");
}