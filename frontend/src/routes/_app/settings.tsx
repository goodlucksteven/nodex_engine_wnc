import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  ArrowRight, Blocks, BookOpen, Check, Copy, Eye, EyeOff,
  KeyRound, LockKeyhole, RadioTower, ShieldCheck, SlidersHorizontal, Trash2, Wallet, Wrench,
} from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/wallet/copy-button";
import { useWallet } from "@/lib/wallet/store";
import { truncateAddress } from "@/lib/utils";
import { usePrices } from "@/lib/wallet/prices";
import { clearTokenCareApiKey, getTokenCareApiKey, saveTokenCareApiKey } from "@/lib/wallet/token-care";
import { reconnectEventStream } from "@/lib/wallet/event-stream";
import { SETTINGS_ITEMS, SETTINGS_SECTION_ACTIVE_EVENT, SETTINGS_SECTION_SELECT_EVENT, type SettingsSection } from "@/lib/settings-navigation";

export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

type LocalSecret = { id: string; name: string; value: string };

const SECRET_STORAGE_KEY = "nodex.settings.local-secrets";
function loadSecrets(): LocalSecret[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(SECRET_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.value === "string") : [];
  } catch { return []; }
}



function SettingsPage() {
  const wallet = useWallet((s) => s.wallet)!;
  const hide = useWallet((s) => s.hideBalances);
  const toggleHide = useWallet((s) => s.toggleHideBalances);
  const rename = useWallet((s) => s.rename);
  const lock = useWallet((s) => s.lock);
  const reset = useWallet((s) => s.reset);
  const setPin = useWallet((s) => s.setPin);
  const navigate = useNavigate();

  const [section, setSection] = useState<SettingsSection>("wallet");

  useEffect(() => {
    const onSelect = (event: Event) => setSection((event as CustomEvent<SettingsSection>).detail);
    window.addEventListener(SETTINGS_SECTION_SELECT_EVENT, onSelect);
    return () => window.removeEventListener(SETTINGS_SECTION_SELECT_EVENT, onSelect);
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_ACTIVE_EVENT, { detail: section }));
  }, [section]);
  const [name, setName] = useState(wallet.name);
  const [nameEditing, setNameEditing] = useState(false);
  const [pin, setPinValue] = useState("");
  const [showPhrase, setShowPhrase] = useState(false);
  const [tokenCareKey, setTokenCareKey] = useState(() => getTokenCareApiKey());
  const [showTokenCareKey, setShowTokenCareKey] = useState(false);
  const [savedTokenCareKey, setSavedTokenCareKey] = useState(() => Boolean(getTokenCareApiKey()));
  const [testingTokenCareKey, setTestingTokenCareKey] = useState(false);
  const [tokenCareKeyResult, setTokenCareKeyResult] = useState<string | null>(null);
  const [checkingPrices, setCheckingPrices] = useState(false);
  const [priceResult, setPriceResult] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<LocalSecret[]>(loadSecrets);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [showSecretValues, setShowSecretValues] = useState(false);
  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);

  const saveSecrets = (next: LocalSecret[]) => {
    try {
      window.localStorage.setItem(SECRET_STORAGE_KEY, JSON.stringify(next));
      setSecrets(next);
      reconnectEventStream();
    } catch {
      toast.error("Could not save secrets in this browser.");
    }
  };

  const selectedItem = SETTINGS_ITEMS.find((item) => item.id === section) ?? SETTINGS_ITEMS[0]!;
  const SelectedIcon = selectedItem.icon;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-28 pt-1 sm:px-6 lg:px-8 lg:pb-12 lg:pt-5">
      <div className="min-w-0">
        <section key={section} className="min-w-0 animate-in fade-in slide-in-from-right-2 duration-200">
          <div className="mb-5 hidden items-center gap-3 border-b border-border/70 pb-4 md:flex">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary/80"><SelectedIcon className="size-[18px]" /></div>
            <div className="min-w-0"><h2 className="font-semibold tracking-tight">{selectedItem.title}</h2><p className="mt-0.5 text-xs text-muted-foreground">{selectedItem.description}</p></div>
          </div>

          {section === "wallet" && <div className="space-y-1">
            <div className="flex items-center gap-3 border-b border-border/60 py-4">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary/70"><Wallet className="size-[18px]" /></div>
              <div className="min-w-0 flex-1"><p className="font-medium">{wallet.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{wallet.chainAddresses.length} network{wallet.chainAddresses.length === 1 ? "" : "s"} connected</p></div>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-4" /> Wallet</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-b border-border/60 py-4">
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">Wallet name</p><p className="mt-1 text-xs text-muted-foreground">{nameEditing ? "Choose a name that helps you recognize this wallet." : name}</p></div>
              {!nameEditing && <Button variant="outline" size="sm" onClick={() => setNameEditing(true)}>Edit name</Button>}
            </div>
            {nameEditing && <div className="flex gap-2 border-b border-border/60 py-4">
              <Input aria-label="Wallet name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoFocus />
              <Button disabled={!name.trim()} onClick={() => { rename(name.trim()); setName(name.trim()); setNameEditing(false); toast("Wallet name saved"); }}><Check className="mr-1.5 size-4" />Save</Button>
              <Button variant="ghost" onClick={() => { setName(wallet.name); setNameEditing(false); }}>Cancel</Button>
            </div>}
            <InfoRow label="Wallet ID" value={wallet.engineWalletId} />
            <InfoRow label="Wallet account" value={wallet.childId} />
            <div className="pt-4"><Button variant="outline" size="sm" onClick={() => setSection("networks")}>View connected networks <ArrowRight className="ml-2 size-4" /></Button></div>
          </div>}

          {section === "networks" && <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">Review the networks attached to this wallet, their addresses, and balance details.</p>
            <div className="divide-y divide-border/60 border-y border-border/60">
              {wallet.chainAddresses.map((chain, index) => <div key={String(chain.chain_id ?? chain.name ?? index)} className="flex min-w-0 items-center gap-3 py-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary/70"><Blocks className="size-4" /></div>
                <div className="min-w-0 flex-1"><p className="text-sm font-medium">{String(chain.name ?? chain.chain_name ?? chain.symbol ?? "Network")}</p><p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{String(chain.address ?? "Address unavailable")}</p></div>
              </div>)}
              {!wallet.chainAddresses.length && <p className="py-4 text-sm text-muted-foreground">No connected network addresses were returned for this wallet.</p>}
            </div>
            <Button variant="outline" onClick={() => void navigate({ to: "/blockchains" })}>Open network details <ArrowRight className="ml-2 size-4" /></Button>
          </div>}

          {section === "connections" && <div className="space-y-5">
            <div className="flex items-start gap-3 border-b border-border/60 pb-4"><div className="min-w-0 flex-1"><p className="text-sm font-medium">Engine event stream</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Live wallet events are managed by the app connection. Open connection tools to inspect its current status and diagnostics.</p></div><Button variant="outline" size="sm" onClick={() => void navigate({ to: "/connection" })}>Open <ArrowRight className="ml-1.5 size-4" /></Button></div>
            <div className="space-y-3">
              <div><h3 className="text-sm font-medium">TokenCare API</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">This key is saved in this browser and sent through the frontend server proxy. It does not modify Render environment variables.</p></div>
              <div className="space-y-1.5"><Label htmlFor="tokencare-api-key">API key</Label><div className="flex gap-2"><Input id="tokencare-api-key" type={showTokenCareKey ? "text" : "password"} autoComplete="off" spellCheck={false} value={tokenCareKey} placeholder="Paste TokenCare API key" onChange={(event) => { setTokenCareKey(event.target.value); setSavedTokenCareKey(false); setTokenCareKeyResult(null); }} className="min-w-0 font-mono" /><Button type="button" variant="secondary" size="icon" aria-label={showTokenCareKey ? "Hide API key" : "Show API key"} onClick={() => setShowTokenCareKey((value) => !value)}>{showTokenCareKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button></div></div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!tokenCareKey.trim()} onClick={() => { try { saveTokenCareApiKey(tokenCareKey); setTokenCareKey(tokenCareKey.trim()); setSavedTokenCareKey(true); setTokenCareKeyResult("API key saved in this browser. Test the connection to verify it."); toast("TokenCare API key saved"); } catch (error) { const message = error instanceof Error ? error.message : "Could not save the API key."; setTokenCareKeyResult(message); toast.error(message); } }}>Save key</Button>
                <Button size="sm" variant="outline" disabled={!savedTokenCareKey || testingTokenCareKey} onClick={async () => { setTestingTokenCareKey(true); setTokenCareKeyResult(null); try { const before = usePrices.getState().updatedAt; await usePrices.getState().refresh(true); const state = usePrices.getState(); const updated = state.updatedAt > before && state.status === "partial"; const message = updated ? "Prices received from the request." : "Request completed, but no valid prices were returned. Check request logs."; setTokenCareKeyResult(message); toast(updated ? "TokenCare connection tested" : "No valid prices returned"); } catch (error) { const message = error instanceof Error ? error.message : "TokenCare connection failed."; setTokenCareKeyResult(message); toast.error(message); } finally { setTestingTokenCareKey(false); } }}>{testingTokenCareKey ? "Testing…" : "Test connection"}</Button>
                <Button size="sm" variant="ghost" disabled={!tokenCareKey && !savedTokenCareKey} onClick={() => { clearTokenCareApiKey(); setTokenCareKey(""); setSavedTokenCareKey(false); setTokenCareKeyResult("Browser-saved TokenCare key cleared. A server environment key may still be configured."); toast("Browser key cleared"); }}>Clear key</Button>
              </div>
              {tokenCareKeyResult && <p role="status" aria-live="polite" className="break-words rounded-md bg-secondary/60 p-3 text-xs leading-relaxed">{tokenCareKeyResult}</p>}
              <div className="flex items-center gap-3 border-t border-border/60 pt-4"><div className="min-w-0 flex-1"><p className="text-sm font-medium">Price refresh</p><p className="mt-1 text-xs text-muted-foreground">{priceResult ?? "Request prices and inspect the response in logs."}</p></div><Button size="sm" variant="outline" disabled={checkingPrices} onClick={async () => { setCheckingPrices(true); setPriceResult(null); try { const before = usePrices.getState().updatedAt; await usePrices.getState().refresh(true); const state = usePrices.getState(); const updated = state.updatedAt > before && state.status === "partial"; setPriceResult(updated ? `Response received · ${new Date(state.updatedAt).toLocaleTimeString()}` : "No valid prices returned. Check logs."); toast(updated ? "Price refresh complete" : "No valid prices returned"); } catch (error) { const message = error instanceof Error ? error.message : "Price request failed"; setPriceResult(message); toast.error(message); } finally { setCheckingPrices(false); } }}>{checkingPrices ? "Loading…" : "Get prices"}</Button></div>
            </div>
          </div>}

          {section === "logs" && <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">Inspect redacted engine requests, responses, errors, and event-stream diagnostics when something fails.</p>
            <button type="button" onClick={() => void navigate({ to: "/engine-logs" })} className="flex w-full items-center gap-3 border-y border-border/60 py-4 text-left transition-colors hover:bg-secondary/30"><div className="grid size-9 place-items-center rounded-lg bg-secondary/70"><BookOpen className="size-4" /></div><span className="flex-1"><span className="block text-sm font-medium">Open request and response logs</span><span className="mt-1 block text-xs text-muted-foreground">Review errors and the exact redacted response.</span></span><ArrowRight className="size-4 text-muted-foreground" /></button>
          </div>}

          {section === "secrets" && <div className="space-y-5">
            <div className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-3 text-xs leading-relaxed text-muted-foreground">These optional entries are stored only in this browser for services that explicitly use local secrets. NodeX Engine authentication now uses the shared <code className="font-mono text-foreground">NODEX_ENGINE_API_KEY</code> environment variable on the frontend server and engine; do not save that shared key in browser storage.</div>
            <form className="space-y-2 rounded-xl border border-border/70 p-3" onSubmit={(event) => { event.preventDefault(); const keyName = secretName.trim(); const value = secretValue.trim(); if (!keyName || !value) { toast.error("Enter both a key name and a secret value."); return; } const next = editingSecretId ? secrets.map((item) => item.id === editingSecretId ? { ...item, name: keyName, value } : item) : [...secrets, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: keyName, value }]; saveSecrets(next); setSecretName(""); setSecretValue(""); setEditingSecretId(null); toast(editingSecretId ? "Secret updated on this device" : "Secret saved on this device"); }}>
              <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-end gap-2"><div className="min-w-0 space-y-1"><Label htmlFor="secret-name" className="text-[11px]">Key name</Label><Input id="secret-name" value={secretName} onChange={(event) => setSecretName(event.target.value)} placeholder="THIRD_PARTY_API_KEY" autoComplete="off" className="h-9 min-w-0 px-2 text-xs" /></div><div className="min-w-0 space-y-1"><Label htmlFor="secret-value" className="text-[11px]">Secret value</Label><Input id="secret-value" type={showSecretValues ? "text" : "password"} value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder="Paste secret" autoComplete="new-password" className="h-9 min-w-0 px-2 text-xs" /></div></div>
              <div className="flex flex-wrap gap-1.5"><Button type="submit" size="sm" className="h-8 px-3 text-xs">{editingSecretId ? "Update secret" : "Add secret"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setShowSecretValues((value) => !value); }}>{showSecretValues ? "Hide values" : "Show values"}</Button>{editingSecretId && <Button type="button" size="sm" variant="ghost" onClick={() => { setEditingSecretId(null); setSecretName(""); setSecretValue(""); }}>Cancel edit</Button>}</div>
            </form>
            <div className="border-t border-border/60">
              {secrets.length === 0 ? <p className="py-5 text-sm text-muted-foreground">No saved entries yet. Add a key above only for an integration that specifically supports browser-local secrets.</p> : secrets.map((secret) => <div key={secret.id} className="grid min-w-0 grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_auto_auto] items-center gap-1.5 border-b border-border/60 py-2"><div className="min-w-0"><p className="truncate text-[11px] font-semibold" title={secret.name}>{secret.name}</p></div><p className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={showSecretValues ? secret.value : "Hidden secret value"}>{showSecretValues ? secret.value : "••••••••••••"}</p><Button size="icon" variant="ghost" className="size-8" aria-label={`Copy ${secret.name}`} onClick={() => { void navigator.clipboard?.writeText(secret.value).then(() => toast(`${secret.name} copied`)).catch(() => toast.error("Could not copy secret")); }}><Copy className="size-3.5" /></Button><Button size="icon" variant="ghost" className="size-8" aria-label={`Edit ${secret.name}`} onClick={() => { setEditingSecretId(secret.id); setSecretName(secret.name); setSecretValue(secret.value); setSection("secrets"); }}><Wrench className="size-3.5" /></Button><Button size="icon" variant="ghost" className="size-8" aria-label={`Delete ${secret.name}`} onClick={() => { saveSecrets(secrets.filter((item) => item.id !== secret.id)); if (editingSecretId === secret.id) { setEditingSecretId(null); setSecretName(""); setSecretValue(""); } toast("Local secret deleted"); }}><Trash2 className="size-3.5 text-muted-foreground" /></Button></div>)}
            </div>
          </div>}

          {section === "privacy" && <div className="flex items-center gap-4 border-b border-border/60 py-4"><div className="min-w-0 flex-1"><p className="text-sm font-medium">Hide balances</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Mask portfolio and network balances throughout the wallet.</p></div><Switch checked={hide} onCheckedChange={() => toggleHide()} /></div>}

          {section === "security" && <div className="space-y-5">
            <div className="flex items-center gap-3 border-b border-border/60 pb-4"><LockKeyhole className="size-5 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm font-medium">Wallet lock</p><p className="mt-1 text-xs text-muted-foreground">{wallet.pinHash ? "A wallet PIN is configured." : "Set a 6-digit PIN to enable wallet locking."}</p></div></div>
            {wallet.pinHash ? <Button variant="outline" onClick={() => { lock(); toast("Wallet locked"); }}>Lock wallet now</Button> : <div className="space-y-2"><Label htmlFor="new-pin">6-digit wallet PIN</Label><div className="flex gap-2"><Input id="new-pin" inputMode="numeric" maxLength={6} value={pin} onChange={(event) => setPinValue(event.target.value.replace(/\D/g, "").slice(0, 6))} className="max-w-[220px] font-mono tracking-[0.3em]" /><Button disabled={pin.length !== 6} onClick={async () => { await setPin(pin); setPinValue(""); toast("Wallet PIN set"); }}>Set PIN</Button></div></div>}
            <div className="space-y-3 border-t border-border/60 pt-4"><div><p className="text-sm font-medium">Recovery phrase</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Anyone with these words can control this wallet. Keep them private and offline.</p></div><p className="break-words rounded-md bg-secondary/50 px-3 py-3 font-mono text-sm">{showPhrase ? wallet.phrase || "No recovery phrase is stored for this wallet." : wallet.phrase ? truncateAddress(wallet.phrase.replace(/\s/g, ""), 8) : "No recovery phrase available"}</p><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!wallet.phrase} onClick={() => setShowPhrase((value) => !value)}>{showPhrase ? "Hide phrase" : "Reveal phrase"} {showPhrase ? <EyeOff className="ml-1.5 size-4" /> : <Eye className="ml-1.5 size-4" />}</Button>{showPhrase && wallet.phrase && <CopyButton value={wallet.phrase} label="Copy phrase" />}</div><p className="text-xs text-muted-foreground">This wallet view does not store a separate private key to reveal here. Do not share your recovery phrase.</p></div>
            <div className="space-y-3 border-t border-destructive/20 pt-4"><div><p className="text-sm font-medium">Remove wallet</p><p className="mt-1 text-xs text-muted-foreground">Erase this wallet and its locally saved balances from this browser.</p></div><AlertDialog><AlertDialogTrigger asChild><Button variant="outline" size="sm" className="text-destructive">Remove wallet</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove this wallet?</AlertDialogTitle><AlertDialogDescription>This cannot be undone unless you saved your recovery phrase securely.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { reset(); void navigate({ to: "/" }); }}>Remove wallet</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>
          </div>}
        </section>
      </div>
      <p className="mt-8 flex items-start gap-2 border-t border-border/60 pt-4 text-xs leading-relaxed text-muted-foreground"><Wrench className="mt-0.5 size-4 shrink-0" /> NodeX is still a testing integration. Sending and swaps stay unavailable until their engine-backed transaction flows are implemented.</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex min-w-0 items-start gap-4 border-b border-border/60 py-4"><div className="w-28 shrink-0 text-xs text-muted-foreground">{label}</div><p className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">{value || "Unavailable"}</p><button type="button" aria-label={`Copy ${label}`} onClick={() => { if (value && typeof navigator !== "undefined") void navigator.clipboard?.writeText(value).then(() => toast(`${label} copied`)).catch(() => toast.error("Could not copy value")); }} className="text-xs text-muted-foreground transition-colors hover:text-foreground">Copy</button></div>;
}
