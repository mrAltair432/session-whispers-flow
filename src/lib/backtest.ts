import type { Candle } from "./analysis";
import { atr as atrSeries } from "./analysis";
import { getStrategy, type Bars, type EngineKey, type StrategyParams } from "./strategies";
import type { TfKey } from "./csv-parser";

// Costos de ejecución en USD (oro). El precio de entrada real se degrada
// `costPerSideUsd` (=spread/2 + slippage + commission) en contra del bias,
// e igual en cada cierre (parcial o total). Se descuentan del rMultiple
// usando el riesgo inicial de la operación.
export type BacktestCosts = {
  spreadUsd?: number;      // ancho total del spread bid/ask (default per-TF)
  slippageUsd?: number;    // deslizamiento por ejecución (default per-TF)
  commissionUsd?: number;  // comisión por lado en USD (default 0)
  latencyBars?: number;    // barras de retraso entre señal y entrada (default per-TF)
};

export type BacktestOptions = {
  engineKey: EngineKey;
  params?: StrategyParams;
  warmupBars?: number;     // bars to skip at start (default 100)
  maxHoldBars?: number;    // close trade after N M15 bars if no exit (default 96 = 24h)
  cooldownBars?: number;   // bars to wait between trades (default 16 = 4h)
  excludeHours?: number[]; // UTC hours to skip (manual)
  excludeWeekdays?: number[]; // 0=Sun..6=Sat to skip
  autoTimeFilters?: boolean; // default true: aplica filtros de horario peligroso del oro
  costs?: BacktestCosts;
  // Daily equity guardrails (idea portada del Fibonacci 61.8 EA, en R):
  // una vez que el PnL del día UTC alcanza `dailyTargetR` o cae por debajo
  // de `-dailyLossLimitR`, no se abren nuevas operaciones hasta el siguiente
  // día UTC. No cierra posiciones ya abiertas.
  dailyTargetR?: number;
  dailyLossLimitR?: number;
  // Reporte de progreso desde el bucle de simulación. El worker lo usa para
  // enviar % + trades acumulados a la UI cada ~5000 barras evaluadas.
  onProgress?: (p: { phase: "simulate"; percent: number; trades: number; bar: number; totalBars: number }) => void;
};

export type BacktestTrade = {
  openTime: number;
  closeTime: number;
  bias: "long" | "short";
  score: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  exit: number;
  rMultiple: number;
  outcome: "tp1" | "tp2" | "tp3" | "sl" | "be" | "timeout";
  hourUTC: number;
  weekday: number; // 0=Sun..6=Sat
  features: number[]; // vector para el clasificador IA (orden en FEATURE_NAMES)
};

// Nombres de features en el mismo orden que buildFeatures().
// Cualquier cambio aquí obliga a reentrenar los modelos guardados.
export const FEATURE_NAMES = [
  "h4Trend",
  "h1Sweep",
  "m15Fvg",
  "m15Bos",
  "killzone",
  "atrScore",
  "h1Align",
  "totalScore",
  "biasLong",
  "hourSin",
  "hourCos",
  "weekdaySin",
  "weekdayCos",
] as const;

export function buildFeatures(
  breakdown: { h4Trend: number; h1Sweep: number; m15Fvg: number; m15Bos: number; killzone: number; atr: number; h1Alignment: number; total: number },
  bias: "long" | "short",
  hourUTC: number,
  weekday: number,
): number[] {
  const twoPi = Math.PI * 2;
  return [
    breakdown.h4Trend / 20,
    breakdown.h1Sweep / 25,
    breakdown.m15Fvg / 20,
    breakdown.m15Bos / 15,
    breakdown.killzone / 12,
    breakdown.atr / 10,
    breakdown.h1Alignment / 5,
    breakdown.total / 100,
    bias === "long" ? 1 : 0,
    Math.sin((twoPi * hourUTC) / 24),
    Math.cos((twoPi * hourUTC) / 24),
    Math.sin((twoPi * weekday) / 7),
    Math.cos((twoPi * weekday) / 7),
  ];
}

