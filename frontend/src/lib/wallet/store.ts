import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type AssetId, type NetworkId } from "@/lib/wallet/assets";
import { hashPin, normalizeMnemonic, type Addresses } from "@/lib/wallet/mnemonic";
import { randomHex } from "@/lib/utils";
import { chainRecords, engineRequest, walletContext, type SelectedChain } from "@/lib/wallet/engine";
import { generateLocalRecoveryPhrase, validateLocalRecoveryPhrase } from "@/lib/wallet/wasm";
import type { EngineStreamEvent } from "@/lib/wallet/event-stream";
import { hydrateTokenRegistry, useTokenRegistry, walletTokenRegistryScope } from "@/lib/wallet/token-registry";

export type TxType = "send" | "receive" | "swap";
export type TxStatus = "confirmed" | "pending";
export type Transaction = {
  id: string; type: TxType; status: TxStatus; assetId: AssetId; amount: number;
  toAssetId?: AssetId; toAmount?: number; counterparty?: string; hash: string; timestamp: number;
};
export type EngineBalance = {
  wallet_id?: string; chain_id?: string; chain_key?: string; chain_name?: string; name?: string; chain_type?: string; address?: string;
  native?: {
    symbol?: string; balance?: string; decimals?: number; name?: string; address?: string;
    logo_url?: string | null; price_usd?: number | null; price_change_24h_percentage?: number | null;
  } | null;
  tokens?: Array<{
    symbol?: string; balance?: string; decimals?: number; name?: string; address?: string; contract_address?: string; contractAddress?: string; token_id?: string | number; tokenId?: string | number; is_native?: boolean;
    logo_url?: string | null; price_usd?: number | null; price_change_24h_percentage?: number | null; is_stale?: boolean;
  }>;
};
export type WalletRecord = {
  name: string;
  derivationErrors: Array<Record<string, unknown>>;
  phrase: string;
  addresses: Addresses;
  chainAddresses: Array<Record<string, unknown>>;
  engineWalletId: string;
  childId: string;
  childIndex: number;
  createdAt: number;
  pinHash: string | null;
  pinSalt: string | null;
};
type ChainFetchState = { status: "idle" | "loading" | "success" | "error"; message?: string; updatedAt?: string };
type WalletState = {
  wallet: WalletRecord | null;
  holdings: Record<AssetId, number>;
  balances: EngineBalance[];
  chainFetchState: Record<string, ChainFetchState>;
  txs: Transaction[];
  locked: boolean;
  hideBalances: boolean;
  network: NetworkId;
  hydrated: boolean;
  setupComplete: boolean;
  refreshingBalances: boolean;
  lastBalanceRefresh: string | null;
  lastEngineError: string | null;
  setHydrated: () => void;
  completeSetup: () => void;
  createWallet: (name: string, pin: string, chains?: SelectedChain[]) => Promise<WalletRecord>;
  restoreWallet: (phrase: string, name: string, pin: string, chains?: SelectedChain[]) => Promise<WalletRecord>;
  importPrivateKey: (privateKey: string, name: string, pin: string, chains: SelectedChain[]) => Promise<WalletRecord>;
  selectChildAccount: (childIndex: number, pin: string) => Promise<WalletRecord>;
  refreshBalances: () => Promise<void>;
  applyEngineEvent: (event: EngineStreamEvent) => void;
  setPin: (pin: string) => Promise<void>;
  unlock: (pin: string) => Promise<boolean>;
  lock: () => void;
  send: (input: { assetId: AssetId; amount: number; to: string }) => Transaction;
  swap: (input: { fromId: AssetId; toId: AssetId; fromAmount: number; toAmount: number }) => Transaction;
  toggleHideBalances: () => void;
  setNetwork: (network: NetworkId) => void;
  rename: (name: string) => void;
  reset: () => void;
};
const EMPTY_HOLDINGS: Record<AssetId, number> = {
  ethereum: 0, bitcoin: 0, "usd-coin": 0, solana: 0, chainlink: 0, uniswap: 0,
};
const selectedDefaults = (): SelectedChain[] => [];
let balanceRefreshInFlight = false;
const streamedChainRevision = new Map<string, number>();

