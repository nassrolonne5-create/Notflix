/**
 * Telemetry & Analytics Tracking Service
 * Collects 100% real, anonymous viewer interactions and sends them to the Notflix backend.
 */

// Generate or retrieve persistent anonymous session ID
function getSessionId(): string {
  try {
    let sid = localStorage.getItem('notflix_telemetry_sid');
    if (!sid) {
      sid = 'sid_' + Math.random().toString(36).substring(2, 12) + '_' + Date.now().toString(36);
      localStorage.setItem('notflix_telemetry_sid', sid);
    }
    return sid;
  } catch {
    return 'sid_anon_' + Date.now();
  }
}

// Device type detection
function detectDevice(): 'mobile' | 'desktop' | 'tablet' | 'tv' {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent.toLowerCase();

  // Smart TV detection
  if (
    ua.includes('smart-tv') ||
    ua.includes('smarttv') ||
    ua.includes('appletv') ||
    ua.includes('googletv') ||
    ua.includes('tizen') ||
    ua.includes('webos') ||
    ua.includes('roku') ||
    ua.includes('hbbtv') ||
    ua.includes('vizio')
  ) {
    return 'tv';
  }

  // Tablet detection
  if (
    ua.includes('ipad') ||
    (ua.includes('android') && !ua.includes('mobi')) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ) {
    return 'tablet';
  }

  // Mobile phone detection
  if (
    ua.includes('iphone') ||
    ua.includes('ipod') ||
    ua.includes('android') ||
    ua.includes('mobile') ||
    ua.includes('blackberry') ||
    ua.includes('iemobile')
  ) {
    return 'mobile';
  }

  return 'desktop';
}

// Browser name detection
function detectBrowser(): string {
  if (typeof navigator === 'undefined') return 'Unknown';
  const ua = navigator.userAgent;

  if (ua.includes('SamsungBrowser')) return 'Samsung Internet';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
  if (ua.includes('Chrome/') && !ua.includes('Chromium')) return 'Chrome';
  if (ua.includes('Safari/') && !ua.includes('Chrome')) return 'Safari';
  if (ua.includes('Firefox/')) return 'Firefox';
  return 'Browser';
}

// OS detection
function detectOS(): string {
  if (typeof navigator === 'undefined') return 'Unknown';
  const ua = navigator.userAgent;

  if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  return 'Unknown OS';
}

// Non-blocking beacon / fetch sender
function sendTelemetry(payload: Record<string, any>) {
  try {
    const data = {
      sessionId: getSessionId(),
      device: detectDevice(),
      browser: detectBrowser(),
      os: detectOS(),
      ...payload,
    };

    const json = JSON.stringify(data);

    // Prefer navigator.sendBeacon if available
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([json], { type: 'application/json' });
      navigator.sendBeacon('/api/analytics/ping', blob);
      return;
    }

    // Fire-and-forget fetch with keepalive
    fetch('/api/analytics/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Fail silently so user playback is never interrupted
  }
}

export const telemetry = {
  // Track page visit
  trackPageView(pathName?: string) {
    sendTelemetry({
      eventType: 'pageview',
      title: pathName || window.location.pathname,
    });
  },

  // Track initial stream playback start
  trackPlay(item: any, season?: number, episode?: number, serverName?: string) {
    if (!item) return;
    const isTv = item.type === 'tv' || item.media_type === 'tv' || Boolean(season);
    const title = item.title || item.name || 'Unknown Title';
    const poster = item.poster_path
      ? `https://image.tmdb.org/t/p/w200${item.poster_path}`
      : item.poster || '';

    sendTelemetry({
      eventType: 'play',
      title,
      mediaType: isTv ? 'tv' : 'movie',
      season: season || 1,
      episode: episode || 1,
      poster,
      serverName: serverName || 'Server 1',
    });
  },

  // Track active playback heartbeat (every 25-30s while movie is actively playing)
  trackHeartbeat(
    item: any,
    season: number | undefined,
    episode: number | undefined,
    watchSeconds: number,
    serverName?: string
  ) {
    if (!item) return;
    const isTv = item.type === 'tv' || item.media_type === 'tv' || Boolean(season);
    const title = item.title || item.name || 'Unknown Title';
    const poster = item.poster_path
      ? `https://image.tmdb.org/t/p/w200${item.poster_path}`
      : item.poster || '';

    sendTelemetry({
      eventType: 'heartbeat',
      title,
      mediaType: isTv ? 'tv' : 'movie',
      season: season || 1,
      episode: episode || 1,
      poster,
      watchSeconds,
      serverName,
    });
  },

  // Track user search query
  trackSearch(query: string) {
    if (!query || query.trim().length < 2) return;
    sendTelemetry({
      eventType: 'search',
      searchQuery: query.trim(),
    });
  },

  // Track streaming server performance (success or error)
  trackServerStatus(serverName: string, success: boolean, serverIndex?: number) {
    sendTelemetry({
      eventType: 'server_status',
      title: success ? 'success' : 'error',
      serverName,
      serverIndex,
    });
  },
};
