import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowDownLeft, ArrowUpRight, ArrowLeftRight, Blocks, DollarSign, Eye, EyeOff, LoaderCircle, RefreshCw, ShieldCheck, Triangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ProgressiveVirtualTokenList } from "@/components/wallet/progressive-virtual-token-list";
import { useWallet, walletChainKey } from "@/lib/wallet/store";
import { getTokenCareBlockchain, getTokenPriceIdentity, nativePriceKey, tokenPriceKey, usePrices } from "@/lib/wallet/prices";
import { refreshMissingTokenLogos } from "@/lib/wallet/logos";
import { formatUsd, formatUsdPrecise } from "@/lib/utils";
import { usdValueFromBalance } from "@/lib/wallet/valuation";
import type { AssetId } from "@/lib/wallet/assets";
import { getEventStreamStatus, type EngineStreamStatus } from "@/lib/wallet/event-stream";

export const Route = createFileRoute("/_app/")({ component: HomePage });
const PRICE_ID: Record<string, AssetId> = { ETH: "ethereum", WETH: "ethereum", BTC: "bitcoin", WBTC: "bitcoin", USDC: "usd-coin", SOL: "solana", LINK: "chainlink", UNI: "uniswap" };
function readableName(chain: Record<string, unknown>) { return String(chain.name ?? chain.chain_name ?? chain.chain_type ?? "Blockchain").replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function numericPrice(value: unknown, allowNegative = false): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && (allowNegative || parsed >= 0) ? parsed : undefined;
}
function displayImageUrl(value: unknown): string | undefined {
  let candidate = String(value ?? "").trim();
  if (!candidate) return undefined;
  // Some chain metadata endpoints return UTF-8 text hex-encoded. Decode only
  // printable UTF-8 strings that look like actual text; leave ordinary URLs alone.
  if (/^(?:[0-9a-fA-F]{2})+$/.test(candidate)) {
    try {
      const bytes = candidate.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16));
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      if (/^[\x20-\x7E]+$/.test(decoded) && /[A-Za-z]/.test(decoded)) candidate = decoded;
    } catch { /* Preserve the original value when it is not valid encoded text. */ }
  }
  return /^https?:\/\//i.test(candidate) ? candidate : undefined;
}
function formatBalance(value: unknown, assetDecimals?: number) {
  const raw = String(value ?? "").trim();
  if (!raw) return "0.00";
  if (/^-?\\d+$/.test(raw) && Number.isInteger(assetDecimals) && Number(assetDecimals) >= 0 && Number(assetDecimals) <= 255) {
    try {
      const negative = raw.startsWith("-");
      const integer = BigInt(negative ? raw.slice(1) : raw);
      const scale = 10n ** BigInt(Number(assetDecimals));
      const whole = integer / scale;
      const fraction = (integer % scale).toString().padStart(Number(assetDecimals), "0").slice(0, 8).replace(/0+$/, "");
      const grouped = whole.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
      return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
    } catch { /* Fall through to the best-effort legacy formatter. */ }
  }
  const parsed = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return raw;
  if (parsed === 0) return "0";
  const places = Math.abs(parsed) >= 0.0001 ? 4 : Math.min(14, Math.max(4, -Math.floor(Math.log10(Math.abs(parsed))) + 4));
  return parsed.toLocaleString("en-US", { maximumFractionDigits: places, minimumFractionDigits: 0, useGrouping: true });
}
function HomePage() {
  const wallet = useWallet((s) => s.wallet);
  const balances = useWallet((s) => s.balances);
  const refreshing = useWallet((s) => s.refreshingBalances);
  const refreshBalances = useWallet((s) => s.refreshBalances);
  const hide = useWallet((s) => s.hideBalances);
  const toggleHide = useWallet((s) => s.toggleHideBalances);
  const prices = usePrices((s) => s.prices);
  const tokenPrices = usePrices((s) => s.tokenPrices);
  const nativePrices = usePrices((s) => s.nativePrices);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [priceRequestResult, setPriceRequestResult] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<{ status: EngineStreamStatus; message?: string }>(() => getEventStreamStatus());
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ status: EngineStreamStatus; message?: string }>).detail;
      if (detail) setStreamStatus(detail);
    };
    setStreamStatus(getEventStreamStatus());
    window.addEventListener("nodex-event-stream-status", update);
    return () => window.removeEventListener("nodex-event-stream-status", update);
  }, []);
  const chains = wallet?.chainAddresses ?? [];
  useEffect(() => {
    // Resolve missing token and native-chain logos without blocking the wallet UI.
    void refreshMissingTokenLogos();
  }, [balances, wallet?.chainAddresses, wallet?.engineWalletId, wallet?.childId]);
  const portfolio = useMemo(() => {
    let value = 0;
    let pricedAssets = 0;
    let dailyChangeValue = 0;
    for (const balance of balances) {
      const nativeSymbol = String(balance.native?.symbol ?? "").toUpperCase();
      const nativeAsset = PRICE_ID[nativeSymbol];
      const blockchain = getTokenCareBlockchain(balance);
      const liveNativePrice = nativePrices[nativePriceKey(blockchain, nativeSymbol)];
      const nativePrice = liveNativePrice?.usd
        ?? numericPrice(balance.native?.price_usd)
        ?? (nativeAsset ? prices[nativeAsset]?.usd : undefined);
      const nativeValue = usdValueFromBalance(balance.native?.balance, balance.native?.decimals, nativePrice);
      if (nativeValue !== undefined) {
        value += nativeValue;
        pricedAssets += 1;
        const change = liveNativePrice?.usd_24h_change ?? numericPrice(balance.native?.price_change_24h_percentage, true) ?? (nativeAsset ? prices[nativeAsset]?.usd_24h_change : undefined);
        if (change !== undefined) dailyChangeValue += nativeValue * change / 100;
      }
      for (const token of balance.tokens ?? []) {
        const symbol = String(token.symbol ?? "").toUpperCase();
        const tokenIdentity = getTokenPriceIdentity(token, blockchain);
        const liveTokenPrice = tokenIdentity
          ? tokenPrices[tokenPriceKey(blockchain, tokenIdentity, balance.chain_type)]
          : undefined;
        // Contract tokens must be priced by their own chain/address identity,
        // never by ticker alone (e.g. a TRON token named USDC is not Ethereum USDC).
        const tokenPrice = liveTokenPrice?.usd ?? numericPrice(token.price_usd);
        const tokenValue = usdValueFromBalance(token.balance, token.decimals, tokenPrice);
        if (tokenValue !== undefined) {
          value += tokenValue;
          pricedAssets += 1;
          const change = liveTokenPrice?.usd_24h_change ?? numericPrice(token.price_change_24h_percentage, true);
          if (change !== undefined) dailyChangeValue += tokenValue * change / 100;
        }
      }
    }
    return { value, pricedAssets, dailyChangeValue, dailyChangePercent: value > 0 ? dailyChangeValue / value * 100 : undefined };
  }, [balances, prices, tokenPrices, nativePrices]);

  const displayAssets = useMemo(() => {
    type DisplayAsset = {
      name?: string | null;
      symbol?: string | null;
      address?: string | null;
      contract_address?: string | null;
      contractAddress?: string | null;
      token_id?: string | number | null;
      tokenId?: string | number | null;
      balance?: unknown;
      decimals?: number | null;
      logo_url?: string | null;
      price_usd?: number | null;
      price_change_24h_percentage?: number | null;
      chainType?: string;
      blockchain?: string;
      chainName?: string;
      chainSymbol?: string;
      chainLogoUrl?: string | null;
      isNative?: boolean;
    };
    const groups = chains.map((chain) => {
      const chainId = String(chain.chain_id ?? "");
      const key = walletChainKey(chain);
      const name = readableName(chain);
      const canonicalBalances = balances.filter((item) => item.chain_key === key);
      const candidates = canonicalBalances.length ? canonicalBalances : balances.filter((item) => {
        if (item.chain_key) return false;
        if (String(item.chain_id ?? "").trim().toLowerCase() !== chainId.trim().toLowerCase()) return false;
        if (item.chain_type && String(item.chain_type).trim().toLowerCase() !== String(chain.chain_type ?? "").trim().toLowerCase()) return false;
        const itemName = String(item.chain_name ?? item.name ?? "").trim().toLowerCase();
        const selectedName = String(chain.name ?? chain.chain_name ?? "").trim().toLowerCase();
        return !itemName || !selectedName || itemName === selectedName;
      });
      const balance = candidates.length === 1 ? candidates[0] : undefined;
      const native = balance?.native;
      const chainType = String(chain.chain_type ?? "");
      const blockchain = getTokenCareBlockchain(balance ?? chain);
      const chainSymbol = String(chain.symbol ?? native?.symbol ?? name.slice(0, 3)).slice(0, 8).toUpperCase();
      const chainLogoUrl = displayImageUrl(chain.logo_url ?? chain.image_url ?? chain.icon_url) ?? null;
      const nativeAsset: DisplayAsset = {
        name: String(native?.name ?? name),
        symbol: String(native?.symbol ?? chain.symbol ?? "Native"),
        address: String(native?.address ?? chain.address ?? ""),
        balance: native?.balance ?? "0",
        decimals: native?.decimals,
        logo_url: displayImageUrl(native?.logo_url ?? chain.logo_url ?? chain.image_url ?? chain.icon_url) ?? null,
        price_usd: numericPrice(native?.price_usd) ?? null,
        price_change_24h_percentage: numericPrice(native?.price_change_24h_percentage, true) ?? null,
        chainType,
        blockchain,
        chainName: name,
        chainSymbol,
        chainLogoUrl,
        isNative: true,
      };
      const tokens: DisplayAsset[] = (balance?.tokens ?? []).map((token) => ({
        ...token,
        chainType,
        blockchain,
        chainName: name,
        chainSymbol,
        chainLogoUrl,
        isNative: false,
      }));
      return { nativeAsset, tokens };
    });
    const maxTokens = Math.max(0, ...groups.map((group) => group.tokens.length));
    const items: DisplayAsset[] = [];
    // Round-robin across chains: native assets first, then token #1 from each
    // chain, token #2 from each chain, etc. This avoids chain-grouped blocks.
    for (let slot = 0; slot <= maxTokens; slot += 1) {
      for (const group of groups) {
        if (slot === 0) items.push(group.nativeAsset);
        else if (group.tokens[slot - 1]) items.push(group.tokens[slot - 1]!);
      }
    }
    const ranked = items.map((asset, index) => {
      const symbol = String(asset.symbol ?? "").toUpperCase();
      let price: number | undefined;
      if (asset.isNative) {
        price = nativePrices[nativePriceKey(String(asset.blockchain ?? ""), symbol)]?.usd
          ?? numericPrice(asset.price_usd)
          ?? (PRICE_ID[symbol] ? prices[PRICE_ID[symbol]]?.usd : undefined);
      } else {
        const identity = getTokenPriceIdentity(asset, String(asset.blockchain ?? ""));
        price = (identity ? tokenPrices[tokenPriceKey(String(asset.blockchain ?? ""), identity, asset.chainType)]?.usd : undefined)
          ?? numericPrice(asset.price_usd);
      }
      const value = usdValueFromBalance(asset.balance, asset.decimals, price);
      return { asset, index, value };
    });
    ranked.sort((a, b) => {
      if (a.value === undefined && b.value !== undefined) return 1;
      if (a.value !== undefined && b.value === undefined) return -1;
      return (b.value ?? 0) - (a.value ?? 0) || a.index - b.index;
    });
    return ranked.map(({ asset }) => asset);
  }, [chains, balances, prices, tokenPrices, nativePrices]);

  async function refresh() {
    try { await refreshBalances(); toast("Balance refresh finished. Check each network's status."); }
    catch (error) { toast(error instanceof Error ? error.message : "Engine balance request failed. Open request logs for details."); }
  }

  async function requestPrices() {
    setRefreshingPrices(true);
    setPriceRequestResult(null);
    try {
      const previousUpdatedAt = usePrices.getState().updatedAt;
      await usePrices.getState().refresh(true);
      const state = usePrices.getState();
      const updated = state.updatedAt > previousUpdatedAt && state.status === "partial";
      const message = updated
        ? `TokenCare returned prices · ${new Date(state.updatedAt).toLocaleTimeString()}`
        : "No valid prices returned. Open Settings → Request and response logs.";
      setPriceRequestResult(message);
      toast(updated ? "TokenCare price response received" : "TokenCare returned no valid prices");
    } catch (error) {
      const message = error instanceof Error ? error.message : "TokenCare price request failed";
      setPriceRequestResult(message);
      toast.error(message);
    } finally {
      setRefreshingPrices(false);
    }
  }

  return <div className="flex h-dvh flex-col overflow-hidden bg-black pb-0 text-white">
    <div className="shrink-0 space-y-2.5 bg-black px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white">
      <section className="px-1 py-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/[0.14] bg-gradient-to-br from-white/20 to-white/[0.025]"><ShieldCheck className="size-[18px] text-white" /></div>
            <div className="min-w-0">
              <h1 className="truncate text-[17px] font-semibold tracking-tight text-white">NodeX Wallet</h1>
              <p className="truncate text-[11px] text-white/55">{wallet?.name ?? "Your crypto. Your control."}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="flex h-7 items-center gap-1 rounded-full border border-white/[0.12] bg-white/[0.045] px-2 text-[10px] text-white/75"><ShieldCheck className="size-3" /> Secure</span>
            <Button variant="ghost" size="icon" disabled={refreshingPrices} onClick={requestPrices} aria-label="Get prices from TokenCare" title="Get prices" className="size-8 rounded-full border border-white/[0.10] bg-white/[0.04] text-white/85 hover:bg-white/[0.09] hover:text-white">{refreshingPrices ? <LoaderCircle className="size-3.5 animate-spin" /> : <DollarSign className="size-3.5" />}</Button>
            <Button variant="ghost" size="icon" disabled={refreshing || !wallet} onClick={refresh} aria-label="Refresh balances" title="Refresh balances" className="size-8 rounded-full border border-white/[0.10] bg-white/[0.04] text-white/85 hover:bg-white/[0.09] hover:text-white">{refreshing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}</Button>
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px]" role="status" aria-live="polite">
          <span className={`size-1.5 shrink-0 rounded-full ${streamStatus.status === "connected" ? "bg-emerald-400" : streamStatus.status === "error" ? "bg-red-400" : "bg-amber-300"}`} />
          <span className="min-w-0 flex-1 truncate text-white/55">
            {streamStatus.status === "connected" ? "Live balance updates connected" : streamStatus.status === "connecting" ? "Connecting live balance updates…" : streamStatus.status === "error" ? `Live updates disconnected: ${streamStatus.message ?? "check engine connection"}` : "Live balance updates disconnected"}
          </span>
          {streamStatus.status !== "connected" && <Link to="/connection" className="shrink-0 text-white/85 underline underline-offset-2">Check</Link>}
        </div>
      </section>

      <section className="relative overflow-hidden rounded-[1.25rem] border border-white/[0.15] bg-gradient-to-br from-white/[0.12] via-[#111111] to-white/[0.035] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
        <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-40 rotate-[-28deg] rounded-full bg-gradient-to-br from-white/[0.14] via-white/[0.025] to-transparent blur-xl" />
        <div className="relative flex items-center gap-1.5 text-xs text-white/65">Total Balance <button type="button" onClick={toggleHide} aria-label={hide ? "Show balance" : "Hide balance"} className="rounded-full p-1 text-white/75 hover:bg-white/10">{hide ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</button></div>
        <div className="relative mt-1 text-[clamp(1.8rem,7vw,2.25rem)] font-semibold leading-tight tracking-tight tabular-nums">{hide ? "••••••" : formatUsd(portfolio.value)}</div>
        <div className="relative mt-1 flex items-center gap-2 text-[11px]"><span className={portfolio.dailyChangeValue >= 0 ? "text-emerald-300" : "text-rose-300"}>{hide ? "••••" : (portfolio.dailyChangeValue >= 0 ? "↑ +" : "↓ ") + formatUsd(Math.abs(portfolio.dailyChangeValue))}</span><span className="text-white/40">(24h estimated change)</span></div>
        <div className="pointer-events-none absolute bottom-3 right-4 flex h-8 w-24 items-end gap-1 opacity-60" aria-hidden="true"><span className="h-2 w-2 rounded-t-full bg-white/50"/><span className="h-3 w-2 rounded-t-full bg-white/60"/><span className="h-2.5 w-2 rounded-t-full bg-white/55"/><span className="h-5 w-2 rounded-t-full bg-white/70"/><span className="h-4 w-2 rounded-t-full bg-white/60"/><span className="h-6 w-2 rounded-t-full bg-white/75"/><span className="h-4 w-2 rounded-t-full bg-white/65"/><span className="h-7 w-2 rounded-t-full bg-white/80"/></div>
      </section>
      <div className="grid grid-cols-5 gap-1 pt-1">
        <Link to="/send" className="flex flex-col items-center gap-1 py-1.5 text-[10px] text-white/85"><span className="grid size-10 place-items-center rounded-full border border-white/[0.13] bg-gradient-to-b from-white/[0.13] to-white/[0.035]"><ArrowUpRight className="size-[18px]" /></span>Send</Link>
        <Link to="/receive" className="flex flex-col items-center gap-1 py-1.5 text-[10px] text-white/85"><span className="grid size-10 place-items-center rounded-full border border-white/[0.13] bg-gradient-to-b from-white/[0.13] to-white/[0.035]"><ArrowDownLeft className="size-[18px]" /></span>Receive</Link>
        <Link to="/swap" className="flex flex-col items-center gap-1 py-1.5 text-[10px] text-white/85"><span className="grid size-10 place-items-center rounded-full border border-white/[0.13] bg-gradient-to-b from-white/[0.13] to-white/[0.035]"><ArrowLeftRight className="size-[18px]" /></span>Swap</Link>
        <Link to="/connection" className="flex flex-col items-center gap-1 py-1.5 text-[10px] text-white/85"><span className="grid size-10 place-items-center rounded-full border border-white/[0.13] bg-gradient-to-b from-white/[0.13] to-white/[0.035]"><Blocks className="size-[18px]" /></span>Scan</Link>
        <Link to="/blockchains" className="flex flex-col items-center gap-1 py-1.5 text-[10px] text-white/85"><span className="grid size-10 place-items-center rounded-full border border-white/[0.13] bg-gradient-to-b from-white/[0.13] to-white/[0.035]"><DollarSign className="size-[18px]" /></span>Buy</Link>
      </div>
    </div>

    <div className="wallet-main-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-28 pt-0">
    <section className="space-y-0">
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-2.5"><div><h2 className="text-sm font-semibold text-white">My Assets</h2></div><Link to="/blockchains" className="text-xs font-medium text-white/70">View all <span aria-hidden="true">›</span></Link></div>
      {!chains.length ? <div className="px-4 py-8 text-center"><div className="mx-auto grid size-9 place-items-center rounded-lg bg-secondary"><Blocks className="size-4" /></div><p className="mt-3 text-sm font-semibold">No networks connected</p><p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">Create or restore a wallet and select the blockchains you want to use.</p></div> : <ProgressiveVirtualTokenList tokens={displayAssets} hidden={hide} formatBalance={formatBalance} />}
    </section>
    </div>
  </div>;
}
