// Monetization & Advertising Service
// Integrated with LiquidInCan / Zone 156800 popunder tag in index.html

export const SMART_LINK_URL = '';

/**
 * Returns a valid direct landing page or smartlink URL if configured.
 * Strictly filters out any .js script files or tag endpoints to prevent
 * the browser from opening raw code in a tab.
 */
export const getSmartLinkUrl = (): string => {
  let url = '';
  if (typeof window !== 'undefined' && (window as any).__NOTFLIX_SMART_LINK__) {
    url = (window as any).__NOTFLIX_SMART_LINK__;
  } else {
    try {
      if (typeof process !== 'undefined' && process.env?.VITE_SMART_LINK_URL) {
        url = process.env.VITE_SMART_LINK_URL;
      }
    } catch {}
  }

  // Safety filter: NEVER open a JavaScript tag or script file as a browser tab!
  if (
    url &&
    (url.includes('fz.liquidincan.com') ||
      url.endsWith('.js') ||
      url.includes('.js?') ||
      url.includes('/script'))
  ) {
    console.warn('[Monetization] Script tag URL detected in SMART_LINK_URL; ignoring to avoid rendering raw code.');
    return '';
  }

  return url;
};

export type AdTriggerType =
  | 'poster'
  | 'dock'
  | 'tab'
  | 'download'
  | 'search'
  | 'episode'
  | 'play'
  | 'pip'
  | 'fullscreen';

interface AdPacingState {
  lastGlobalAdTime: number;
  lastPosterAdTime: number;
  posterClickCount: number;
  lastDockAdTime: number;
  dockClickCount: number;
  lastFullscreenAdTime: number;
  fullscreenClickCount: number;
  lastTabAdTime: number;
  lastEpisodeAdTime: number;
  downloadClicks: number;
}

// Tuned intervals for repetitive, higher-frequency ad monetization
const GLOBAL_MIN_INTERVAL_MS = 3000; // 3 seconds minimum global spacing
const POSTER_INTERVAL_MS = 4000;     // 4 seconds cooldown for poster clicks
const DOCK_INTERVAL_MS = 5000;       // 5 seconds cooldown for floating dock tabs
const FULLSCREEN_INTERVAL_MS = 6000; // 6 seconds cooldown for fullscreen toggles
const TAB_INTERVAL_MS = 5000;        // 5 seconds cooldown for general tab changes
const EPISODE_INTERVAL_MS = 8000;    // 8 seconds cooldown for episode switching

const getInitialAdPacingState = (): AdPacingState => ({
  lastGlobalAdTime: 0,
  lastPosterAdTime: 0,
  posterClickCount: 0,
  lastDockAdTime: 0,
  dockClickCount: 0,
  lastFullscreenAdTime: 0,
  fullscreenClickCount: 0,
  lastTabAdTime: 0,
  lastEpisodeAdTime: 0,
  downloadClicks: 0,
});

/**
 * Checks whether the user is currently inside the admin dashboard or has admin session
 */
export function isAdminActive(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as any).__NOTFLIX_IS_ADMIN__) return true;
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  if (path.startsWith('/admin') || hash.includes('admin')) return true;
  try {
    if (localStorage.getItem('notflix_admin_token')) return true;
  } catch {}
  return false;
}

if (typeof window !== 'undefined') {
  (window as any).SMART_LINK_URL = SMART_LINK_URL;
  if (!(window as any)._notflixAdPacingState) {
    (window as any)._notflixAdPacingState = getInitialAdPacingState();
  }
}

import { smartAdController } from './smartAdController';
export { smartAdController };

let pausedForAd = false;

/**
 * Triggers monetization ad with Smart Ad Frequency Control.
 * Dynamically adjusts intervals based on user engagement metrics (watch time,
 * browsing intent, rage/friction signals, and onboarding status).
 * Completely bypassed on admin dashboard.
 */
export function triggerAd(type: AdTriggerType, videoElement?: HTMLVideoElement | null): boolean {
  if (typeof window === 'undefined') return false;

  // 1. Strictly block ads if inside admin dashboard
  if (isAdminActive()) {
    return false;
  }

  // 2. Record interaction velocity
  smartAdController.recordInteraction(type);

  // 3. Dynamic evaluation based on real-time engagement tier
  const evaluation = smartAdController.evaluateTrigger(type);
  if (!evaluation.allowed) {
    return false;
  }

  // 4. Record successful ad delivery
  smartAdController.recordAdDelivered(type);

  const directAdUrl = getSmartLinkUrl();

  // If a valid external landing page/direct smartlink is configured, pause and open
  if (directAdUrl) {
    if (type !== 'fullscreen') {
      const video = videoElement || document.querySelector('video');
      if (video && !video.paused) {
        try {
          video.pause();
        } catch {}
        pausedForAd = true;
      } else {
        pausedForAd = true;
      }
    }

    const openDirectTab = () => {
      try {
        if ((window as any).AndroidInterface?.openExternal) {
          (window as any).AndroidInterface.openExternal(directAdUrl);
          return;
        }
      } catch {}

      try {
        const link = document.createElement('a');
        link.href = directAdUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch {
        try {
          window.open(directAdUrl, '_blank', 'noopener,noreferrer');
        } catch {}
      }
    };

    if (type === 'fullscreen') {
      setTimeout(openDirectTab, 80);
    } else {
      openDirectTab();
    }

    return true;
  }

  // Otherwise, the on-click popunder script in index.html naturally handles monetization via DOM bubbling
  return true;
}

/**
 * Sets up visibility and focus listeners to automatically resume video
 * when returning from the external ad page.
 */
export function initAdResumeListeners(getVideo: () => HTMLVideoElement | null) {
  if (typeof window === 'undefined') return () => {};

  const handleReturn = () => {
    if (pausedForAd) {
      pausedForAd = false;
      const video = getVideo() || document.querySelector('video');
      if (video && video.paused) {
        video.play().catch((e) => console.log('Auto-resume after ad failed:', e));
      }
    }
  };

  const handleVisibility = () => {
    if (document.visibilityState === 'visible') {
      handleReturn();
    }
  };

  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('focus', handleReturn);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('focus', handleReturn);
  };
}
