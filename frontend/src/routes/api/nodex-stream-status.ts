import { createFileRoute } from "@tanstack/react-router";

const ENGINE_URL = process.env.NODEX_ENGINE_URL?.trim().replace(/\/+$/, "");
const PROBE_TIMEOUT_MS = 10_000;

type DiagnosticStatus =
  | "connected"
  | "missing_secret"
  | "authentication_failed"
  | "engine_error"
  | "timeout"
  | "unreachable"
  | "invalid_response";

export const Route = createFileRoute("/api/nodex-stream-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const started = Date.now();
        const apiKey = process.env.NODEX_ENGINE_API_KEY?.trim();
        const checkedAt = new Date().toISOString();

        if (!ENGINE_URL) return Response.json({ configured: false, status: "unreachable" satisfies DiagnosticStatus, statusCode: null, contentType: null, detail: "NODEX_ENGINE_URL is not configured on the frontend service.", checkedAt, durationMs: Date.now() - started }, { status: 503, headers: { "cache-control": "no-store" } });

        if (!apiKey) {
          return Response.json({
            configured: false,
            status: "missing_secret" satisfies DiagnosticStatus,
            statusCode: null,
            contentType: null,
            detail: "NODEX_ENGINE_API_KEY is not configured on the frontend service.",
            checkedAt,
            durationMs: Date.now() - started,
          }, { headers: { "cache-control": "no-store" } });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
          // Probe the exact canonical engine with the selected token. Never
          // include the token in diagnostic output.
          const upstream = await fetch(`${ENGINE_URL}/api/events`, {
            method: "GET",
            headers: {
              accept: "text/event-stream",
              "x-nodex-api-key": apiKey,
            },
            cache: "no-store",
            signal: controller.signal,
          });
          const contentType = upstream.headers.get("content-type");
          let status: DiagnosticStatus;
          let detail: string;

          if (upstream.status === 401 || upstream.status === 403) {
            status = "authentication_failed";
            detail = `The engine rejected the event-stream request (HTTP ${upstream.status}). Confirm NODEX_ENGINE_API_KEY matches on both Render services.`;
          } else if (!upstream.ok) {
            status = "engine_error";
            const body = await upstream.text().catch(() => "");
            detail = body.trim().slice(0, 1200) || `The engine returned HTTP ${upstream.status}.`;
          } else if (!upstream.body || !contentType?.toLowerCase().includes("text/event-stream")) {
            status = "invalid_response";
            const body = upstream.body ? await upstream.text().catch(() => "") : "";
            detail = body.trim().slice(0, 1200) || `Expected an SSE response, but received content-type: ${contentType ?? "missing"}.`;
          } else {
            status = "connected";
            detail = "The engine accepted the selected token and opened the event stream (HTTP 200, text/event-stream). This is a connection probe; the wallet's persistent stream is monitored separately.";
          }

          // This is only a short probe; close it immediately rather than keeping
          // a second permanent SSE connection open.
          await upstream.body?.cancel().catch(() => undefined);
          return Response.json({
            configured: true,
            status,
            statusCode: upstream.status,
            contentType,
            detail,
            checkedAt,
            durationMs: Date.now() - started,
          }, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          const timedOut = controller.signal.aborted;
          const status: DiagnosticStatus = timedOut ? "timeout" : "unreachable";
          const detail = timedOut
            ? `Timed out after ${PROBE_TIMEOUT_MS} ms while contacting the NodeX engine event stream.`
            : `Could not reach ${ENGINE_URL}/api/events: ${error instanceof Error ? error.message : "unknown network error"}`;
          return Response.json({
            configured: true,
            status,
            statusCode: null,
            contentType: null,
            detail,
            checkedAt,
            durationMs: Date.now() - started,
          }, { headers: { "cache-control": "no-store" } });
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  },
});
