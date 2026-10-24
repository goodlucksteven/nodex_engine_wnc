/**
 * NodeX Cloudflare edge proxy.
 *
 * This deliberately keeps the existing native Rust/Warp service on Render.
 * Configure NODEX_ORIGIN_URL as a Worker variable (the Render service's base
 * URL, e.g. https://your-service.onrender.com) before using the deployed Worker.
 *
 * Requests and responses are streamed through fetch; this does not buffer the
 * full response in the Worker. Existing authorization headers are forwarded.
 */
export default {
  async fetch(request, env) {
    const configuredOrigin = env.NODEX_ORIGIN_URL;

    if (!configuredOrigin) {
      return new Response(
        "NodeX edge proxy is not configured: set the NODEX_ORIGIN_URL Worker variable to the existing Render service URL.",
        {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }

    let origin;
    try {
      origin = new URL(configuredOrigin);
    } catch {
      return new Response("Invalid NODEX_ORIGIN_URL configuration.", {
        status: 500,
        headers: { "cache-control": "no-store" },
      });
    }

    if (
      (origin.protocol !== "https:" && origin.protocol !== "http:") ||
      origin.username ||
      origin.password
    ) {
      return new Response("NODEX_ORIGIN_URL must be an HTTP(S) base URL.", {
        status: 500,
        headers: { "cache-control": "no-store" },
      });
    }

    const target = new URL(request.url);
    target.protocol = origin.protocol;
    target.host = origin.host;

    try {
      // Forward the request as-is, including method, body, query and auth headers.
      // The Response body remains a stream, which supports SSE and progressive
      // response delivery when the upstream server and client stream correctly.
      const upstreamRequest = new Request(target.toString(), request);
      const upstreamResponse = await fetch(upstreamRequest);

      const headers = new Headers(upstreamResponse.headers);
      headers.set("x-nodex-proxy", "cloudflare");

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    } catch {
      return new Response("NodeX upstream service is unavailable.", {
        status: 502,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
  },
};
