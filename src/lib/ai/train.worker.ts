/// <reference lib="webworker" />
import { trainLogistic, type TrainInput, type TrainedModel } from "./logistic";

type Job = {
  id: number;
  features: number[][];
  labels: number[];
  rMultiples: number[];
  epochs?: number;
};

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
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
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: job.id, done: true, error: err instanceof Error ? err.message : "Train error",
    });
  }
};

export {};