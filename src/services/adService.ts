// Adsterra Smart Link Service
// Mirrors original index.html frequency & logic, opening ads in external tabs/windows without leaving movie page

export const SMART_LINK_URL =
  'https://www.effectivecpmnetwork.com/iguja6tv?key=64d3ff50e48f5a21653b7b6c4c49933b';

export type AdTriggerType =
  | 'poster'
  | 'tab'
  | 'download'
  | 'search'
  | 'episode'
  | 'play'
  | 'pip'
  | 'fullscreen';

interface AdState {
  lastReset: number;
  posterTriggered: boolean;
  tabTriggered: boolean;
  downloadClicks: number;
  fullscreenTriggered: boolean;
}

// Global window adState sync for debugging or external script compatibility
const getInitialAdState = (): AdState => ({
  lastReset: Date.now(),
  posterTriggered: false,
  tabTriggered: false,
  downloadClicks: 0,
  fullscreenTriggered: false,
});

if (typeof window !== 'undefined') {
  (window as any).SMART_LINK_URL = SMART_LINK_URL;
  if (!(window as any).adState) {
    (window as any).adState = getInitialAdState();
  }
}

let pausedForAd = false;

/**
 * Triggers the smart ad based on the exact same logic and rates as index.html
 * Opens in an external page/tab so the current website and movie page are not replaced.
 */
export function triggerAd(type: AdTriggerType, videoElement?: HTMLVideoElement | null): boolean {
  if (!SMART_LINK_URL || typeof window === 'undefined') return false;

  const now = Date.now();
  const state: AdState = (window as any).adState || getInitialAdState();

  // Reset ad cooldown state every 60 seconds
  if (now - state.lastReset > 60000) {
    state.lastReset = now;
    state.posterTriggered = false;
    state.tabTriggered = false;
    state.downloadClicks = 0;
    state.fullscreenTriggered = false;
    (window as any).adState = state;
  }

  let shouldTrigger = false;

  if (type === 'poster') {
    if (!state.posterTriggered) {
      shouldTrigger = true;
      state.posterTriggered = true;
    }
  } else if (type === 'tab') {
    if (!state.tabTriggered) {
      shouldTrigger = true;
      state.tabTriggered = true;
    }
  } else if (type === 'download') {
    state.downloadClicks++;
    if (state.downloadClicks <= 2) {
      shouldTrigger = true;
    }
  } else if (type === 'fullscreen') {
    if (!state.fullscreenTriggered) {
      shouldTrigger = true;
      state.fullscreenTriggered = true;
    }
  }

  (window as any).adState = state;

  if (shouldTrigger) {
    const video = videoElement || document.querySelector('video');
    if (video && !video.paused) {
      try {
        video.pause();
      } catch {}
      pausedForAd = true;
    } else {
      pausedForAd = true;
    }

    // Open external page without replacing movie page
    if ((window as any).AndroidInterface?.openExternal) {
      try {
        (window as any).AndroidInterface.openExternal(SMART_LINK_URL);
      } catch {
        window.open(SMART_LINK_URL, '_blank', 'noopener,noreferrer');
      }
    } else {
      window.open(SMART_LINK_URL, '_blank', 'noopener,noreferrer');
    }

    return true;
  }

  return false;
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
