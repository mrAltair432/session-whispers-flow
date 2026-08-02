// Modo FTMO / prop-firm: reglas del reto + simulador de challenge.
// -----------------------------------------------------------------
// Convierte una lista de trades en R a una curva de equity en USD usando
// riesgo fijo por operación (% del balance inicial, como hace un trader de
// reto con lotes calculados sobre el balance de partida) y evalúa las tres
// reglas clásicas: objetivo de beneficio, pérdida diaria máxima y pérdida
// total máxima, más los días mínimos de trading.

export type FtmoRules = {
  balance: number;          // capital del reto en USD
  riskPerTradePct: number;  // riesgo por operación (% del balance inicial)
  profitTargetPct: number;  // objetivo fase 1 (FTMO: 10 %)
  dailyLossPct: number;     // pérdida diaria máxima (FTMO: 5 %)
  maxLossPct: number;       // pérdida total máxima (FTMO: 10 %)
  minTradingDays: number;   // días mínimos con al menos 1 operación
  // Si está activo, el simulador deja de abrir operaciones el resto del día
  // cuando la pérdida del día alcanza `dailyStopBufferPct` del límite diario.
  enforceDailyStop?: boolean;
  dailyStopBufferPct?: number; // 0..1 (default 0.8 = corta al 80 % del límite)
};

export const DEFAULT_FTMO_RULES: FtmoRules = {
  balance: 10_000,
  riskPerTradePct: 0.5,
  profitTargetPct: 10,
  dailyLossPct: 5,
  maxLossPct: 10,
  minTradingDays: 4,
  enforceDailyStop: true,
  dailyStopBufferPct: 0.8,
};

export type ChallengeTrade = {
  openTime: number;   // epoch segundos
  closeTime: number;  // epoch segundos
  rMultiple: number;
  maeR?: number;      // peor excursión flotante (R, negativo)
};

export type ChallengeDay = {
  date: string;          // YYYY-MM-DD UTC
  trades: number;
  skipped: number;       // operaciones no tomadas por el stop diario
  pnlUsd: number;
  worstFloatingUsd: number; // peor equity intradía respecto al inicio del día
  ddPct: number;         // % de caída intradía sobre el balance de inicio de día
  equityEnd: number;
};

export type ChallengeResult = {
  rules: FtmoRules;
  passed: boolean;
  failed: boolean;
  status: "passed" | "failed" | "in_progress";
  failReason: string | null;
  finalEquity: number;
  netPct: number;
  peakEquity: number;
  maxDdPct: number;         // caída máxima desde el balance inicial (flotante incluido)
  worstDailyDdPct: number;
  tradingDays: number;
  daysToTarget: number | null;
  tradesTaken: number;
  tradesSkipped: number;
  dailyStopHits: number;
  days: ChallengeDay[];
  equityCurve: Array<{ t: number; equity: number; floor: number }>;
};

function utcDay(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().slice(0, 10);
}

