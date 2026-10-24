import { useEffect, useMemo, useState } from "react";
import { formatUsdPrecise } from "@/lib/utils";
import { CachedTokenLogo } from "@/components/wallet/cached-token-logo";
import { getTokenPriceIdentity, nativePriceKey, tokenPriceKey, usePrices } from "@/lib/wallet/prices";
import { usdValueFromBalance } from "@/lib/wallet/valuation";

type TokenLike = {
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
  logoUrl?: string | null;
  image_url?: string | null;
  imageUrl?: string | null;
  icon_url?: string | null;
  chainType?: string;
  blockchain?: string;
  chainName?: string;
  chainSymbol?: string;
  chainLogoUrl?: string | null;
  isNative?: boolean;
  price_usd?: number | null;
  price_change_24h_percentage?: number | null;
};

type ProgressiveTokenListProps = {
  tokens: TokenLike[];
  chainType?: string;
  blockchain?: string;
  hidden: boolean;
  formatBalance: (value: unknown, decimals?: number) => string;
};

const BATCH_SIZE = 12;
const BATCH_DELAY_MS = 16;

function decodedText(value: unknown): string {
  let candidate = String(value ?? "").trim();
  if (/^(?:[0-9a-fA-F]{2})+$/.test(candidate)) {
    try {
      const bytes = candidate.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16));
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      if (/^[\x20-\x7E]+$/.test(decoded) && /[A-Za-z]/.test(decoded)) candidate = decoded;
    } catch { /* Keep original metadata if it is not valid UTF-8 hex text. */ }
  }
  return candidate;
}

function safeImageUrl(value: unknown): string | undefined {
  const candidate = decodedText(value);
  return /^https?:\/\//i.test(candidate) ? candidate : undefined;
}

function tokenKey(token: TokenLike, index: number, chainType: string) {
  const address = String(token.address ?? "").trim();
  if (address) return chainType.trim().toLowerCase() === "evm" ? address.toLowerCase() : address;
  return `${String(token.blockchain ?? "").toLowerCase()}|${chainType.trim().toLowerCase()}|${String(token.name ?? "").trim().toLowerCase()}|${String(token.symbol ?? "").trim().toLowerCase()}|${String(token.decimals ?? "")}|${index}`;
}

/**
 * Progressive rendering only; this component deliberately has no scroll
 * container, fixed-height viewport, virtual spacer, or card. All rows remain
 * in the homepage's single scrolling document with the network cards.
 */
