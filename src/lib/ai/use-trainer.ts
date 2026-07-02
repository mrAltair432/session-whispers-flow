import { useEffect, useRef, useState } from "react";
import type { TrainedModel } from "./logistic";
import type { MlpTrainedModel } from "./mlp";

export type AnyModel = TrainedModel | MlpTrainedModel;
export function isMlpModel(m: AnyModel | null): m is MlpTrainedModel {
  return !!m && (m as MlpTrainedModel).modelType === "mlp";
}

export type TrainProgress = { epoch: number; total: number; loss: number };

export function useAiTrainer() {
  const workerRef = useRef<Worker | null>(null);
  const counter = useRef(0);
  const [progress, setProgress] = useState<TrainProgress | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("./train.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    return () => { w.terminate(); workerRef.current = null; };
  }, []);

  function train(payload: {
    features: number[][]; labels: number[]; rMultiples: number[]; epochs?: number;
    modelType?: "logistic" | "mlp"; featureNames?: readonly string[];
  }): Promise<AnyModel> {
    return new Promise((resolve, reject) => {
      const w = workerRef.current;
      if (!w) return reject(new Error("Trainer no inicializado"));
      const id = ++counter.current;
      setProgress({ epoch: 0, total: payload.epochs ?? 200, loss: 0 });
      const onMsg = (
        e: MessageEvent<{ id: number; done?: boolean; error?: string; model?: AnyModel; progress?: TrainProgress }>,
      ) => {
        if (e.data.id !== id) return;
        if (e.data.progress) { setProgress(e.data.progress); return; }
        if (e.data.done) {
          w.removeEventListener("message", onMsg);
          setProgress(null);
          if (e.data.error) reject(new Error(e.data.error));
          else if (e.data.model) resolve(e.data.model);
          else reject(new Error("Trainer: sin modelo"));
        }
      };
      w.addEventListener("message", onMsg);
      w.postMessage({ id, ...payload });
    });
  }

  return { train, progress };
}

const MODEL_KEY_PREFIX = "tc.ai.model.";
export function loadModel(engineKey: string): AnyModel | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(MODEL_KEY_PREFIX + engineKey);
    return raw ? (JSON.parse(raw) as AnyModel) : null;
  } catch { return null; }
}
export function saveModel(engineKey: string, model: AnyModel) {
  try { localStorage.setItem(MODEL_KEY_PREFIX + engineKey, JSON.stringify(model)); } catch { /* ignore */ }
}
export function deleteModel(engineKey: string) {
  try { localStorage.removeItem(MODEL_KEY_PREFIX + engineKey); } catch { /* ignore */ }
}