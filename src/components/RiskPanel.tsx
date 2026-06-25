import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { calcLotSize } from "@/lib/analysis";

type Props = {
  balance: number;
  riskPct: number;
  currentPrice: number | null;
};

export function RiskPanel({ balance, riskPct, currentPrice }: Props) {
  const [entry, setEntry] = useState(currentPrice?.toFixed(2) ?? "2400");
  const [sl, setSl] = useState(((currentPrice ?? 2400) - 3).toFixed(2));
  const e = parseFloat(entry) || 0;
  const s = parseFloat(sl) || 0;
  const { lot, riskUsd } = calcLotSize(balance, riskPct, e, s);
  const distance = Math.abs(e - s);
  const tp1 = e > s ? e + distance : e - distance;
  const tp2 = e > s ? e + distance * 2 : e - distance * 2;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="font-semibold mb-3 text-sm tracking-wider text-muted-foreground uppercase">Calculadora rápida</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Entrada</Label>
          <Input value={entry} onChange={(e) => setEntry(e.target.value)} className="font-mono" />
        </div>
        <div>
          <Label className="text-xs">Stop Loss</Label>
          <Input value={sl} onChange={(e) => setSl(e.target.value)} className="font-mono" />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <Stat label="Lote" value={lot.toFixed(2)} />
        <Stat label="Riesgo" value={`$${riskUsd.toFixed(2)}`} />
        <Stat label="TP1 (1R)" value={tp1.toFixed(2)} accent />
        <Stat label="TP2 (2R)" value={tp2.toFixed(2)} accent />
      </div>
      <p className="text-xs text-muted-foreground mt-3">
        Basado en balance ${balance} y riesgo {riskPct}%.
      </p>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded bg-background/50 border border-border/50 px-2 py-1.5">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`font-mono font-medium ${accent ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}