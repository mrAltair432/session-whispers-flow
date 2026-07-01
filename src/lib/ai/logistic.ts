// Regresión logística binaria + normalización z-score, 100% JS.
// Entrenamiento con SGD por mini-batch y L2. Sin dependencias.
// El modelo se serializa a JSON y se guarda en localStorage.

import { FEATURE_NAMES } from "../backtest";

export type TrainedModel = {
  featureNames: readonly string[];
  mean: number[];
  std: number[];
  weights: number[]; // length = features.length
  bias: number;
  metrics: {
    trainSize: number;
    valSize: number;
    baselineWinrate: number; // WR sin filtro
    valAuc: number;
    valLogLoss: number;
    threshold: number;       // umbral P(win) sugerido
    winrateAtThreshold: number;
    keptRatio: number;       // % de trades que pasan el filtro
    expectancyBase: number;
    expectancyFiltered: number;
    totalRBase: number;
    totalRFiltered: number;
  };
  trainedAt: number;
  epochs: number;
  version: 1;
};

function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)); }

function computeStats(rows: number[][]) {
  const dim = rows[0]?.length ?? 0;
  const mean = new Array(dim).fill(0);
  const std = new Array(dim).fill(0);
  for (const r of rows) for (let i = 0; i < dim; i++) mean[i] += r[i];
  for (let i = 0; i < dim; i++) mean[i] /= rows.length;
  for (const r of rows) for (let i = 0; i < dim; i++) std[i] += (r[i] - mean[i]) ** 2;
  for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i] / rows.length) || 1;
  return { mean, std };
}

function normalize(row: number[], mean: number[], std: number[]) {
  const out = new Array(row.length);
  for (let i = 0; i < row.length; i++) out[i] = (row[i] - mean[i]) / std[i];
  return out;
}

export function predictProb(model: TrainedModel, features: number[]): number {
  const x = normalize(features, model.mean, model.std);
  let z = model.bias;
  for (let i = 0; i < x.length; i++) z += x[i] * model.weights[i];
  return sigmoid(z);
}

// AUC vía ranking (aprox O(n log n)).
function computeAuc(scores: number[], labels: number[]) {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] }))
    .sort((a, b) => a.s - b.s);
  let pos = 0, neg = 0;
  for (const p of pairs) (p.y === 1 ? pos++ : neg++);
  if (pos === 0 || neg === 0) return 0.5;
  let rankSum = 0;
  pairs.forEach((p, idx) => { if (p.y === 1) rankSum += idx + 1; });
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export type TrainInput = {
  features: number[][];
  labels: number[]; // 0/1
  rMultiples: number[]; // para métricas monetarias
  epochs?: number;
  learningRate?: number;
  l2?: number;
  batchSize?: number;
  onProgress?: (p: { epoch: number; total: number; loss: number }) => void;
};

