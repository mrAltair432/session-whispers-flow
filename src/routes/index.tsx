import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Trading Compass — XAU/USD" },
      { name: "description", content: "Dashboard de análisis multi-timeframe para XAU/USD." },
    ],
  }),
  component: Landing,
});

function Landing() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setAuthed(!!data.session));
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <div className="flex items-center gap-3 mb-12">
          <div className="h-10 w-10 rounded-md bg-primary flex items-center justify-center font-bold text-primary-foreground">TC</div>
          <span className="font-semibold tracking-tight">Trading Compass</span>
        </div>
        <h1 className="text-5xl font-bold tracking-tight mb-6">
          Tu copiloto para <span className="text-primary">XAU/USD</span><br />
          en la sesión de Londres.
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mb-10">
          Análisis multi-timeframe (H4 / H1 / M15), motor de señales basado en barridos de
          liquidez + FVG, calculadora de riesgo dinámica y alertas a Telegram. Sin ruido,
          sin indicadores basura.
        </p>
        <div className="flex gap-3">
          {authed ? (
            <Link to="/dashboard"><Button size="lg">Abrir dashboard</Button></Link>
          ) : (
            <>
              <Link to="/auth"><Button size="lg">Entrar</Button></Link>
              <Link to="/auth"><Button size="lg" variant="outline">Crear cuenta</Button></Link>
            </>
          )}
        </div>

        <div className="grid md:grid-cols-3 gap-4 mt-20">
          {[
            { t: "Multi-timeframe", d: "H4, H1 y M15 sincronizados. EMA 20 y 50. Cero saturación." },
            { t: "Motor de señales", d: "Detecta barridos + FVG + confirmación M15 en dirección de H4." },
            { t: "Riesgo controlado", d: "Lote calculado para 0.5%, máximo 2 ops/día, alerta de pérdida máxima." },
          ].map((c) => (
            <div key={c.t} className="rounded-lg border border-border bg-card p-5">
              <h3 className="font-semibold mb-2">{c.t}</h3>
              <p className="text-sm text-muted-foreground">{c.d}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