export type BacktestMetrics = {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winrate: number;
  totalR: number;
  avgR: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownR: number;
  longestWinStreak: number;
  longestLossStreak: number;
  sharpe: number;
  outcomeCounts: Record<BacktestTrade["outcome"], number>;
  byHour: Array<{ hour: number; trades: number; totalR: number; winrate: number }>;
  byWeekday: Array<{ weekday: number; trades: number; totalR: number; winrate: number }>;
  equityCurve: Array<{ trade: number; equityR: number }>;
};

export type BacktestResult = {
  engineKey: EngineKey;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
};

// Filtros automáticos para XAU/USD:
// - sábado completo (weekday=6) → mercado cerrado
// - viernes >= 21 UTC → cierre semanal
// - domingo < 22 UTC → mercado aún cerrado (abre 22 UTC dom = lunes Sídney)
// - lunes < 2 UTC → primeras 2h tras gap de apertura
// - hora UTC 22 lun-jue → pausa diaria CME (17:00 NY)
function isMarketClosedOrRisky(d: Date): boolean {
  const wd = d.getUTCDay(); // 0=Sun..6=Sat
  const h = d.getUTCHours();
  if (wd === 6) return true;             // sábado
  if (wd === 0 && h < 22) return true;   // domingo antes de la apertura
  if (wd === 5 && h >= 21) return true;  // viernes cierre
  if (wd === 1 && h < 2) return true;    // gap lunes
  if (wd >= 1 && wd <= 4 && h === 22) return true; // pausa diaria L-J
  return false;
}

// Filter h4/h1 candles up to a given timestamp (returns slice).
function sliceUpTo(candles: Candle[], time: number): Candle[] {
  // binary search for last index with time <= time
  let lo = 0;
  let hi = candles.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= time) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (res < 0) return [];
  return candles.slice(0, res + 1);
}

