import { createFileRoute } from "@tanstack/react-router";
import { fetchUpcomingEvents } from "@/lib/economic-calendar";

// Endpoint público de sólo lectura para el calendario económico high-impact.
// Cacheado 6h en memoria. No requiere token porque no expone datos privados.

export const Route = createFileRoute("/api/public/econ-calendar")({
  server: {
    handlers: {
      GET: async () => {
        const events = await fetchUpcomingEvents();
        const now = Date.now();
        // Devuelve sólo los próximos 30 días
        const horizon = now + 30 * 24 * 60 * 60 * 1000;
        const upcoming = events.filter((e) => {
          const t = new Date(e.timeISO).getTime();
          return t >= now - 2 * 60 * 60 * 1000 && t <= horizon;
        });
        return Response.json({
          ok: true,
          count: upcoming.length,
          events: upcoming,
          cached_source: events[0]?.source ?? "fallback",
        });
      },
    },
  },
});