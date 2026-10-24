import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, LoaderCircle, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/wallet/copy-button";
import { ProgressiveVirtualTokenList } from "@/components/wallet/progressive-virtual-token-list";
import { useWallet, walletChainKey } from "@/lib/wallet/store";
import { getTokenCareBlockchain, nativePriceKey, usePrices } from "@/lib/wallet/prices";
import { formatUsdPrecise } from "@/lib/utils";
import { usdValueFromBalance } from "@/lib/wallet/valuation";

export const Route = createFileRoute("/_app/blockchains")({ component: BlockchainsPage });
function displayName(chain: Record<string, unknown>) { return String(chain.name ?? chain.chain_name ?? chain.chain_type ?? "Blockchain").replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function shortAddress(address: string) { return address.length > 26 ? `${address.slice(0, 12)}…${address.slice(-8)}` : address || "Address unavailable"; }
function formatBalance(value: unknown, decimals?: number) {
  const raw = String(value ?? "").trim(); if (!raw) return "—";
  const parsed = Number(raw.replace(/,/g, "")); if (!Number.isFinite(parsed)) return raw;
  const amount = Number.isInteger(decimals) && Number(decimals) >= 0 && Number(decimals) <= 255 ? parsed / 10 ** Number(decimals) : parsed;
  if (amount === 0) return "0";
  const digits = Math.abs(amount) >= 0.0001 ? 4 : Math.min(14, Math.max(4, -Math.floor(Math.log10(Math.abs(amount))) + 4));
  return amount.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0, useGrouping: true });
}
function BlockchainsPage() {
  const wallet = useWallet((s) => s.wallet);
  const balances = useWallet((s) => s.balances);
  const states = useWallet((s) => s.chainFetchState);
  const hide = useWallet((s) => s.hideBalances);
  const nativePrices = usePrices((s) => s.nativePrices);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const chains = wallet?.chainAddresses ?? [];
  return <div className="mx-auto w-full max-w-7xl space-y-4 px-3 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-12">
    <header><p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Wallet settings</p><h1 className="mt-1 text-xl font-semibold tracking-tight">Networks</h1><p className="mt-1 text-xs text-muted-foreground">Independent balances, addresses, and request status.</p></header>
    <section className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-3"><div className="grid size-9 place-items-center rounded-lg bg-secondary"><WalletCards className="size-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{chains.length} connected networks</p><p className="mt-0.5 text-[11px] text-muted-foreground">Tap a network to inspect its address and response.</p></div></section>
    {!chains.length ? <section className="rounded-xl border border-border bg-card px-4 py-10 text-center"><p className="text-sm font-medium">No networks connected</p><p className="mt-1 text-xs text-muted-foreground">Create or restore a wallet and select the networks you need.</p></section> : <div className="space-y-1.5">{chains.map((chain) => {
      const id = String(chain.chain_id ?? "");
      const address = String(chain.address ?? "");
      const key = walletChainKey(chain);
      const name = displayName(chain);
      const canonicalBalances = balances.filter((item) => item.chain_key === key);
      const candidates = canonicalBalances.length ? canonicalBalances : balances.filter((item) => {
        if (item.chain_key) return false;
        if (!id || String(item.chain_id ?? "").trim().toLowerCase() !== id.trim().toLowerCase()) return false;
        if (item.chain_type && String(item.chain_type).trim().toLowerCase() !== String(chain.chain_type ?? "").trim().toLowerCase()) return false;
        const itemName = String(item.chain_name ?? item.name ?? "").trim().toLowerCase();
        const chainName = String(chain.name ?? chain.chain_name ?? "").trim().toLowerCase();
        return !itemName || !chainName || itemName === chainName;
      });
      const balance = candidates.length === 1 ? candidates[0] : undefined;
      const state = states[key] ?? { status: "idle" as const };
      const native = balance?.native;
      const blockchain = getTokenCareBlockchain(balance ?? chain);
      const nativeSymbol = String(native?.symbol ?? chain.symbol ?? "").trim();
      const nativePrice = nativePrices[nativePriceKey(blockchain, nativeSymbol)]?.usd
        ?? (typeof native?.price_usd === "number" && Number.isFinite(native.price_usd) && native.price_usd >= 0 ? native.price_usd : undefined);
      const nativeValue = usdValueFromBalance(native?.balance, native?.decimals, nativePrice);
      const isOpen = Boolean(expanded[key]);
      return <article key={key} className="overflow-hidden rounded-xl border border-border bg-card">
        <button type="button" onClick={() => setExpanded((s) => ({ ...s, [key]: !s[key] }))} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-secondary/30">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-[10px] font-semibold">{String(chain.symbol ?? native?.symbol ?? name.slice(0, 3)).slice(0, 3).toUpperCase()}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{name}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{String(chain.symbol ?? native?.symbol ?? "Native asset")}{id ? ` · ID ${id}` : ""}</span></span>
          <span className="min-w-0 text-right"><span className="block max-w-[40vw] truncate text-sm font-semibold tabular-nums">{hide ? "••••••" : formatBalance(native?.balance, native?.decimals)}</span><span className="mt-0.5 block text-xs font-semibold tabular-nums text-muted-foreground">{hide ? "••••" : nativeValue !== undefined ? formatUsdPrecise(nativeValue) : "Price unavailable"}</span></span>
          <span className="grid size-5 shrink-0 place-items-center">{state.status === "loading" ? <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" /> : state.status === "success" ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : state.status === "error" ? <CircleAlert className="size-3.5 text-destructive" /> : null}</span>
          {isOpen ? <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
        </button>
        {isOpen && <div className="space-y-3 border-t border-border px-3 py-3">
          <div><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Wallet address</p><p className="mt-1 break-all font-mono text-[11px] leading-relaxed">{address || "No address returned"}</p><div className="mt-2 flex flex-wrap items-center gap-2">{address && <CopyButton value={address} label="Copy address" />}{chain.derivation_path && <span className="text-[10px] text-muted-foreground">Path: {String(chain.derivation_path)}</span>}</div></div>
          {state.status === "error" && <div className="rounded-lg border border-destructive/20 bg-destructive/[0.04] p-2.5"><p className="text-[10px] font-semibold text-destructive">Balance request failed</p><p className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">{state.message ?? "The engine did not provide an error detail."}</p><Link to="/engine-logs" className="mt-2 inline-block text-[10px] underline underline-offset-4">Open full request log</Link></div>}
          {balance?.tokens?.length ? <div className="border-t border-border pt-2.5"><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Tokens</p><div className="space-y-1.5"><ProgressiveVirtualTokenList tokens={balance.tokens} chainType={String(chain.chain_type ?? "")} blockchain={blockchain} hidden={hide} formatBalance={(value, decimals) => formatBalance(value, decimals)} /></div></div> : null}
        </div>}
      </article>;
    })}</div>}
    <Button variant="secondary" className="h-10 w-full rounded-xl" asChild><Link to="/">Back to portfolio</Link></Button>
  </div>;
}
