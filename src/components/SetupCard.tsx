import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowDown, ArrowUp, Send, Save } from "lucide-react";
import type { Signal } from "@/lib/signal-engine";
import { calcLotSize } from "@/lib/analysis";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { saveSetup } from "@/lib/setups.functions";
import { toast } from "sonner";

type Props = {
  signal: NonNullable<Signal> | null;
  balance: number;
  riskPct: number;
  telegramEnabled: boolean;
};

export function SetupCard({ signal, balance, riskPct, telegramEnabled }: Props) {
  const save = useServerFn(saveSetup);
  const m = useMutation({
    mutationFn: save,
    onSuccess: (_d, vars) => {
      const sent = (vars as { data: { send_telegram?: boolean } }).data.send_telegram;
      toast.success(sent ? "Setup guardado y enviado a Telegram" : "Setup guardado");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error al guardar"),
  });

  if (!signal) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 h-full flex flex-col items-center justify-center text-center">
        <div className="text-4xl mb-3 opacity-30">⌖</div>
        <h3 className="font-semibold mb-1">Sin setup válido</h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          Esperando alineación: tendencia H4 + barrido de liquidez H1 + confirmación M15.
        </p>
      </div>
    );
  }

  const { lot, riskUsd } = calcLotSize(balance, riskPct, signal.entry, signal.stopLoss);
  const slPips = Math.abs(signal.entry - signal.stopLoss) * 10;
  const longBias = signal.bias === "long";

  function handleSave(sendTelegram: boolean) {
    m.mutate({
      data: {
        bias: signal!.bias,
        confidence: signal!.confidence,
        entry: signal!.entry,
        stop_loss: signal!.stopLoss,
        tp1: signal!.tp1,
        tp2: signal!.tp2,
        tp3: signal!.tp3,
        lot_size: lot,
        risk_usd: riskUsd,
        reasoning: signal!.reasoning as unknown as Record<string, unknown>,
        send_telegram: sendTelegram,
      },
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {longBias
            ? <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40"><ArrowUp className="w-3 h-3 mr-1" />LONG</Badge>
            : <Badge className="bg-red-500/20 text-red-400 border-red-500/40"><ArrowDown className="w-3 h-3 mr-1" />SHORT</Badge>}
          <Badge variant="outline">{signal.confidence === "high" ? "🔥 Alta" : "Media"}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">XAU/USD</span>
      </div>

      <div className="space-y-2 text-sm">
        <Row label="Entrada" value={signal.entry.toFixed(2)} accent />
        <Row label="Stop Loss" value={`${signal.stopLoss.toFixed(2)}  (${slPips.toFixed(0)} pips)`} negative />
        <div className="border-t border-border/50 my-2" />
        <Row label="TP1 (1R)" value={signal.tp1.toFixed(2)} positive />
        <Row label="TP2 (2R)" value={signal.tp2.toFixed(2)} positive />
        <Row label="TP3 (3R)" value={signal.tp3.toFixed(2)} positive />
        <div className="border-t border-border/50 my-2" />
        <Row label="Lote" value={lot.toFixed(2)} />
        <Row label="Riesgo" value={`$${riskUsd.toFixed(2)} (${riskPct}%)`} />
      </div>

      <div className="mt-4 rounded-md bg-background/50 border border-border/50 p-3 text-xs space-y-1">
        <div><span className="text-muted-foreground">H4:</span> {signal.reasoning.h4Trend}</div>
        <div><span className="text-muted-foreground">H1:</span> {signal.reasoning.h1Liquidity}</div>
        <div><span className="text-muted-foreground">M15:</span> {signal.reasoning.m15Confirmation}</div>
        {signal.reasoning.notes.map((n, i) => <div key={i} className="text-muted-foreground">• {n}</div>)}
      </div>

      <div className="mt-4 text-xs text-muted-foreground">
        Plan: cerrar 50% en TP1 → SL a BE, 30% en TP2, 20% runner.
      </div>

      <div className="mt-auto pt-4 flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => handleSave(false)} disabled={m.isPending}>
          <Save className="w-4 h-4 mr-1" /> Guardar
        </Button>
        <Button size="sm" className="flex-1" onClick={() => handleSave(true)} disabled={m.isPending || !telegramEnabled}>
          <Send className="w-4 h-4 mr-1" /> {telegramEnabled ? "Enviar a Telegram" : "Telegram off"}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, positive, negative, accent }: { label: string; value: string; positive?: boolean; negative?: boolean; accent?: boolean }) {
  const color = accent ? "text-primary" : positive ? "text-emerald-400" : negative ? "text-red-400" : "text-foreground";
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono font-medium ${color}`}>{value}</span>
    </div>
  );
}