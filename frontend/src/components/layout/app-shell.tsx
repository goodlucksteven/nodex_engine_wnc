import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, ArrowLeftRight, Clock, Home, Settings } from "lucide-react";
import { SableWordmark } from "@/components/brand/sable-mark";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn, truncateAddress } from "@/lib/utils";
import { usePrices } from "@/lib/wallet/prices";
import { useWallet } from "@/lib/wallet/store";
import { connectEngineEventStream } from "@/lib/wallet/event-stream";
import { SETTINGS_ITEMS, SETTINGS_SECTION_ACTIVE_EVENT, SETTINGS_SECTION_SELECT_EVENT, type SettingsSection } from "@/lib/settings-navigation";

function CryptoSwapIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 100 100"
      fill="none"
    >
      <circle cx="30" cy="34" r="19" stroke="currentColor" strokeWidth="4" />
      <path
        d="M26 25H33C38 25 38 32 33 32H26M26 32H34C40 32 40 40 34 40H25M30 21V44"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="70" cy="66" r="19" stroke="currentColor" strokeWidth="4" />
      <path
        d="M70 53L80 66L70 79L60 66Z"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M48 25H67Q76 25 76 34V38M70 32L76 39L82 32"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M52 75H33Q24 75 24 66V62M30 68L24 61L18 68"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HomeNavIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 64 64"
      fill="none"
    >
      <path
        d="M14 25L28.8 13.5Q32 10.8 35.2 13.5 L50 25Q52 27 52 30V47 Q52 52 46 52H18Q12 52 12 47V30 Q12 27 14 25Z"
        fill="currentColor"
      />
      <rect
        x="24.5"
        y="43.5"
        width="15"
        height="3.2"
        rx="1.6"
        fill="#0e111b"
      />
    </svg>
  );
}

