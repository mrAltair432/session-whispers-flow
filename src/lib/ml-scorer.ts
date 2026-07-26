// Scorer logístico compartido entre el notebook Python (que exporta los
// pesos en ml_filters_*.json) y el server. La función `predictProb` aplica
// una regresión logística estándar sobre el vector de features.

export type ScorerModel = {
  engine: string;
  features: string[];   // nombres, en el orden esperado
  weights: number[];    // mismo largo que features
  intercept: number;
  auc?: number;
  trained_at?: string;
};

/** Aplica el modelo. Si falta alguna feature, se sustituye por 0. */
export function predictProb(model: ScorerModel, features: Record<string, number>): number {
  let z = model.intercept ?? 0;
  for (let i = 0; i < model.features.length; i++) {
    const name = model.features[i];
    const w = model.weights[i] ?? 0;
    const x = features[name];
    z += w * (Number.isFinite(x) ? (x as number) : 0);
  }
  return 1 / (1 + Math.exp(-z));
}

/**
 * Interpreta un p_win → acción sobre la señal.
 *   - p < 0.5  → descartar
 *   - 0.5-0.6 → downgrade a medium
 *   - >= 0.6  → high
 */
export function scorerVerdict(p: number): "reject" | "medium" | "high" {
  if (p < 0.5) return "reject";
  if (p < 0.6) return "medium";
  return "high";
}