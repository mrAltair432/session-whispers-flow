/// <reference lib="webworker" />
import { trainLogistic, type TrainInput, type TrainedModel } from "./logistic";
import { trainMlp, type MlpTrainedModel } from "./mlp";

type Job = {
  id: number;
  features: number[][];
  labels: number[];
  rMultiples: number[];
  epochs?: number;
  modelType?: "logistic" | "mlp";
  featureNames?: readonly string[];
};

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    const modelType = job.modelType ?? "logistic";
    if (modelType === "mlp") {
      const model: MlpTrainedModel = trainMlp({
        features: job.features,
        labels: job.labels,
        rMultiples: job.rMultiples,
        featureNames: job.featureNames ?? [],
        epochs: job.epochs,
        onProgress: (p) => {
          (self as unknown as Worker).postMessage({ id: job.id, progress: p });
        },
      });
      (self as unknown as Worker).postMessage({ id: job.id, done: true, model });
    } else {
      const model: TrainedModel = trainLogistic({
        features: job.features,
        labels: job.labels,
        rMultiples: job.rMultiples,
        epochs: job.epochs,
        onProgress: (p) => {
          (self as unknown as Worker).postMessage({ id: job.id, progress: p });
        },
      } as TrainInput);
      (self as unknown as Worker).postMessage({ id: job.id, done: true, model });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: job.id, done: true, error: err instanceof Error ? err.message : "Train error",
    });
  }
};

export {};