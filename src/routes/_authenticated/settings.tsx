import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getMyConfig, updateMyConfig } from "@/lib/config.functions";
import { sendTelegramTest } from "@/lib/setups.functions";
import { getMyEaToken, rotateMyEaToken, deleteMyEaToken, getMyMt5Diagnostics, getMyEngineHealth } from "@/lib/mt5.functions";
import { listMyScorers, uploadMyScorer, deleteMyScorer } from "@/lib/ml-scorers.functions";
import { listStrategies } from "@/lib/strategies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, Copy, RefreshCw, Trash2, Download } from "lucide-react";
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
    mt5_auto_route_enabled: false,
    mt5_min_confidence: "high" as "high" | "medium",
    mt5_enabled_engines: null as string[] | null,
    econ_filter_enabled: true,
    econ_filter_window_min: 30,
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
      mt5_auto_route_enabled: (data as { mt5_auto_route_enabled?: boolean }).mt5_auto_route_enabled ?? false,
      mt5_min_confidence: ((data as { mt5_min_confidence?: string }).mt5_min_confidence as "high" | "medium") ?? "high",
      mt5_enabled_engines: (data as { mt5_enabled_engines?: string[] | null }).mt5_enabled_engines ?? null,
      econ_filter_enabled: (data as { econ_filter_enabled?: boolean }).econ_filter_enabled ?? true,
      econ_filter_window_min: (data as { econ_filter_window_min?: number }).econ_filter_window_min ?? 30,
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

  const testTg = useServerFn(sendTelegramTest);
  const testM = useMutation({
    mutationFn: () => testTg(),
    onSuccess: () => toast.success("Mensaje enviado a Telegram 🚀"),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error enviando"),
  });

  // ---- MT5 EA token ----
  const fetchEa = useServerFn(getMyEaToken);
  const rotateEa = useServerFn(rotateMyEaToken);
  const deleteEa = useServerFn(deleteMyEaToken);
  const fetchMt5Diag = useServerFn(getMyMt5Diagnostics);
  const eaQ = useQuery({ queryKey: ["my-ea-token"], queryFn: () => fetchEa() });
  const diagQ = useQuery({
    queryKey: ["my-mt5-diagnostics"],
    queryFn: () => fetchMt5Diag(),
    refetchInterval: 8000,
  });
  const fetchHealth = useServerFn(getMyEngineHealth);
  const healthQ = useQuery({
    queryKey: ["my-engine-health"],
    queryFn: () => fetchHealth(),
    refetchInterval: 15_000,
  });
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const rotateM = useMutation({
    mutationFn: () => rotateEa(),
    onSuccess: (res: { token: string }) => {
      setFreshToken(res.token);
      qc.invalidateQueries({ queryKey: ["my-ea-token"] });
      qc.invalidateQueries({ queryKey: ["my-mt5-diagnostics"] });
      toast.success("Token generado. Cópialo ahora — no volverá a mostrarse.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });
  const deleteM = useMutation({
    mutationFn: () => deleteEa(),
    onSuccess: () => {
      setFreshToken(null);
      qc.invalidateQueries({ queryKey: ["my-ea-token"] });
      qc.invalidateQueries({ queryKey: ["my-mt5-diagnostics"] });
      toast.success("Token eliminado");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  // ---- ML scorers ----
  const fetchScorers = useServerFn(listMyScorers);
  const uploadScorer = useServerFn(uploadMyScorer);
  const removeScorer = useServerFn(deleteMyScorer);
  const scorersQ = useQuery({ queryKey: ["my-scorers"], queryFn: () => fetchScorers() });
  const uploadScorerM = useMutation({
    mutationFn: uploadScorer,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-scorers"] });
      toast.success("Modelo ML cargado");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });
  const deleteScorerM = useMutation({
    mutationFn: removeScorer,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-scorers"] });
      toast.success("Modelo eliminado");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Error"),
  });

  // ---- Calendario económico (feed público) ----
  const econQ = useQuery({
    queryKey: ["econ-calendar"],
    queryFn: async () => {
      const res = await fetch("/api/public/econ-calendar");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json() as Promise<{ events: Array<{ timeISO: string; label: string; type: string; source: string }> }>;
    },
    staleTime: 60 * 60 * 1000,
  });

  async function handleScorerFile(engine: string, file: File) {
    try {
      const text = await file.text();
      const json = JSON.parse(text) as {
        features?: string[]; weights?: number[]; intercept?: number; auc?: number;
        coef?: number[]; feature_names?: string[]; // formatos alternativos del notebook
      };
      const features = json.features ?? json.feature_names ?? [];
      const weights = json.weights ?? json.coef ?? [];
      const intercept = json.intercept ?? 0;
      if (!features.length || features.length !== weights.length) {
        toast.error("JSON inválido: features y weights deben coincidir");
        return;
      }
      uploadScorerM.mutate({ data: { engine, features, weights, intercept, auc: json.auc } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "JSON inválido");
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    m.mutate({
      data: {
        ...form,
        telegram_chat_id: form.telegram_chat_id.trim() || null,
      },
    });
  }

  const lastEaUse = diagQ.data?.last_used_at ?? eaQ.data?.last_used_at ?? null;

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
              <strong>✅ Telegram conectado.</strong> Guarda los cambios y usa el botón de abajo para verificar que el mensaje llega a tu chat.
            </div>
            <div className="pt-2">
              <Button type="button" variant="outline" size="sm"
                onClick={() => testM.mutate()}
                disabled={testM.isPending || !form.telegram_enabled || !form.telegram_chat_id.trim()}>
                {testM.isPending ? "Enviando..." : "Enviar mensaje de prueba"}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Guarda primero los cambios para que el chat_id quede registrado.
              </p>
            </div>
          </Section>

          <Section title="MetaTrader 5 (EA puente)" subtitle="Envía automáticamente las señales del dashboard a MetaTrader 5 vía el EA LovableBridge.">
            <Field label="Auto-enviar señales al EA" hint="Cuando esté activo, cada señal generada por el cron se encolará en MT5 para que el EA la ejecute.">
              <Switch
                checked={form.mt5_auto_route_enabled}
                onCheckedChange={(v) => setForm({ ...form, mt5_auto_route_enabled: v })}
              />
            </Field>
            <Field label="Confianza mínima" hint="Sólo se envían al EA las señales que igualen o superen este umbral.">
              <select
                className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={form.mt5_min_confidence}
                onChange={(e) => setForm({ ...form, mt5_min_confidence: e.target.value as "high" | "medium" })}
              >
                <option value="high">Solo Alta</option>
                <option value="medium">Media o Alta</option>
              </select>
            </Field>

            <div className="border-t border-border pt-4 space-y-2">
              <div>
                <Label className="text-sm">Estrategias conectadas al EA</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Sólo las estrategias activadas aquí encolarán operaciones en MT5. Las apagadas siguen generando señales y avisos en Telegram, pero no se envían al EA.
                </p>
              </div>
              <div className="space-y-2">
                {listStrategies().map((s) => {
                  const enabled = form.mt5_enabled_engines === null
                    ? true
                    : form.mt5_enabled_engines.includes(s.key);
                  return (
                    <div key={s.key} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{s.shortName}</p>
                        <p className="text-xs text-muted-foreground truncate">{s.name}</p>
                      </div>
                      <Switch
                        checked={enabled}
                        onCheckedChange={(v) => {
                          const all = listStrategies().map((x) => x.key);
                          const current = form.mt5_enabled_engines === null ? [...all] : [...form.mt5_enabled_engines];
                          const next = v
                            ? Array.from(new Set([...current, s.key]))
                            : current.filter((k) => k !== s.key);
                          setForm({ ...form, mt5_enabled_engines: next });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2 pt-1">
                <Button type="button" variant="outline" size="sm"
                  onClick={() => setForm({ ...form, mt5_enabled_engines: null })}>
                  Activar todas
                </Button>
                <Button type="button" variant="ghost" size="sm"
                  onClick={() => setForm({ ...form, mt5_enabled_engines: [] })}>
                  Desactivar todas
                </Button>
              </div>
            </div>

            <div className="border-t border-border pt-4 space-y-3">
              <div>
                <Label className="text-sm">Salud de estrategias (kill-switch)</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  El sistema desconecta automáticamente una estrategia del EA si acumula −3R en los últimos 20 trades o 5 SL consecutivos. Puedes volver a activarla manualmente con el switch de arriba.
                </p>
              </div>
              <div className="space-y-2">
                {healthQ.data && healthQ.data.length > 0 ? (
                  healthQ.data.map((h) => (
                    <div key={h.engine} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {(() => {
                            const s = listStrategies().find((x) => x.key === h.engine);
                            return s ? s.shortName : h.engine;
                          })()}
                          {h.disabled_at && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-mono">DESACTIVADA</span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {h.disabled_at
                            ? `Kill-switch: ${h.disabled_reason}`
                            : `R acumulado (últ. 20): ${Number(h.total_r).toFixed(2)}R · SL consecutivos: ${h.consecutive_losses}`}
                        </p>
                      </div>
                      <div className={`text-xs font-mono ${Number(h.total_r) < -1.5 ? "text-red-400" : "text-emerald-400"}`}>
                        {h.total_closed} cerradas
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">Aún no hay datos de salud. Se generan automáticamente cuando el EA reporta cierres reales.</p>
                )}
              </div>
            </div>

            <div className="border-t border-border pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm">Token del EA</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Pega este token en el input <code>InpEaToken</code> del EA en MT5.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => rotateM.mutate()}
                    disabled={rotateM.isPending}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                    {eaQ.data ? "Rotar" : "Generar"}
                  </Button>
                  {eaQ.data && (
                    <Button type="button" variant="ghost" size="sm"
                      onClick={() => deleteM.mutate()}
                      disabled={deleteM.isPending}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              {freshToken && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-xs text-amber-300">
                    ⚠️ Cópialo ahora. Por seguridad no volverá a mostrarse.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono break-all bg-background/60 rounded p-2">
                      {freshToken}
                    </code>
                    <Button type="button" variant="outline" size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(freshToken);
                        toast.success("Copiado");
                      }}>
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}

              {!freshToken && eaQ.data && (
                <div className="text-xs text-muted-foreground rounded-md border border-border bg-background/50 p-3">
                  <strong className="text-emerald-400">✅ Token activo.</strong>{" "}
                  Creado: {new Date(eaQ.data.created_at).toLocaleString()}.{" "}
                  {lastEaUse
                    ? <>Último uso: <span className="font-mono">{new Date(lastEaUse).toLocaleString()}</span></>
                    : <span className="text-amber-400">Aún no se ha conectado el EA.</span>}
                </div>
              )}

              {eaQ.data && (
                <div className="rounded-md border border-border bg-background/50 p-3 text-xs text-muted-foreground space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-foreground">Diagnóstico MT5</strong>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => diagQ.refetch()}
                      disabled={diagQ.isFetching}
                    >
                      {diagQ.isFetching ? "Revisando..." : "Actualizar"}
                    </Button>
                  </div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    <p>Auto-envío: <span className="text-foreground">{diagQ.data?.auto_route_enabled ? "Activo" : "Apagado"}</span></p>
                    <p>Confianza mínima: <span className="text-foreground">{diagQ.data?.min_confidence === "medium" ? "Media o Alta" : "Solo Alta"}</span></p>
                    <p>Señales pendientes: <span className="text-foreground">{diagQ.data?.pending_count ?? 0}</span></p>
                    <p>Revisado: <span className="text-foreground">{diagQ.data?.checked_at ? new Date(diagQ.data.checked_at).toLocaleTimeString() : "—"}</span></p>
                  </div>
                  {diagQ.data?.latest_signal ? (
                    <p>
                      Última señal MT5: <span className="text-foreground font-mono">{diagQ.data.latest_signal.engine}</span>{" "}
                      {diagQ.data.latest_signal.bias} · {diagQ.data.latest_signal.status} · score {diagQ.data.latest_signal.score ?? "—"}
                      {diagQ.data.latest_signal.error_message ? ` · ${diagQ.data.latest_signal.error_message}` : ""}
                    </p>
                  ) : (
                    <p>No hay señales MT5 generadas todavía. Si Telegram notificó pero aquí no aparece nada, la señal no pasó el filtro de auto-envío o no estaba guardado el switch.</p>
                  )}
                </div>
              )}

              {!eaQ.data && !freshToken && (
                <div className="text-xs text-muted-foreground rounded-md border border-border bg-background/50 p-3">
                  No hay token todavía. Genera uno para conectar tu EA.
                </div>
              )}

              <div className="text-xs text-muted-foreground border-t border-border pt-3 space-y-1.5">
                <p className="font-semibold text-foreground">Pasos rápidos:</p>
                <ol className="list-decimal ml-4 space-y-1">
                  <li>Descarga el EA:{" "}
                    <a href="/mt5/LovableBridge.mq5" download className="text-primary underline inline-flex items-center gap-1">
                      <Download className="w-3 h-3" />LovableBridge.mq5
                    </a>
                  </li>
                  <li>En MT5: <em>File → Open Data Folder → MQL5/Experts/</em> y pega el archivo.</li>
                  <li>Compílalo (F7) en MetaEditor.</li>
                  <li><em>Tools → Options → Expert Advisors → Allow WebRequest for URL</em> y añade{" "}
                    <code className="bg-background/60 px-1 rounded">https://session-whispers-flow.lovable.app</code></li>
                  <li>Arrastra el EA a un gráfico XAUUSD y pega el token en <code>InpEaToken</code>.</li>
                </ol>
              </div>
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