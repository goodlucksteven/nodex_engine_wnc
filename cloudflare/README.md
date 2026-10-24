# NodeX Cloudflare edge proxy

This is a small Cloudflare Worker in front of the existing native Rust/Warp
service. It does **not** compile or run the full Rust server on Cloudflare.
That is intentional: the existing root crate uses Tokio, Warp, Reqwest and
other dependencies that are not a drop-in fit for the `workers-rs`
WebAssembly runtime.

## Configure

1. In Cloudflare Workers & Pages, open the deployed `nodex-engine-edge` Worker.
2. Add a Worker variable named `NODEX_ORIGIN_URL` with the base URL of the
   existing Render `nodex-wallet-engine` service, for example
   `https://your-actual-service.onrender.com`. Use the actual service URL,
   not the example.
3. Deploy again.

The proxy forwards paths, query strings, HTTP methods, request bodies and
authorization headers to Render. It does not cache responses, so authenticated
requests and live balances are not accidentally cached. Response bodies are
passed through as streams, including the `/api/events` SSE route.

## Deploy

From the repository root, use the existing Cloudflare deploy command:

```sh
npx wrangler deploy
```

The repository-root `wrangler.jsonc` points Wrangler to `cloudflare/worker.js`.
No static assets directory or npm package is required.

## Important limitations

- Render remains the origin and still performs the Rust work. This edge proxy
  does not by itself make slow RPC calls or sequential Rust code faster.
- The Worker must be configured with the real `NODEX_ORIGIN_URL`; without it,
  requests return HTTP 503 instead of silently forwarding to an unknown host.
- Keep `NODEX_ENGINE_API_KEY` configured on Render. The Worker forwards the
  client's `x-nodex-api-key` header; do not place wallet API keys or other
  secrets in source control.
- This is a reversible, minimal deployment fix. A true Rust Worker migration
  would require a separate compatibility review and likely a different HTTP
  layer/runtime; do not point Wrangler at the existing Warp binary.