export function simulateTrade(
  m15: Candle[],
  entryIdx: number,
  bias: "long" | "short",
  entry: number,
  initialSL: number,
  tp1: number,
  tp2: number,
  tp3: number,
  maxHoldBars: number,
  costPerSideUsd: number,
  management?: { breakEvenAtR?: number; timeStopBars?: number; trailAfterR?: number; trailStepAtrMult?: number },
  atrArr?: number[],
): { exit: number; rMultiple: number; outcome: BacktestTrade["outcome"]; closeTime: number } {
  const initRisk = Math.abs(entry - initialSL);
  let sl = initialSL;
  let tp1Hit = false;
  let tp2Hit = false;
  // Position allocation: 50% to TP1, 30% to TP2, 20% runner
  let realizedR = 0;
  let remaining = 1;
  const costR = initRisk > 0 ? costPerSideUsd / initRisk : 0;
  // Coste de la entrada (una sola vez sobre la posición completa)
  realizedR -= costR;
  const beAtR = management?.breakEvenAtR;
  const timeStopBars = management?.timeStopBars;
  const trailAfterR = management?.trailAfterR;
  const trailStepMult = management?.trailStepAtrMult;
  const trailingOn = !!(trailAfterR && trailStepMult && atrArr && atrArr.length);
  let beMoved = false;
  let bestPrice = entry; // MFE para trailing escalonado

  const closeRemaining = (price: number, time: number, outcome: BacktestTrade["outcome"]) => {
    const moveR = bias === "long" ? (price - entry) / initRisk : (entry - price) / initRisk;
    realizedR += remaining * moveR;
    // Coste de cierre proporcional al tamaño que queda
    realizedR -= remaining * costR;
    remaining = 0;
    return { exit: price, rMultiple: realizedR, outcome, closeTime: time };
  };

  const end = Math.min(m15.length - 1, entryIdx + maxHoldBars);
  for (let i = entryIdx + 1; i <= end; i++) {
    const c = m15[i];
    // Time-stop (H): si no ha llegado a TP1 tras N barras, cierre a mercado.
    if (!tp1Hit && timeStopBars && (i - entryIdx) >= timeStopBars) {
      return closeRemaining(c.open, c.time, "timeout");
    }
    // Break-even a N*R (I): mueve SL a entry cuando el MFE alcanza N*R.
    if (!tp1Hit && !beMoved && beAtR && beAtR > 0) {
      const trigger = bias === "long" ? entry + beAtR * initRisk : entry - beAtR * initRisk;
      const reached = bias === "long" ? c.high >= trigger : c.low <= trigger;
      if (reached) {
        sl = entry;
        beMoved = true;
      }
    }
    if (bias === "long") {
      // Trailing escalonado (post-Fibonacci EA idea): tras alcanzar
      // trailAfterR·R, arrastramos SL en pasos discretos de step·ATR bajo
      // el MFE. Nunca movemos SL en contra.
      if (trailingOn) {
        bestPrice = Math.max(bestPrice, c.high);
        const mfeR = (bestPrice - entry) / initRisk;
        if (mfeR >= (trailAfterR as number)) {
          const step = (atrArr as number[])[i] * (trailStepMult as number);
          if (step > 0) {
            const trail = Math.floor((bestPrice - entry) / step) * step;
            const candidate = entry + trail - step;
            if (candidate > sl) sl = candidate;
          }
        }
      }
      // Check SL first (conservative)
      if (c.low <= sl) {
        if (!tp1Hit) return closeRemaining(sl, c.time, beMoved ? "be" : "sl");
        // partials already realized: TP1 secured, possibly TP2
        const outcome: BacktestTrade["outcome"] = tp2Hit ? "tp2" : "tp1";
        return closeRemaining(sl, c.time, outcome);
      }
      if (!tp1Hit && c.high >= tp1) {
        realizedR += 0.5 * 1;
        realizedR -= 0.5 * costR; // coste del parcial 50%
        remaining -= 0.5;
        sl = entry; // move to BE
        tp1Hit = true;
      }
      if (tp1Hit && !tp2Hit && c.high >= tp2) {
        realizedR += 0.3 * 2;
        realizedR -= 0.3 * costR; // coste del parcial 30%
        remaining -= 0.3;
        tp2Hit = true;
      }
      if (tp2Hit && c.high >= tp3) {
        realizedR += 0.2 * 3;
        realizedR -= 0.2 * costR; // coste del cierre runner
        remaining = 0;
        return { exit: tp3, rMultiple: realizedR, outcome: "tp3", closeTime: c.time };
      }
    } else {
      if (trailingOn) {
        bestPrice = Math.min(bestPrice, c.low);
        const mfeR = (entry - bestPrice) / initRisk;
        if (mfeR >= (trailAfterR as number)) {
          const step = (atrArr as number[])[i] * (trailStepMult as number);
          if (step > 0) {
            const trail = Math.floor((entry - bestPrice) / step) * step;
            const candidate = entry - trail + step;
            if (candidate < sl) sl = candidate;
          }
        }
      }
      if (c.high >= sl) {
        if (!tp1Hit) return closeRemaining(sl, c.time, beMoved ? "be" : "sl");
        const outcome: BacktestTrade["outcome"] = tp2Hit ? "tp2" : "tp1";
        return closeRemaining(sl, c.time, outcome);
      }
      if (!tp1Hit && c.low <= tp1) {
        realizedR += 0.5 * 1;
        realizedR -= 0.5 * costR;
        remaining -= 0.5;
        sl = entry;
        tp1Hit = true;
      }
      if (tp1Hit && !tp2Hit && c.low <= tp2) {
        realizedR += 0.3 * 2;
        realizedR -= 0.3 * costR;
        remaining -= 0.3;
        tp2Hit = true;
      }
      if (tp2Hit && c.low <= tp3) {
        realizedR += 0.2 * 3;
        realizedR -= 0.2 * costR;
        remaining = 0;
        return { exit: tp3, rMultiple: realizedR, outcome: "tp3", closeTime: c.time };
      }
    }
  }
  // Timeout: close at last close
  const last = m15[end];
  return closeRemaining(last.close, last.time, "timeout");
}

