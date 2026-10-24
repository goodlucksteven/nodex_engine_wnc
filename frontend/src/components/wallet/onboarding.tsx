import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Eye, EyeOff, Shield, LoaderCircle, KeyRound, KeySquare, Check, Delete } from "lucide-react";
import { toast } from "sonner";
import { SableMark } from "@/components/brand/sable-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeMnemonic } from "@/lib/wallet/mnemonic";
import { engineRequest, fetchBlockchainCatalog, type SelectedChain } from "@/lib/wallet/engine";
import { useWallet } from "@/lib/wallet/store";
import { cn } from "@/lib/utils";

type Step = "welcome" | "create" | "restore-method" | "phrase" | "phrase-chains" | "key-chains" | "key-secret" | "pin" | "discover" | "backup" | "complete";
type Mode = "create" | "phrase" | "private-key";

export function Onboarding() {
  const navigate = useNavigate();
  const createWallet = useWallet((s) => s.createWallet);
  const restoreWallet = useWallet((s) => s.restoreWallet);
  const importPrivateKey = useWallet((s) => s.importPrivateKey);
  const selectChildAccount = useWallet((s) => s.selectChildAccount);
  const refreshBalances = useWallet((s) => s.refreshBalances);
  const setPin = useWallet((s) => s.setPin);
  const completeSetup = useWallet((s) => s.completeSetup);
  const wallet = useWallet((s) => s.wallet);
  const [step, setStep] = useState<Step>("welcome");
  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("Primary");
  const [restorePhrase, setRestorePhrase] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pin, setPinValue] = useState("");
  const [pin2, setPin2] = useState("");
  const [pinStage, setPinStage] = useState<"enter" | "confirm">("enter");
  const [pinError, setPinError] = useState(false);
  const [allPhraseChains, setAllPhraseChains] = useState(true);
  const [allEvmChains, setAllEvmChains] = useState(false);
  const [chainCatalog, setChainCatalog] = useState<SelectedChain[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedPhrase, setSelectedPhrase] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string[]>([]);
  const [discoveredChildren, setDiscoveredChildren] = useState<Array<{ child_index: number; derivation_path: string; address: string; chainName: string; chainSymbol: string }>>([]);
  const [discoveryChains, setDiscoveryChains] = useState<Array<{ name: string; symbol: string; status: "checked" | "pending" }>>([]);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [selectionPin, setSelectionPin] = useState("");
  const [selectingChild, setSelectingChild] = useState(false);
  const [selectedChildIndex, setSelectedChildIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBlockchainCatalog().then((chains) => {
      if (cancelled) return;
      setChainCatalog(chains);
      setCatalogError(chains.length ? null : "NodeX returned no supported mainnet blockchains.");
    }).catch((error) => {
      if (!cancelled) setCatalogError(error instanceof Error ? error.message : "Could not load supported blockchains from NodeX.");
    }).finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const evmChains = useMemo(() => chainCatalog.filter((chain) => chain.chain_type.toLowerCase() === "evm"), [chainCatalog]);
  const nonEvmChains = useMemo(() => chainCatalog.filter((chain) => chain.chain_type.toLowerCase() !== "evm"), [chainCatalog]);
  const phraseChains = allPhraseChains ? chainCatalog : chainCatalog.filter((chain) => selectedPhrase.includes(chain.chain_id));
  const keyChains = allEvmChains
    ? evmChains
    : chainCatalog.filter((chain) => selectedKey.includes(chain.chain_id));
  const selectedChains = mode === "create" || mode === "phrase" ? phraseChains : keyChains;

  function toggleChain(id: string, checked: boolean, forKey = false) {
    if (forKey) {
      setSelectedKey((previous) => checked ? [...new Set([...previous, id])] : previous.filter((value) => value !== id));
      setAllEvmChains(false);
    } else {
      setSelectedPhrase((previous) => {
        // If all networks were active, the first individual selection means only this network.
        if (allPhraseChains) return checked ? [id] : [];
        return checked ? [...new Set([...previous, id])] : previous.filter((value) => value !== id);
      });
      setAllPhraseChains(false);
    }
  }

  function toggleKeyChain(id: string, checked: boolean) {
    const target = chainCatalog.find((chain) => chain.chain_id === id);
    if (!target) return;
    const isEvm = target.chain_type.toLowerCase() === "evm";
    if (!checked) {
      if (allEvmChains && isEvm) {
        setSelectedKey(evmChains.filter((chain) => chain.chain_id !== id).map((chain) => chain.chain_id));
      } else {
        setSelectedKey((previous) => previous.filter((value) => value !== id));
      }
      setAllEvmChains(false);
      return;
    }
    const currentlySelected = chainCatalog.filter((chain) => selectedKey.includes(chain.chain_id));
    const hasEvm = currentlySelected.some((chain) => chain.chain_type.toLowerCase() === "evm");
    const hasNonEvm = currentlySelected.some((chain) => chain.chain_type.toLowerCase() !== "evm");
    if ((isEvm && hasNonEvm) || (!isEvm && hasEvm)) {
      toast.error("Choose multiple EVM networks, or just one non-EVM blockchain.");
      return;
    }
    if (isEvm) {
      setSelectedKey((previous) => [...new Set([...previous, id])]);
      setAllEvmChains(false);
    } else {
      setSelectedKey([id]);
      setAllEvmChains(false);
    }
  }

  async function onPin(firstPin: string, confirmedPin: string) {
    if (firstPin.length !== 6 || firstPin !== confirmedPin) return;
    if (catalogLoading || catalogError || !selectedChains.length) { toast.error("Select at least one supported blockchain."); return; }
    if (mode === "private-key" && selectedChains.some((chain) => chain.chain_type.toLowerCase() !== "evm") && selectedChains.length > 1) {
      toast.error("Choose one non-EVM blockchain, or select EVM networks only."); return;
    }
    setBusy(true);
    try {
      let importedWallet = null;
      if (mode === "create") await createWallet(name, firstPin, selectedChains);
      else if (mode === "phrase") importedWallet = await restoreWallet(restorePhrase, name, firstPin, selectedChains);
      else await importPrivateKey(privateKey, name, firstPin, selectedChains);
      await setPin(firstPin);
      if (mode === "phrase" && importedWallet) {
        setSelectionPin(firstPin);
        setDiscoveryError(null);
        setDiscoveredChildren([]);
        // The discovery screen is shared by every blockchain. Only dispatch to
        // adapters that are implemented; never report an unimplemented chain as unused.
        const implementedDiscoveryChains = selectedChains.filter((chain) => {
          const identity = `${chain.name} ${chain.symbol} ${chain.chain_type} ${chain.chain_id}`.toLowerCase();
          return identity.includes("tron") || chain.symbol.toLowerCase() === "trx";
        });
        setDiscoveryChains(selectedChains.map((chain) => ({
          name: chain.name,
          symbol: chain.symbol,
          status: implementedDiscoveryChains.some((implemented) => implemented.chain_id === chain.chain_id) ? "checked" : "pending",
        })));
        const found: Array<{ child_index: number; derivation_path: string; address: string; chainName: string; chainSymbol: string }> = [];
        const failures: string[] = [];
        for (const chain of implementedDiscoveryChains) {
          try {
            const response = await engineRequest<Record<string, unknown>>("discover_child_accounts", {
              wallet_id: importedWallet.engineWalletId,
              child_id: importedWallet.childId,
              pin: firstPin,
              chain_type: "tron",
              start_index: 0,
              max_count: 20,
              gap_limit: 3,
            });
            const payload = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : {};
            // Engine and adapter versions wrap discovery results differently:
            // { children }, { raw: { children } }, or
            // { response: { data: { raw: { children } } } }. Unwrap only
            // known response containers so valid child addresses are not lost.
            const findChildren = (value: unknown, depth = 0): unknown[] => {
              if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return [];
              const object = value as Record<string, unknown>;
              if (Array.isArray(object.children)) return object.children;
              for (const key of ["raw", "data", "response", "result", "payload"]) {
                const nested = object[key];
                if (nested && typeof nested === "object") {
                  const children = findChildren(nested, depth + 1);
                  if (children.length) return children;
                }
              }
              return [];
            };
            const candidates = findChildren(payload);
            found.push(...candidates.filter((item): item is Record<string, unknown> =>
              !!item && typeof item === "object" && !Array.isArray(item)
              && Number.isInteger((item as Record<string, unknown>).child_index)
              && typeof (item as Record<string, unknown>).derivation_path === "string"
              && typeof (item as Record<string, unknown>).address === "string"
            ).map((item) => ({
              child_index: Number(item.child_index),
              derivation_path: String(item.derivation_path),
              address: String(item.address),
              chainName: chain.name,
              chainSymbol: chain.symbol,
            })));
          } catch (error) {
            failures.push(`${chain.name}: ${error instanceof Error ? error.message : "discovery failed"}`);
          }
        }
        setDiscoveredChildren(found);
        setDiscoveryError(failures.length ? failures.join(" · ") : null);
        setStep("discover");
      } else {
        setStep("complete");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "NodeX could not create this wallet.";
      toast.error(message, { action: { label: "View logs", onClick: () => { void navigate({ to: "/engine-logs" }); } } });
      setPinValue("");
      setPin2("");
      setPinStage("enter");
    } finally { setBusy(false); }
  }

  function enterPinDigit(key: string) {
    if (busy) return;
    if (key === "del") {
      if (pinStage === "enter") setPinValue((value) => value.slice(0, -1));
      else setPin2((value) => value.slice(0, -1));
      setPinError(false);
      return;
    }
    if (!key || !/^\d$/.test(key)) return;
    if (pinStage === "enter") {
      const next = (pin + key).slice(0, 6);
      setPinValue(next);
      if (next.length === 6) {
        setPin2("");
        setPinError(false);
        setPinStage("confirm");
      }
      return;
    }
    const next = (pin2 + key).slice(0, 6);
    setPin2(next);
    setPinError(false);
    if (next.length === 6) {
      if (next !== pin) {
        setPinError(true);
        setPin2("");
        return;
      }
      void onPin(pin, next);
    }
  }

  function continueFromPhrase() {
    const normalized = normalizeMnemonic(restorePhrase);
    if (![12, 15, 18, 21, 24].includes(normalized.split(" ").length)) {
      toast.error("Enter a valid 12, 15, 18, 21, or 24-word recovery phrase.");
      return;
    }
    setMode("phrase");
    setAllPhraseChains(true);
    setSelectedPhrase([]);
    setStep("phrase-chains");
  }

  function continueFromKeyChains() {
    if (!selectedChains.length) { toast.error("Choose at least one blockchain."); return; }
    const hasEvm = selectedChains.some((chain) => chain.chain_type.toLowerCase() === "evm");
    const hasNonEvm = selectedChains.some((chain) => chain.chain_type.toLowerCase() !== "evm");
    if (hasEvm && hasNonEvm) { toast.error("Choose EVM networks or one non-EVM blockchain, not both."); return; }
    if (hasNonEvm && selectedChains.length > 1) {
      toast.error("Non-EVM private-key imports must use one blockchain at a time."); return;
    }
    setPrivateKey("");
    setStep("key-secret");
  }

  function continueFromPrivateKey() {
    // Trim harmless whitespace; preserve Base58 case and characters for Solana.
    const raw = privateKey.trim().replace(/\s+/g, "");
    if (!raw) { toast.error("Paste your private key."); return; }

    const solanaSelected = selectedChains.length === 1
      && selectedChains[0]?.chain_type.toLowerCase() === "solana";

    if (solanaSelected) {
      const hexKey = raw.replace(/^0x/i, "");
      const looksHex = /^[0-9a-f]+$/i.test(hexKey) && (hexKey.length === 64 || hexKey.length === 128);
      const looksBase58 = /^[1-9A-HJ-NP-Za-km-z]+$/.test(raw);
      if (!looksHex && !looksBase58) {
        toast.error("Enter a Solana Base58 secret key or a 64/128-character hexadecimal key.");
        return;
      }
      setPrivateKey(looksHex ? hexKey : raw);
      setStep("pin");
      return;
    }

    const normalized = raw.replace(/^0x/i, "");
    if (!/^[0-9a-f]+$/i.test(normalized)) {
      toast.error("Private key must contain hexadecimal characters only (0–9 and A–F).");
      return;
    }
    if (normalized.length % 2 !== 0) {
      toast.error("This private key has an odd number of hex digits. Copy it again; do not add or remove digits manually.");
      return;
    }
    if (selectedChains.every((chain) => chain.chain_type.toLowerCase() === "evm") && normalized.length !== 64) {
      toast.error("For EVM networks such as Polygon, the private key must contain exactly 64 hexadecimal digits (32 bytes), with an optional 0x prefix.");
      return;
    }
    setPrivateKey(normalized);
    setStep("pin");
  }

  const back = () => {
    if (step === "restore-method") setStep("welcome");
    else if (step === "phrase") setStep("restore-method");
    else if (step === "phrase-chains") setStep("phrase");
    else if (step === "key-chains") setStep("restore-method");
    else if (step === "key-secret") setStep("key-chains");
    else if (step === "pin") setStep(mode === "create" ? "create" : mode === "phrase" ? "phrase-chains" : "key-secret");
    else if (step === "discover") setStep("complete");
    else setStep("welcome");
  };

  return (
    <div className={cn("relative flex min-h-dvh flex-col bg-background", step === "discover" && "h-dvh overflow-hidden")}>
      <div className={step === "discover" ? "flex min-h-0 w-full flex-1 flex-col" : step === "create" || step === "phrase-chains" || step === "key-chains" ? "flex w-full flex-1 flex-col pb-8" : "mx-auto flex w-full max-w-md flex-1 flex-col px-6 py-8"}>
        {step !== "welcome" && step !== "backup" && step !== "complete" && step !== "create" && step !== "phrase-chains" && step !== "key-chains" && step !== "discover" && (
          <button type="button" onClick={back} className="mb-5 inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Back</button>
        )}

        {step === "welcome" && <div className="flex flex-1 flex-col">
          <div className="stagger-enter flex flex-1 flex-col justify-end pb-10">
            <SableMark className="mb-8 size-12" />
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Sable · NodeX Engine</p>
            <h1 className="mt-3 text-4xl font-medium tracking-tight text-foreground">Your wallet, your choice.</h1>
            <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-muted-foreground">Create a new wallet or restore an existing one using your recovery phrase or private key.</p>
          </div>
          <div className="stagger-enter flex flex-col gap-3">
            <Button size="lg" onClick={() => { setMode("create"); setAllPhraseChains(true); setStep("create"); }}>Create wallet <ArrowRight className="size-4" /></Button>
            <Button size="lg" variant="secondary" onClick={() => { setMode("phrase"); setStep("restore-method"); }}>Restore wallet</Button>
          </div>
        </div>}

        {step === "restore-method" && <div className="flex flex-1 flex-col">
          <Header kicker="Restore wallet" title="How would you like to restore?" copy="Choose the secret you already have. Your secret is sent only to the configured NodeX engine for wallet import." />
          <div className="mt-8 space-y-3">
            <Choice icon={<KeyRound className="size-5" />} title="Recovery phrase" copy="Restore an HD wallet using 12–24 recovery words." onClick={() => { setMode("phrase"); setStep("phrase"); }} />
            <Choice icon={<KeySquare className="size-5" />} title="Private key" copy="Import one non-EVM chain or one or more EVM networks." onClick={() => { setMode("private-key"); setSelectedKey([]); setAllEvmChains(false); setStep("key-chains"); }} />
          </div>
        </div>}

        {step === "create" && <div className="flex min-h-dvh flex-1 flex-col">
          <SelectorTopBar title="Choose blockchains" subtitle="New wallet · Step 1" onBack={back} allSelected={allPhraseChains} onToggleAll={() => setAllPhraseChains((value) => !value)} />
          <ChainSelection chains={chainCatalog} loading={catalogLoading} error={catalogError} allSelected={allPhraseChains} allSelectedType="all" setAllSelected={setAllPhraseChains} selected={selectedPhrase} onToggle={(id, checked) => toggleChain(id, checked)} />
          <div className="pointer-events-none fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] right-4 z-30"><Button size="lg" className="pointer-events-auto rounded-full px-6 shadow-lg" disabled={catalogLoading || !!catalogError || !selectedChains.length} onClick={() => setStep("pin")}>Continue <ArrowRight className="size-4" /></Button></div>
        </div>}

        {step === "phrase" && <div className="flex flex-1 flex-col">
          <Header kicker="Restore · Recovery phrase" title="Enter your recovery phrase" copy="Paste the words in order, separated by spaces. Check that no word is missing before continuing." />
          <div className="mt-7 space-y-2"><Label htmlFor="restore-phrase">Secret recovery phrase</Label><textarea id="restore-phrase" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={restorePhrase} onChange={(e) => setRestorePhrase(e.target.value)} rows={5} className="w-full resize-none rounded-xl bg-secondary px-4 py-3 font-mono text-sm shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-ring/40" placeholder="Paste your recovery words here" /></div>
          <div className="mt-3 rounded-lg bg-card p-3 text-xs leading-relaxed text-muted-foreground"><Shield className="mr-1 inline size-3.5" /> Never share your recovery phrase with anyone, including support.</div>
          <div className="mt-auto pt-8"><Button size="lg" className="w-full" onClick={continueFromPhrase}>Continue to blockchains <ArrowRight className="size-4" /></Button></div>
        </div>}

        {step === "phrase-chains" && <div className="flex min-h-dvh flex-1 flex-col">
          <SelectorTopBar title="Choose networks" subtitle="Restore · Recovery phrase" onBack={back} allSelected={allPhraseChains} onToggleAll={() => { setAllPhraseChains((value) => !value); if (!allPhraseChains) setSelectedPhrase([]); }} />
          <ChainSelection chains={chainCatalog} loading={catalogLoading} error={catalogError} allSelected={allPhraseChains} allSelectedType="all" setAllSelected={(value) => { setAllPhraseChains(value); if (!value) setSelectedPhrase([]); }} selected={selectedPhrase} onToggle={(id, checked) => toggleChain(id, checked)} />
          <div className="pointer-events-none fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] right-4 z-30"><Button size="lg" className="pointer-events-auto rounded-full px-6 shadow-lg" disabled={catalogLoading || !!catalogError || !phraseChains.length} onClick={() => setStep("pin")}>Continue <ArrowRight className="size-4" /></Button></div>
        </div>}

        {step === "key-chains" && <div className="flex min-h-dvh flex-1 flex-col">
          <SelectorTopBar title="Choose blockchains" subtitle="Restore · Private key" onBack={back} allSelected={allEvmChains} allLabel={allEvmChains ? "All EVM ✓" : "All EVM"} onToggleAll={() => { const next = !allEvmChains; setAllEvmChains(next); setSelectedKey(next ? [] : selectedKey.filter((id) => chainCatalog.find((chain) => chain.chain_id === id)?.chain_type.toLowerCase() !== "evm")); }} />
          <ChainSelection chains={chainCatalog} loading={catalogLoading} error={catalogError} allSelected={allEvmChains} allSelectedType="evm" selected={selectedKey} onToggle={(id, checked) => toggleKeyChain(id, checked)} disabledForChain={(chain) => {
            if (allEvmChains) return chain.chain_type.toLowerCase() !== "evm";
            const chosen = chainCatalog.filter((item) => selectedKey.includes(item.chain_id));
            const hasEvm = chosen.some((item) => item.chain_type.toLowerCase() === "evm");
            const hasNonEvm = chosen.some((item) => item.chain_type.toLowerCase() !== "evm");
            return chain.chain_type.toLowerCase() === "evm" ? hasNonEvm : hasEvm || chosen.some((item) => item.chain_type.toLowerCase() !== "evm" && item.chain_id !== chain.chain_id);
          }} />
          <div className="pointer-events-none fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] right-4 z-30"><Button size="lg" className="pointer-events-auto rounded-full px-6 shadow-lg" disabled={catalogLoading || !!catalogError || !keyChains.length} onClick={continueFromKeyChains}>Continue <ArrowRight className="size-4" /></Button></div>
        </div>}

        {step === "key-secret" && <div className="flex flex-1 flex-col">
          <Header kicker="Restore · Private key" title="Enter your private key" copy="Paste the private key for the blockchain selection you just made. It stays hidden by default." />
          <div className="mt-7 space-y-2"><Label htmlFor="private-key">Private key</Label><div className="flex gap-2"><Input id="private-key" type={showSecret ? "text" : "password"} autoComplete="off" spellCheck={false} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="Paste private key" className="font-mono" /><Button type="button" variant="secondary" size="icon" onClick={() => setShowSecret((value) => !value)} aria-label={showSecret ? "Hide private key" : "Show private key"}>{showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button></div><p className="text-xs text-muted-foreground">Never share this key. NodeX request logs redact secret fields.</p></div>
          <div className="mt-auto pt-8"><Button size="lg" className="w-full" disabled={!privateKey.trim()} onClick={continueFromPrivateKey}>Continue · Set PIN <ArrowRight className="size-4" /></Button></div>
        </div>}

        {step === "pin" && <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-background/55 p-3 backdrop-blur-md sm:p-6"><section className="relative flex h-[min(42rem,calc(100dvh_-_1.5rem))] w-full max-w-sm flex-col justify-between gap-3 overflow-hidden rounded-[1.75rem] border border-border/70 bg-card px-6 pt-[calc(env(safe-area-inset-top,0px)_+_1rem)] pb-[calc(env(safe-area-inset-bottom,0px)_+_1rem)] shadow-2xl">
          <style>{`@keyframes pin-toast-drop { from { opacity: 0; transform: translateY(-120%); } to { opacity: 1; transform: translateY(0); } }`}</style>
          {busy && <div role="status" aria-live="polite" className="fixed left-4 right-4 top-[calc(env(safe-area-inset-top,0px)+0.5rem)] z-50 mx-auto flex max-w-sm items-center gap-3 rounded-2xl border border-white/10 bg-card/95 px-4 py-3.5 text-left shadow-2xl backdrop-blur-2xl" style={{ animation: "pin-toast-drop 460ms cubic-bezier(0.2,0.8,0.2,1) both" }}>
            <LoaderCircle className="size-5 shrink-0 animate-spin text-primary" />
            <span className="min-w-0"><span className="block text-sm font-semibold">{mode === "create" ? "Creating your wallet…" : mode === "phrase" ? "Restoring your wallet…" : "Importing your wallet…"}</span><span className="mt-0.5 block text-xs text-muted-foreground">Please wait a moment.</span></span>
          </div>}
          <div className="stagger-enter flex min-h-0 flex-1 flex-col items-center text-center">
            <h1 className="-mt-1 w-full text-2xl font-medium tracking-tight">{pinStage === "enter" ? "Enter your PIN" : "Confirm your PIN"}</h1>
            <SableMark className="mt-6 size-14 shrink-0" />
            <p className="mt-5 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{mode === "create" ? "New wallet" : mode === "phrase" ? "Restore wallet" : "Import wallet"}</p>
            <p className="mt-2 max-w-[17rem] text-sm leading-snug text-muted-foreground">{pinStage === "enter" ? "Choose a six-digit PIN to protect your wallet." : "Enter the same six digits once more."}</p>
            <div className={cn("mt-7 flex gap-3", pinError && "animate-pulse")}>
              {Array.from({ length: 6 }).map((_, i) => <span key={i} className={cn("size-2.5 rounded-full transition-colors duration-150", i < (pinStage === "enter" ? pin.length : pin2.length) ? "bg-foreground" : "bg-foreground/20", pinError && "bg-destructive")} />)}
            </div>
            {pinError && <p className="mt-3 text-sm text-destructive">PINs do not match. Please try again.</p>}
          </div>
          <div className="mx-auto grid w-full max-w-xs shrink-0 grid-cols-3 gap-1.5">
            {["1","2","3","4","5","6","7","8","9","","0","del"].map((key, i) => key === "" ? <span key={i} /> : <button key={key} type="button" disabled={busy} onClick={() => enterPinDigit(key)} className="flex h-[clamp(2.65rem,7.5svh,3.75rem)] items-center justify-center rounded-lg text-xl font-medium tabular-nums transition-[background-color,transform] duration-150 hover:bg-accent active:scale-[0.96] disabled:opacity-40">{key === "del" ? <Delete className="size-5" /> : key}</button>)}
          </div>
        </section></div>}

        {step === "discover" && wallet && <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="sticky top-0 z-20 shrink-0 pt-[env(safe-area-inset-top,0px)]">
            <div className="flex h-10 items-center gap-2 bg-background/75 px-4 sm:px-6">
              <button type="button" onClick={back} aria-label="Go back" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary/75 text-foreground"><ArrowLeft className="size-4" /></button>
              <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">Choose wallet</h1>
              <span className="shrink-0 rounded-full bg-secondary/80 px-2.5 py-1 text-[11px] font-semibold">{new Set(discoveredChildren.map((child) => child.child_index)).size} found</span>
            </div>
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
            <div className="w-full">
              {discoveryError && <div role="alert" className="mx-4 my-3 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive sm:mx-6"><p className="font-semibold">Account discovery error</p><p className="mt-1 break-words text-xs leading-relaxed">{discoveryError}</p></div>}
              {[...new Set(discoveredChildren.map((child) => child.child_index))].sort((a, b) => a - b).map((childIndex) => {
                const children = discoveredChildren.filter((child) => child.child_index === childIndex);
                const isSelected = selectedChildIndex === childIndex;
                return <button key={childIndex} type="button" disabled={selectingChild} aria-pressed={isSelected} onClick={() => setSelectedChildIndex(childIndex)} className={cn("flex min-h-[68px] w-full items-start gap-3 border-b border-white/[0.055] px-4 py-3 text-left transition-colors last:border-b-0 sm:px-6", isSelected && "bg-secondary/40", selectingChild && "opacity-60")}>
                  <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full border border-white/[0.08] text-[10px] font-bold tracking-tight", isSelected ? "bg-foreground text-background" : "bg-secondary/70 text-foreground/90")}><KeyRound className="size-4" /></span>
                  <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-medium">Wallet {childIndex + 1}{isSelected && <Check className="size-4 text-primary" />}</span>
                    {children.map((child) => <span key={child.chainSymbol + child.address} className="mt-1.5 block min-w-0"><span className="block text-[11px] text-muted-foreground">{child.chainName} · {child.chainSymbol}</span><span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{child.address}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{child.derivation_path}</span></span>)}
                    {discoveryChains.some((chain) => chain.status === "pending") && <span className="mt-1.5 block text-[11px] text-muted-foreground">Some selected chains are awaiting discovery support.</span>}
                  </span>
                  <span className={cn("mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border", isSelected ? "border-foreground bg-foreground text-background" : "border-muted-foreground/45")}>{isSelected && <Check className="size-3.5" />}</span>
                </button>;
              })}
              {!discoveredChildren.length && !discoveryError && <div className="px-4 py-5 text-sm text-muted-foreground sm:px-6"><p className="font-medium text-foreground">No wallets found</p><p className="mt-1 leading-relaxed">No accounts were returned by the available discovery adapters. Chains without an implemented adapter remain pending.</p></div>}
              {!discoveredChildren.length && discoveryError && <div className="px-4 pb-4 text-sm text-muted-foreground sm:px-6">Fix the discovery error above or continue with Wallet 1.</div>}
            </div>
          </main>
          <div className="pointer-events-none fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] right-4 z-30">
            <Button size="lg" className="pointer-events-auto rounded-full px-6 shadow-lg" disabled={selectingChild} onClick={async () => {
              setSelectingChild(true);
              try {
                const childIndex = selectedChildIndex ?? wallet.childIndex ?? 0;
                if (childIndex !== wallet.childIndex) {
                  await selectChildAccount(childIndex, selectionPin);
                  toast.success(`Wallet ${childIndex + 1} selected`);
                }
                setStep("complete");
                void refreshBalances().catch((error) => toast.error(error instanceof Error ? error.message : "Balance refresh failed."));
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not select this wallet.");
              } finally { setSelectingChild(false); }
            }}>{selectingChild ? <LoaderCircle className="size-4 animate-spin" /> : <>Continue <ArrowRight className="size-4" /></>}</Button>
          </div>
        </div>}

        {step === "complete" && wallet && <div className="flex min-h-dvh flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <div className="stagger-enter flex w-full max-w-sm flex-col items-center">
            <div className="relative mb-8 flex size-28 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 shadow-[0_0_70px_rgba(16,185,129,0.12)]">
              <span className="absolute inset-0 rounded-full border border-emerald-500/20 animate-ping" />
              <span className="absolute inset-2 rounded-full border border-emerald-500/20" />
              <Check className="size-12 animate-[sable-pulse_1.8s_ease-in-out_infinite]" strokeWidth={2.5} />
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{mode === "private-key" ? "Import complete" : "Setup complete"}</p>
            <h1 className="mt-3 text-3xl font-medium tracking-tight">{mode === "private-key" ? "Wallet imported" : mode === "phrase" ? "Wallet restored" : "Your wallet is ready"}</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Your wallet has been registered with NodeX Engine and is ready to use.</p>
          </div>
          <div className="mt-12 w-full max-w-sm">
            <Button size="lg" className="h-14 w-full rounded-2xl shadow-lg" onClick={() => completeSetup()}>Continue to my wallet <ArrowRight className="size-4" /></Button>
          </div>
        </div>}
      </div>
    </div>
  );
}

function SelectorTopBar({ title, subtitle, onBack, allSelected, allLabel, onToggleAll }: { title: string; subtitle: string; onBack: () => void; allSelected: boolean; allLabel?: string; onToggleAll: () => void }) {
  return <div className="sticky top-0 z-20 flex items-center gap-3 bg-background/75 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] backdrop-blur-2xl">
    <button type="button" onClick={onBack} aria-label="Go back" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary/75 text-foreground shadow-md backdrop-blur-2xl"><ArrowLeft className="size-[18px]" /></button>
    <div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{subtitle}</p><h1 className="mt-1 truncate text-lg font-semibold tracking-tight">{title}</h1></div>
    <button type="button" onClick={onToggleAll} className="shrink-0 rounded-full bg-secondary/80 px-4 py-2.5 text-xs font-semibold shadow-md backdrop-blur-2xl">{allLabel ?? (allSelected ? "Deselect all" : "Select all")}</button>
  </div>;
}
function ChainSelection({ chains, loading, error, allSelected, allSelectedType = "all", selected, onToggle, disabledForChain }: { chains: SelectedChain[]; loading: boolean; error: string | null; allSelected: boolean; allSelectedType?: "all" | "evm"; setAllSelected?: (value: boolean) => void; selected: string[]; onToggle: (id: string, checked: boolean) => void; disabledForChain?: (chain: SelectedChain) => boolean }) {
  return <div className="w-full flex-1 pb-24">
    <p className="px-4 py-2 text-xs text-muted-foreground">{allSelected ? "All " + chains.length + " networks selected" : selected.length + " selected · " + chains.length + " available"}</p>
    {loading && <p className="px-4 py-4 text-sm text-muted-foreground">Loading supported blockchains from NodeX…</p>}
    {error && <p role="alert" className="mx-4 my-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    <div className="w-full">{chains.map((chain) => <ChainRow key={chain.chain_id} chain={chain} checked={allSelected ? allSelectedType === "evm" ? chain.chain_type.toLowerCase() === "evm" : true : selected.includes(chain.chain_id)} disabled={disabledForChain?.(chain)} onChange={(checked) => onToggle(chain.chain_id, checked)} />)}</div>
  </div>;
}
function ChainRow({ chain, checked, disabled, onChange }: { chain: SelectedChain; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const symbol = chain.symbol.trim().slice(0, 4).toUpperCase();
  return <label className={cn("flex min-h-[68px] w-full cursor-pointer items-center gap-3 border-b border-white/[0.055] px-4 py-3 transition-colors last:border-b-0", checked && "bg-secondary/35", disabled && "cursor-default")}>
    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-secondary/70 text-[10px] font-bold tracking-tight text-foreground/90">{symbol || "◈"}</span>
    <span className="min-w-0 flex-1"><span className="block text-sm font-medium leading-snug">{chain.name}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{chain.symbol} · {chain.chain_type} · {chain.chain_id}</span></span>
    <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors", checked ? "border-foreground bg-foreground text-background" : "border-muted-foreground/45 bg-transparent", disabled && "opacity-90")}>{checked && <Check className="size-3.5" />}</span>
    <input aria-label={"Select " + chain.name} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
  </label>;
}
function Choice({ icon, title, copy, onClick }: { icon: React.ReactNode; title: string; copy: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-4 rounded-xl bg-card p-4 text-left shadow-[var(--shadow-border)] transition-colors hover:bg-secondary"><span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-secondary">{icon}</span><span className="min-w-0 flex-1"><span className="block font-semibold">{title}</span><span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{copy}</span></span><ArrowRight className="size-4 shrink-0 text-muted-foreground" /></button>;
}
function Header({ kicker, title, copy }: { kicker: string; title: string; copy: string }) {
  return <div className="stagger-enter pt-2"><p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{kicker}</p><h1 className="mt-3 text-3xl font-medium tracking-tight">{title}</h1><p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{copy}</p></div>;
}
