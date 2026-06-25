import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Entrar — Trading Compass" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: { emailRedirectTo: window.location.origin + "/dashboard" },
        });
        if (error) throw error;
        toast.success("Cuenta creada. Entrando...");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      navigate({ to: "/dashboard" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error de autenticación");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex h-12 w-12 rounded-md bg-primary items-center justify-center font-bold text-primary-foreground mb-3">TC</div>
          <h1 className="text-2xl font-bold">Trading Compass</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {mode === "signin" ? "Entra para abrir tu dashboard" : "Crea tu cuenta"}
          </p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-6">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="pwd">Contraseña</Label>
            <Input id="pwd" type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "..." : mode === "signin" ? "Entrar" : "Crear cuenta"}
          </Button>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
            {mode === "signin" ? "¿No tienes cuenta? Crear una" : "¿Ya tienes cuenta? Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}