function computeMetrics(trades: BacktestTrade[]): BacktestMetrics {
  const n = trades.length;
  const outcomeCounts = { tp1: 0, tp2: 0, tp3: 0, sl: 0, be: 0, timeout: 0 } as Record<BacktestTrade["outcome"], number>;
  let wins = 0, losses = 0, breakeven = 0;
  let totalR = 0;
  let posSum = 0, negSum = 0;
  let curWin = 0, curLoss = 0, longestWin = 0, longestLoss = 0;
  const byHourMap = new Map<number, { trades: number; totalR: number; wins: number }>();
  const byWdMap = new Map<number, { trades: number; totalR: number; wins: number }>();
  const equityCurve: Array<{ trade: number; equityR: number }> = [{ trade: 0, equityR: 0 }];
  const rs: number[] = [];

  trades.forEach((t, i) => {
    outcomeCounts[t.outcome] += 1;
    totalR += t.rMultiple;
    rs.push(t.rMultiple);
    if (t.rMultiple > 0.05) { wins += 1; posSum += t.rMultiple; curWin += 1; curLoss = 0; }
    else if (t.rMultiple < -0.05) { losses += 1; negSum += Math.abs(t.rMultiple); curLoss += 1; curWin = 0; }
    else { breakeven += 1; curWin = 0; curLoss = 0; }
    longestWin = Math.max(longestWin, curWin);
    longestLoss = Math.max(longestLoss, curLoss);
    equityCurve.push({ trade: i + 1, equityR: totalR });
    const hRec = byHourMap.get(t.hourUTC) ?? { trades: 0, totalR: 0, wins: 0 };
    hRec.trades += 1; hRec.totalR += t.rMultiple; if (t.rMultiple > 0) hRec.wins += 1;
    byHourMap.set(t.hourUTC, hRec);
    const wRec = byWdMap.get(t.weekday) ?? { trades: 0, totalR: 0, wins: 0 };
    wRec.trades += 1; wRec.totalR += t.rMultiple; if (t.rMultiple > 0) wRec.wins += 1;
    byWdMap.set(t.weekday, wRec);
  });

  // Max drawdown in R
  let peak = 0, maxDD = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equityR);
    const dd = peak - p.equityR;
    if (dd > maxDD) maxDD = dd;
  }

  const mean = n ? totalR / n : 0;
  const variance = n ? rs.reduce((s, r) => s + (r - mean) ** 2, 0) / n : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(n) : 0;

  return {
    trades: n,
    wins,
    losses,
    breakeven,
    winrate: n ? wins / n : 0,
    totalR,
    avgR: mean,
    expectancy: mean,
    profitFactor: negSum > 0 ? posSum / negSum : posSum > 0 ? Infinity : 0,
    maxDrawdownR: maxDD,
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
    sharpe,
    outcomeCounts,
    byHour: Array.from(byHourMap.entries())
      .map(([hour, v]) => ({ hour, trades: v.trades, totalR: v.totalR, winrate: v.trades ? v.wins / v.trades : 0 }))
      .sort((a, b) => a.hour - b.hour),
    byWeekday: Array.from(byWdMap.entries())
      .map(([weekday, v]) => ({ weekday, trades: v.trades, totalR: v.totalR, winrate: v.trades ? v.wins / v.trades : 0 }))
      .sort((a, b) => a.weekday - b.weekday),
    equityCurve,
  };
}

