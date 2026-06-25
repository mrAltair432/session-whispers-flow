import { useEffect, useState } from "react";

function nowUtcHours() {
  const d = new Date();
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function getSession(h: number): { name: string; color: string } {
  // UTC sessions
  if (h >= 0 && h < 7) return { name: "Asia", color: "text-blue-400" };
  if (h >= 7 && h < 12) return { name: "Londres", color: "text-primary" };
  if (h >= 12 && h < 16) return { name: "Londres + NY", color: "text-emerald-400" };
  if (h >= 16 && h < 21) return { name: "Nueva York", color: "text-emerald-400" };
  return { name: "Cierre", color: "text-muted-foreground" };
}

export function SessionClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const session = getSession(nowUtcHours());
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`flex items-center gap-1.5 ${session.color}`}>
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
        {session.name}
      </span>
      <span className="text-muted-foreground tabular-nums">
        {time.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
    </div>
  );
}