import type { Candle } from "../analysis";
import { generateSignal as smcGenerate, type Signal } from "../signal-engine";
import { evaluateAlligatorBB } from "./alligator-bb";
import { evaluateFiboScalping } from "./fibo-scalping";
import { evaluateGoldScalping } from "./gold-scalping";
import { evaluateEmaCrossM1 } from "./ema-cross-m1";
import { evaluateStraddleBreakout } from "./straddle-breakout";
import { evaluateFiboGridCent } from "./fibo-grid-cent";
import type { TfKey } from "../csv-parser";

export type EngineKey =
  | "smc_london"
  | "alligator_bb"
  | "fibo_scalping"
  | "gold_scalping"
  | "ema_cross_m1"
  | "straddle_breakout"
  | "fibo_grid_cent";

export type StrategyParams = {
  minScore?: number;
  [k: string]: unknown;
};

// Mapa de velas por timeframe. Cada estrategia declara qué TFs necesita.
export type Bars = Partial<Record<TfKey, Candle[]>>;

export type StrategyEngine = {
  key: EngineKey;
  name: string;
  shortName: string;
  description: string;
  defaultParams: StrategyParams;
  killzoneHoursUTC: number[]; // informativo
  // Si es false, la estrategia NO se envía al EA salvo que el usuario la
  // active explícitamente en /settings (motores experimentales / alto riesgo).
  defaultEnabled?: boolean;
  // Aviso mostrado en la UI para motores de alto riesgo.
  riskNote?: string;
  // TF que dispara la evaluación (se itera bar por bar en el backtest y
  // define la granularidad de simulación de SL/TP).
  triggerTf: TfKey;
  // TFs que la estrategia necesita presentes (subset de M1..H4).
  requiredTfs: TfKey[];
  // Overrides del simulador (cooldown entre trades y hold máximo en barras del
  // trigger TF). Útil para motores tipo grid que reevalúan constantemente.
  backtestDefaults?: { cooldownBars?: number; maxHoldBars?: number };
  // Nueva API: recibe un mapa de bars ya sliced hasta el tiempo del trigger bar.
  evaluate(bars: Bars, params: StrategyParams): Signal;
};