export function simulateChallenge(
  rawTrades: ChallengeTrade[],
  rulesInput: Partial<FtmoRules> = {},
): ChallengeResult {
  const rules: FtmoRules = { ...DEFAULT_FTMO_RULES, ...rulesInput };
  const riskUsd = (rules.balance * rules.riskPerTradePct) / 100;
  const dailyLimitUsd = (rules.balance * rules.dailyLossPct) / 100;
  const maxLossFloor = rules.balance - (rules.balance * rules.maxLossPct) / 100;
  const targetEquity = rules.balance + (rules.balance * rules.profitTargetPct) / 100;
  const stopBuffer = rules.dailyStopBufferPct ?? 0.8;

  const trades = [...rawTrades].sort((a, b) => a.closeTime - b.closeTime);

  let equity = rules.balance;
  let peakEquity = rules.balance;
  let minEquity = rules.balance;
  let failReason: string | null = null;
  let passedAt: number | null = null;
  let tradesTaken = 0;
  let tradesSkipped = 0;
  let dailyStopHits = 0;
  let worstDailyDdPct = 0;

  const days: ChallengeDay[] = [];
  const equityCurve: Array<{ t: number; equity: number; floor: number }> = [
    { t: trades[0]?.openTime ?? 0, equity: rules.balance, floor: rules.balance },
  ];

  let currentDay = "";
  let dayStartEquity = equity;
  let day: ChallengeDay | null = null;
  let dayStopped = false;

  const closeDay = () => {
    if (!day) return;
    day.equityEnd = equity;
    day.ddPct = dayStartEquity > 0
      ? Math.max(0, (dayStartEquity - (dayStartEquity + day.worstFloatingUsd)) / dayStartEquity) * 100
      : 0;
    worstDailyDdPct = Math.max(worstDailyDdPct, day.ddPct);
    days.push(day);
    day = null;
  };

  for (const t of trades) {
    const d = utcDay(t.closeTime);
    if (d !== currentDay) {
      closeDay();
      currentDay = d;
      dayStartEquity = equity;
      dayStopped = false;
      day = { date: d, trades: 0, skipped: 0, pnlUsd: 0, worstFloatingUsd: 0, ddPct: 0, equityEnd: equity };
    }
    if (!day) continue;

    if (dayStopped && rules.enforceDailyStop) {
      day.skipped++;
      tradesSkipped++;
      continue;
    }

    // Flotante peor caso durante la operación
    const floating = equity + (t.maeR ?? Math.min(0, t.rMultiple)) * riskUsd;
    minEquity = Math.min(minEquity, floating);
    const dayFloating = floating - dayStartEquity;
    if (dayFloating < day.worstFloatingUsd) day.worstFloatingUsd = dayFloating;

    if (!failReason && floating <= maxLossFloor) {
      failReason = `Pérdida total máxima (${rules.maxLossPct}%) superada el ${d} (flotante)`;
    }
    if (!failReason && dayStartEquity - floating >= dailyLimitUsd) {
      failReason = `Pérdida diaria máxima (${rules.dailyLossPct}%) superada el ${d} (flotante)`;
    }

    // Cierre de la operación
    equity += t.rMultiple * riskUsd;
    day.trades++;
    tradesTaken++;
    day.pnlUsd += t.rMultiple * riskUsd;
    peakEquity = Math.max(peakEquity, equity);
    minEquity = Math.min(minEquity, equity);
    const dayClosed = equity - dayStartEquity;
    if (dayClosed < day.worstFloatingUsd) day.worstFloatingUsd = dayClosed;

    if (!failReason && equity <= maxLossFloor) {
      failReason = `Pérdida total máxima (${rules.maxLossPct}%) superada el ${d}`;
    }
    if (!failReason && dayStartEquity - equity >= dailyLimitUsd) {
      failReason = `Pérdida diaria máxima (${rules.dailyLossPct}%) superada el ${d}`;
    }

    equityCurve.push({ t: t.closeTime, equity, floor: maxLossFloor });

    if (!dayStopped && dayStartEquity - equity >= dailyLimitUsd * stopBuffer) {
      dayStopped = true;
      dailyStopHits++;
    }

    if (failReason) break;
    if (passedAt === null && equity >= targetEquity) passedAt = t.closeTime;
  }
  closeDay();

  const tradingDays = days.filter((x) => x.trades > 0).length;
  const firstTs = trades[0]?.openTime ?? 0;
  const daysToTarget = passedAt && firstTs
    ? Math.max(1, Math.round((passedAt - firstTs) / 86_400))
    : null;

  const reachedTarget = passedAt !== null;
  const enoughDays = tradingDays >= rules.minTradingDays;
  const failed = failReason !== null;
  const passed = !failed && reachedTarget && enoughDays;

  if (!failed && reachedTarget && !enoughDays) {
    failReason = null; // no es fallo: sólo faltan días mínimos
  }

  return {
    rules,
    passed,
    failed,
    status: failed ? "failed" : passed ? "passed" : "in_progress",
    failReason,
    finalEquity: equity,
    netPct: ((equity - rules.balance) / rules.balance) * 100,
    peakEquity,
    maxDdPct: ((rules.balance - minEquity) / rules.balance) * 100,
    worstDailyDdPct,
    tradingDays,
    daysToTarget,
    tradesTaken,
    tradesSkipped,
    dailyStopHits,
    days,
    equityCurve,
  };
}

// Riesgo máximo por operación (% del balance) que mantiene la peor racha
// histórica dentro del límite de pérdida total, con un margen de seguridad.
export function suggestRiskPct(maxDrawdownR: number, maxLossPct: number, safety = 0.6): number {
  if (!Number.isFinite(maxDrawdownR) || maxDrawdownR <= 0) return 1;
  const raw = (maxLossPct * safety) / maxDrawdownR;
  return Math.max(0.05, Math.min(2, Math.round(raw * 100) / 100));
}

// --- Modo FTMO en vivo -------------------------------------------------
export type FtmoLiveConfig = {
  enabled: boolean;
  balance: number;
  dailyLossPct: number;
  maxLossPct: number;
  stopBuffer: number; // 0..1
};

export function readFtmoConfig(row: Record<string, unknown> | null | undefined): FtmoLiveConfig {
  return {
    enabled: (row?.["ftmo_mode_enabled"] as boolean | undefined) ?? false,
    balance: Number(row?.["balance"] ?? 10_000),
    dailyLossPct: Number(row?.["ftmo_daily_loss_pct"] ?? 5),
    maxLossPct: Number(row?.["ftmo_max_loss_pct"] ?? 10),
    stopBuffer: 0.8,
  };
}

// ¿Debe bloquearse la operativa de hoy por el límite diario del reto?
export function ftmoDailyBlock(cfg: FtmoLiveConfig, todayLossUsd: number): string | null {
  if (!cfg.enabled) return null;
  const limit = (cfg.balance * cfg.dailyLossPct) / 100;
  if (Math.abs(todayLossUsd) >= limit * cfg.stopBuffer) {
    return `Modo FTMO: pérdida diaria en ${Math.abs(todayLossUsd).toFixed(2)} USD de ${limit.toFixed(2)} permitidos`;
  }
  return null;
}