export function trainLogistic(input: TrainInput): TrainedModel {
  const { features, labels, rMultiples } = input;
  const epochs = input.epochs ?? 200;
  const lr = input.learningRate ?? 0.05;
  const l2 = input.l2 ?? 0.001;
  const batchSize = input.batchSize ?? 32;
  const n = features.length;
  if (n < 40) throw new Error(`Muy pocos trades (${n}). Necesitas ≥40 para entrenar.`);

  // Split cronológico 70/30 (asumimos features ya ordenados por tiempo).
  const cut = Math.floor(n * 0.7);
  const trainX = features.slice(0, cut);
  const trainY = labels.slice(0, cut);
  const valX = features.slice(cut);
  const valY = labels.slice(cut);
  const valR = rMultiples.slice(cut);

  const { mean, std } = computeStats(trainX);
  const trainN = trainX.map((r) => normalize(r, mean, std));
  const valN = valX.map((r) => normalize(r, mean, std));
  const dim = trainN[0].length;

  let w = new Array(dim).fill(0);
  let b = 0;

  // Shuffle indices para mini-batch
  const idx = Array.from({ length: trainN.length }, (_, i) => i);
  const rng = mulberry32(1337);

  for (let ep = 0; ep < epochs; ep++) {
    // fisher-yates
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    let loss = 0;
    for (let start = 0; start < idx.length; start += batchSize) {
      const end = Math.min(start + batchSize, idx.length);
      const gW = new Array(dim).fill(0);
      let gB = 0;
      for (let k = start; k < end; k++) {
        const i = idx[k];
        const x = trainN[i];
        let z = b;
        for (let d = 0; d < dim; d++) z += w[d] * x[d];
        const p = sigmoid(z);
        const y = trainY[i];
        const err = p - y;
        for (let d = 0; d < dim; d++) gW[d] += err * x[d];
        gB += err;
        loss += -(y * Math.log(p + 1e-9) + (1 - y) * Math.log(1 - p + 1e-9));
      }
      const bs = end - start;
      for (let d = 0; d < dim; d++) w[d] -= lr * (gW[d] / bs + l2 * w[d]);
      b -= lr * (gB / bs);
    }
    if (input.onProgress && (ep % 10 === 0 || ep === epochs - 1)) {
      input.onProgress({ epoch: ep + 1, total: epochs, loss: loss / trainN.length });
    }
  }

  // Val metrics
  const valProbs = valN.map((x) => {
    let z = b;
    for (let d = 0; d < dim; d++) z += w[d] * x[d];
    return sigmoid(z);
  });
  let logLoss = 0;
  for (let i = 0; i < valProbs.length; i++) {
    const p = valProbs[i], y = valY[i];
    logLoss += -(y * Math.log(p + 1e-9) + (1 - y) * Math.log(1 - p + 1e-9));
  }
  logLoss = valProbs.length ? logLoss / valProbs.length : 0;
  const valAuc = computeAuc(valProbs, valY);

  // Umbral óptimo: probar 0.30..0.70 y elegir el que maximiza total R filtrado con ≥30% kept.
  const baseTotalR = valR.reduce((s, r) => s + r, 0);
  const baseWins = valY.filter((y) => y === 1).length;
  const baseWr = valY.length ? baseWins / valY.length : 0;
  const baseExp = valR.length ? baseTotalR / valR.length : 0;
  let best = { threshold: 0.5, totalR: -Infinity, keptRatio: 0, wr: 0, exp: 0 };
  for (let t = 30; t <= 70; t += 2) {
    const thr = t / 100;
    let kept: number[] = [];
    let keptY: number[] = [];
    let keptR: number[] = [];
    for (let i = 0; i < valProbs.length; i++) {
      if (valProbs[i] >= thr) { kept.push(i); keptY.push(valY[i]); keptR.push(valR[i]); }
    }
    const keptRatio = valProbs.length ? kept.length / valProbs.length : 0;
    if (keptRatio < 0.25) continue;
    const totalR = keptR.reduce((s, r) => s + r, 0);
    const wr = keptY.length ? keptY.filter((y) => y === 1).length / keptY.length : 0;
    const exp = keptR.length ? totalR / keptR.length : 0;
    if (totalR > best.totalR) best = { threshold: thr, totalR, keptRatio, wr, exp };
  }
  if (!isFinite(best.totalR)) best = { threshold: 0.5, totalR: baseTotalR, keptRatio: 1, wr: baseWr, exp: baseExp };

  return {
    featureNames: FEATURE_NAMES,
    mean, std, weights: w, bias: b,
    metrics: {
      trainSize: trainX.length,
      valSize: valX.length,
      baselineWinrate: baseWr,
      valAuc,
      valLogLoss: logLoss,
      threshold: best.threshold,
      winrateAtThreshold: best.wr,
      keptRatio: best.keptRatio,
      expectancyBase: baseExp,
      expectancyFiltered: best.exp,
      totalRBase: baseTotalR,
      totalRFiltered: best.totalR,
    },
    trainedAt: Date.now(),
    epochs,
    version: 1,
  };
}

function mulberry32(a: number) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}