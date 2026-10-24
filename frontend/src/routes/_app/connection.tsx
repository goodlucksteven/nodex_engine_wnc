import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, CircleAlert, RadioTower, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getEventStreamStatus, reconnectEventStream, type EngineStreamStatus } from "@/lib/wallet/event-stream";
import { logConnectionDiagnostic } from "@/lib/wallet/engine";

export const Route = createFileRoute("/_app/connection")({ component: ConnectionPage });

type ServerStreamConfig = { configured: boolean | null; status: string; statusCode: number | null; contentType: string | null; detail: string; checkedAt: string; durationMs: number };

function ConnectionPage() {
  const [status, setStatus] = useState<{ status: EngineStreamStatus; message?: string }>({ status: "disconnected" });
  const [serverConfig, setServerConfig] = useState<ServerStreamConfig | null>(null);
  const [checkingConfig, setCheckingConfig] = useState(true);

  const runConnectionTest = useCallback(async () => {
    setCheckingConfig(true);
    const started = Date.now();
    try {
      const response = await fetch("/api/nodex-stream-status", { cache: "no-store" });
      const result = await response.json() as ServerStreamConfig;
      setServerConfig(result);
      logConnectionDiagnostic(result.status === "connected", result.durationMs ?? Date.now() - started, result, result.status === "connected" ? undefined : result.detail);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not run the NodeX engine connection test.";
      const result: ServerStreamConfig = { configured: null, status: "diagnostic_failed", statusCode: null, contentType: null, detail, checkedAt: new Date().toISOString(), durationMs: Date.now() - started };
      setServerConfig(result);
      logConnectionDiagnostic(false, result.durationMs, result, detail);
    } finally {
      setCheckingConfig(false);
    }
  }, []);

  useEffect(() => {
    setStatus(getEventStreamStatus());
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ status: EngineStreamStatus; message?: string }>).detail;
      if (detail) setStatus(detail);
    };
    window.addEventListener("nodex-event-stream-status", update);
    void runConnectionTest();
    return () => {
      window.removeEventListener("nodex-event-stream-status", update);
    };
  }, [runConnectionTest]);

  const connected = status.status === "connected";
  const failed = status.status === "error";
  const missingSecret = serverConfig?.configured === false;

  return <div className="mx-auto w-full max-w-4xl space-y-5 px-3 pb-28 pt-4 sm:px-5 lg:px-8 lg:pb-12">
    <header className="space-y-1 border-b border-border/70 pb-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">NodeX engine</p>
      <h1 className="text-2xl font-semibold tracking-tight">Connection</h1>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">Live event feed for wallet balance updates while engine requests are running.</p>
    </header>

    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-full border border-border/80">
          <RadioTower className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Live event stream</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">Uses the shared server-side API key configured in the frontend and NodeX Engine Render environments.</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-medium ${connected ? "border-emerald-500/30 text-emerald-500" : failed || missingSecret ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}>
          {connected ? "Connected" : missingSecret ? "API key missing" : checkingConfig ? "Connecting" : status.status === "error" ? "Error" : status.status}
        </span>
      </div>

      <div className="border-y border-border/70 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Shared API key configuration</p>
          <span className={`rounded-full border px-2 py-1 text-[11px] font-medium ${checkingConfig ? "border-border text-muted-foreground" : serverConfig?.configured ? "border-emerald-500/30 text-emerald-500" : serverConfig?.configured === false ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}>
            {checkingConfig ? "Checking…" : serverConfig?.configured === true ? "Configured" : serverConfig?.configured === false ? "Missing secret" : "Unavailable"}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">The API key is kept server-side and is never included in browser requests or diagnostic output.</p>
        <div className="mt-3 flex items-start gap-2">
          {connected ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <CircleAlert className={`mt-0.5 size-4 shrink-0 ${failed || missingSecret ? "text-destructive" : "text-muted-foreground"}`} />}
          <p className="min-w-0 break-words text-sm leading-relaxed">{connected ? "Connected to the NodeX event stream and receiving live events." : missingSecret ? "NODEX_ENGINE_API_KEY is missing from the frontend Render environment or does not match the engine configuration." : checkingConfig ? "Checking server-side secret configuration and engine response…" : status.message ?? "Waiting for the event stream connection to be established."}</p>
        </div>
        {serverConfig && <div className="mt-3 space-y-1 border-l-2 border-border pl-3">
          <p className="text-xs font-semibold">Connection test: <span className={serverConfig.status === "connected" ? "text-emerald-500" : "text-destructive"}>{serverConfig.status.replaceAll("_", " ")}</span></p>
          <p className="break-words text-xs leading-relaxed text-muted-foreground">{serverConfig.detail}</p>
          <p className="text-[10px] tabular-nums text-muted-foreground">HTTP {serverConfig.statusCode ?? "—"} · {serverConfig.contentType ?? "no content type"} · {serverConfig.durationMs} ms · {new Date(serverConfig.checkedAt).toLocaleTimeString()}</p>
        </div>}
      </div>

      {(!connected || missingSecret) && <div className="space-y-2 border-b border-border/70 pb-4">
        <h3 className="text-sm font-semibold">How to connect</h3>
        <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>Open the frontend service and NodeX engine service in Render.</li>
          <li>In Settings → Secrets, set <code className="break-all rounded bg-secondary px-1 py-0.5 font-mono text-foreground">NODEX_ENGINE_API_KEY</code> in the frontend Render environment.</li>
          <li>If using Render environment variables, set the same <code className="break-all rounded bg-secondary px-1 py-0.5 font-mono text-foreground">NODEX_ENGINE_API_KEY</code> value on both Render services.</li>
          <li>Retry the connection test below after saving the environment variables.</li>
        </ol>
      </div>}

      <div className="flex flex-wrap gap-2">
        <Button className="h-9 flex-1 basis-40" variant="secondary" onClick={() => void runConnectionTest()} disabled={checkingConfig}><RadioTower className="mr-2 size-4" />{checkingConfig ? "Testing…" : "Test connection"}</Button>
        <Button className="h-9 flex-1 basis-40" variant="outline" onClick={reconnectEventStream} disabled={checkingConfig}><RefreshCw className="mr-2 size-4" />Reconnect stream</Button>
        <Button className="h-9 flex-1 basis-40" variant="outline" asChild><Link to="/engine-logs">View request logs</Link></Button>
      </div>
    </section>

    <section className="border-t border-border/70 pt-4">
      <h2 className="font-semibold">What this connection does</h2>
      <ul className="mt-2 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <li className="flex gap-2"><span className="text-primary">•</span><span>Receives per-chain balance results and failures as separate live events.</span></li>
        <li className="flex gap-2"><span className="text-primary">•</span><span>Updates a chain's wallet balance as soon as its result arrives.</span></li>
        <li className="flex gap-2"><span className="text-primary">•</span><span>Reports connection and authentication failures without displaying the secret.</span></li>
        <li className="flex gap-2"><span className="text-primary">•</span><span>Does not configure RPC provider keys, create balances, or replace the engine's normal request API.</span></li>
      </ul>
    </section>
  </div>;
}
