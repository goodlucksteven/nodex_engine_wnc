import { getTokenCareBlockchain, getTokenPriceIdentity, tokenPriceKey, nativePriceKey } from "@/lib/wallet/prices";
import { useWallet, type EngineBalance } from "@/lib/wallet/store";
import { tokenCareRequest } from "@/lib/wallet/token-care";
import { hydrateTokenRegistry, useTokenRegistry, walletTokenRegistryScope } from "@/lib/wallet/token-registry";
import { logExternalRequest } from "@/lib/wallet/engine";

type LogoRequestAsset =
  | { type: "token"; blockchain: string; address: string; name?: string; symbol?: string }
  | { type: "blockchain"; blockchain: string; name: string; symbol: string; chain_id: string };

type LogoWorkItem = {
  key: string;
  kind: "token" | "native";
  blockchain: string;
  address?: string;
  symbol?: string;
  chainKey?: string;
  request: LogoRequestAsset;
};

type LogoBatchResult = {
  index?: number;
  success?: boolean;
  error?: string;
  data?: { logo_url?: string | null; blockchain?: string; address?: string; symbol?: string; type?: string };
};

const BATCH_SIZE = 200;
const RETRY_AFTER_MS = 15 * 60 * 1000;
const inFlight = new Set<string>();
const attemptedAt = new Map<string, number>();

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function usableUrl(value: unknown): string | undefined {
  const url = clean(value);
  return /^https?:\/\//i.test(url) ? url : undefined;
}

function tokenAddress(token: NonNullable<EngineBalance["tokens"]>[number], blockchain: string): string {
  return getTokenPriceIdentity(token, blockchain);
}

function nativeKey(blockchain: string, symbol: string): string {
  return `native:${nativePriceKey(blockchain, symbol)}`;
}

function nativeDetails(chain: Record<string, unknown>, blockchain: string) {
  const symbol = clean(chain.symbol ?? chain.native_symbol ?? chain.nativeSymbol);
  const name = blockchain === "tron" && symbol.toUpperCase() === "TRX"
    ? "TRON"
    : clean(chain.name ?? chain.chain_name ?? chain.native_name ?? chain.nativeName);
  const chainId = blockchain === "tron" ? "tron" : clean(chain.chain_id ?? blockchain);
  return { symbol, name, chainId };
}

function collectMissingLogos(balances: EngineBalance[], chains: Array<Record<string, unknown>>): LogoWorkItem[] {
  const work: LogoWorkItem[] = [];
  const seen = new Set<string>();
  const existingLogoKeys = new Set<string>();
  const now = Date.now();

  // Scan all current sources first so an older registry record cannot cause
  // a needless fetch when the live wallet balance already has a logo URL.
  for (const balance of balances) {
    const blockchain = getTokenCareBlockchain(balance);
    if (!blockchain) continue;
    if (usableUrl(balance.native?.logo_url) && clean(balance.native?.symbol)) {
      existingLogoKeys.add(nativeKey(blockchain, clean(balance.native?.symbol)));
    }
    for (const token of balance.tokens ?? []) {
      if (!usableUrl(token.logo_url)) continue;
      const address = tokenAddress(token, blockchain);
      if (address) existingLogoKeys.add(`token:${tokenPriceKey(blockchain, address, balance.chain_type)}`);
    }
  }
  for (const chain of chains) {
    const blockchain = getTokenCareBlockchain(chain);
    const symbol = clean(chain.symbol ?? chain.native_symbol ?? chain.nativeSymbol);
    if (blockchain && symbol && usableUrl(chain.logo_url)) {
      existingLogoKeys.add(nativeKey(blockchain, symbol));
    }
  }

  const add = (item: LogoWorkItem) => {
    if (existingLogoKeys.has(item.key) || seen.has(item.key) || inFlight.has(item.key)) return;
    if (now - (attemptedAt.get(item.key) ?? 0) < RETRY_AFTER_MS) return;
    seen.add(item.key);
    work.push(item);
  };

  for (const balance of balances) {
    const blockchain = getTokenCareBlockchain(balance);
    if (!blockchain) continue;
    const chainKey = clean(balance.chain_key);
    const native = balance.native;
    const symbol = clean(native?.symbol);
    if (symbol && !usableUrl(native?.logo_url)) {
      const details = nativeDetails({
        name: native?.name ?? balance.chain_name ?? balance.name,
        chain_name: balance.chain_name,
        chain_id: balance.chain_id,
        symbol,
      }, blockchain);
      if (details.name && details.chainId) {
        const key = nativeKey(blockchain, symbol);
        add({
          key, kind: "native", blockchain, symbol, chainKey,
          request: { type: "blockchain", blockchain, name: details.name, symbol, chain_id: details.chainId },
        });
      }
    }

    for (const token of balance.tokens ?? []) {
      if (token.is_native === true || usableUrl(token.logo_url)) continue;
      const address = tokenAddress(token, blockchain);
      if (!address) continue;
      const key = `token:${tokenPriceKey(blockchain, address, balance.chain_type)}`;
      add({
        key, kind: "token", blockchain, address, chainKey,
        request: {
          type: "token", blockchain, address,
          ...(clean(token.name) ? { name: clean(token.name) } : {}),
          ...(clean(token.symbol) ? { symbol: clean(token.symbol) } : {}),
        },
      });
    }
  }

  // Also request the selected chain's native logo if the engine has not yet
  // returned a balance row for that chain.
  for (const chain of chains) {
    const blockchain = getTokenCareBlockchain(chain);
    if (!blockchain) continue;
    const details = nativeDetails(chain, blockchain);
    if (!details.symbol || !details.name || !details.chainId || usableUrl(chain.logo_url)) continue;
    const key = nativeKey(blockchain, details.symbol);
    add({
      key, kind: "native", blockchain, symbol: details.symbol,
      request: { type: "blockchain", blockchain, name: details.name, symbol: details.symbol, chain_id: details.chainId },
    });
  }

  return work;
}

