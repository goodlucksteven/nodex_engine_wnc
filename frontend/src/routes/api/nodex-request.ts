import { createFileRoute } from "@tanstack/react-router";

const ENGINE_URL = process.env.NODEX_ENGINE_URL?.trim().replace(/\/+$/, "");

export const Route = createFileRoute("/api/nodex-request")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.NODEX_ENGINE_API_KEY?.trim();
        let body: string;
        try {
          body = await request.text();
          JSON.parse(body);
        } catch {
          return Response.json({ success: false, error: "Request body must be valid JSON." }, { status: 400 });
        }

        if (!ENGINE_URL) return Response.json({ success: false, error: "NODEX_ENGINE_URL is not configured on the frontend service." }, { status: 503 });
        if (!apiKey) return Response.json({ success: false, error: "NODEX_ENGINE_API_KEY is not configured on the frontend service." }, { status: 503 });

        try {
          const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
          headers.set("x-nodex-api-key", apiKey);
          const upstream = await fetch(`${ENGINE_URL}/api/request`, {
            method: "POST",
            headers,
            body,
            cache: "no-store",
          });
          const responseBody = await upstream.text();
          return new Response(responseBody, {
            status: upstream.status,
            headers: {
              "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        } catch {
          return Response.json(
            { success: false, error: "The frontend server could not reach the configured NodeX engine. Check Render service health and engine logs." },
            { status: 502, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
