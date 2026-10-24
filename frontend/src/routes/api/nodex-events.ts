import { createFileRoute } from "@tanstack/react-router";

const ENGINE_URL = process.env.NODEX_ENGINE_URL?.trim().replace(/\/+$/, "");

export const Route = createFileRoute("/api/nodex-events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const apiKey = process.env.NODEX_ENGINE_API_KEY?.trim();
        if (!apiKey) {
          return new Response("NODEX_ENGINE_API_KEY is not configured on the frontend service.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          });
        }
        if (!ENGINE_URL) return new Response("NODEX_ENGINE_URL is not configured on the frontend service.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
        try {
          const upstream = await fetch(`${ENGINE_URL}/api/events`, {
            headers: { accept: "text/event-stream", "x-nodex-api-key": apiKey },
            cache: "no-store",
          });
          if (!upstream.ok || !upstream.body) {
            const detail = await upstream.text().catch(() => "");
            return new Response(upstream.status === 401
              ? "The engine rejected the API key. Confirm NODEX_ENGINE_API_KEY matches on both Render services."
              : detail || "The NodeX engine event stream is unavailable.", {
              status: upstream.status || 502,
              headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            });
          }
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              "x-accel-buffering": "no",
            },
          });
        } catch {
          return new Response("Could not reach the configured NodeX engine event stream.", {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          });
        }
      },
    },
  },
});
