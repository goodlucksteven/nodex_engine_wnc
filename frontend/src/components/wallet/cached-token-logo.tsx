import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared token-logo loader. It deduplicates concurrent requests, stores
 * CORS-readable image responses in the browser Cache API, and reuses object
 * URLs across every mounted token row. Hosts that do not permit CORS fall
 * back to the browser's normal image cache.
 */
const CACHE_NAME = "nodex-token-logos-v1";
const resolvedLogos = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

async function resolveLogoUrl(url: string): Promise<string> {
  const cachedUrl = resolvedLogos.get(url);
  if (cachedUrl) return cachedUrl;
  const existing = pending.get(url);
  if (existing) return existing;

  const task = (async () => {
    try {
      if ("caches" in window) {
        const cache = await window.caches.open(CACHE_NAME);
        const cached = await cache.match(url);
        if (cached) {
          const objectUrl = URL.createObjectURL(await cached.blob());
          resolvedLogos.set(url, objectUrl);
          return objectUrl;
        }
        const response = await fetch(url, { mode: "cors", credentials: "omit" });
        if (response.ok && response.type !== "opaque") {
          await cache.put(url, response.clone());
          const objectUrl = URL.createObjectURL(await response.blob());
          resolvedLogos.set(url, objectUrl);
          return objectUrl;
        }
      }
    } catch {
      // Some public logo hosts do not enable CORS; use their direct URL.
    }
    return url;
  })();

  pending.set(url, task);
  try {
    return await task;
  } finally {
    pending.delete(url);
  }
}

export function CachedTokenLogo({
  url,
  alt,
  className,
  fallbackFavicon = false,
}: {
  url?: string | null;
  alt: string;
  className?: string;
  fallbackFavicon?: boolean;
}) {
  const candidate = String(url ?? "").trim();
  // Reuse the runtime URL synchronously on remount, so navigating away and back
  // does not reset a previously resolved logo to the uncached network URL.
  const [resolvedLogo, setResolvedLogo] = useState<{ url: string; src: string } | null>(() => {
    const cachedSrc = resolvedLogos.get(candidate);
    return cachedSrc ? { url: candidate, src: cachedSrc } : null;
  });
  const [fallback, setFallback] = useState<{ url: string; src: string } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!/^https?:\/\//i.test(candidate)) return () => { cancelled = true; };
    // Start from the original URL immediately so the logo never waits for
    // Indexed/Cache API reads before appearing. Resolve the durable cache in
    // the background and switch to its object URL only after it is ready.
    void resolveLogoUrl(candidate).then((resolvedUrl) => {
      if (!cancelled) setResolvedLogo({ url: candidate, src: resolvedUrl });
    });
    return () => { cancelled = true; };
  }, [candidate]);

  if (!/^https?:\/\//i.test(candidate) || failedUrl === candidate) return null;
  const src = fallback?.url === candidate
    ? fallback.src
    : resolvedLogo?.url === candidate
      ? resolvedLogo.src
      : candidate;

  return <img
    src={src}
    alt={alt}
    loading="eager"
    decoding="async"
    referrerPolicy="no-referrer"
    className={cn("object-cover", className)}
    onError={() => {
      if (fallbackFavicon && fallback?.url !== candidate && candidate) {
        try {
          const host = new URL(candidate).hostname;
          const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
          setFallback({ url: candidate, src: favicon });
          return;
        } catch {
          // Invalid URL; let the caller's symbol fallback show.
        }
      }
      setFailedUrl(candidate);
    }}
  />;
}