const NAV = [
  { to: "/", label: "Home", icon: Home },
  { to: "/swap", label: "Swap", icon: ArrowLeftRight },
  { to: "/activity", label: "Activity", icon: Clock },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.resolvedLocation?.pathname ?? s.location.pathname });
  const [expandedSettingsItem, setExpandedSettingsItem] = useState<SettingsSection | null>(null);
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSection>("wallet");
  const settingsNavRef = useRef<HTMLElement | null>(null);
  const touchXRef = useRef<number | null>(null);
  const edgePullRef = useRef(0);
  const onSettingsPage = pathname.startsWith("/settings");

  useEffect(() => {
    const onActive = (event: Event) => setActiveSettingsSection((event as CustomEvent<SettingsSection>).detail);
    window.addEventListener(SETTINGS_SECTION_ACTIVE_EVENT, onActive);
    return () => window.removeEventListener(SETTINGS_SECTION_ACTIVE_EVENT, onActive);
  }, []);

  useEffect(() => {
    setExpandedSettingsItem(null);
  }, [pathname]);
  const wallet = useWallet((s) => s.wallet);
  const lock = useWallet((s) => s.lock);
  const refresh = usePrices((s) => s.refresh);
  const applyEngineEvent = useWallet((s) => s.applyEngineEvent);

  useEffect(() => {
    let lastResumeRefresh = 0;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      // Android may emit focus, pageshow, and visibilitychange together.
      // Debounce them so one resume triggers one balance/price refresh.
      if (now - lastResumeRefresh < 15_000) return;
      lastResumeRefresh = now;
      void refresh();
      const state = useWallet.getState();
      if (state.wallet && !state.refreshingBalances) {
        void state.refreshBalances().catch(() => undefined);
      }
    };

    refreshWhenVisible();
    const id = window.setInterval(() => void refresh(), 5 * 60_000);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("pageshow", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("pageshow", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  useEffect(() => {
    let disconnect: (() => void) | undefined;
    const connect = () => {
      disconnect?.();
      disconnect = undefined;
      // The proxy uses a stream token saved in Settings > Secrets, or the Render environment token.
      disconnect = connectEngineEventStream(applyEngineEvent);
    };
    connect();
    window.addEventListener("nodex-event-stream-reconnect", connect);
    return () => {
      window.removeEventListener("nodex-event-stream-reconnect", connect);
      disconnect?.();
    };
  }, [applyEngineEvent]);

  useEffect(() => {
    if (!wallet?.pinHash) return;
    let timer = 0;
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => lock(), 5 * 60 * 1000);
    };
    bump();
    window.addEventListener("pointerdown", bump);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", bump);
    };
  }, [wallet?.pinHash, lock]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-dvh bg-background text-foreground">
        <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-border px-4 py-6 lg:flex">
          <SableWordmark className="px-2" />
          <nav className="mt-10 flex flex-1 flex-col gap-1">
            {NAV.map((item) => {
              const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
              const Icon = item.icon;
              return <Link key={item.to} to={item.to} className={cn("flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors duration-150", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}><Icon className="size-4" />{item.label}</Link>;
            })}
          </nav>
          {wallet && <div className="rounded-lg bg-secondary px-3 py-3 shadow-[var(--shadow-border)]"><p className="text-sm font-medium">{wallet.name}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{truncateAddress(String(wallet.chainAddresses[0]?.address ?? ""), 5)}</p></div>}
        </aside>
        <div className={cn(pathname !== "/" && "lg:pl-56")}>
          {pathname !== "/" && pathname !== "/engine-logs" && (
            <>
              <header className="pointer-events-none fixed inset-x-0 top-0 z-30 rounded-b-md border-x-0 border-t-0 border-b border-white/[0.14] bg-background/65 shadow-none backdrop-blur-2xl lg:left-56">
                <div className={cn("relative flex min-h-[calc(3rem+env(safe-area-inset-top,0px))] items-center gap-2 pl-3 pr-0 pt-[env(safe-area-inset-top,0px)] sm:pl-4 sm:pr-0 lg:items-center lg:pt-0 lg:min-h-0 lg:pl-6 lg:pr-0", "h-[calc(3rem+env(safe-area-inset-top,0px))] lg:h-14")}>
                  <Link to={pathname === "/connection" || pathname === "/engine-logs" ? "/settings" : pathname.startsWith("/asset/") ? "/blockchains" : "/"} className="pointer-events-auto inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-white/[0.16] bg-secondary/45 text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_3px_12px_rgba(0,0,0,0.08)] backdrop-blur-2xl transition-colors hover:bg-secondary/65 hover:text-foreground" aria-label="Go back">
                    <ArrowLeft className="size-[17px]" />
                  </Link>
                  <h1 className="pointer-events-none min-w-0 shrink-0 truncate text-base font-semibold tracking-tight">{pathname.startsWith("/swap") ? "Swap" : pathname.startsWith("/send") ? "Send" : pathname.startsWith("/receive") ? "Receive" : pathname.startsWith("/activity") ? "Activity" : pathname.startsWith("/blockchains") ? "Networks" : pathname.startsWith("/asset/") ? "Asset details" : pathname.startsWith("/connection") ? "Connection" : pathname.startsWith("/engine-logs") ? "Engine logs" : onSettingsPage ? "Settings" : "Wallet"}</h1>
                  {onSettingsPage && <nav ref={settingsNavRef} aria-label="Settings sections" onTouchStart={(event) => {
                    touchXRef.current = event.touches[0]?.clientX ?? null;
                    edgePullRef.current = 0;
                    if (settingsNavRef.current) settingsNavRef.current.style.transition = "none";
                  }} onTouchMove={(event) => {
                    const nav = settingsNavRef.current;
                    const x = event.touches[0]?.clientX;
                    const previousX = touchXRef.current;
                    if (!nav || x === undefined || previousX === null) return;
                    const delta = x - previousX;
                    touchXRef.current = x;
                    const atStart = nav.scrollLeft <= 0;
                    const atEnd = nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1;
                    if ((atStart && delta > 0) || (atEnd && delta < 0)) {
                      edgePullRef.current = Math.max(-26, Math.min(26, edgePullRef.current + delta * 0.28));
                      nav.style.transform = `translateX(${edgePullRef.current}px)`;
                    }
                  }} onTouchEnd={() => {
                    const nav = settingsNavRef.current;
                    touchXRef.current = null;
                    edgePullRef.current = 0;
                    if (nav) {
                      nav.style.transition = "transform 520ms cubic-bezier(0.22, 1.45, 0.45, 1)";
                      nav.style.transform = "translateX(0)";
                    }
                  }} onTouchCancel={() => {
                    const nav = settingsNavRef.current;
                    touchXRef.current = null;
                    edgePullRef.current = 0;
                    if (nav) {
                      nav.style.transition = "transform 520ms cubic-bezier(0.22, 1.45, 0.45, 1)";
                      nav.style.transform = "translateX(0)";
                    }
                  }} className="pointer-events-auto relative flex min-w-0 flex-1 touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-auto pr-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {SETTINGS_ITEMS.map((item) => {
                      const Icon = item.icon;
                      const expanded = expandedSettingsItem === item.id;
                      const active = activeSettingsSection === item.id;
                      return <button key={item.id} type="button" aria-label={item.title} aria-expanded={expanded} title={item.title} onClick={(event) => {
                        const nav = settingsNavRef.current;
                        const button = event.currentTarget;
                        if (nav) {
                          const navRect = nav.getBoundingClientRect();
                          const buttonRect = button.getBoundingClientRect();
                          const edgeThreshold = Math.min(56, nav.clientWidth * 0.22);
                          const nearLeft = buttonRect.left - navRect.left < edgeThreshold;
                          const nearRight = navRect.right - buttonRect.right < edgeThreshold;
                          if (nearLeft || nearRight) {
                            const targetLeft = button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2;
                            nav.scrollTo({ left: Math.max(0, Math.min(targetLeft, nav.scrollWidth - nav.clientWidth)), behavior: "smooth" });
                          }
                        }
                        window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_SELECT_EVENT, { detail: item.id }));
                        setActiveSettingsSection(item.id);
                        setExpandedSettingsItem(item.id);
                      }} className={cn("group relative flex h-7 shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full transition-[width,background-color,color,box-shadow] duration-300 ease-out", expanded ? "w-[var(--settings-pill-width)] bg-white px-2 text-slate-900 shadow-sm ring-1 ring-black/5" : "w-8 px-0", active && !expanded ? "bg-secondary text-foreground" : !expanded && "text-muted-foreground hover:bg-secondary/70 hover:text-foreground")} style={{ "--settings-pill-width": `${Math.max(46, item.title.length * 6.2 + 34)}px` } as CSSProperties}><Icon className={cn("size-3.5 shrink-0 transition-transform duration-300", expanded && "text-slate-700")} /><span className={cn("overflow-hidden whitespace-nowrap text-[11px] font-medium transition-[max-width,opacity,margin] duration-300", expanded ? "max-w-[120px] opacity-100" : "max-w-0 opacity-0")}>{item.title}</span></button>;
                    })}
                  </nav>}
                </div>
              </header>
              {pathname !== "/engine-logs" && <div aria-hidden="true" className={"h-[calc(3rem+env(safe-area-inset-top,0px))] lg:h-14"} />}
            </>
          )}
          <main className={cn("min-h-dvh w-full", pathname === "/" ? "max-w-none px-0 pb-0 pt-0 lg:max-w-none lg:pb-0 lg:pt-0" : "px-0 pb-28 pt-0 lg:pb-12")}><Outlet /></main>
        </div>
        <nav aria-label="Main navigation" className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] z-40 flex items-stretch gap-2 lg:hidden">
          <div className="flex h-[60px] flex-1 items-center rounded-full border border-white/20 bg-secondary/65 p-1.5 shadow-[0_0_0_1px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.22),0_-6px_24px_rgba(0,0,0,0.28)] backdrop-blur-2xl">
            <div className="grid h-full w-full grid-cols-3">
              {NAV.filter((item) => item.to !== "/swap" && item.to !== "/settings").map((item) => {
                const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
                const Icon = item.icon;
                return <Link key={item.to} to={item.to} aria-current={active ? "page" : undefined} aria-label={item.label} title={item.label} className={cn("flex h-full items-center justify-center rounded-full transition-colors", active ? "bg-background/75 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]" : "text-muted-foreground hover:text-foreground")}>
                  {item.to === "/" ? <HomeNavIcon className="size-[21px]" /> : <Icon className="size-[21px]" />}
                </Link>;
              })}
              {(() => {
                const item = NAV[3];
                const active = pathname.startsWith(item.to);
                const Icon = item.icon;
                return <Link key={item.to} to={item.to} aria-current={active ? "page" : undefined} aria-label={item.label} title={item.label} className={cn("flex h-full items-center justify-center rounded-full transition-colors", active ? "bg-background/75 text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  <Icon className="size-[21px]" />
                </Link>;
              })()}
            </div>
          </div>
          {(() => {
            const item = NAV[1];
            const active = pathname.startsWith(item.to);
            const Icon = item.icon;
            return <Link to={item.to} aria-current={active ? "page" : undefined} aria-label={item.label} title={item.label} className={cn("grid size-[60px] shrink-0 place-items-center rounded-full border border-white/25 bg-secondary/65 text-muted-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.22),0_-6px_24px_rgba(0,0,0,0.28)] backdrop-blur-2xl transition-colors", active && "text-foreground")}>
              <CryptoSwapIcon className="size-[36px]" />
            </Link>;
          })()}
        </nav>     </div>
    </TooltipProvider>
  );
}