function markStreamedChainRevision(key: string) {
  streamedChainRevision.set(key, (streamedChainRevision.get(key) ?? 0) + 1);
}

const normalizeChainValue = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** Stable UI identity is scoped to a chain, not merely its numeric/string chain ID. */
export function walletChainKey(chain: Record<string, unknown>): string {
  return [
    chain.chain_type,
    chain.chain_id,
    chain.name ?? chain.chain_name,
    chain.symbol,
    chain.network,
  ].map(normalizeChainValue).join("::");
}

function resolveWalletChainKey(
  wallet: WalletRecord | null,
  identity: Record<string, unknown>,
): string {
  if (!wallet) return "";
  const id = normalizeChainValue(identity.chain_id);
  const type = normalizeChainValue(identity.chain_type);
  const name = normalizeChainValue(identity.chain_name ?? identity.name);
  const address = String(identity.address ?? "").trim();
  let candidates = wallet.chainAddresses;
  if (id) {
    candidates = candidates.filter((chain) => normalizeChainValue(chain.chain_id) === id);
    if (!candidates.length) return "";
  }
  if (type) {
    candidates = candidates.filter((chain) => normalizeChainValue(chain.chain_type) === type);
    if (!candidates.length) return "";
  }
  // The engine's balance result already carries authoritative chain identity
  // (chain_id + chain_type). If that pair uniquely identifies one configured
  // network, do not reject the balance because an address field is absent,
  // stale, or represented differently by an engine version.
  // Keep the stricter name/address checks only when the identity is ambiguous.
  if (id && type && candidates.length === 1) {
    return walletChainKey(candidates[0]!);
  }
  if (name) {
    candidates = candidates.filter((chain) =>
      [chain.name, chain.chain_name].some((value) => normalizeChainValue(value) === name));
    if (!candidates.length) return "";
  }
  if (address) {
    candidates = candidates.filter((chain) => {
      const configured = String(chain.address ?? "").trim();
      if (!configured) return false;
      const isEvm = normalizeChainValue(chain.chain_type) === "evm";
      return isEvm ? configured.toLowerCase() === address.toLowerCase() : configured === address;
    });
    if (!candidates.length) return "";
  }
  return candidates.length === 1 ? walletChainKey(candidates[0]!) : "";
}

