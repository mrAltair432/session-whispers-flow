import { useEffect, useRef, useState } from "react";

export type WorkerProgress = {
  step: number;
  total: number;
  label: string;
  // Extended fields for phase-aware progress
  phase?: string;
  percent?: number;   // 0..1 dentro de la fase
  trades?: number;    // trades acumulados en la simulación actual
  phaseStartedAt?: number; // Date.now() al iniciar la fase actual
  jobStartedAt?: number;   // Date.now() al iniciar el job completo
};

export function useBacktestWorker() {
  const workerRef = useRef<Worker | null>(null);
  const counter = useRef(0);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("./backtest.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    return () => { w.terminate(); workerRef.current = null; };
  }, []);

  function run<TResp = unknown, TReq extends Record<string, unknown> = Record<string, unknown>>(
    payload: TReq,
  ): Promise<TResp> {
    return new Promise((resolve, reject) => {
      const w = workerRef.current;
      if (!w) return reject(new Error("Worker no inicializado"));
      const id = ++counter.current;
      setProgress({ step: 0, total: 1, label: "Iniciando..." });
      const onMsg = (e: MessageEvent<{ id: number; done?: boolean; progress?: WorkerProgress; error?: string } & Record<string, unknown>>) => {
        const msg = e.data;
        if (msg.id !== id) return;
        if (msg.progress) { setProgress(msg.progress); return; }
        if (msg.done) {
          w.removeEventListener("message", onMsg);
          setProgress(null);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg as unknown as TResp);
        }
      };
      w.addEventListener("message", onMsg);
      w.postMessage({ id, ...payload });
    });
  }

  return { run, progress };
}