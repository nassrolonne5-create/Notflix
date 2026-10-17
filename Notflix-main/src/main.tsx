import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Global Deployment Transition Monitor (prevents open Chrome tabs from ever getting stuck on a cached 404 after updates)
(function initDeploymentMonitor() {
  if (typeof window === 'undefined') return;

  let activeVersion: string | null = null;
  let isChecking = false;

  const evictBrowserHtmlCacheAndCookies = async () => {
    try {
      // Clear any proxy sticky-session cookies that could pin Chrome to a dead container
      const cookies = document.cookie ? document.cookie.split(';') : [];
      for (const c of cookies) {
        const eq = c.indexOf('=');
        const name = (eq > -1 ? c.slice(0, eq) : c).trim();
        if (name) {
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${window.location.hostname}`;
        }
      }
    } catch {}

    try {
      // Force Chrome to overwrite its HTTP disk cache for / and current path with fresh server HTML
      await Promise.allSettled([
        fetch('/', { cache: 'reload', headers: { Accept: 'text/html' } }),
        fetch('/admin', { cache: 'reload', headers: { Accept: 'text/html' } }),
        fetch(window.location.pathname, { cache: 'reload', headers: { Accept: 'text/html' } }),
      ]);
    } catch {}
  };

  const checkDeploymentVersion = async () => {
    if (isChecking || document.visibilityState === 'hidden') return;
    isChecking = true;
    try {
      const res = await fetch(`/api/version?_cb=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      });

      if (!res.ok) {
        // Server is mid-deployment (e.g. 404/502 from Traefik) — wait for health recovery then evict cache
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const h = await fetch(`/api/health?_cb=${Date.now()}`, { cache: 'no-store' });
            if (h.ok) {
              await evictBrowserHtmlCacheAndCookies();
              break;
            }
          } catch {}
        }
        return;
      }

      const data = await res.json();
      const serverVer = data?.version ? String(data.version) : null;
      if (serverVer) {
        if (activeVersion && activeVersion !== serverVer) {
          activeVersion = serverVer;
          await evictBrowserHtmlCacheAndCookies();
          // If no video player is actively open, seamlessly refresh to load new assets
          const isPlayingVideo = Boolean(document.querySelector('video'));
          if (!isPlayingVideo) {
            const url = new URL(window.location.href);
            url.searchParams.set('_cb', String(Date.now()));
            window.location.replace(url.toString());
          }
        } else {
          activeVersion = serverVer;
        }
      }
    } catch {
      // Ignore transient network errors during container swap
    } finally {
      isChecking = false;
    }
  };

  // Initial version check + periodic poll every 25s
  setTimeout(checkDeploymentVersion, 2000);
  setInterval(checkDeploymentVersion, 25000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkDeploymentVersion();
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      checkDeploymentVersion();
    }
  });
})();

createRoot(document.getElementById('root')!).render(<App />);
