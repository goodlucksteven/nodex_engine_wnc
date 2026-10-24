import { createFileRoute } from "@tanstack/react-router";

const TOKEN_CARE_URL = "https://back-end-gamma-ebon.vercel.app/api/developer";
const TOKEN_ACTIONS = new Set([
  "verify",
  "scan",
  "metadata",
  "logo",
  "price",
  "market",
  "discover",
  "intelligence",
]);
const SECURITY_ACTIONS = new Set(["scan", "details", "investigate"]);
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;

export const Route = createFileRoute("/api/token-care")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Prefer the user's saved UI key; fall back to a server-side Render secret.
        // Never log or echo this header.
        const apiKey = request.headers.get("x-token-care-api-key")?.trim()
          || process.env["TOKEN-CARE-API"]?.trim()
          || process.env.TOKEN_CARE_API?.trim();
        if (!apiKey) {
          return Response.json(
            { success: false, code: "TOKEN_CARE_NOT_CONFIGURED", message: "TokenCare API key is not configured. Paste it in Settings → TokenCare API, or configure TOKEN-CARE-API on the frontend service." },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }

        const contentLength = Number(request.headers.get("content-length") ?? 0);
        if (contentLength > MAX_BODY_BYTES) {
          return Response.json(
            { success: false, code: "REQUEST_TOO_LARGE", message: "Request body exceeds the 64 KB limit." },
            { status: 413, headers: { "cache-control": "no-store" } },
          );
        }

        let body: Record<string, unknown>;
        try {
          const raw = await request.text();
          if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
            return Response.json(
              { success: false, code: "REQUEST_TOO_LARGE", message: "Request body exceeds the 64 KB limit." },
              { status: 413, headers: { "cache-control": "no-store" } },
            );
          }
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
          body = parsed as Record<string, unknown>;
        } catch {
          return Response.json(
            { success: false, code: "INVALID_JSON", message: "Request body must be a valid JSON object." },
            { status: 400, headers: { "cache-control": "no-store" } },
          );
        }

        const service = typeof body.service === "string" ? body.service.trim().toLowerCase() : "";
        const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
        const allowed = service === "token"
          ? TOKEN_ACTIONS.has(action)
          : service === "security" && SECURITY_ACTIONS.has(action);
        if (!allowed) {
          return Response.json(
            { success: false, code: "UNSUPPORTED_OPERATION", message: "Use a documented token or security operation." },
            { status: 400, headers: { "cache-control": "no-store" } },
          );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const upstream = await fetch(TOKEN_CARE_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "X-API-Key": apiKey,
            },
            body: JSON.stringify(body),
            cache: "no-store",
            signal: controller.signal,
          });
          const responseBody = await upstream.text();
          return new Response(responseBody, {
            status: upstream.status,
            headers: {
              "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
              "cache-control": "no-store",
              ...(upstream.headers.get("x-tokencare-credits-charged")
                ? { "x-tokencare-credits-charged": upstream.headers.get("x-tokencare-credits-charged")! }
                : {}),
              ...(upstream.headers.get("x-tokencare-credits-remaining")
                ? { "x-tokencare-credits-remaining": upstream.headers.get("x-tokencare-credits-remaining")! }
                : {}),
            },
          });
        } catch {
          const timedOut = controller.signal.aborted;
          return Response.json(
            {
              success: false,
              code: timedOut ? "TOKEN_CARE_TIMEOUT" : "TOKEN_CARE_UNREACHABLE",
              message: timedOut
                ? `TokenCare did not respond within ${REQUEST_TIMEOUT_MS} ms.`
                : "The frontend server could not reach the TokenCare developer gateway.",
            },
            { status: 502, headers: { "cache-control": "no-store" } },
          );
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  },
});
