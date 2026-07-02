// MLP pequeño (2 capas ocultas 32/16, ReLU + sigmoide) 100% JS.
// - RobustScaler (mediana + IQR) para resistir spikes del oro (art. 18078).
// - He init, mini-batch SGD, L2, early stopping por AUC de validación.
// - Serializable a JSON para localStorage. Compatible con TrainedModel.metrics.

import type { TrainedModel } from "./logistic";

export type MlpTrainedModel = {
  featureNames: readonly string[];
  scaler: { median: number[]; iqr: number[]; kind: "robust" };
  layers: Array<{ w: number[][]; b: number[]; activation: "relu" | "sigmoid" }>;
  metrics: TrainedModel["metrics"];
  trainedAt: number;
  epochs: number;
  version: 2;
  modelType: "mlp";
};

export type MlpTrainInput = {
  features: number[][];
  labels: number[];
  rMultiples: number[];
  featureNames: readonly string[];
  epochs?: number;
  learningRate?: number;
  l2?: number;
  batchSize?: number;
  hiddenSizes?: [number, number];
  onProgress?: (p: { epoch: number; total: number; loss: number }) => void;
};

function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)); }
function relu(z: number) { return z > 0 ? z : 0; }

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function robustFit(rows: number[][]) {
  const dim = rows[0].length;
  const median: number[] = new Array(dim).fill(0);
  const iqr: number[] = new Array(dim).fill(1);
  for (let j = 0; j < dim; j++) {
    const col = rows.map((r) => r[j]).sort((a, b) => a - b);
    median[j] = quantile(col, 0.5);
    const q25 = quantile(col, 0.25);
    const q75 = quantile(col, 0.75);
    const spread = q75 - q25;
    iqr[j] = spread > 1e-9 ? spread : 1;
  }
  return { median, iqr };
}

function robustTransform(row: number[], median: number[], iqr: number[]) {
  const out = new Array(row.length);
  for (let i = 0; i < row.length; i++) out[i] = (row[i] - median[i]) / iqr[i];
  return out;
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

function heInit(inDim: number, outDim: number, rng: () => number) {
  const scale = Math.sqrt(2 / inDim);
  const w: number[][] = [];
  for (let i = 0; i < outDim; i++) {
    const row: number[] = [];
    for (let j = 0; j < inDim; j++) {
      // Box-Muller light
      const u = Math.max(rng(), 1e-9);
      const v = rng();
      row.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale);
    }
    w.push(row);
  }
  return { w, b: new Array(outDim).fill(0) };
}

function forward(
  x: number[],
  layers: Array<{ w: number[][]; b: number[]; activation: "relu" | "sigmoid" }>,
) {
  const activations: number[][] = [x];
  const preacts: number[][] = [];
  let cur = x;
  for (const layer of layers) {
    const z: number[] = new Array(layer.b.length);
    for (let i = 0; i < layer.b.length; i++) {
      let s = layer.b[i];
      const wi = layer.w[i];
      for (let j = 0; j < cur.length; j++) s += wi[j] * cur[j];
      z[i] = s;
    }
    preacts.push(z);
    const a = z.map((v) => (layer.activation === "relu" ? relu(v) : sigmoid(v)));
    activations.push(a);
    cur = a;
  }
  return { activations, preacts };
}

function predictProbInternal(
  layers: Array<{ w: number[][]; b: number[]; activation: "relu" | "sigmoid" }>,
  x: number[],
) {
  const { activations } = forward(x, layers);
  return activations[activations.length - 1][0];
}

export function mlpPredictProb(model: MlpTrainedModel, features: number[]): number {
  const x = robustTransform(features, model.scaler.median, model.scaler.iqr);
  return predictProbInternal(model.layers, x);
}

