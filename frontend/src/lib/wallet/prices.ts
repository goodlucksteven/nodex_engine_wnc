import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { FALLBACK_PRICES, type AssetId } from "@/lib/wallet/assets";
import { useWallet, type EngineBalance } from "@/lib/wallet/store";
import { tokenCareRequest } from "@/lib/wallet/token-care";
import { hydrateTokenRegistry, useTokenRegistry, walletTokenRegistryScope } from "@/lib/wallet/token-registry";

export type PricePoint = { usd: number; usd_24h_change: number };
type RequestedAsset = {
  blockchain: string;
  chainKey?: string;
  address?: string;
  symbol: string;
  kind: "token" | "native";
  request:
    | { type: "token"; blockchain: string; address: string; name?: string; symbol?: string }
    | { type: "blockchain"; name: string; symbol: string; chain_id: string };
};
type PriceState = {
  prices: Record<AssetId, PricePoint>;
  tokenPrices: Record<string, PricePoint>;
  nativePrices: Record<string, PricePoint>;
  updatedAt: number;
  status: "idle" | "partial" | "fallback";
  refresh: (logRequest?: boolean) => Promise<void>;
};

type TokenPriceResult = {
  index?: number;
  success?: boolean;
  data?: {
    price_usd?: number | string;
    price_change_24h_pct?: number | string;
    price_change_24h?: number | string;
    price_change_24h_percentage?: number | string;
  };
};

