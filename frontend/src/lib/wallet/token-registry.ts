import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { EngineBalance } from "@/lib/wallet/store";

export const TOKEN_REGISTRY_VERSION = 1;

export function walletTokenRegistryScope(engineWalletId: string, childId: string): string {
  return `${engineWalletId}::${childId}`;
}

export type TokenRegistryGroup = {
  key: string;
  walletScope: string;
  chain_id: string;
  chain_type: string;
  chain_name: string;
  chain_key: string;
  address?: string;
  native: EngineBalance["native"];
  tokens: NonNullable<EngineBalance["tokens"]>;
  updatedAt: number;
};

type RegistryState = {
  version: number;
  groups: Record<string, TokenRegistryGroup>;
  upsertBalances: (walletScope: string, balances: EngineBalance[]) => void;
  setAssetPrice: (walletScope: string, chainKey: string, identity: string, price: {
    price_usd: number;
    price_change_24h_percentage: number;
  }) => void;
  getBalances: (walletScope: string) => EngineBalance[];
  clearWallet: (walletScope: string) => void;
};

const memory = new Map<string, string>();
let databasePromise: Promise<IDBDatabase | null> | undefined;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!databasePromise) {
    databasePromise = new Promise((resolve) => {
      const request = indexedDB.open("nodex-token-registry", TOKEN_REGISTRY_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return databasePromise;
}

const indexedDbStorage: StateStorage = {
  async getItem(name) {
    const db = await openDatabase();
    if (!db) return memory.get(name) ?? null;
    return new Promise((resolve) => {
      const request = db.transaction("state", "readonly").objectStore("state").get(name);
      request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : memory.get(name) ?? null);
      request.onerror = () => resolve(memory.get(name) ?? null);
    });
  },
  async setItem(name, value) {
    memory.set(name, value);
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const transaction = db.transaction("state", "readwrite");
      transaction.objectStore("state").put(value, name);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  },
  async removeItem(name) {
    memory.delete(name);
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const transaction = db.transaction("state", "readwrite");
      transaction.objectStore("state").delete(name);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  },
};

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();
function tokenIdentity(token: NonNullable<EngineBalance["tokens"]>[number], chainType: string): string {
  const address = [token.address, token.contract_address, token.contractAddress].map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
  if (address) return `contract:${norm(chainType) === "evm" ? address.toLowerCase() : address}`;
  const tokenId = String(token.token_id ?? token.tokenId ?? "").trim();
  if (tokenId) return `token-id:${tokenId}`;
  return `metadata:${norm(token.name)}|${norm(token.symbol)}|${String(token.decimals ?? "")}`;
}

function mergeTokens(
  previous: NonNullable<EngineBalance["tokens"]>,
  incoming: NonNullable<EngineBalance["tokens"]>,
  chainType: string,
) {
  const merged = new Map<string, NonNullable<EngineBalance["tokens"]>[number]>();
  const incomingKeys = new Set(incoming.map((token) => tokenIdentity(token, chainType)));
  for (const token of previous) {
    const key = tokenIdentity(token, chainType);
    merged.set(key, incomingKeys.has(key) ? token : { ...token, balance: "0", is_stale: true });
  }
  for (const token of incoming) {
    const key = tokenIdentity(token, chainType);
    const old = merged.get(key);
    // Keep last-known metadata when an engine refresh omits optional fields.
    merged.set(key, { ...old, ...token, is_stale: false,
      name: token.name ?? old?.name,
      symbol: token.symbol ?? old?.symbol,
      address: token.address ?? old?.address,
      contract_address: token.contract_address ?? old?.contract_address,
      contractAddress: token.contractAddress ?? old?.contractAddress,
      token_id: token.token_id ?? old?.token_id,
      tokenId: token.tokenId ?? old?.tokenId,
      logo_url: token.logo_url ?? old?.logo_url,
      decimals: token.decimals ?? old?.decimals,
    });
  }
  return [...merged.values()];
}

export const useTokenRegistry = create<RegistryState>()(persist((set, get) => ({
  version: TOKEN_REGISTRY_VERSION,
  groups: {},
  upsertBalances: (walletScope, balances) => set((state) => {
    const groups = { ...state.groups };
    const now = Date.now();
    for (const balance of balances) {
      const chainKey = String(balance.chain_key ?? [balance.chain_type, balance.chain_id, balance.chain_name ?? balance.name].map(norm).join("::"));
      if (!chainKey || chainKey === "::") continue;
      const key = `${walletScope}::${chainKey}`;
      const previous = groups[key];
      const chainType = String(balance.chain_type ?? previous?.chain_type ?? "");
      groups[key] = {
        key, walletScope,
        chain_id: String(balance.chain_id ?? previous?.chain_id ?? ""),
        chain_type: chainType,
        chain_name: String(balance.chain_name ?? balance.name ?? previous?.chain_name ?? ""),
        chain_key: chainKey,
        address: String(balance.address ?? previous?.address ?? ""),
        native: balance.native ? { ...previous?.native, ...balance.native,
          name: balance.native.name ?? previous?.native?.name,
          symbol: balance.native.symbol ?? previous?.native?.symbol,
          logo_url: balance.native.logo_url ?? previous?.native?.logo_url,
        } : previous?.native ?? null,
        tokens: balance.tokens === undefined ? (previous?.tokens ?? []) : mergeTokens(previous?.tokens ?? [], balance.tokens, chainType),
        updatedAt: now,
      };
    }
    return { version: TOKEN_REGISTRY_VERSION, groups };
  }),
  setAssetPrice: (walletScope, chainKey, identity, price) => set((state) => {
    const groups = { ...state.groups };
    const key = `${walletScope}::${chainKey}`;
    const group = groups[key];
    if (!group) return state;
    const tokens = group.tokens.map((token) => {
      const tokenId = [token.address, token.contract_address, token.contractAddress, token.token_id, token.tokenId].map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
      const normalizedIdentity = tokenId.replace(/^trc10:/i, "");
      return normalizedIdentity === identity ? { ...token, price_usd: price.price_usd, price_change_24h_percentage: price.price_change_24h_percentage } : token;
    });
    return { groups: { ...groups, [key]: { ...group, tokens, updatedAt: Date.now() } } };
  }),
  getBalances: (walletScope) => Object.values(get().groups)
    .filter((group) => group.walletScope === walletScope)
    .map((group) => ({
      chain_id: group.chain_id, chain_type: group.chain_type, chain_name: group.chain_name,
      chain_key: group.chain_key, address: group.address, native: group.native, tokens: group.tokens,
    })),
  clearWallet: (walletScope) => set((state) => ({
    groups: Object.fromEntries(Object.entries(state.groups).filter(([, group]) => group.walletScope !== walletScope)),
  })),
}), {
  name: "nodex-token-registry-v1",
  version: TOKEN_REGISTRY_VERSION,
  storage: createJSONStorage(() => indexedDbStorage),
  skipHydration: true,
  partialize: (state) => ({ version: state.version, groups: state.groups }) as RegistryState,
  migrate: (persisted) => {
    const state = persisted as Partial<RegistryState> | undefined;
    return { version: TOKEN_REGISTRY_VERSION, groups: state?.groups ?? {} };
  },
}));

let hydrationPromise: Promise<void> | undefined;

/** Rehydrate once before any registry reads or writes, avoiding competing async restores. */
export function hydrateTokenRegistry(): Promise<void> {
  if (useTokenRegistry.persist.hasHydrated()) return Promise.resolve();
  if (!hydrationPromise) {
    hydrationPromise = useTokenRegistry.persist.rehydrate().then(() => undefined);
  }
  return hydrationPromise;
}