function normalizeTokensForChain(
  tokens: EngineBalance["tokens"],
  chainType: unknown,
): NonNullable<EngineBalance["tokens"]> {
  const seen = new Set<string>();
  const isEvm = normalizeChainValue(chainType) === "evm";
  return (tokens ?? []).filter((token) => {
    const address = String(token.address ?? "").trim();
    // A contract address is the authoritative token identity. Symbol/name are
    // display metadata and must never merge contracts or tokens on other chains.
    const identity = address
      ? `contract:${isEvm ? address.toLowerCase() : address}`
      : `metadata:${normalizeChainValue(token.name)}|${normalizeChainValue(token.symbol)}|${String(token.decimals ?? "")}|${String(token.balance ?? "")}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function normalizeBalanceForChain(
  balance: EngineBalance,
  chain: Record<string, unknown>,
  key: string,
): EngineBalance {
  const chainType = chain.chain_type ?? balance.chain_type;
  return {
    ...balance,
    chain_key: key,
    chain_id: String(chain.chain_id ?? balance.chain_id ?? ""),
    chain_type: String(chainType ?? ""),
    chain_name: String(chain.name ?? chain.chain_name ?? balance.chain_name ?? balance.name ?? ""),
    address: String(balance.address ?? chain.address ?? ""),
    tokens: normalizeTokensForChain(balance.tokens, chainType),
  };
}

function makeAddresses(chains: Array<Record<string, unknown>>): Addresses {
  const find = (type: string, name?: string) => {
    const match = chains.find((c) => String(c.chain_type ?? "").toLowerCase() === type || String(c.name ?? "").toLowerCase() === name);
    return String(match?.address ?? "");
  };
  return {
    evm: find("evm", "ethereum"),
    sol: find("solana", "solana"),
    btc: find("btc", "bitcoin"),
    byChain: Object.fromEntries(chains.map((c) => [walletChainKey(c), String(c.address ?? "")])),
  } as Addresses;
}

async function createOrImport(name: string, pin: string, chains: SelectedChain[], phrase?: string): Promise<WalletRecord> {
  // Generate new recovery material in the local Rust/WASM core. The engine still
  // registers the wallet, derives authoritative addresses, and encrypts its secrets.
  const normalizedPhrase = phrase ? normalizeMnemonic(phrase) : await generateLocalRecoveryPhrase();
  if (!(await validateLocalRecoveryPhrase(normalizedPhrase))) {
    throw new Error("The local NodeX runtime rejected the recovery phrase. No wallet was registered.");
  }
  const body = await engineRequest<Record<string, unknown>>("import_wallet", {
    name: name.trim() || (phrase ? "Restored" : "Primary"),
    pin,
    word_count: 12,
    mnemonic: normalizedPhrase,
    chains: chains.map((chain) => ({ ...chain })),
  });
  const raw = walletContext(body.data);
  const engineWalletId = String(raw.wallet_group_id ?? raw.wallet_id ?? raw.id ?? "");
  // The current engine response returns addresses as a name -> address object,
  // not always as a chain/blockchain array. Normalize both formats for the UI.
  const chainAddressesFromEngine = chainRecords(raw);
  const addressMapValue = raw.addresses ?? body.data?.addresses;
  const addressMap = addressMapValue && typeof addressMapValue === "object" && !Array.isArray(addressMapValue)
    ? addressMapValue as Record<string, unknown>
    : {};
  const chainAddresses = chainAddressesFromEngine.length
    ? chainAddressesFromEngine
    : chains.map((chain) => ({
        ...chain,
        address: String(addressMap[chain.name] ?? addressMap[chain.chain_type] ?? ""),
      })).filter((chain) => chain.address.length > 0);
  const derivationErrorValue = raw.derivation_errors ?? body.data?.derivation_errors;
  const derivationErrors = Array.isArray(derivationErrorValue)
    ? derivationErrorValue.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
  // child_id is the registered derivation child (e.g. wallet_2_child_0);
  // wallet_id identifies the parent wallet and must not be substituted for it.
  const childId = String(raw.child_id ?? raw.childId ?? raw.wallet_child_id ?? raw.id ?? engineWalletId);
  if (!engineWalletId || !childId || chainAddresses.some((chain) => !chain.address) || (!chainAddresses.length && !derivationErrors.length)) {
    throw new Error("Engine response was successful but the wallet ID, child ID, or chain addresses could not be normalized. Open Engine request logs for the redacted response.");
  }
  let returnedPhrase = normalizedPhrase;
  if (!returnedPhrase) {
    const phraseResponse = await engineRequest<Record<string, unknown>>("get_mnemonic", {
      wallet_id: engineWalletId, child_id: childId, pin, include_secret_phrase: true,
    });
    returnedPhrase = String(phraseResponse.data?.secret_phrase ?? walletContext(phraseResponse.data).mnemonic ?? "");
  }
  if (!returnedPhrase) {
    throw new Error("Wallet was created by the engine, but it did not return the recovery phrase. See Settings/Engine logs; do not invent or derive a phrase in the frontend.");
  }
  const now = Date.now();
  return {
    name: name.trim() || "Primary",
    derivationErrors,
    phrase: returnedPhrase,
    addresses: makeAddresses(chainAddresses),
    chainAddresses,
    engineWalletId,
    childId,
    childIndex: Number(raw.child_index ?? 0),
    createdAt: now,
    pinHash: null,
    pinSalt: null,
  };
}

export const useWallet = create<WalletState>()(persist((set, get) => ({
  wallet: null, holdings: { ...EMPTY_HOLDINGS }, balances: [], chainFetchState: {}, txs: [], locked: false,
  hideBalances: false, network: "all", hydrated: false, setupComplete: true,
  refreshingBalances: false, lastBalanceRefresh: null, lastEngineError: null,
  setHydrated: () => set({ hydrated: true }),
  completeSetup: () => set({ setupComplete: true }),
  createWallet: async (name, pin, chains = selectedDefaults()) => {
    const wallet = await createOrImport(name, pin, chains);
    set({ wallet, holdings: { ...EMPTY_HOLDINGS }, balances: [], chainFetchState: {}, txs: [], locked: false, setupComplete: false, lastEngineError: null });
    return wallet;
  },
  restoreWallet: async (phrase, name, pin, chains = selectedDefaults()) => {
    const wallet = await createOrImport(name, pin, chains, phrase);
    set({ wallet, holdings: { ...EMPTY_HOLDINGS }, balances: [], chainFetchState: {}, txs: [], locked: false, setupComplete: false, lastEngineError: null });
    return wallet;
  },
  importPrivateKey: async (privateKey, name, pin, chains) => {
    if (!chains.length) throw new Error("Select at least one blockchain.");
    const selectedEvm = chains.every((chain) => chain.chain_type.toLowerCase() === "evm");
    if (chains.length > 1 && !selectedEvm) throw new Error("A private key can be imported to multiple EVM networks, or one non-EVM network at a time.");
    const body = await engineRequest<Record<string, unknown>>("import_private_key", {
      name: name.trim() || "Imported wallet",
      pin,
      private_key: privateKey.trim(),
      chains: chains.map((chain) => ({ ...chain })),
    });
    const raw = walletContext(body.data);
    const engineWalletId = String(raw.wallet_group_id ?? raw.wallet_id ?? raw.id ?? "");
    const chainAddresses = chainRecords(raw);
    const derivationErrorValue = raw.derivation_errors ?? body.data?.derivation_errors;
    const derivationErrors = Array.isArray(derivationErrorValue)
      ? derivationErrorValue.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
      : [];
    const childId = String(raw.wallet_id ?? raw.child_id ?? raw.childId ?? "");
    if (!engineWalletId || !childId || chainAddresses.some((chain) => !chain.address) || (!chainAddresses.length && !derivationErrors.length)) {
      throw new Error("The engine did not return a complete private-key wallet record. Check the redacted Engine request log.");
    }
    const wallet: WalletRecord = {
      name: String(raw.name ?? name.trim() ?? "Imported wallet"),
      derivationErrors,
      phrase: "",
      addresses: makeAddresses(chainAddresses),
      chainAddresses,
      engineWalletId,
      childId,
      childIndex: Number(raw.child_index ?? 0),
      createdAt: Date.now(),
      pinHash: null,
      pinSalt: null,
    };
    set({ wallet, holdings: { ...EMPTY_HOLDINGS }, balances: [], chainFetchState: {}, txs: [], locked: false, setupComplete: false, lastEngineError: null });
    return wallet;
  },
  selectChildAccount: async (childIndex, pin) => {
    const current = get().wallet;
    if (!current) throw new Error("Restore a recovery phrase before selecting a child account.");
    if (!Number.isSafeInteger(childIndex) || childIndex < 0 || childIndex > 100000) {
      throw new Error("The selected child account index is invalid.");
    }
    if (childIndex === current.childIndex) return current;

    const chains = current.chainAddresses.map((chain) => ({
      name: String(chain.name ?? chain.chain_name ?? ""),
      chain_id: String(chain.chain_id ?? ""),
      chain_type: String(chain.chain_type ?? ""),
      symbol: String(chain.symbol ?? ""),
      network: String(chain.network ?? "mainnet"),
      derivation_path: String(chain.derivation_path ?? ""),
      rpc_provider: String(chain.rpc_provider ?? "public"),
      rpc_url: String(chain.rpc_url ?? ""),
    })).filter((chain) => chain.chain_id && chain.chain_type && chain.derivation_path);

    const response = await engineRequest<Record<string, unknown>>("create_child_wallet", {
      wallet_id: current.engineWalletId,
      child_index: childIndex,
      name: childIndex === 0 ? current.name : `${current.name} ${childIndex + 1}`,
      pin,
      chains,
    });
    const raw = walletContext(response.data);
    const returnedChains = chainRecords(raw);
    const chainAddresses = returnedChains.length
      ? returnedChains
      : current.chainAddresses.map((chain) => ({ ...chain, address: "" }));
    if (!raw.wallet_id || !returnedChains.length || returnedChains.some((chain) => !String(chain.address ?? "").trim())) {
      throw new Error("NodeX created or selected the child but did not return its complete chain addresses.");
    }
    const childId = String(raw.wallet_id ?? raw.child_id ?? raw.childId ?? "");
    const next: WalletRecord = {
      ...current,
      name: String(raw.name ?? (childIndex === 0 ? current.name : `${current.name} ${childIndex + 1}`)),
      addresses: makeAddresses(chainAddresses),
      chainAddresses,
      engineWalletId: current.engineWalletId,
      childId,
      childIndex: Number(raw.child_index ?? childIndex),
      createdAt: Date.now(),
    };
    set({ wallet: next, holdings: { ...EMPTY_HOLDINGS }, balances: [], chainFetchState: {}, txs: [], locked: false, lastEngineError: null, lastBalanceRefresh: null });
    return next;
  },
  refreshBalances: async () => {
    const wallet = get().wallet;
    if (!wallet) throw new Error("Create or restore a wallet first.");
    // Do not launch a second full-wallet refresh while one is already active.
    if (balanceRefreshInFlight || get().refreshingBalances) return;
    balanceRefreshInFlight = true;
    // All selected chains are dispatched together, so all should show loading
    // immediately rather than making later chains look idle while they fetch.
    const initialStates = Object.fromEntries(wallet.chainAddresses.map((chain) => [
      walletChainKey(chain),
      { status: "loading" as const },
    ]));
    const streamRevisionAtStart = new Map(wallet.chainAddresses.map((chain) => {
      const key = walletChainKey(chain);
      return [key, streamedChainRevision.get(key) ?? 0] as const;
    }));
    set({ refreshingBalances: true, lastEngineError: null, chainFetchState: { ...get().chainFetchState, ...initialStates } });
    try {
      const result = await engineRequest<Record<string, unknown>>("refresh_balance", {
        wallet_id: wallet.engineWalletId,
        child_id: wallet.childId,
      });
      // The engine has returned several response shapes across versions:
      // { balances, errors }, { raw: { balances, errors } }, and chain results
      // nested under data. Normalize these before touching UI state.
      const envelopeData = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
      const payload = walletContext(envelopeData);
      const raw = envelopeData.raw && typeof envelopeData.raw === "object" ? envelopeData.raw as Record<string, unknown> : {};
      const candidates = [payload.balances, raw.balances, envelopeData.balances, payload.results, raw.results];
      const balances = candidates.find(Array.isArray) as EngineBalance[] | undefined ?? [];
      const errorCandidates = [payload.errors, raw.errors, envelopeData.errors, payload.derivation_errors, raw.derivation_errors];
      const errors = errorCandidates.find(Array.isArray) as Array<Record<string, unknown>> | undefined ?? [];
      const now = new Date().toISOString();
      const nextStates = { ...get().chainFetchState };
      const mergedBalances = get().balances.flatMap((item) => {
        const key = item.chain_key || resolveWalletChainKey(wallet, item);
        const configured = wallet.chainAddresses.find((chain) => walletChainKey(chain) === key);
        // Discard legacy entries whose chain identity is missing or ambiguous;
        // retaining them could make one old balance appear on multiple networks.
        return key && configured ? [normalizeBalanceForChain(item, configured, key)] : [];
      });
      const findChainKey = (balance: EngineBalance) => resolveWalletChainKey(wallet, {
        chain_id: balance.chain_id,
        chain_type: balance.chain_type,
        chain_name: balance.chain_name,
        name: balance.name,
        address: balance.address,
      });
      for (const balance of balances) {
        const key = findChainKey(balance);
        // Never identify a blockchain by address: EVM networks commonly share
        // the same address, so address-based merging can move Polygon assets into Ethereum.
        if (!key) continue;
        // If the live stream already reported this chain during the request,
        // trust that newer terminal event instead of overwriting it with the
        // later aggregate HTTP response.
        if ((streamedChainRevision.get(key) ?? 0) !== (streamRevisionAtStart.get(key) ?? 0)) continue;
        nextStates[key] = { status: "success", updatedAt: now };
        const configuredChain = wallet.chainAddresses.find((chain) => walletChainKey(chain) === key)!;
        const normalizedBalance = normalizeBalanceForChain(balance, configuredChain, key);
        const index = mergedBalances.findIndex((item) =>
          String(item.chain_key ?? "").trim() === key);
        if (index >= 0) mergedBalances[index] = { ...mergedBalances[index], ...normalizedBalance };
        else mergedBalances.push(normalizedBalance);
      }
      const effectiveErrors: Array<Record<string, unknown>> = [];
      for (const error of errors) {
        const key = resolveWalletChainKey(wallet, { chain_id: error.chain_id, chain_name: error.chain_name ?? error.chain, name: error.name, chain_type: error.chain_type, address: error.address });
        if (key && (streamedChainRevision.get(key) ?? 0) === (streamRevisionAtStart.get(key) ?? 0)) {
          nextStates[key] = { status: "error", message: String(error.error ?? error.message ?? "Balance unavailable"), updatedAt: now };
          effectiveErrors.push(error);
        }
      }
      // Every chain included in this refresh must leave "loading" when the
      // response is received, even if an older engine omitted a matching error
      // entry or returned an unfamiliar response shape for that chain.
      for (const chain of wallet.chainAddresses) {
        const key = walletChainKey(chain);
        if ((streamedChainRevision.get(key) ?? 0) !== (streamRevisionAtStart.get(key) ?? 0)) continue;
        if (nextStates[key]?.status === "loading" || nextStates[key]?.status === "idle") {
          nextStates[key] = {
            status: "error",
            message: "The engine returned no balance result for this blockchain.",
            updatedAt: now,
          };
        }
      }
      // A returned balance object without a numeric amount is still a completed
      // response; render its real payload rather than leaving a spinner forever.
      set({ balances: mergedBalances, chainFetchState: nextStates, lastBalanceRefresh: now });
      // Persist engine-returned chains and tokens in the shared registry.
      await hydrateTokenRegistry();
      const registry = useTokenRegistry.getState();
      const registryScope = walletTokenRegistryScope(wallet.engineWalletId, wallet.childId);
      registry.upsertBalances(registryScope, mergedBalances);
      // Keep every existing page on the registry-backed shared balance view.
      const registryBalances = useTokenRegistry.getState().getBalances(registryScope);
      if (registryBalances.length) set({ balances: registryBalances });
      if (effectiveErrors.length) {
        set({ lastEngineError: effectiveErrors.map((e) => String(e.error ?? e.message ?? JSON.stringify(e))).join("; ") });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Balance refresh failed";
      const nextStates = { ...get().chainFetchState };
      for (const chain of wallet.chainAddresses) {
        const key = walletChainKey(chain);
        if (nextStates[key]?.status === "loading" || nextStates[key]?.status === "idle") nextStates[key] = { status: "error", message };
      }
      set({ lastEngineError: message, chainFetchState: nextStates });
      throw error;
    } finally {
      balanceRefreshInFlight = false;
      set({ refreshingBalances: false });
    }
  },
  applyEngineEvent: (event) => {
    const data = event.data ?? {};
    const chainId = String(event.chain_id ?? data.chain_id ?? data.chain_name ?? data.blockchain ?? (data.balance && typeof data.balance === "object" ? (data.balance as Record<string, unknown>).chain_id : "") ?? "");
    const now = new Date(Number(event.timestamp_ms ?? Date.now())).toISOString();
    const eventType = String(event.event_type ?? "").toLowerCase();
    if (eventType === "balance.fetch.started" && !chainId) {
      set((s) => ({ refreshingBalances: true, chainFetchState: Object.fromEntries(Object.entries(s.chainFetchState).map(([id, state]) => [id, { ...state, status: "loading" as const }])) }));
      return;
    }
    if ((eventType === "balance.refresh.completed" || eventType === "balance.fetch.completed" || eventType === "balance.refresh.finished") && !chainId) {
      set({ refreshingBalances: balanceRefreshInFlight, lastBalanceRefresh: now });
      return;
    }
    if ((eventType === "balance.refresh.failed" || eventType === "balance.fetch.failed") && !chainId) {
      const message = String(data.message ?? "Balance refresh failed");
      set((s) => ({ refreshingBalances: balanceRefreshInFlight, lastEngineError: message, chainFetchState: Object.fromEntries(Object.entries(s.chainFetchState).map(([id, state]) => [id, state.status === "loading" ? { status: "error" as const, message, updatedAt: now } : state])) }));
      return;
    }
    if (!chainId) return;

    // Ignore balance updates for a different wallet if the engine provides a
    // wallet/child identifier. This prevents one wallet's events updating another.
    const activeWallet = get().wallet;
    const eventWalletId = String(event.wallet_id ?? data.wallet_id ?? data.child_id ?? "");
    if (eventWalletId && activeWallet
      && eventWalletId !== activeWallet.engineWalletId
      && eventWalletId !== activeWallet.childId) return;

    const eventBalance = data.balance && typeof data.balance === "object"
      ? data.balance as Record<string, unknown>
      : {};
    const resolvedChainKey = resolveWalletChainKey(activeWallet, {
      ...data,
      ...eventBalance,
      chain_id: event.chain_id ?? data.chain_id ?? eventBalance.chain_id ?? chainId,
      chain_type: eventBalance.chain_type ?? data.chain_type,
      chain_name: eventBalance.chain_name ?? data.chain_name,
      name: eventBalance.name ?? data.name,
      address: eventBalance.address ?? data.address,
    });
    // Unknown or ambiguous identifiers must never mutate another network's card.
    if (!resolvedChainKey) return;

    if (eventType === "balance.fetch.failed"
      || eventType === "balance.result"
      || eventType === "balance.updated"
      || eventType === "balance.result.failed"
      || eventType === "balance.updated.failed") {
      markStreamedChainRevision(resolvedChainKey);
    }

    if (eventType === "balance.fetch.started") {
      set((s) => ({ chainFetchState: { ...s.chainFetchState, [resolvedChainKey]: { status: "loading" } } }));
      return;
    }
    if (eventType === "balance.fetch.failed") {
      const message = String(data.message ?? "Balance fetch failed");
      set((s) => {
        const nextStates = { ...s.chainFetchState, [resolvedChainKey]: { status: "error" as const, message, updatedAt: now } };
        return {
          chainFetchState: nextStates,
          // The global refresh stays active while independent chain requests are running.
          // Only balance.refresh.completed (or the HTTP response) ends it.
          lastEngineError: message,
        };
      });
      return;
    }
    // balance.result is emitted as soon as an individual chain adapter returns,
    // so the UI can update progressively before the whole refresh completes.
    if (eventType === "balance.result" || eventType === "balance.updated") {
      const incomingValue = (data.balance && typeof data.balance === "object" ? data.balance : data) as unknown as EngineBalance;
      // If the event envelope and its payload disagree about the chain, reject it.
      // A malformed event must never overwrite another network's balance card.
      const payloadKey = resolveWalletChainKey(activeWallet, incomingValue);
      if (payloadKey && payloadKey !== resolvedChainKey) return;
      const normalizedKey = resolvedChainKey;
      set((s) => {
        const configuredChain = activeWallet?.chainAddresses.find((chain) => walletChainKey(chain) === normalizedKey);
        if (!configuredChain) return s;
        const incoming = normalizeBalanceForChain(incomingValue, configuredChain, normalizedKey);
        const existing = s.balances.filter((item) =>
          String(item.chain_key ?? resolveWalletChainKey(activeWallet, item)).trim() !== normalizedKey);
        const nextStates = { ...s.chainFetchState, [normalizedKey]: { status: "success" as const, updatedAt: now } };
        return {
          balances: [...existing, incoming],
          // Keep the refresh lock while the engine moves to the next chain.
          refreshingBalances: s.refreshingBalances,
          chainFetchState: nextStates,
          lastBalanceRefresh: now,
        };
      });
      if (activeWallet) {
        void hydrateTokenRegistry().then(() => {
          const configured = activeWallet.chainAddresses.find((chain) => walletChainKey(chain) === resolvedChainKey);
          if (!configured) return;
          const scope = walletTokenRegistryScope(activeWallet.engineWalletId, activeWallet.childId);
          useTokenRegistry.getState().upsertBalances(
            scope,
            [normalizeBalanceForChain(incomingValue, configured, resolvedChainKey)],
          );
          if (useWallet.getState().wallet?.childId === activeWallet.childId) {
            const registryBalances = useTokenRegistry.getState().getBalances(scope);
            if (registryBalances.length) useWallet.setState({ balances: registryBalances });
          }
        });
      }
      return;
    }
    if (eventType === "balance.fetch.completed") {
      set((s) => {
        const nextStates = { ...s.chainFetchState, [resolvedChainKey]: { status: "success" as const, updatedAt: now } };
        return { chainFetchState: nextStates, lastBalanceRefresh: now };
      });
      return;
    }
    if (eventType === "balance.result.failed" || eventType === "balance.updated.failed") {
      const message = String(data.message ?? data.error ?? "Balance fetch failed");
      set((s) => {
        const nextStates = { ...s.chainFetchState, [resolvedChainKey]: { status: "error" as const, message, updatedAt: now } };
        return { chainFetchState: nextStates, lastEngineError: message };
      });
      return;
    }
  },
  setPin: async (pin) => {
    const wallet = get().wallet; if (!wallet) return;
    const pinSalt = randomHex(16); const pinHash = await hashPin(pin, pinSalt);
    set({ wallet: { ...wallet, pinHash, pinSalt } });
  },
  unlock: async (pin) => {
    const wallet = get().wallet;
    if (!wallet?.pinHash || !wallet.pinSalt) { set({ locked: false }); return true; }
    const next = await hashPin(pin, wallet.pinSalt);
    if (next !== wallet.pinHash) return false;
    set({ locked: false }); return true;
  },
  lock: () => { if (get().wallet?.pinHash) set({ locked: true }); },
  send: () => { throw new Error("Sending is disabled until an engine-backed transaction/broadcast flow is implemented."); },
  swap: () => { throw new Error("Swaps are disabled until an engine-backed swap flow is implemented."); },
  toggleHideBalances: () => set((s) => ({ hideBalances: !s.hideBalances })),
  setNetwork: (network) => set({ network }),
  rename: (name) => { const wallet = get().wallet; if (wallet) set({ wallet: { ...wallet, name: name.trim() || wallet.name } }); },
  reset: () => {
    const wallet = get().wallet;
    if (wallet) void hydrateTokenRegistry().then(() => useTokenRegistry.getState().clearWallet(walletTokenRegistryScope(wallet.engineWalletId, wallet.childId)));
    set({ wallet: null, holdings: { ...EMPTY_HOLDINGS }, balances: [], chainFetchState: {}, txs: [], locked: false, hideBalances: false, network: "all", setupComplete: true, lastBalanceRefresh: null, lastEngineError: null });
  },
}), {
  name: "sable-wallet",
  skipHydration: true,
  partialize: (s) => ({
    wallet: s.wallet, holdings: s.holdings, balances: s.balances, chainFetchState: s.chainFetchState, txs: s.txs,
    hideBalances: s.hideBalances, network: s.network,
    locked: s.wallet?.pinHash ? true : false, setupComplete: s.setupComplete,
    lastBalanceRefresh: s.lastBalanceRefresh,
  }),
  onRehydrateStorage: () => (state) => {
    state?.setHydrated();
    // Discard pre-integration demo wallets so fabricated addresses/balances
    // can never be mistaken for engine-registered wallet data.
    if (state?.wallet && !state.wallet.engineWalletId) state.reset();
    if (state?.wallet?.pinHash) state.lock();
  },
}));