export function ProgressiveVirtualTokenList({
  tokens,
  chainType = "",
  blockchain = "",
  hidden,
  formatBalance,
}: ProgressiveTokenListProps) {
  const liveTokenPrices = usePrices((state) => state.tokenPrices);
  const liveNativePrices = usePrices((state) => state.nativePrices);
  const prices = usePrices((state) => state.prices);
  const [renderedCount, setRenderedCount] = useState(8);
  const uniqueTokens = useMemo(() => {
    const seen = new Set<string>();
    return tokens.filter((token) => {
      const address = String(token.address ?? "").trim();
      if (!address) return true;
      const tokenChainType = String(token.chainType ?? chainType).trim().toLowerCase();
      const identity = `${String(token.blockchain ?? blockchain).trim().toLowerCase()}|${tokenChainType}|${tokenChainType === "evm" ? address.toLowerCase() : address}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }, [tokens, chainType, blockchain]);
  const tokenCount = uniqueTokens.length;

  useEffect(() => {
    if (renderedCount >= tokenCount) return;
    let cancelled = false;
    let timer: number | undefined;
    const revealNextBatch = () => {
      if (cancelled) return;
      setRenderedCount((count) => Math.min(Math.max(count, 0) + BATCH_SIZE, tokenCount));
      timer = window.setTimeout(revealNextBatch, BATCH_DELAY_MS);
    };
    timer = window.setTimeout(revealNextBatch, 16);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [renderedCount, tokenCount]);

  useEffect(() => {
    if (renderedCount > tokenCount) setRenderedCount(tokenCount);
  }, [renderedCount, tokenCount]);

  const visibleTokens = useMemo(() => uniqueTokens.slice(0, renderedCount), [uniqueTokens, renderedCount]);

  return (
    <div aria-label="Token balances" aria-busy={renderedCount < tokenCount} className="min-w-0">
      {visibleTokens.map((token, index) => {
        const name = decodedText(token.name ?? token.symbol ?? "Unknown token").trim() || "Unknown token";
        const symbol = decodedText(token.symbol ?? "").trim();
        const effectiveChainType = String(token.chainType ?? chainType);
        const effectiveBlockchain = String(token.blockchain ?? blockchain);
        const address = token.isNative ? String(token.symbol ?? "").trim().toUpperCase() : getTokenPriceIdentity(token, effectiveBlockchain);
        const logoUrl = safeImageUrl(token.logo_url ?? token.logoUrl ?? token.image_url ?? token.imageUrl ?? token.icon_url);
        const nativeSymbol = String(token.symbol ?? "").trim().toUpperCase();
        const livePrice = !token.isNative && address && effectiveBlockchain
          ? liveTokenPrices[tokenPriceKey(effectiveBlockchain, address, effectiveChainType)]
          : undefined;
        const liveNativePrice = token.isNative && nativeSymbol && effectiveBlockchain
          ? liveNativePrices[nativePriceKey(effectiveBlockchain, nativeSymbol)]
          : undefined;
        const nativePriceId: Record<string, string> = { ETH: "ethereum", WETH: "ethereum", BTC: "bitcoin", WBTC: "bitcoin", USDC: "usd-coin", SOL: "solana", LINK: "chainlink", UNI: "uniswap" };
        const fallbackNativePrice = nativePriceId[nativeSymbol] ? prices[nativePriceId[nativeSymbol] as keyof typeof prices]?.usd : undefined;
        const price = (token.isNative ? liveNativePrice?.usd ?? fallbackNativePrice : livePrice?.usd)
          ?? (typeof token.price_usd === "number" && Number.isFinite(token.price_usd) && token.price_usd >= 0 ? token.price_usd : undefined);
        const change = (token.isNative ? liveNativePrice?.usd_24h_change : livePrice?.usd_24h_change)
          ?? (typeof token.price_change_24h_percentage === "number" && Number.isFinite(token.price_change_24h_percentage) ? token.price_change_24h_percentage : undefined);
        const tokenValue = usdValueFromBalance(token.balance, token.decimals ?? undefined, price);
        return (
          <div
            key={tokenKey(token, index, chainType)}
            data-token-address={token.address ?? token.contract_address ?? token.contractAddress ?? undefined}
            style={{ animationDelay: `${Math.min(index * 12, 180)}ms` }}
            className="token-float-row flex min-h-[3.25rem] items-center gap-2.5 border-b border-white/[0.055] px-1.5 py-1.5 motion-reduce:animate-none"
          >
            <div className="relative size-8 shrink-0">
              <span className="flex size-8 items-center justify-center rounded-full bg-white/[0.09] text-[9px] font-semibold text-white/85">{(symbol || name.slice(0, 3)).slice(0, 3).toUpperCase()}</span>
              {logoUrl && <CachedTokenLogo url={logoUrl} alt={`${name} logo`} fallbackFavicon className="absolute inset-0 z-10 size-full rounded-full bg-[#171717] object-contain" />}
              {!token.isNative && token.chainLogoUrl && <span title={`${token.chainName ?? "Blockchain"} network`} className="absolute -bottom-1 -right-1 z-20 size-4 overflow-hidden rounded-full bg-background p-0.5 shadow-sm"><CachedTokenLogo url={token.chainLogoUrl} alt={`${token.chainName ?? "Blockchain"} logo`} className="size-full rounded-full object-contain" /></span>}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-white">{name}</p>
              <p className="mt-0.5 truncate text-[11px] text-white/50 tabular-nums">{hidden ? "••••••" : formatBalance(token.balance ?? "0", token.decimals ?? undefined)}</p>
            </div>
            <div className="min-w-0 max-w-[40vw] text-right">
              <p className="truncate text-[15px] font-medium tracking-tight text-white tabular-nums">{hidden ? "••••" : tokenValue !== undefined ? formatUsdPrecise(tokenValue) : "Price unavailable"}</p>
              <p className={`mt-0.5 truncate text-[11px] tabular-nums ${change === undefined ? "text-white/40" : change >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{change === undefined ? "0.0000%" : `${change >= 0 ? "+" : ""}${change.toFixed(4)}%`}</p>
            </div>
          </div>
        );
      })}
      {renderedCount < tokenCount && tokenCount > 0 && (
        <p className="py-1 text-[10px] text-muted-foreground" aria-live="polite">
          Loading tokens… {Math.min(renderedCount, tokenCount).toLocaleString()} of {tokenCount.toLocaleString()}
        </p>
      )}
    </div>
  );
}
