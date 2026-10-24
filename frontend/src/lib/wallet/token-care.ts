export type TokenCarePayload = {
  service: "token" | "security";
  action: string;
  params?: Record<string, unknown>;
  assets?: Array<
    | { type: "token"; blockchain: string; address: string; name?: string; symbol?: string }
    | { type: "blockchain"; blockchain: string; name: string; symbol: string; chain_id: string }
  >;
  [key: string]: unknown;
};

export type TokenCareEnvelope<T = Record<string, unknown>> = {
  success: boolean;
  service?: string;
  action?: string;
  request_id?: string;
  data?: T;
  code?: string;
  message?: string;
};

const TOKEN_CARE_KEY_STORAGE = "nodex.tokencare.api-key";

/** The key is stored only in this browser and is never written into app logs. */
export function getTokenCareApiKey(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(TOKEN_CARE_KEY_STORAGE) ?? ""; }
  catch { return ""; }
}

export function saveTokenCareApiKey(value: string): void {
  if (typeof window === "undefined") throw new Error("API key settings are only available in the browser.");
  const key = value.trim();
  if (!key) throw new Error("Paste your TokenCare API key first.");
  window.localStorage.setItem(TOKEN_CARE_KEY_STORAGE, key);
}

export function clearTokenCareApiKey(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(TOKEN_CARE_KEY_STORAGE); } catch { /* Ignore unavailable storage. */ }
}

export async function tokenCareRequest<T = Record<string, unknown>>(
  payload: TokenCarePayload,
): Promise<TokenCareEnvelope<T>> {
  let response: Response;
  try {
    const apiKey = getTokenCareApiKey();
    response = await fetch("/api/token-care", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { "x-token-care-api-key": apiKey } : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    throw new Error("Could not reach the TokenCare API proxy on the frontend server.");
  }

  let body: TokenCareEnvelope<T>;
  try {
    body = await response.json() as TokenCareEnvelope<T>;
  } catch {
    throw new Error(`TokenCare returned a non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok || body.success !== true) {
    const error = new Error(body.message ?? body.code ?? `TokenCare request failed (HTTP ${response.status}).`) as Error & { response?: unknown; status?: number };
    error.response = body;
    error.status = response.status;
    throw error;
  }
  return body;
}
