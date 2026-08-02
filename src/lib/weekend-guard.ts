// Gestión de fin de semana (compatible con reglas prop-firm tipo FTMO):
// - No abrir operaciones el viernes a partir de `fridayCutoffHour` UTC.
// - No abrir el sábado ni el domingo.
// - No abrir el lunes antes de `mondayOpenHour` UTC (gap de apertura).
// - Cerrar todo (posiciones + pendientes) desde el corte del viernes.

export type WeekendGuardConfig = {
  enabled: boolean;
  fridayCutoffHour: number; // 0-23 UTC
  mondayOpenHour: number;   // 0-23 UTC
  flatten: boolean;
};

export const DEFAULT_WEEKEND_GUARD: WeekendGuardConfig = {
  enabled: true,
  fridayCutoffHour: 20,
  mondayOpenHour: 2,
  flatten: true,
};

// ¿Estamos dentro de la ventana de cierre semanal?
export function isWeekendWindow(d: Date, cfg: WeekendGuardConfig): boolean {
  if (!cfg.enabled) return false;
  const wd = d.getUTCDay(); // 0=Dom .. 6=Sáb
  const h = d.getUTCHours();
  if (wd === 6) return true;
  if (wd === 0) return true;
  if (wd === 5 && h >= cfg.fridayCutoffHour) return true;
  if (wd === 1 && h < cfg.mondayOpenHour) return true;
  return false;
}

// ¿Debe el EA aplanar la cuenta (cerrar posiciones y cancelar pendientes)?
export function shouldFlatten(d: Date, cfg: WeekendGuardConfig): boolean {
  if (!cfg.enabled || !cfg.flatten) return false;
  const wd = d.getUTCDay();
  const h = d.getUTCHours();
  if (wd === 6 || wd === 0) return true;
  return wd === 5 && h >= cfg.fridayCutoffHour;
}

export function weekendGuardReason(d: Date, cfg: WeekendGuardConfig): string | null {
  if (!isWeekendWindow(d, cfg)) return null;
  const wd = d.getUTCDay();
  if (wd === 5) return `viernes ≥ ${cfg.fridayCutoffHour}:00 UTC (cierre semanal)`;
  if (wd === 6 || wd === 0) return "fin de semana (mercado cerrado)";
  return `lunes < ${cfg.mondayOpenHour}:00 UTC (gap de apertura)`;
}

export function readWeekendGuard(row: Record<string, unknown> | null | undefined): WeekendGuardConfig {
  return {
    enabled: (row?.["weekend_guard_enabled"] as boolean | undefined) ?? DEFAULT_WEEKEND_GUARD.enabled,
    fridayCutoffHour: (row?.["friday_cutoff_hour"] as number | undefined) ?? DEFAULT_WEEKEND_GUARD.fridayCutoffHour,
    mondayOpenHour: (row?.["monday_open_hour"] as number | undefined) ?? DEFAULT_WEEKEND_GUARD.mondayOpenHour,
    flatten: (row?.["weekend_flatten_enabled"] as boolean | undefined) ?? DEFAULT_WEEKEND_GUARD.flatten,
  };
}