function applyLogoUrls(items: Array<{ item: LogoWorkItem; url: string }>) {
  if (!items.length) return;
  const tokenUrls = new Map<string, string>();
  const nativeUrls = new Map<string, string>();
  for (const { item, url } of items) {
    if (item.kind === "native" && item.symbol) nativeUrls.set(nativeKey(item.blockchain, item.symbol), url);
    else if (item.address) tokenUrls.set(item.key, url);
  }

  useWallet.setState((state) => {
    const balances = state.balances.map((balance) => {
      const blockchain = getTokenCareBlockchain(balance);
      const symbol = clean(balance.native?.symbol);
      const nativeUrl = symbol ? nativeUrls.get(nativeKey(blockchain, symbol)) : undefined;
      const tokens = (balance.tokens ?? []).map((token) => {
        const address = tokenAddress(token, blockchain);
        if (!address) return token;
        const url = tokenUrls.get(`token:${tokenPriceKey(blockchain, address, balance.chain_type)}`);
        return url && !usableUrl(token.logo_url) ? { ...token, logo_url: url } : token;
      });
      return {
        ...balance,
        ...(nativeUrl && !usableUrl(balance.native?.logo_url) ? { native: { ...balance.native, logo_url: nativeUrl } } : {}),
        tokens,
      };
    });

    const chainAddresses = (state.wallet?.chainAddresses ?? []).map((chain) => {
      const blockchain = getTokenCareBlockchain(chain);
      const details = nativeDetails(chain, blockchain);
      const url = details.symbol ? nativeUrls.get(nativeKey(blockchain, details.symbol)) : undefined;
      return url && !usableUrl(chain.logo_url) ? { ...chain, logo_url: url } : chain;
    });

    return {
      balances,
      ...(state.wallet ? { wallet: { ...state.wallet, chainAddresses } } : {}),
    };
  });

  const wallet = useWallet.getState().wallet;
  if (!wallet) return;
  const scope = walletTokenRegistryScope(wallet.engineWalletId, wallet.childId);
  useTokenRegistry.setState((state) => {
    const groups = { ...state.groups };
    for (const [key, group] of Object.entries(groups)) {
      if (group.walletScope !== scope) continue;
      const blockchain = getTokenCareBlockchain({
        chain_id: group.chain_id,
        chain_type: group.chain_type,
        chain_name: group.chain_name,
        chain_key: group.chain_key,
      });
      const symbol = clean(group.native?.symbol);
      const nativeUrl = symbol ? nativeUrls.get(nativeKey(blockchain, symbol)) : undefined;
      const tokens = (group.tokens ?? []).map((token) => {
        const address = tokenAddress(token, blockchain);
        if (!address) return token;
        const url = tokenUrls.get(`token:${tokenPriceKey(blockchain, address, group.chain_type)}`);
        return url && !usableUrl(token.logo_url) ? { ...token, logo_url: url } : token;
      });
      groups[key] = {
        ...group,
        ...(nativeUrl && !usableUrl(group.native?.logo_url) ? { native: { ...group.native, logo_url: nativeUrl } } : {}),
        tokens,
        updatedAt: Date.now(),
      };
    }
    return { groups };
  });
}

/**
 * Background-only logo hydration. Requests are deduplicated, sent in the
 * backend's 50-item assets batch format, and successful URLs are persisted.
 */
export async function refreshMissingTokenLogos(): Promise<void> {
  await hydrateTokenRegistry();
  const walletState = useWallet.getState();
  const wallet = walletState.wallet;
  const scope = wallet ? walletTokenRegistryScope(wallet.engineWalletId, wallet.childId) : "";
  const registryBalances = scope ? useTokenRegistry.getState().getBalances(scope) : [];
  const work = collectMissingLogos(
    [...registryBalances, ...walletState.balances],
    wallet?.chainAddresses ?? [],
  );
  if (!work.length) return;

  for (let offset = 0; offset < work.length; offset += BATCH_SIZE) {
    const chunk = work.slice(offset, offset + BATCH_SIZE);
    chunk.forEach((item) => {
      inFlight.add(item.key);
      attemptedAt.set(item.key, Date.now());
    });
    const payload = {
      service: "token" as const,
      action: "logo" as const,
      assets: chunk.map((item) => item.request),
    };
    const started = Date.now();
    try {
      const response = await tokenCareRequest<{ batch?: boolean; results?: LogoBatchResult[] }>(payload);
      const results = Array.isArray(response.data?.results) ? response.data.results : [];
      const successful: Array<{ item: LogoWorkItem; url: string }> = [];
      for (const result of results) {
        if (!Number.isInteger(result.index)) continue;
        const item = chunk[result.index as number];
        const url = usableUrl(result.data?.logo_url);
        if (!item || result.success !== true || !url) continue;
        successful.push({ item, url });
      }
      applyLogoUrls(successful);
      logExternalRequest("tokencare.token.logo", payload, true, Date.now() - started, response);
    } catch (error) {
      logExternalRequest(
        "tokencare.token.logo",
        payload,
        false,
        Date.now() - started,
        error && typeof error === "object" && "response" in error
          ? (error as { response?: unknown }).response
          : undefined,
        error instanceof Error ? error.message : "Unknown TokenCare logo batch error",
      );
      // Permit a retry after a transient request-level failure.
      chunk.forEach((item) => attemptedAt.delete(item.key));
    } finally {
      chunk.forEach((item) => inFlight.delete(item.key));
    }
  }
}
