import { getEngineBaseUrl } from "@/lib/wallet/engine";

export type EngineStreamEvent = {
  event_id: number;
  event_type: string;
  timestamp_ms: number;
  request_id?: string | null;
  wallet_id?: string | null;
  child_id?: string | null;
  chain_id?: string | null;
  data: Record<string, unknown>;
};

export type EngineStreamStatus = "connected" | "connecting" | "disconnected" | "error";
const LOG_KEY = "nodex-live-events";
const LOG_LIMIT = 300;
let memoryEvents: EngineStreamEvent[] | null = null;
const STATUS_KEY = "nodex-event-stream-status";
export function reconnectEventStream(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("nodex-event-stream-reconnect"));
}

export function getEventStreamStatus(): { status: EngineStreamStatus; message?: string } {
  if (typeof window === "undefined") return { status: "disconnected" };
  try {
    const raw = window.sessionStorage.getItem(STATUS_KEY);
    return raw ? JSON.parse(raw) as { status: EngineStreamStatus; message?: string } : { status: "disconnected" };
  } catch { return { status: "disconnected" }; }
}

export function readLiveEvents(): EngineStreamEvent[] {
  if (typeof window === "undefined") return [];
  if (memoryEvents !== null) return memoryEvents;
  try {
    const raw = window.sessionStorage.getItem(LOG_KEY);
    memoryEvents = raw ? JSON.parse(raw) as EngineStreamEvent[] : [];
  } catch { memoryEvents = []; }
  return memoryEvents;
}

function compactEventForStorage(event: EngineStreamEvent): EngineStreamEvent {
  if (event.event_type !== "balance.result") return event;
  const balance = event.data?.balance;
  if (!balance || typeof balance !== "object" || Array.isArray(balance)) return event;
  const record = balance as Record<string, unknown>;
  const tokens = Array.isArray(record.tokens) ? record.tokens : [];
  if (tokens.length <= 5) return event;
  return { ...event, data: { ...event.data, balance: { ...record, token_count: tokens.length, tokens_truncated_for_storage: true, tokens: tokens.slice(0, 5) } } };
}

function publishStatus(status: EngineStreamStatus, message?: string) {
  if (typeof window !== "undefined") {
    try { window.sessionStorage.setItem(STATUS_KEY, JSON.stringify({ status, message })); } catch { /* optional status cache */ }
    window.dispatchEvent(new CustomEvent("nodex-event-stream-status", { detail: { status, message } }));
  }
}

function publishEvent(event: EngineStreamEvent, onEvent: (event: EngineStreamEvent) => void) {
  if (typeof window !== "undefined") {
    memoryEvents = [event, ...readLiveEvents()].slice(0, LOG_LIMIT);
    try { window.sessionStorage.setItem(LOG_KEY, JSON.stringify(memoryEvents)); }
    catch {
      try { window.sessionStorage.setItem(LOG_KEY, JSON.stringify(memoryEvents.map(compactEventForStorage).slice(0, 100))); }
      catch { /* storage is optional; keep the in-memory log */ }
    }
    window.dispatchEvent(new CustomEvent("nodex-engine-event-log", { detail: memoryEvents }));
  }
  onEvent(event);
}

/** Fetch-based SSE reader through the frontend proxy; the server attaches the shared API key. */
export function connectEngineEventStream(
  onEvent: (event: EngineStreamEvent) => void,
  onStatus?: (status: EngineStreamStatus, message?: string) => void,
): () => void {
  // Preserve one canonical configured engine address; no fallback is attempted.
  void getEngineBaseUrl();
  const controller = new AbortController();
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const status = (value: EngineStreamStatus, message?: string) => {
    publishStatus(value, message);
    onStatus?.(value, message);
  };
  const run = async () => {
    let delay = 1000;
    while (!stopped) {
      try {
        status("connecting");
        const headers = new Headers({ accept: "text/event-stream" });
        const response = await fetch("/api/nodex-events", { headers, signal: controller.signal, cache: "no-store" });
        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          if (response.status === 401 || response.status === 503) throw new Error(detail.trim() || "The server-side stream secret is missing or rejected. Check Render Environment settings.");
          throw new Error(`Event stream connection failed (HTTP ${response.status}).`);
        }
        status("connected");
        delay = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let data = "";
            for (const line of frame.split("\n")) if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
            if (data) {
              try {
                const event = JSON.parse(data) as EngineStreamEvent;
                if (event && typeof event.event_type === "string" && event.data) publishEvent(event, onEvent);
              } catch { /* ignore malformed frames, keep the stream alive */ }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
        if (!stopped) throw new Error("The event stream closed. Reconnecting…");
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        status("error", error instanceof Error ? error.message : "Event stream connection failed.");
        await new Promise<void>((resolve) => { retryTimer = setTimeout(resolve, delay); });
        delay = Math.min(delay * 2, 15000);
      }
    }
  };
  void run();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    controller.abort();
    status("disconnected");
  };
}
