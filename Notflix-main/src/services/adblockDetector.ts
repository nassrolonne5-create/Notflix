/**
 * Ad-Blocker Detection Service
 * Combines network probe and DOM cosmetic filter tests to detect ad-blocking extensions reliably
 * without false positives when offline.
 */

const AD_PROBE_URLS = [
  'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
  'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
];

const DISMISSAL_STORAGE_KEY = 'notflix_adblock_banner_dismissed_until';
const DISMISSAL_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export function isAdBlockBannerDismissed(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = localStorage.getItem(DISMISSAL_STORAGE_KEY);
    if (!raw) return false;
    const expiresAt = parseInt(raw, 10);
    return !isNaN(expiresAt) && Date.now() < expiresAt;
  } catch {
    return false;
  }
}

export function dismissAdBlockBanner(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      DISMISSAL_STORAGE_KEY,
      String(Date.now() + DISMISSAL_DURATION_MS)
    );
  } catch {}
}

export function resetAdBlockDismissal(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(DISMISSAL_STORAGE_KEY);
  } catch {}
}

/**
 * Detects if an ad-blocking extension is actively blocking ad network requests or cosmetic elements.
 */
export async function detectAdBlocker(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }

  // If user is completely offline, do not report ad-blocking
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  // 1. Bait DOM Element Test (Checks for cosmetic filtering: uBlock, Adblock Plus, AdGuard, Brave)
  let cosmeticBlocked = false;
  try {
    const bait = document.createElement('div');
    bait.className =
      'adsbox pub_300x250 pub_300x250m pub_728x90 text-ad textAd text_ad text_ads text-ads text-ad-links banner-ad ad-zone banner_ad';
    bait.style.cssText =
      'position: absolute !important; left: -9999px !important; top: -9999px !important; width: 10px !important; height: 10px !important; pointer-events: none !important;';
    document.body.appendChild(bait);

    // Allow browser a tick to apply extension cosmetic CSS rules
    await new Promise((resolve) => setTimeout(resolve, 60));

    const style = window.getComputedStyle(bait);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      bait.offsetParent === null ||
      bait.clientHeight === 0 ||
      bait.offsetHeight === 0
    ) {
      cosmeticBlocked = true;
    }
    bait.remove();
  } catch {
    cosmeticBlocked = false;
  }

  if (cosmeticBlocked) {
    return true;
  }

  // 2. Network Request Probe (Checks if network filter blocks standard ad domain requests)
  let networkBlocked = false;
  for (const url of AD_PROBE_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      // mode: 'no-cors' allows hitting cross-origin ad scripts without CORS errors
      await fetch(url, {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (err: any) {
      // AbortError might just be a slow connection, but TypeError / Failed to fetch
      // indicates browser extension or DNS level ad-blocking (ERR_BLOCKED_BY_CLIENT)
      if (err?.name !== 'AbortError' && navigator.onLine !== false) {
        networkBlocked = true;
        break;
      }
    }
  }

  return networkBlocked;
}