export const STRATEGIES: Record<EngineKey, StrategyEngine> = {
  smc_london: {
    key: "smc_london",
    name: "SMC Londres (Sweep + FVG)",
    shortName: "E1 · SMC Londres",
    description:
      "v2 (optimizada sobre 1 año de XAUUSD M1): tendencia H4 + barrido de liquidez H1 + FVG/BOS en M15. Nuevo: SL acotado a 2×ATR(M15) (descarta sweeps lejanos que disparaban el drawdown flotante), break-even a 0.5R y time-stop de 24 velas M15. Backtest 1 año: 233 trades, 50.6% WR, +75.7R, PF 2.22, Max DD 4.2R y reto FTMO superado con 0.5%/trade.",
    defaultParams: { minScore: 70, maxRiskAtrMult: 2, breakEvenAtR: 0.5, timeStopBars: 24 },
    killzoneHoursUTC: [2, 3, 4],
    triggerTf: "M15",
    requiredTfs: ["H4", "H1", "M15"],
    evaluate: (bars, params) =>
      smcGenerate(bars.H4 ?? [], bars.H1 ?? [], bars.M15 ?? [], {
        profile: "full",
        minScore: (params.minScore as number) ?? 70,
        requireKillzone: params.requireKillzone as boolean | undefined,
        requireBos: params.requireBos as boolean | undefined,
        requireH1Align: params.requireH1Align as boolean | undefined,
        maxRiskAtrMult: params.maxRiskAtrMult as number | undefined,
        minRiskAtrMult: params.minRiskAtrMult as number | undefined,
        breakEvenAtR: params.breakEvenAtR as number | undefined,
        timeStopBars: params.timeStopBars as number | undefined,
        trailAfterR: params.trailAfterR as number | undefined,
        trailStepAtrMult: params.trailStepAtrMult as number | undefined,
      }),
  },
  alligator_bb: {
    key: "alligator_bb",
    name: "Alligator + Bollinger Breakout (M15)",
    shortName: "E2 · Alligator BB",
    description:
      "v4: Alligator (13/8/5) + Bollinger(20,2) con TTM-Squeeze release (BB dentro de Keltner 1.5×ATR y ahora fuera), confirmación de Awesome Oscillator (Bill Williams), ADX≥22, doble EMA200 (H1+H4) con pendiente, y ventana Londres-NY overlap 12-17 UTC. Retest tras breakout, cuerpo ≥65%, mecha opuesta ≤30%. SL estructural (swing±0.3×ATR, cap 1.8×ATR). BE@0.7R, time-stop 10.",
    defaultParams: { minScore: 70 },
    killzoneHoursUTC: [12, 13, 14, 15, 16, 17],
    triggerTf: "M15",
    requiredTfs: ["H4", "H1", "M15"],
    evaluate: (bars, params) =>
      evaluateAlligatorBB(bars.M15 ?? [], bars.H1 ?? [], (params.minScore as number) ?? 70, bars.H4),
  },
  fibo_scalping: {
    key: "fibo_scalping",
    name: "Fibo Scalping M5 Oro (Londres)",
    shortName: "E3 · Fibo Scalping M5",
    description:
      "v2 (post-Fibonacci 61.8 EA sin martingala): sesgo H4 (>0.08%), swing H1 con EMA20/50 alineada obligatoria, retroceso 0.5-0.786 tocado en las últimas 4 M15, trigger M5 con BOS20 y bonus por confluencia Fibo H4. Killzone Londres 07-11, sin domingos, viernes hasta 12 UTC. Gestión: BE@0.6R, time-stop 20 M5, trailing escalonado desde 0.8R (paso 0.4·ATR), daily target/loss ±2R.",
    defaultParams: { minScore: 72 },
    killzoneHoursUTC: [7, 8, 9, 10],
    triggerTf: "M5",
    requiredTfs: ["H4", "H1", "M15", "M5"],
    evaluate: (bars, params) =>
      evaluateFiboScalping(bars.H4 ?? [], bars.H1 ?? [], bars.M15 ?? [], bars.M5 ?? [], (params.minScore as number) ?? 72),
  },
  gold_scalping: {
    key: "gold_scalping",
    name: "VWAP Band Failure Oro (M1)",
    shortName: "E4 · VWAP Reversion",
    description:
      "v2 (optimizada en 1 año de XAUUSD M1): la reversión al VWAP perdía −2.028R, así que ahora se opera la continuación. Precio estirado ≥2.9σ del VWAP diario + pin bar de rebote fallido (mecha ≥55%, cuerpo ≤50%) ⇒ se entra A FAVOR de la extensión. SL = extremo 3 velas ± 2.0×ATR(M1), riesgo 2.5-8 USD, TP 1R/2R/3R, trailing desde 1.0R (0.3×ATR) y time-stop 180 velas. 05-22 UTC, sin fines de semana. Backtest 1 año: 52 trades, 65.4% WR, +13.2R, PF 1.69, Max DD 4.7R y positivo en los 4 trimestres.",
    defaultParams: { minScore: 60 },
    killzoneHoursUTC: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    triggerTf: "M1",
    requiredTfs: ["M1", "M5"],
    evaluate: (bars, params) =>
      evaluateGoldScalping(bars.M1 ?? [], bars.M5 ?? [], (params.minScore as number) ?? 60),
  },
  ema_cross_m1: {
    key: "ema_cross_m1",
    name: "EMA Cross Reversal M1 v2 (fade)",
    shortName: "E5 · EMA Cross M1",
    description:
      "Reversión al cruce EMA9/EMA21 en M1: detecta el impulso (slope EMA9 ≥ 0.20, RSI 55/45, MACD hist cruzando 0) y opera EN CONTRA. Killzone UTC 7-16, ATR M5 sano, SL = 1.8×ATR(M1) sobre swing 5b y trailing escalonado desde 1.0R (0.25×ATR). Optimizada en 1 año de XAUUSD M1: 301 trades, WR 56.8%, +36.5R, PF 1.27, Max DD 6.4R.",
    defaultParams: { minScore: 60 },
    killzoneHoursUTC: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    triggerTf: "M1",
    requiredTfs: ["M1", "M5"],
    evaluate: (bars, params) =>
      evaluateEmaCrossM1(bars.M1 ?? [], bars.M5 ?? [], (params.minScore as number) ?? 60),
  },
  straddle_breakout: {
    key: "straddle_breakout",
    name: "Straddle Breakout ATR M1",
    shortName: "E6 · Straddle Breakout",
    description:
      "Straddle ±0.6×ATR(M5) alrededor del close previo M1. Entra en ruptura con cuerpo ≥55% del rango y sesgo M5 alineado. Killzones Londres 7-10 y NY 13-15 UTC. SL = 0.8×ATR(M1), sin cierre por tiempo.",
    defaultParams: { minScore: 65 },
    killzoneHoursUTC: [7, 8, 9, 13, 14],
    triggerTf: "M1",
    requiredTfs: ["M1", "M5"],
    evaluate: (bars, params) =>
      evaluateStraddleBreakout(bars.M1 ?? [], bars.M5 ?? [], (params.minScore as number) ?? 65),
  },
  fibo_grid_cent: {
    key: "fibo_grid_cent",
    name: "Fibo 61.8 Grid Cent (XAUUSD)",
    shortName: "E7 · Fibo 61.8 Cent",
    description:
      "Réplica 1:1 del 'Fibonacci 61.8 EA' (MQL5 178321, .set oficial) para cuentas CENT de prueba (100 USD = 10.000 cents). Opera 24 h: re-mide el fibo del swing H1 en cada barra, borra y recoloca hasta 100 pendientes combinando LIMIT (retroceso) y STOP (impulso) con sesgo 3:1 al lado de la tendencia, mismo lote (SIN martingala). RSI(14) 35/75, Awesome Oscillator y MA(15m) como en el original; régimen ATR M15 (bajo 2.5 / alto 4.5). Perfil SL 20 % / TP 5 % traducido a ATR: SL holgado 8×ATR para dejar respirar el precio y TP corto 2×ATR (≈0.25R). Trailing escalonado desde 0.2R (paso 1×ATR), BE a 0.35R y time-stop 96 barras. Desactivada por defecto.",
    defaultParams: {
      minScore: 45,
      fiboLevel: 0.618,
      maxOrders: 100,
      gridStepAtr: 0.35,
      atrMediumRatio: 1.3,
      atrBlockRatio: 2.4,
      rsiLow: 35,
      rsiHigh: 75,
      expireMinutes: 66,
      dailyTargetR: 3,
      dailyLossLimitR: 2,
      slAtrMult: 8,
      tpAtrMult: 2,
      longBias: 3,
      requireAo: false,
    },
    killzoneHoursUTC: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    triggerTf: "M1",
    requiredTfs: ["H4", "H1", "M15", "M1"],
    // El EA reevalúa cada minuto: cooldown corto y hold largo para que el
    // precio respire (24 h de barras M1).
    backtestDefaults: { cooldownBars: 30, maxHoldBars: 1440 },
    defaultEnabled: false,
    riskNote: "Alto riesgo · sólo cuenta CENT de pruebas",
    evaluate: (bars, params) =>
      evaluateFiboGridCent(bars.H4 ?? [], bars.H1 ?? [], bars.M15 ?? [], bars.M1, params as never),
  },
};

export function listStrategies(): StrategyEngine[] {
  return Object.values(STRATEGIES);
}

export function getStrategy(key: EngineKey): StrategyEngine {
  return STRATEGIES[key];
}