import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getMyConfig, updateMyConfig } from "@/lib/config.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Configuración — Trading Compass" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const fetchConfig = useServerFn(getMyConfig);
  const update = useServerFn(updateMyConfig);
  const { data } = useQuery({ queryKey: ["my-config"], queryFn: () => fetchConfig() });

  const [form, setForm] = useState({
    balance: 1000,
    risk_per_trade: 0.5,
    max_daily_loss_pct: 1.5,
    max_trades_per_day: 2,
    telegram_chat_id: "",
    telegram_enabled: false,
    auto_alert_high_confidence: true,
  });

  useEffect(() => {
    if (data) setForm({
      balance: Number(data.balance),
      risk_per_trade: Number(data.risk_per_trade),
      max_daily_loss_pct: Number(data.max_daily_loss_pct),
      max_trades_per_day: data.max_trades_per_day,
      telegram_chat_id: data.telegram_chat_id ?? "",
      telegram_enabled: data.telegram_enabled,
      auto_alert_high_confidence: data.auto_alert_high_confidence,
    });
  }, [data]);

  const m = useMutation({
    mutationFn: update,
    onSuccess: () => {
      toast.success("Configuración guardada");
      qc.invalidateQueries({ queryKey: ["my-config"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  function save(e: React.FormEvent) {
    e.preventDefault();
    m.mutate({
      data: {
        ...form,
        telegram_chat_id: form.telegram_chat_id.trim() || null,
      },
    });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 sticky top-0 z-10">
        <div className="mx-auto max-w-3xl px-4 h-14 flex items-center gap-3">
          <Link to="/dashboard"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
          <h1 className="font-semibold">Configuración</h1>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <form onSubmit={save} className="space-y-6">
          <Section title="Cuenta" subtitle="Balance y reglas de riesgo. El lote se calcula automáticamente.">
            <Field label="Balance (USD)" hint="Balance real de tu cuenta Exness en USD (no cents).">
              <Input type="number" step="0.01" value={form.balance}
                onChange={(e) => setForm({ ...form, balance: parseFloat(e.target.value) || 0 })} />
            </Field>
            <Field label="Riesgo por trade (%)" hint="0.5% es la regla del plan. Máx 1%.">
              <Input type="number" step="0.05" min="0.1" max="2" value={form.risk_per_trade}
                onChange={(e) => setForm({ ...form, risk_per_trade: parseFloat(e.target.value) || 0.5 })} />
            </Field>
            <Field label="Pérdida máxima diaria (%)" hint="Cuando se alcanza, el dashboard te bloquea por el día.">
              <Input type="number" step="0.1" value={form.max_daily_loss_pct}
                onChange={(e) => setForm({ ...form, max_daily_loss_pct: parseFloat(e.target.value) || 1.5 })} />
            </Field>
            <Field label="Operaciones máximas por día" hint="Tu regla: 2.">
              <Input type="number" min="1" max="10" value={form.max_trades_per_day}
                onChange={(e) => setForm({ ...form, max_trades_per_day: parseInt(e.target.value) || 2 })} />
            </Field>
          </Section>

          <Section title="Alertas de Telegram" subtitle="Recibe los setups directo a tu celular.">
            <Field label="Activar alertas">
              <Switch checked={form.telegram_enabled} onCheckedChange={(v) => setForm({ ...form, telegram_enabled: v })} />
            </Field>
            <Field label="Chat ID de Telegram" hint="Cómo obtenerlo: abre @userinfobot en Telegram y te lo da. También necesitas iniciar conversación con tu bot primero.">
              <Input value={form.telegram_chat_id} placeholder="Ej: 123456789"
                onChange={(e) => setForm({ ...form, telegram_chat_id: e.target.value })} />
            </Field>
            <Field label="Auto-enviar setups de alta confianza">
              <Switch checked={form.auto_alert_high_confidence} onCheckedChange={(v) => setForm({ ...form, auto_alert_high_confidence: v })} />
            </Field>
            <div className="text-xs text-muted-foreground rounded-md border border-border bg-background/50 p-3 mt-2">
              <strong>⚠️ Falta conectar Telegram.</strong> Cuando me pidas activar las alertas, conecto el bot de Telegram desde Lovable y queda listo.
            </div>
          </Section>

          <div className="flex justify-end">
            <Button type="submit" disabled={m.isPending}>{m.isPending ? "Guardando..." : "Guardar cambios"}</Button>
          </div>
        </form>
      </main>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid sm:grid-cols-[1fr_240px] gap-2 sm:items-start">
      <div>
        <Label className="text-sm">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}