const SYMBOL_ASSET: Record<string, AssetId> = {
  ETH: "ethereum", WETH: "ethereum", BTC: "bitcoin", WBTC: "bitcoin",
  USDC: "usd-coin", SOL: "solana", WSOL: "solana", LINK: "chainlink", UNI: "uniswap",
};

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function numericChange(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : 0;
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function getTokenCareBlockchain(balance: Partial<EngineBalance> | Record<string, unknown>): string {
  const name = normalized(balance.chain_name ?? balance.name ?? balance.chain_key ?? balance.chain_type);
  const type = normalized(balance.chain_type);
  const id = normalized(balance.chain_id);
  const combined = `${name} ${type}`;
  if (/\btron\b|\btrx\b/.test(combined) || name.includes("tron-mainnet")) return "tron";
  if (/\bsolana\b|\bsol\b/.test(combined)) return "solana";
  if (/\bbitcoin\b|\bbtc\b/.test(combined)) return "bitcoin";
  if (name.includes("base") || id === "8453") return "base";
  if (name.includes("binance") || name.includes("bsc") || id === "56") return "bsc";
  if (name.includes("polygon") || id === "137") return "polygon";
  if (name.includes("arbitrum") || id === "42161") return "arbitrum";
  if (name.includes("optimism") || id === "10") return "optimism";
  if (name.includes("avalanche") || name.includes("avalanche c") || id === "43114") return "avalanche";
  if (name.includes("ethereum") || /\beth\b/.test(combined) || id === "1") return "ethereum";
  return name.replace(/\b(mainnet|testnet)\b/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Resolve the chain-level identity used by TokenCare and the price cache.
 * TRC-10 assets expose a numeric token_id instead of a contract address;
 * those tokens are still visible in Overview and must be sent for pricing.
 */
export function getTokenPriceIdentity(
  token: {
    address?: unknown;
    contract_address?: unknown;
    contractAddress?: unknown;
    token_id?: unknown;
    tokenId?: unknown;
  },
  blockchain: string,
): string {
  const address = [token.address, token.contract_address, token.contractAddress].map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
  if (blockchain === "tron") {
    // The TRON engine represents TRC-10 assets as address: "trc10:<id>".
    // TokenCare expects the numeric token ID, not that frontend storage prefix.
    const prefixedId = address.match(/^trc10:([0-9]+)$/i)?.[1];
    if (prefixedId) return prefixedId;
    const tokenId = String(token.token_id ?? token.tokenId ?? "").trim();
    if (/^[0-9]+$/.test(tokenId)) return tokenId;
  }
  if (address) return address;
  return "";
}

export function tokenPriceKey(blockchain: string, address: string, chainType?: string): string {
  const normalizedAddress = chainType?.toLowerCase() === "evm" || blockchain !== "tron" && /^0x/i.test(address)
    ? address.trim().toLowerCase()
    : address.trim();
  return `${blockchain.toLowerCase()}:${normalizedAddress}`;
}

export function nativePriceKey(blockchain: string, symbol: string): string {
  return `${blockchain.toLowerCase()}:native:${symbol.trim().toLowerCase()}`;
}

function isPriceableTokenIdentity(address: string, blockchain: string): boolean {
  const identity = address.trim();
  if (!identity || /^(native|native:|unknown|undefined|null)$/i.test(identity)) return false;
  if (blockchain === "ethereum" || blockchain === "base" || blockchain === "bsc"
      || blockchain === "polygon" || blockchain === "arbitrum" || blockchain === "optimism"
      || blockchain === "avalanche") return /^0x[0-9a-f]{40}$/i.test(identity);
  if (blockchain === "tron") {
    // TRON wallets can contain both TRC-20 contract addresses and TRC-10
    // assets, whose identity is a numeric token ID rather than a contract.
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(identity)
      || /^41[0-9a-f]{40}$/i.test(identity)
      || /^[0-9]+$/.test(identity);
  }
  if (blockchain === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(identity);
  return identity.length > 8;
}

function buildRequestedAssets(
  balances: EngineBalance[],
  configuredChains: Array<Record<string, unknown>> = [],
): RequestedAsset[] {
  const assets: RequestedAsset[] = [];
  const seen = new Set<string>();

  for (const balance of balances) {
    const blockchain = getTokenCareBlockchain(balance);
    if (!blockchain) continue;

    // Request each native coin as a blockchain asset rather than as a wrapped
    // token. TRX uses the exact native identifiers verified against TokenCare.
    const native = balance.native;
    const nativeSymbol = String(native?.symbol ?? "").trim();
    if (nativeSymbol) {
      const nativeName = blockchain === "tron" && nativeSymbol.toUpperCase() === "TRX"
        ? "TRON"
        : String(native?.name ?? balance.chain_name ?? balance.name ?? "").trim();
      const chainId = blockchain === "tron"
        ? "tron"
        : String(balance.chain_id ?? blockchain).trim();
      if (nativeName && chainId) {
        const key = `native:${nativePriceKey(blockchain, nativeSymbol)}`;
        if (!seen.has(key)) {
          seen.add(key);
          assets.push({
            blockchain,
            symbol: nativeSymbol,
            kind: "native",
            request: {
              type: "blockchain",
              name: nativeName,
              symbol: nativeSymbol,
              chain_id: chainId,
            },
          });
        }
      }
    }

    // Contract tokens are sent using their chain and contract address only.
    // TokenCare is responsible for resolving name and symbol from the contract.
    for (const token of balance.tokens ?? []) {
      if (token.is_native === true) continue;
      const address = getTokenPriceIdentity(token, blockchain);
      if (!isPriceableTokenIdentity(address, blockchain)) continue;
      const key = tokenPriceKey(blockchain, address, balance.chain_type);
      if (seen.has(key)) continue;
      seen.add(key);
      const tokenName = String(token.name ?? "").trim();
      const tokenSymbol = String(token.symbol ?? "").trim();
      // Send identity metadata only when both fields are actually known.
      // If metadata is missing, keep the request address-only so the backend
      // can attempt its own address-to-token resolution.
      assets.push({
        blockchain,
        chainKey: String(balance.chain_key ?? ""),
        address,
        symbol: tokenSymbol,
        kind: "token",
        request: {
          type: "token",
          blockchain,
          address,
          ...(tokenName && tokenSymbol ? { name: tokenName, symbol: tokenSymbol } : {}),
        },
      });
    }
  }

  // Native pricing must not depend on token discovery or even on a returned
  // balance row. Use the wallet's configured chain catalog to request each
  // selected chain's native coin when the balance endpoint omits native data.
  for (const chain of configuredChains) {
    const blockchain = getTokenCareBlockchain(chain);
    const nativeSymbol = String(chain.symbol ?? "").trim();
    const nativeName = blockchain === "tron" && nativeSymbol.toUpperCase() === "TRX"
      ? "TRON"
      : String(chain.name ?? chain.chain_name ?? "").trim();
    const chainId = blockchain === "tron"
      ? "tron"
      : String(chain.chain_id ?? blockchain).trim();
    if (!blockchain || !nativeSymbol || !nativeName || !chainId) continue;
    const key = `native:${nativePriceKey(blockchain, nativeSymbol)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assets.push({
      blockchain,
      symbol: nativeSymbol,
      kind: "native",
      request: {
        type: "blockchain",
        name: nativeName,
        symbol: nativeSymbol,
        chain_id: chainId,
      },
    });
  }

  return assets;
}

const priceStorage: StateStorage = {
  getItem: (name) => typeof window === "undefined" ? null : window.localStorage.getItem(name),
  setItem: (name, value) => { if (typeof window !== "undefined") window.localStorage.setItem(name, value); },
  removeItem: (name) => { if (typeof window !== "undefined") window.localStorage.removeItem(name); },
};

export const usePrices = create<PriceState>()(persist((set, get) => ({
  prices: FALLBACK_PRICES,
  tokenPrices: {},
  nativePrices: {},
  updatedAt: 0,
  status: "idle",
  refresh: async (logRequest = false) => {
    const started = Date.now();
    const walletState = useWallet.getState();
    await hydrateTokenRegistry();
    const registryScope = walletState.wallet
      ? walletTokenRegistryScope(walletState.wallet.engineWalletId, walletState.wallet.childId)
      : "";
    const registryBalances = registryScope ? useTokenRegistry.getState().getBalances(registryScope) : [];
    // Registry hydration can lag behind the currently displayed Zustand balances.
    // Price every asset from both sources; buildRequestedAssets deduplicates by
    // chain + native symbol or token identity, so a partial registry cannot hide
    // contracts and TRC-10 IDs already present in the wallet overview.
    const sourceBalances = [...registryBalances, ...walletState.balances];
    const requestedAssets = buildRequestedAssets(sourceBalances, walletState.wallet?.chainAddresses ?? []);
    if (requestedAssets.length === 0) {
      if (logRequest) {
        const { logExternalRequest } = await import("@/lib/wallet/engine");
        logExternalRequest(
          "tokencare.token.price",
          { service: "token", action: "price", assets: [] },
          false,
          Date.now() - started,
          undefined,
          "No displayed token contract addresses are available yet. Refresh wallet balances first.",
        );
      }
      if (get().status === "idle") set({ status: "fallback", updatedAt: Date.now() });
      return;
    }

    const allResults: Array<{ asset: RequestedAsset; result: TokenPriceResult }> = [];
    for (let offset = 0; offset < requestedAssets.length; offset += 200) {
      const chunk = requestedAssets.slice(offset, offset + 200);
      const request = {
        service: "token" as const,
        action: "price" as const,
        assets: chunk.map(({ request: assetRequest }) => assetRequest),
      };
      try {
        const response = await tokenCareRequest<{ batch?: boolean; results?: TokenPriceResult[] }>(request);
        const results = Array.isArray(response.data?.results) ? response.data.results : [];
        for (const result of results) {
          if (!Number.isInteger(result.index)) continue;
          const asset = chunk[result.index as number];
          if (asset) allResults.push({ asset, result });
        }
        if (logRequest) {
          const { logExternalRequest } = await import("@/lib/wallet/engine");
          logExternalRequest("tokencare.token.price", request, true, Date.now() - started, response);
        }
      } catch (error) {
        if (logRequest) {
          const { logExternalRequest } = await import("@/lib/wallet/engine");
          logExternalRequest(
            "tokencare.token.price",
            request,
            false,
            Date.now() - started,
            error && typeof error === "object" && "response" in error
              ? (error as { response?: unknown }).response
              : undefined,
            error instanceof Error ? error.message : "Unknown TokenCare price request error",
          );
        }
      }
    }

    const nextPrices = { ...get().prices };
    const nextTokenPrices = { ...get().tokenPrices };
    const nextNativePrices = { ...get().nativePrices };
    let updated = 0;
    for (const { asset, result } of allResults) {
      if (result.success !== true || !result.data) continue;
      const price = numeric(result.data.price_usd);
      if (price === undefined) continue;
      const point = {
        usd: price,
        usd_24h_change: numericChange(
          result.data.price_change_24h_pct
          ?? result.data.price_change_24h
          ?? result.data.price_change_24h_percentage,
        ),
      };
      if (asset.kind === "native") {
        nextNativePrices[nativePriceKey(asset.blockchain, asset.symbol)] = point;
      } else {
        if (asset.address) {
          nextTokenPrices[tokenPriceKey(asset.blockchain, asset.address)] = point;
          if (registryScope && asset.chainKey) {
            useTokenRegistry.getState().setAssetPrice(registryScope, asset.chainKey, asset.address, {
              price_usd: point.usd,
              price_change_24h_percentage: point.usd_24h_change,
            });
          }
        }
      }
      const assetId = SYMBOL_ASSET[asset.symbol.toUpperCase()];
      if (assetId) nextPrices[assetId] = point;
      updated += 1;
    }

    if (updated > 0) {
      set({
        prices: nextPrices,
        tokenPrices: nextTokenPrices,
        nativePrices: nextNativePrices,
        updatedAt: Date.now(),
        status: "partial",
      });
    } else if (get().status === "idle") {
      set({ status: "fallback", updatedAt: Date.now() });
    }
  },
}), {
  name: "nodex-wallet-prices-v1",
  storage: createJSONStorage(() => priceStorage),
  partialize: (state) => ({
    prices: state.prices,
    tokenPrices: state.tokenPrices,
    nativePrices: state.nativePrices,
    updatedAt: state.updatedAt,
    status: state.status,
  }),
}));

export function sparklinePath(
  seed: string,
  end: number,
  changePct: number,
  points = 24,
) {
  const start = end / (1 + changePct / 100);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const values: number[] = [];
  for (let i = 0; i < points; i++) {
    hash = (hash * 1664525 + 1013904223) | 0;
    const t = i / (points - 1);
    const drift = start + (end - start) * t;
    const noise = ((hash % 1000) / 1000 - 0.5) * (end * 0.018);
    values.push(Math.max(0, drift + noise));
  }
  values[values.length - 1] = end;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = values.map((v, i) => {
    const x = (i / (points - 1)) * 100;
    const y = 32 - ((v - min) / span) * 28 - 2;
    return [x, y] as const;
  });
  return coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
}