// Motor genérico: itera sobre el TF trigger de la estrategia y le pasa un
// mapa de bars ya sliced hasta el bar actual. La simulación de SL/TP corre
// sobre las velas del TF trigger (mayor resolución para scalping M1).
export function runBacktestBars(bars: Bars, opts: BacktestOptions): BacktestResult {
  const strategy = getStrategy(opts.engineKey);
  const params: StrategyParams = { ...strategy.defaultParams, ...(opts.params ?? {}) };
  const triggerTf = strategy.triggerTf;
  const triggerBars = bars[triggerTf] ?? [];
  if (!triggerBars.length) {
    return { engineKey: opts.engineKey, metrics: computeMetrics([]), trades: [] };
  }
  // Defaults escalan según TF trigger: M1 requiere holds/cooldowns más largos
  // en bars pero más cortos en tiempo real (24h M1 = 1440 bars).
  const tfMinutes: Record<TfKey, number> = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440 };
  const defaultMaxHold = strategy.backtestDefaults?.maxHoldBars
    ?? Math.max(20, Math.round((24 * 60) / tfMinutes[triggerTf])); // ~24h
  const defaultCooldown = strategy.backtestDefaults?.cooldownBars
    ?? Math.max(3, Math.round((4 * 60) / tfMinutes[triggerTf]));   // ~4h
  const warmup = opts.warmupBars ?? (triggerTf === "M1" ? 300 : 100);
  const maxHold = opts.maxHoldBars ?? defaultMaxHold;
  const cooldown = opts.cooldownBars ?? defaultCooldown;
  const autoFilters = opts.autoTimeFilters ?? true;
  const dailyTargetR = opts.dailyTargetR;
  const dailyLossLimitR = opts.dailyLossLimitR;
  const dailyPnl = new Map<string, number>();
  const dayKey = (t: number) => {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  };
  // Defaults de costos por TF trigger. Oro retail M1: spread ~0.20 USD,
  // slippage ~0.05 USD, latencia 1 barra (60s) señal→ejecución.
  const costDefaults: BacktestCosts = triggerTf === "M1"
    ? { spreadUsd: 0.20, slippageUsd: 0.05, commissionUsd: 0, latencyBars: 1 }
    : { spreadUsd: 0, slippageUsd: 0, commissionUsd: 0, latencyBars: 0 };
  const costs: Required<BacktestCosts> = {
    spreadUsd: opts.costs?.spreadUsd ?? costDefaults.spreadUsd ?? 0,
    slippageUsd: opts.costs?.slippageUsd ?? costDefaults.slippageUsd ?? 0,
    commissionUsd: opts.costs?.commissionUsd ?? costDefaults.commissionUsd ?? 0,
    latencyBars: opts.costs?.latencyBars ?? costDefaults.latencyBars ?? 0,
  };
  const costPerSideUsd = costs.spreadUsd / 2 + costs.slippageUsd + costs.commissionUsd;
  const trades: BacktestTrade[] = [];

  // Pre-computar los otros TFs necesarios (excluyendo el trigger).
  const auxTfs = strategy.requiredTfs.filter((tf) => tf !== triggerTf);

  let lastExitIdx = -Infinity;
  const totalBars = triggerBars.length;
  const progressStep = Math.max(2000, Math.floor(totalBars / 40));
  let lastReport = warmup;
  // ATR del trigger TF para trailing escalonado (una sola vez).
  const triggerAtr = atrSeries(triggerBars, 14);

  for (let i = warmup; i < triggerBars.length - 2; i++) {
    if (opts.onProgress && i - lastReport >= progressStep) {
      lastReport = i;
      opts.onProgress({
        phase: "simulate",
        percent: totalBars > 0 ? i / totalBars : 0,
        trades: trades.length,
        bar: i,
        totalBars,
      });
    }
    if (i - lastExitIdx < cooldown) continue;
    const barTime = triggerBars[i].time;
    const d0 = new Date(barTime * 1000);
    if (autoFilters && isMarketClosedOrRisky(d0)) continue;
    if (opts.excludeHours?.includes(d0.getUTCHours())) continue;
    if (opts.excludeWeekdays?.includes(d0.getUTCDay())) continue;
    // Daily equity gate: cierra el día si ya se alcanzó target/loss.
    if (dailyTargetR != null || dailyLossLimitR != null) {
      const dk = dayKey(barTime);
      const dPnl = dailyPnl.get(dk) ?? 0;
      if (dailyTargetR != null && dPnl >= dailyTargetR) continue;
      if (dailyLossLimitR != null && dPnl <= -Math.abs(dailyLossLimitR)) continue;
    }

    const slicedBars: Bars = {
      [triggerTf]: triggerBars.slice(0, i + 1),
    };
    for (const tf of auxTfs) {
      const arr = bars[tf];
      if (arr && arr.length) slicedBars[tf] = sliceUpTo(arr, barTime);
    }

    const signal = strategy.evaluate(slicedBars, params);
    if (!signal) continue;

    // Latencia: entramos en la apertura de la barra i+1+latency
    const entryBarIdx = i + 1 + costs.latencyBars;
    if (entryBarIdx >= triggerBars.length - 1) continue;
    const entryBar = triggerBars[entryBarIdx];
    // Entrada = open de la barra tras la latencia. El coste se descuenta
    // enteramente vía rMultiple dentro de simulateTrade (entry fill + cada
    // cierre parcial/total), evitando distorsionar SL/TP absolutos.
    const entry = entryBar.open;
    const dist = Math.abs(signal.entry - signal.stopLoss);
    // Respetamos los ratios R que declara la estrategia (por defecto 1R/2R/3R).
    // Motores tipo grid usan TPs cortos (<1R) con SL holgado, y forzar 1R/2R/3R
    // deformaría por completo su perfil de resultados.
    const rr = (tp: number) => {
      const v = Math.abs(tp - signal.entry) / dist;
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    const r1 = rr(signal.tp1) || 1;
    const r2 = rr(signal.tp2) || r1 * 2;
    const r3 = rr(signal.tp3) || r1 * 3;
    const sl = signal.bias === "long" ? entry - dist : entry + dist;
    const tp1 = signal.bias === "long" ? entry + dist * r1 : entry - dist * r1;
    const tp2 = signal.bias === "long" ? entry + dist * r2 : entry - dist * r2;
    const tp3 = signal.bias === "long" ? entry + dist * r3 : entry - dist * r3;

    const sim = simulateTrade(triggerBars, entryBarIdx, signal.bias, entry, sl, tp1, tp2, tp3, maxHold, costPerSideUsd, signal.management, triggerAtr);
    const de = new Date(entryBar.time * 1000);
    const hourUTC = de.getUTCHours();
    const weekday = de.getUTCDay();
    const dk2 = dayKey(entryBar.time);
    dailyPnl.set(dk2, (dailyPnl.get(dk2) ?? 0) + sim.rMultiple);
    trades.push({
      openTime: entryBar.time,
      closeTime: sim.closeTime,
      bias: signal.bias,
      score: signal.score,
      entry,
      stopLoss: sl,
      tp1, tp2, tp3,
      exit: sim.exit,
      rMultiple: sim.rMultiple,
      outcome: sim.outcome,
      hourUTC,
      weekday,
      features: signal.features
        ?? buildFeatures(signal.scoreBreakdown, signal.bias, hourUTC, weekday),
    });
    const exitIdx = triggerBars.findIndex((c) => c.time >= sim.closeTime);
    lastExitIdx = exitIdx >= 0 ? exitIdx : i + maxHold;
    i = lastExitIdx;
  }

  return { engineKey: opts.engineKey, metrics: computeMetrics(trades), trades };
}

// Wrapper legacy: firma antigua (h4, h1, m15) → nueva API basada en Bars.
// Mantiene compatibilidad con callers que aún no pasan M1/M5.
export function runBacktest(
  h4: Candle[],
  h1: Candle[],
  m15: Candle[],
  opts: BacktestOptions,
): BacktestResult {
  return runBacktestBars({ H4: h4, H1: h1, M15: m15 }, opts);
}