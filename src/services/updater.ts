// Automatic Update & Anti-Stale Deployment Manager
// Ensures Coolify updates take effect immediately without requiring manual cache/history deletion

if (typeof window !== 'undefined') {
  // 1. Automatically unregister any lingering service workers from previous PWA/workbox builds
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister().catch(() => {});
      }
    });
  }

  // 2. Clear stale browser CacheStorage entries
  if ('caches' in window) {
    caches.keys().then((cacheNames) => {
      for (const name of cacheNames) {
        caches.delete(name).catch(() => {});
      }
    });
  }

  // 3. Auto-recover from chunk loading errors when old hashed files are replaced after deployment
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    window.location.reload();
  });

  window.addEventListener('error', (event) => {
    const message = String(event?.message || '');
    if (
      message.includes('Failed to fetch dynamically imported module') ||
      message.includes('Importing a module script failed') ||
      message.includes('error loading dynamically imported module') ||
      message.includes('Loading chunk')
    ) {
      const lastReload = sessionStorage.getItem('notflix_last_chunk_reload');
      const now = Date.now();
      // Guard against infinite reload loop: reload at most once every 8 seconds
      if (!lastReload || now - Number(lastReload) > 8000) {
        sessionStorage.setItem('notflix_last_chunk_reload', String(now));
        window.location.reload();
      }
    }
  });

  // 4. Background version check to reload immediately when a new Coolify build is deployed
  let currentAppVersion: string | null = null;

  const checkForNewDeployment = async () => {
    try {
      const res = await fetch(`/api/version?_t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store' },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.version) return;

      if (!currentAppVersion) {
        currentAppVersion = String(data.version);
      } else if (currentAppVersion !== String(data.version)) {
        // New deployment detected on Coolify! Refresh immediately to apply updates
        window.location.reload();
      }
    } catch {
      // Ignore background network transient errors
    }
  };

  // Run initial check and set currentAppVersion
  checkForNewDeployment();

  // Re-check whenever user refocuses or switches back to the tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkForNewDeployment();
    }
  });

  // Check periodically every 30 seconds
  setInterval(checkForNewDeployment, 30000);
}