function computeAuc(scores: number[], labels: number[]) {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  let pos = 0, neg = 0;
  for (const p of pairs) (p.y === 1 ? pos++ : neg++);
  if (pos === 0 || neg === 0) return 0.5;
  let rankSum = 0;
  pairs.forEach((p, idx) => { if (p.y === 1) rankSum += idx + 1; });
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function trainMlp(input: MlpTrainInput): MlpTrainedModel {
  const { features, labels, rMultiples, featureNames } = input;
  const epochs = input.epochs ?? 300;
  const lr = input.learningRate ?? 0.01;
  const l2 = input.l2 ?? 0.0005;
  const batchSize = input.batchSize ?? 32;
  const [h1Size, h2Size] = input.hiddenSizes ?? [32, 16];
  const n = features.length;
  if (n < 40) throw new Error(`Muy pocos trades (${n}). Necesitas ≥40 para entrenar MLP.`);
  const inDim = features[0].length;

  // Split cronológico 70/30
  const cut = Math.floor(n * 0.7);
  const trainX = features.slice(0, cut);
  const trainY = labels.slice(0, cut);
  const valX = features.slice(cut);
  const valY = labels.slice(cut);
  const valR = rMultiples.slice(cut);

  const { median, iqr } = robustFit(trainX);
  const trainN = trainX.map((r) => robustTransform(r, median, iqr));
  const valN = valX.map((r) => robustTransform(r, median, iqr));

  const rng = mulberry32(1337);
  const layers = [
    { ...heInit(inDim, h1Size, rng), activation: "relu" as const },
    { ...heInit(h1Size, h2Size, rng), activation: "relu" as const },
    { ...heInit(h2Size, 1, rng), activation: "sigmoid" as const },
  ];

  let bestAuc = 0;
  let bestSnapshot = JSON.parse(JSON.stringify(layers)) as typeof layers;
  let bestEpoch = 0;
  let patience = 0;
  const maxPatience = 25;

  const idx = Array.from({ length: trainN.length }, (_, i) => i);

  for (let ep = 0; ep < epochs; ep++) {
    // shuffle
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    let epochLoss = 0;

    for (let start = 0; start < idx.length; start += batchSize) {
      const end = Math.min(start + batchSize, idx.length);
      // Grad accumulators (mismo shape que layers)
      const gW = layers.map((l) => l.w.map((row) => row.map(() => 0)));
      const gB = layers.map((l) => l.b.map(() => 0));

      for (let k = start; k < end; k++) {
        const i = idx[k];
        const x = trainN[i];
        const y = trainY[i];
        const { activations, preacts } = forward(x, layers);
        const yHat = activations[activations.length - 1][0];
        epochLoss += -(y * Math.log(yHat + 1e-9) + (1 - y) * Math.log(1 - yHat + 1e-9));

        // Backprop
        // dL/dz_out = yHat - y  (sigmoid + binary cross-entropy)
        let delta: number[] = [yHat - y];
        for (let li = layers.length - 1; li >= 0; li--) {
          const layer = layers[li];
          const aPrev = activations[li];
          for (let i2 = 0; i2 < layer.b.length; i2++) {
            gB[li][i2] += delta[i2];
            for (let j = 0; j < aPrev.length; j++) {
              gW[li][i2][j] += delta[i2] * aPrev[j];
            }
          }
          if (li > 0) {
            const prevLayer = layers[li];
            const prevPreact = preacts[li - 1];
            const newDelta: number[] = new Array(prevPreact.length).fill(0);
            for (let j = 0; j < prevPreact.length; j++) {
              let s = 0;
              for (let i2 = 0; i2 < prevLayer.b.length; i2++) {
                s += prevLayer.w[i2][j] * delta[i2];
              }
              // derivada ReLU
              newDelta[j] = prevPreact[j] > 0 ? s : 0;
            }
            delta = newDelta;
          }
        }
      }

      const bs = end - start;
      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        for (let i2 = 0; i2 < layer.b.length; i2++) {
          layer.b[i2] -= lr * (gB[li][i2] / bs);
          for (let j = 0; j < layer.w[i2].length; j++) {
            layer.w[i2][j] -= lr * (gW[li][i2][j] / bs + l2 * layer.w[i2][j]);
          }
        }
      }
    }

    // Val AUC para early stopping cada 5 épocas
    if (ep % 5 === 0 || ep === epochs - 1) {
      const probs = valN.map((x) => predictProbInternal(layers, x));
      const auc = computeAuc(probs, valY);
      if (auc > bestAuc + 0.001) {
        bestAuc = auc;
        bestEpoch = ep;
        bestSnapshot = JSON.parse(JSON.stringify(layers));
        patience = 0;
      } else {
        patience++;
      }
      if (patience >= maxPatience) break;
    }

    if (input.onProgress && (ep % 10 === 0 || ep === epochs - 1)) {
      input.onProgress({ epoch: ep + 1, total: epochs, loss: epochLoss / trainN.length });
    }
  }

  // Restaurar mejor snapshot
  const finalLayers = bestSnapshot;

  // Métricas de validación
  const valProbs = valN.map((x) => predictProbInternal(finalLayers, x));
  let logLoss = 0;
  for (let i = 0; i < valProbs.length; i++) {
    const p = valProbs[i], y = valY[i];
    logLoss += -(y * Math.log(p + 1e-9) + (1 - y) * Math.log(1 - p + 1e-9));
  }
  logLoss = valProbs.length ? logLoss / valProbs.length : 0;
  const valAuc = computeAuc(valProbs, valY);
  const baseTotalR = valR.reduce((s, r) => s + r, 0);
  const baseWins = valY.filter((y) => y === 1).length;
  const baseWr = valY.length ? baseWins / valY.length : 0;
  const baseExp = valR.length ? baseTotalR / valR.length : 0;

  // Umbral óptimo
  let best = { threshold: 0.5, totalR: -Infinity, keptRatio: 0, wr: 0, exp: 0 };
  for (let t = 30; t <= 70; t += 2) {
    const thr = t / 100;
    const keptY: number[] = [];
    const keptR: number[] = [];
    for (let i = 0; i < valProbs.length; i++) {
      if (valProbs[i] >= thr) { keptY.push(valY[i]); keptR.push(valR[i]); }
    }
    const keptRatio = valProbs.length ? keptY.length / valProbs.length : 0;
    if (keptRatio < 0.25) continue;
    const totalR = keptR.reduce((s, r) => s + r, 0);
    const wr = keptY.length ? keptY.filter((y) => y === 1).length / keptY.length : 0;
    const exp = keptR.length ? totalR / keptR.length : 0;
    if (totalR > best.totalR) best = { threshold: thr, totalR, keptRatio, wr, exp };
  }
  if (!isFinite(best.totalR)) best = { threshold: 0.5, totalR: baseTotalR, keptRatio: 1, wr: baseWr, exp: baseExp };

  return {
    featureNames,
    scaler: { median, iqr, kind: "robust" },
    layers: finalLayers,
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
    epochs: bestEpoch + 1,
    version: 2,
    modelType: "mlp",
  };
}