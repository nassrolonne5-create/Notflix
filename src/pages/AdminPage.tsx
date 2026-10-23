import React, { useState, useEffect, useCallback } from 'react';
import {
  Lock,
  User,
  Eye,
  EyeOff,
  LogOut,
  Radio,
  Play,
  Clock,
  Search,
  Users,
  Smartphone,
  Monitor,
  Tablet,
  Tv,
  RefreshCw,
  TrendingUp,
  ArrowLeft,
  Server,
  Activity,
  Calendar,
  Compass,
  AlertCircle,
  CheckCircle2,
  Globe,
  Film,
  Download,
  Upload,
  Shield,
  ShieldAlert,
  Bug,
  Zap,
  Sparkles,
  BarChart3,
  Trophy,
} from 'lucide-react';
import { smartAdController, SmartAdMetrics } from '../services/smartAdController';

interface AdminPageProps {
  onExit: () => void;
}

interface AnalyticsKPIs {
  liveViewers: number;
  totalViews: number;
  totalWatchHours: number;
  totalWatchMinutes: number;
  totalSearches: number;
  uniqueVisitors: number;
}

interface LiveStreamItem {
  sessionId: string;
  title: string;
  device: string;
  mediaType?: string;
  season?: number;
  episode?: number;
  poster?: string;
  secondsAgo: number;
}

interface TimelinePoint {
  date: string;
  label: string;
  views: number;
  watchHours: number;
}

interface TopTitleItem {
  title: string;
  mediaType?: string;
  poster?: string;
  views: number;
  watchMinutes: number;
  avgMinutes: number;
}

interface TopSearchItem {
  query: string;
  count: number;
  lastSearched: number;
}

interface RecentEventItem {
  id: string;
  ts: number;
  type: string;
  title?: string;
  mediaType?: string;
  season?: number;
  episode?: number;
  poster?: string;
  device?: string;
  browser?: string;
  watchMinutes?: number;
  searchQuery?: string;
}

interface ServerHealthItem {
  server: string;
  success: number;
  error: number;
  total: number;
  rate: number;
}

interface AnalyticsResponse {
  success: boolean;
  range: string;
  kpis: AnalyticsKPIs;
  liveStreams: LiveStreamItem[];
  timeline: TimelinePoint[];
  hourlyDistribution: number[];
  topTitles: TopTitleItem[];
  topSearches: TopSearchItem[];
  recentEvents: RecentEventItem[];
  devices: { mobile: number; desktop: number; tablet: number; tv: number };
  browsers: Record<string, number>;
  operatingSystems: Record<string, number>;
  serverHealth: ServerHealthItem[];
  security?: {
    totalBlockedScrapers: number;
    totalInterceptionsBlocked?: number;
    totalRateLimited: number;
    totalHoneypotTrapped: number;
    activeBannedIps: number;
    permanentBans?: Array<{
      ip: string;
      reason: string;
      category: string;
      userAgent: string;
      path: string;
      bannedAt: number;
      permanent: boolean;
      blockedAttempts: number;
      lastAttemptAt: number;
    }>;
    recentEvents: Array<{
      ip: string;
      reason: string;
      category?: string;
      userAgent: string;
      path: string;
      ts: number;
      permanent?: boolean;
    }>;
  };
}

type ScraperServerId = 'cinepro' | 'tmdb_embed' | 'gateway_fallback';

interface ScraperEndpointConfig {
  id: ScraperServerId;
  name: string;
  role: string;
  protocol: 'http' | 'https';
  host: string;
  port: string;
  url: string;
  defaultUrl: string;
}

interface ScraperConfigStore {
  scrapers: Record<ScraperServerId, ScraperEndpointConfig>;
  updatedAt: number;
  isCustom: boolean;
}

interface ScraperPingResult {
  loading: boolean;
  reachable?: boolean;
  status?: number;
  latencyMs?: number;
  streamCount?: number | null;
  message?: string;
}

const SCRAPER_VAULT_STORAGE_KEY = 'notflix_admin_scraper_vault_v1';

const DEFAULT_SCRAPER_ENDPOINTS: Record<ScraperServerId, ScraperEndpointConfig> = {
  cinepro: {
    id: 'cinepro',
    name: 'CinePro Primary Scraper',
    role: 'Primary high-speed stream & subtitle extractor (/v1/movies & /v1/tv)',
    protocol: 'http',
    host: '62.171.179.144',
    port: '3001',
    url: 'http://62.171.179.144:3001',
    defaultUrl: 'http://62.171.179.144:3001',
  },
  tmdb_embed: {
    id: 'tmdb_embed',
    name: 'TMDB Embed Scraper',
    role: 'Secondary multi-provider stream extractor (/api/streams/movie & /series)',
    protocol: 'http',
    host: '62.171.179.144',
    port: '3005',
    url: 'http://62.171.179.144:3005',
    defaultUrl: 'http://62.171.179.144:3005',
  },
  gateway_fallback: {
    id: 'gateway_fallback',
    name: 'Coolify Gateway Fallback',
    role: 'Failover Coolify gateway mirror when primary scrapers return 0 streams',
    protocol: 'http',
    host: 'kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io',
    port: '',
    url: 'http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io',
    defaultUrl: 'http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io',
  },
};

export const AdminPage: React.FC<AdminPageProps> = ({ onExit }) => {
  // Authentication State
  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem('notflix_admin_token') || null;
  });
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(true);

  // Login Form State (Always clean and empty - never prefilled or exposed)
  const [usernameInput, setUsernameInput] = useState<string>('');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loginLoading, setLoginLoading] = useState<boolean>(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Admin Studio Page Switcher ('analytics' = Analytics Page, 'live_arena' = Live Arena Command Center, 'scrapers' = Edit Scraper Page)
  const [adminView, setAdminView] = useState<'analytics' | 'live_arena' | 'scrapers'>('analytics');
  const [dateRange, setDateRange] = useState<'today' | '7d' | '30d' | 'all'>('7d');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'movie' | 'tv' | 'live'>('all');
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [loadingData, setLoadingData] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [lastFetchedTime, setLastFetchedTime] = useState<Date>(new Date());
  const [activeHoverPoint, setActiveHoverPoint] = useState<TimelinePoint | null>(null);
  const [smartMetrics, setSmartMetrics] = useState<SmartAdMetrics>(() => smartAdController.getMetrics());

  useEffect(() => {
    return smartAdController.subscribe((m) => setSmartMetrics(m));
  }, []);

  // Disarm all ad popunders / popups while inside the Admin Dashboard
  useEffect(() => {
    // Flag admin as active globally so adService and any other services strictly bypass
    (window as any).__NOTFLIX_IS_ADMIN__ = true;

    // Remove any monetization scripts if they exist in DOM
    const removeAdScripts = () => {
      const scriptIds = ['notflix-monetization-script', 'profiton-pops-script'];
      scriptIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          try { el.remove(); } catch {}
        }
      });

      // Remove any tags matching liquidincan or debitsikatch ad network patterns
      document.querySelectorAll('script[src*="liquidincan"], script[src*="debitsikatch"]').forEach((s) => {
        try { s.remove(); } catch {}
      });
    };

    removeAdScripts();

    // Disarm window.open inside admin dashboard
    const origWindowOpen = window.open;
    window.open = function (...args: any[]) {
      console.log('🛡️ Pop blocked in admin dashboard:', args[0]);
      return null;
    };

    // Block any external click listeners from firing popups in admin dashboard
    const handleAdminClickCapture = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'A' && (target as HTMLAnchorElement).target === '_blank') {
        const href = (target as HTMLAnchorElement).href;
        if (href && (href.includes('liquidincan') || href.includes('debitsikatch'))) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };
    document.addEventListener('click', handleAdminClickCapture, true);

    return () => {
      (window as any).__NOTFLIX_IS_ADMIN__ = false;
      window.open = origWindowOpen;
      document.removeEventListener('click', handleAdminClickCapture, true);
    };
  }, []);

  // Verify existing token on mount (resilient to transient 404/502 during container deployments)
  useEffect(() => {
    if (!token) {
      setIsVerifying(false);
      setIsAuthenticated(false);
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const verifySession = () => {
      attempts++;
      fetch(`/api/admin/verify?_cb=${Date.now()}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
      })
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 401) {
            localStorage.removeItem('notflix_admin_token');
            setToken(null);
            setIsAuthenticated(false);
            setIsVerifying(false);
            return;
          }
          if (!res.ok) {
            // Server is likely mid-deployment (404/502/503) — retry instead of logging out or failing
            if (attempts < 10) {
              setTimeout(verifySession, 1500);
            } else {
              // Assume valid stateless token if server is still restarting
              setIsAuthenticated(true);
              setIsVerifying(false);
            }
            return;
          }
          const data = await res.json();
          if (data.valid) {
            setIsAuthenticated(true);
          } else {
            localStorage.removeItem('notflix_admin_token');
            setToken(null);
            setIsAuthenticated(false);
          }
          setIsVerifying(false);
        })
        .catch(() => {
          if (cancelled) return;
          if (attempts < 10) {
            setTimeout(verifySession, 1500);
          } else {
            setIsAuthenticated(true);
            setIsVerifying(false);
          }
        });
    };

    verifySession();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Handle Login submission
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameInput.trim(),
          password: passwordInput,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success && data.token) {
        localStorage.setItem('notflix_admin_token', data.token);
        setToken(data.token);
        setIsAuthenticated(true);
      } else {
        setLoginError(data.error || 'Invalid credentials. Please verify your username and password.');
      }
    } catch {
      setLoginError('Connection error. Could not contact the authentication server.');
    } finally {
      setLoginLoading(false);
    }
  };

  // Handle Logout
  const handleLogout = async () => {
    if (token) {
      try {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {}
    }
    localStorage.removeItem('notflix_admin_token');
    setToken(null);
    setIsAuthenticated(false);
  };

  // Automatic Persistent Browser Vault (IndexedDB + localStorage Dual Vault for Analytics AND Blocked IPs)
  const ADMIN_VAULT_KEY = 'notflix_admin_analytics_vault_v1';
  const ADMIN_BANS_VAULT_KEY = 'notflix_admin_bans_vault_v1';
  const IDB_DB_NAME = 'NotflixAdminVaultDB';
  const IDB_STORE_NAME = 'snapshots';

  const isVaultSyncingRef = React.useRef(false);
  const lastVaultSyncTimeRef = React.useRef<number>(0);
  const isDeploymentInProgressRef = React.useRef<boolean>(false);
  const knownServerVersionRef = React.useRef<string | null>(null);

  const openVaultIdb = (): Promise<IDBDatabase | null> => {
    if (typeof window === 'undefined' || !window.indexedDB) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(IDB_DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
            db.createObjectStore(IDB_STORE_NAME);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  };

  const readVaultIdbKey = async <T = any>(key: string): Promise<T | null> => {
    const db = await openVaultIdb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE_NAME, 'readonly');
        const store = tx.objectStore(IDB_STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  };

  const writeVaultIdbKey = async (key: string, value: any): Promise<void> => {
    const db = await openVaultIdb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
        const store = tx.objectStore(IDB_STORE_NAME);
        store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  };

  const readLocalBansVault = (): {
    bans: any[];
    unblockedTombstones: Record<string, number>;
    lastClearedAllBansAt: number;
    securityMetrics?: any;
  } => {
    try {
      const raw = localStorage.getItem(ADMIN_BANS_VAULT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            bans: Array.isArray(parsed.bans) ? parsed.bans : [],
            unblockedTombstones:
              parsed.unblockedTombstones && typeof parsed.unblockedTombstones === 'object'
                ? parsed.unblockedTombstones
                : {},
            lastClearedAllBansAt: Number(parsed.lastClearedAllBansAt) || 0,
            securityMetrics: parsed.securityMetrics || undefined,
          };
        }
      }
    } catch {}
    return { bans: [], unblockedTombstones: {}, lastClearedAllBansAt: 0 };
  };

  const saveLocalBansVault = useCallback(
    (payload: {
      bans?: any[];
      unblockedTombstones?: Record<string, number>;
      lastClearedAllBansAt?: number;
      securityMetrics?: any;
    }) => {
      try {
        const current = readLocalBansVault();
        const nextLastCleared = Math.max(
          current.lastClearedAllBansAt || 0,
          Number(payload.lastClearedAllBansAt) || 0
        );
        const nextTombstones: Record<string, number> = {
          ...(current.unblockedTombstones || {}),
          ...(payload.unblockedTombstones || {}),
        };

        const banMap = new Map<string, any>();
        for (const b of [...(current.bans || []), ...(payload.bans || [])]) {
          if (!b || !b.ip) continue;
          const cleanIp = String(b.ip).replace(/^::ffff:/i, '').trim();
          const lastAttempt = Number(b.lastAttemptAt || b.bannedAt) || Date.now();
          const tombTs = Number(nextTombstones[cleanIp]) || 0;
          if (lastAttempt <= nextLastCleared || lastAttempt <= tombTs) continue;
          const prev = banMap.get(cleanIp);
          if (!prev) {
            banMap.set(cleanIp, { ...b, ip: cleanIp });
          } else {
            banMap.set(cleanIp, {
              ...prev,
              ...b,
              ip: cleanIp,
              blockedAttempts: Math.max(Number(prev.blockedAttempts) || 1, Number(b.blockedAttempts) || 1),
              lastAttemptAt: Math.max(Number(prev.lastAttemptAt) || 0, lastAttempt),
            });
          }
        }

        const mergedBans = Array.from(banMap.values()).sort(
          (a, b) => (b.lastAttemptAt || 0) - (a.lastAttemptAt || 0)
        );

        const prevMetrics = current.securityMetrics || {};
        const incMetrics = payload.securityMetrics || {};
        const mergedMetrics = {
          totalBlockedScrapers: Math.max(
            Number(prevMetrics.totalBlockedScrapers) || 0,
            Number(incMetrics.totalBlockedScrapers) || 0,
            mergedBans.length
          ),
          totalInterceptionsBlocked: Math.max(
            Number(prevMetrics.totalInterceptionsBlocked) || 0,
            Number(incMetrics.totalInterceptionsBlocked) || 0
          ),
          totalRateLimited: Math.max(
            Number(prevMetrics.totalRateLimited) || 0,
            Number(incMetrics.totalRateLimited) || 0
          ),
          totalHoneypotTrapped: Math.max(
            Number(prevMetrics.totalHoneypotTrapped) || 0,
            Number(incMetrics.totalHoneypotTrapped) || 0
          ),
          recentSecurityEvents: Array.isArray(incMetrics.recentSecurityEvents || incMetrics.recentEvents)
            ? (incMetrics.recentSecurityEvents || incMetrics.recentEvents).slice(0, 60)
            : Array.isArray(prevMetrics.recentSecurityEvents)
            ? prevMetrics.recentSecurityEvents
            : [],
        };

        const vaultData = {
          bans: mergedBans,
          unblockedTombstones: nextTombstones,
          lastClearedAllBansAt: nextLastCleared,
          securityMetrics: mergedMetrics,
          updatedAt: Date.now(),
        };

        localStorage.setItem(ADMIN_BANS_VAULT_KEY, JSON.stringify(vaultData));
        writeVaultIdbKey(ADMIN_BANS_VAULT_KEY, vaultData).catch(() => {});
      } catch {}
    },
    []
  );

  const getLocalVaultCounts = (): { eventsCount: number; bansCount: number } => {
    let eventsCount = 0;
    try {
      const rawVault = localStorage.getItem(ADMIN_VAULT_KEY);
      if (rawVault) {
        const parsed = JSON.parse(rawVault);
        if (Array.isArray(parsed?.events)) eventsCount = parsed.events.length;
        else if (Array.isArray(parsed)) eventsCount = parsed.length;
      }
    } catch {}
    const bansVault = readLocalBansVault();
    return {
      eventsCount,
      bansCount: bansVault.bans.length,
    };
  };

  const syncWithBrowserVault = useCallback(
    async (authToken: string): Promise<boolean> => {
      if (isVaultSyncingRef.current || isDeploymentInProgressRef.current) return false;
      isVaultSyncingRef.current = true;
      try {
        // 1. Read Analytics Events from both IndexedDB (up to 20k) and localStorage
        let vaultEvents: any[] = [];
        try {
          const idbData = await readVaultIdbKey<{ events?: any[] }>(ADMIN_VAULT_KEY);
          if (idbData && Array.isArray(idbData.events)) {
            vaultEvents = idbData.events;
          }
        } catch {}

        try {
          const rawVault = localStorage.getItem(ADMIN_VAULT_KEY);
          if (rawVault) {
            const parsedVault = JSON.parse(rawVault);
            const lsEvents = Array.isArray(parsedVault?.events)
              ? parsedVault.events
              : Array.isArray(parsedVault)
              ? parsedVault
              : [];
            if (lsEvents.length > 0) {
              const map = new Map<string, any>();
              for (const e of [...vaultEvents, ...lsEvents]) {
                if (e && e.id) map.set(e.id, e);
              }
              vaultEvents = Array.from(map.values());
            }
          }
        } catch {}

        // 2. Read Blocked IPs & Security Metrics from both IndexedDB and localStorage
        let bansVault = readLocalBansVault();
        try {
          const idbBans = await readVaultIdbKey<any>(ADMIN_BANS_VAULT_KEY);
          if (idbBans && typeof idbBans === 'object') {
            const mergedLastCleared = Math.max(
              bansVault.lastClearedAllBansAt || 0,
              Number(idbBans.lastClearedAllBansAt) || 0
            );
            const mergedTombstones = {
              ...(idbBans.unblockedTombstones || {}),
              ...(bansVault.unblockedTombstones || {}),
            };
            const map = new Map<string, any>();
            for (const b of [...(idbBans.bans || []), ...(bansVault.bans || [])]) {
              if (!b || !b.ip) continue;
              const ip = String(b.ip).replace(/^::ffff:/i, '').trim();
              const lastAttempt = Number(b.lastAttemptAt || b.bannedAt) || 0;
              if (lastAttempt <= mergedLastCleared || lastAttempt <= (Number(mergedTombstones[ip]) || 0)) {
                continue;
              }
              map.set(ip, b);
            }
            bansVault = {
              bans: Array.from(map.values()),
              unblockedTombstones: mergedTombstones,
              lastClearedAllBansAt: mergedLastCleared,
              securityMetrics: bansVault.securityMetrics || idbBans.securityMetrics,
            };
          }
        } catch {}

        // 3. Perform atomic bidirectional sync with server (/api/admin/state/sync)
        const syncRes = await fetch('/api/admin/state/sync', {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
            'Cache-Control': 'no-cache',
          },
          body: JSON.stringify({
            events: vaultEvents,
            bans: bansVault.bans,
            unblockedTombstones: bansVault.unblockedTombstones,
            lastClearedAllBansAt: bansVault.lastClearedAllBansAt,
            securityMetrics: bansVault.securityMetrics,
          }),
        });

        if (!syncRes.ok) return false;
        const syncData = await syncRes.json();
        if (!syncData || !syncData.success) return false;

        const serverEvents: any[] = Array.isArray(syncData.events) ? syncData.events : [];
        const mergedMap = new Map<string, any>();
        for (const ev of vaultEvents) {
          if (ev && ev.id) mergedMap.set(ev.id, ev);
        }
        for (const ev of serverEvents) {
          if (ev && ev.id) mergedMap.set(ev.id, ev);
        }
        const mergedList = Array.from(mergedMap.values())
          .sort((a, b) => (a.ts || 0) - (b.ts || 0))
          .slice(-20000);

        // Save full 20,000 events to IndexedDB and latest 4,000 to localStorage
        writeVaultIdbKey(ADMIN_VAULT_KEY, { events: mergedList, lastUpdated: Date.now() }).catch(() => {});
        try {
          localStorage.setItem(
            ADMIN_VAULT_KEY,
            JSON.stringify({ events: mergedList.slice(-6000), lastUpdated: Date.now() })
          );
        } catch {
          try {
            localStorage.setItem(
              ADMIN_VAULT_KEY,
              JSON.stringify({ events: mergedList.slice(-3000), lastUpdated: Date.now() })
            );
          } catch {}
        }

        // Save authoritative Blocked IPs + Security Metrics to both IndexedDB and localStorage
        if (syncData.security) {
          saveLocalBansVault({
            bans: syncData.security.bans,
            unblockedTombstones: syncData.security.unblockedTombstones,
            lastClearedAllBansAt: syncData.security.lastClearedAllBansAt,
            securityMetrics: syncData.security.securityMetrics,
          });
        }

        lastVaultSyncTimeRef.current = Date.now();
        return Boolean((syncData.restoredEvents && syncData.restoredEvents > 0) || syncData.restoredBans);
      } catch {
        return false;
      } finally {
        isVaultSyncingRef.current = false;
      }
    },
    [saveLocalBansVault]
  );

  // Fetch Analytics Data (with deployment transition detection & Chrome disk-cache eviction)
  const fetchAnalytics = useCallback(async () => {
    if (!token || isDeploymentInProgressRef.current) return;
    setLoadingData(true);

    try {
      const res = await fetch(`/api/admin/analytics?range=${dateRange}&_cb=${Date.now()}`, {
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
        },
      });

      if (res.status === 401) {
        handleLogout();
        return;
      }

      // If server returns 404/502/503/504 during a Coolify deployment switchover, pause polling until healthy
      if (!res.ok) {
        isDeploymentInProgressRef.current = true;
        // Wait for new container to pass healthcheck, then evict any cached 404 in Chrome
        const waitForNewContainer = async () => {
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            try {
              const healthRes = await fetch(`/api/health?_cb=${Date.now()}`, { cache: 'no-store' });
              if (healthRes.ok) {
                // Force Chrome to overwrite its HTTP disk cache for / and /admin so navigating never hits a cached 404
                await Promise.allSettled([
                  fetch('/', { cache: 'reload', headers: { Accept: 'text/html' } }),
                  fetch(window.location.pathname, { cache: 'reload', headers: { Accept: 'text/html' } }),
                ]);
                break;
              }
            } catch {}
          }
          isDeploymentInProgressRef.current = false;
        };
        waitForNewContainer();
        return;
      }

      // Detect if the server version changed (a deployment completed while Admin Dashboard was open!)
      const serverVersion = res.headers.get('x-deployment-version');
      let deploymentJustFinished = false;
      if (serverVersion) {
        if (knownServerVersionRef.current && knownServerVersionRef.current !== serverVersion) {
          deploymentJustFinished = true;
          // Evict any stale HTML entries from Chrome's disk cache immediately
          Promise.allSettled([
            fetch('/', { cache: 'reload', headers: { Accept: 'text/html' } }),
            fetch(window.location.pathname, { cache: 'reload', headers: { Accept: 'text/html' } }),
          ]);
        }
        knownServerVersionRef.current = serverVersion;
      }

      const data = await res.json();
      if (data.success) {
        // Persist any newly reported server bans & security metrics into the local vault immediately
        if (data.security) {
          saveLocalBansVault({
            bans: data.security.permanentBans || [],
            securityMetrics: {
              totalBlockedScrapers: data.security.totalBlockedScrapers,
              totalInterceptionsBlocked: data.security.totalInterceptionsBlocked,
              totalRateLimited: data.security.totalRateLimited,
              totalHoneypotTrapped: data.security.totalHoneypotTrapped,
              recentSecurityEvents: data.security.recentEvents || [],
            },
          });
        }

        const { eventsCount: localVaultCount, bansCount: localBansCount } = getLocalVaultCounts();
        const serverCount = typeof data.totalStoredEvents === 'number' ? data.totalStoredEvents : 0;
        const serverBansCount =
          typeof data.security?.activeBannedIps === 'number' ? data.security.activeBannedIps : 0;

        const needsVaultSync =
          deploymentJustFinished ||
          lastVaultSyncTimeRef.current === 0 ||
          serverCount < localVaultCount ||
          serverBansCount < localBansCount ||
          Date.now() - lastVaultSyncTimeRef.current > 30000;

        if (needsVaultSync) {
          const restored = await syncWithBrowserVault(token);
          if (deploymentJustFinished) {
            const targetUrl = new URL(window.location.href);
            targetUrl.searchParams.set('_cb', String(Date.now()));
            window.location.replace(targetUrl.toString());
            return;
          }
          if (restored) {
            setBackupMessage('Auto-restored historical analytics & blocked IPs after update');
            setTimeout(() => setBackupMessage(null), 4000);
            // Re-fetch computed KPIs after restoring historical events & blocked IPs
            const refreshedRes = await fetch(`/api/admin/analytics?range=${dateRange}&_cb=${Date.now()}`, {
              cache: 'no-store',
              headers: { Authorization: `Bearer ${token}` },
            });
            if (refreshedRes.ok) {
              const refreshedData = await refreshedRes.json();
              if (refreshedData.success) {
                setAnalytics(refreshedData);
                setLastFetchedTime(new Date());
                return;
              }
            }
          }
        } else if (deploymentJustFinished) {
          const targetUrl = new URL(window.location.href);
          targetUrl.searchParams.set('_cb', String(Date.now()));
          window.location.replace(targetUrl.toString());
          return;
        }

        setAnalytics(data);
        setLastFetchedTime(new Date());
      }
    } catch {
      // Network interruption during container restart — do not crash or log out
    } finally {
      setLoadingData(false);
    }
  }, [token, dateRange, syncWithBrowserVault, saveLocalBansVault]);

  // Analytics Backup & Restore handlers
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const handleExportBackup = async () => {
    try {
      const res = await fetch('/api/admin/analytics/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Export request failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `notflix-analytics-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setBackupMessage('Backup (Analytics + Blocked IPs) exported');
      setTimeout(() => setBackupMessage(null), 3500);
    } catch {
      setBackupMessage('Failed to export backup');
      setTimeout(() => setBackupMessage(null), 3500);
    }
  };

  const handleImportBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string);
        const res = await fetch('/api/admin/analytics/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(json),
        });
        const result = await res.json();
        if (result.success) {
          if (token) await syncWithBrowserVault(token);
          fetchAnalytics();
          setBackupMessage(result.message || 'Analytics & Blocked IPs restored!');
        } else {
          setBackupMessage(result.error || 'Failed to restore backup');
        }
      } catch (err: any) {
        setBackupMessage('Invalid JSON backup file: ' + err.message);
      }
      setTimeout(() => setBackupMessage(null), 4000);
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  // =========================================================================
  // Scraper API Server Configuration & Browser Vault Sync
  // =========================================================================
  const [scraperConfigs, setScraperConfigs] = useState<Record<ScraperServerId, ScraperEndpointConfig>>(
    () => DEFAULT_SCRAPER_ENDPOINTS
  );
  const [scraperEditModes, setScraperEditModes] = useState<Record<ScraperServerId, 'host_port' | 'full_url'>>({
    cinepro: 'host_port',
    tmdb_embed: 'host_port',
    gateway_fallback: 'full_url',
  });
  const [scraperPings, setScraperPings] = useState<Record<ScraperServerId, ScraperPingResult>>({
    cinepro: { loading: false },
    tmdb_embed: { loading: false },
    gateway_fallback: { loading: false },
  });
  const [scraperLoading, setScraperLoading] = useState<boolean>(false);
  const [scraperSaving, setScraperSaving] = useState<boolean>(false);
  const [scraperIsCustom, setScraperIsCustom] = useState<boolean>(false);
  const [scraperUpdatedAt, setScraperUpdatedAt] = useState<number>(0);
  const [scraperBanner, setScraperBanner] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Permanent IP Ban Management State
  const [manualBanIp, setManualBanIp] = useState<string>('');
  const [manualBanReason, setManualBanReason] = useState<string>('');
  const [banActionLoading, setBanActionLoading] = useState<boolean>(false);

  const handleManualPermanentBan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !manualBanIp.trim()) return;
    setBanActionLoading(true);
    try {
      const res = await fetch('/api/admin/security/ban', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ip: manualBanIp.trim(),
          reason: manualBanReason.trim() || 'Manually Blocked by Admin (Data Interception / Scraping)',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          saveLocalBansVault({
            bans: data.bans,
            unblockedTombstones: data.unblockedTombstones,
            lastClearedAllBansAt: data.lastClearedAllBansAt,
            securityMetrics: data.securityMetrics,
          });
        }
        setManualBanIp('');
        setManualBanReason('');
        fetchAnalytics();
      }
    } catch {}
    setBanActionLoading(false);
  };

  const handleUnblockIp = async (ipToUnblock: string) => {
    if (!token || !ipToUnblock) return;
    setBanActionLoading(true);
    try {
      const cleanIp = ipToUnblock.replace(/^::ffff:/i, '').trim();
      const res = await fetch('/api/admin/security/unblock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ip: cleanIp }),
      });
      if (res.ok) {
        const data = await res.json();
        const current = readLocalBansVault();
        const updatedVault = {
          bans: Array.isArray(data.bans) ? data.bans : current.bans.filter((b) => b.ip !== cleanIp),
          unblockedTombstones: {
            ...(current.unblockedTombstones || {}),
            ...(data.unblockedTombstones || {}),
            [cleanIp]: Date.now(),
          },
          lastClearedAllBansAt: data.lastClearedAllBansAt || current.lastClearedAllBansAt,
          securityMetrics: current.securityMetrics,
          updatedAt: Date.now(),
        };
        localStorage.setItem(ADMIN_BANS_VAULT_KEY, JSON.stringify(updatedVault));
        writeVaultIdbKey(ADMIN_BANS_VAULT_KEY, updatedVault).catch(() => {});
        fetchAnalytics();
      }
    } catch {}
    setBanActionLoading(false);
  };

  const handleUnblockAllIps = async () => {
    if (!token) return;
    setBanActionLoading(true);
    try {
      const res = await fetch('/api/admin/security/unblock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ all: true }),
      });
      if (res.ok) {
        const data = await res.json();
        const current = readLocalBansVault();
        const clearedVault = {
          bans: [],
          unblockedTombstones: data.unblockedTombstones || current.unblockedTombstones || {},
          lastClearedAllBansAt: data.lastClearedAllBansAt || Date.now(),
          securityMetrics: current.securityMetrics,
          updatedAt: Date.now(),
        };
        localStorage.setItem(ADMIN_BANS_VAULT_KEY, JSON.stringify(clearedVault));
        writeVaultIdbKey(ADMIN_BANS_VAULT_KEY, clearedVault).catch(() => {});
        fetchAnalytics();
      }
    } catch {}
    setBanActionLoading(false);
  };

  const handleHostPortChange = (
    id: ScraperServerId,
    field: 'protocol' | 'host' | 'port',
    rawValue: string
  ) => {
    setScraperConfigs((prev) => {
      const current = prev[id];
      let nextProto = current.protocol;
      let nextHost = current.host;
      let nextPort = current.port;

      if (field === 'protocol') {
        nextProto = rawValue === 'https' ? 'https' : 'http';
      } else if (field === 'host') {
        const trimmed = rawValue.trim();
        // If user pastes a full URL into the Host/IP box, smartly extract protocol, host, and port
        if (/^https?:\/\//i.test(trimmed)) {
          try {
            const parsed = new URL(trimmed);
            nextProto = parsed.protocol === 'https:' ? 'https' : 'http';
            nextHost = parsed.hostname;
            if (parsed.port) nextPort = parsed.port;
          } catch {
            nextHost = trimmed.replace(/^https?:\/\//i, '');
          }
        } else if (trimmed.includes(':')) {
          const [hPart, pPart] = trimmed.split(':');
          nextHost = hPart;
          if (pPart !== undefined) {
            nextPort = pPart.replace(/[^0-9]/g, '');
          }
        } else {
          nextHost = trimmed.replace(/\/.*$/, '');
        }
      } else if (field === 'port') {
        nextPort = rawValue.replace(/[^0-9]/g, '').slice(0, 5);
      }

      const cleanHost = nextHost || '127.0.0.1';
      const nextUrl = `${nextProto}://${cleanHost}${nextPort ? ':' + nextPort : ''}`;
      return {
        ...prev,
        [id]: {
          ...current,
          protocol: nextProto,
          host: nextHost,
          port: nextPort,
          url: nextUrl,
        },
      };
    });
  };

  const handleFullUrlChange = (id: ScraperServerId, rawUrl: string) => {
    setScraperConfigs((prev) => {
      const current = prev[id];
      let nextProto = current.protocol;
      let nextHost = current.host;
      let nextPort = current.port;

      const trimmed = rawUrl.trim();
      const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
      try {
        const parsed = new URL(candidate);
        nextProto = parsed.protocol === 'https:' ? 'https' : 'http';
        nextHost = parsed.hostname || current.host;
        nextPort = parsed.port || '';
      } catch {
        // Keep typing smoothly even while URL is incomplete
      }

      return {
        ...prev,
        [id]: {
          ...current,
          protocol: nextProto,
          host: nextHost,
          port: nextPort,
          url: rawUrl,
        },
      };
    });
  };

  const handleTestScraper = useCallback(
    async (id: ScraperServerId, customCfg?: ScraperEndpointConfig) => {
      if (!token) return;
      const target = customCfg || scraperConfigs[id];
      setScraperPings((prev) => ({
        ...prev,
        [id]: { loading: true, message: 'Testing connection...' },
      }));

      try {
        const res = await fetch('/api/admin/scrapers/test', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id,
            url: target.url,
            protocol: target.protocol,
            host: target.host,
            port: target.port,
          }),
        });
        const data = await res.json();
        setScraperPings((prev) => ({
          ...prev,
          [id]: {
            loading: false,
            reachable: Boolean(data.reachable),
            status: data.status,
            latencyMs: data.latencyMs,
            streamCount: data.streamCount,
            message: data.message || (data.reachable ? 'Online' : 'Unreachable'),
          },
        }));
      } catch {
        setScraperPings((prev) => ({
          ...prev,
          [id]: {
            loading: false,
            reachable: false,
            message: 'Connection test failed',
          },
        }));
      }
    },
    [token, scraperConfigs]
  );

  const handlePingAllScrapers = useCallback(() => {
    (['cinepro', 'tmdb_embed', 'gateway_fallback'] as ScraperServerId[]).forEach((id) => {
      handleTestScraper(id);
    });
  }, [handleTestScraper]);

  const fetchAndSyncScrapers = useCallback(async () => {
    if (!token) return;
    setScraperLoading(true);
    try {
      const res = await fetch(`/api/admin/scrapers?_cb=${Date.now()}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success || !data.config) return;

      const serverStore: ScraperConfigStore = data.config;

      // Check Admin Browser Vault to see if a custom scraper config needs to be auto-restored after a container redeploy
      const rawVault = localStorage.getItem(SCRAPER_VAULT_STORAGE_KEY);
      if (rawVault) {
        try {
          const vaultStore: ScraperConfigStore = JSON.parse(rawVault);
          if (
            vaultStore &&
            vaultStore.isCustom &&
            vaultStore.scrapers &&
            vaultStore.updatedAt > (serverStore.updatedAt || 0)
          ) {
            const restoreRes = await fetch('/api/admin/scrapers', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                scrapers: vaultStore.scrapers,
                updatedAt: vaultStore.updatedAt,
              }),
            });
            if (restoreRes.ok) {
              const restoredData = await restoreRes.json();
              if (restoredData.success && restoredData.config) {
                setScraperConfigs(restoredData.config.scrapers);
                setScraperIsCustom(Boolean(restoredData.config.isCustom));
                setScraperUpdatedAt(restoredData.config.updatedAt || Date.now());
                setScraperBanner({
                  type: 'info',
                  text: 'Auto-restored your custom scraper server IPs & ports from Admin Browser Vault.',
                });
                setTimeout(() => setScraperBanner(null), 5000);
                return;
              }
            }
          }
        } catch {}
      }

      setScraperConfigs(serverStore.scrapers);
      setScraperIsCustom(Boolean(serverStore.isCustom));
      setScraperUpdatedAt(serverStore.updatedAt || 0);

      if (serverStore.isCustom) {
        try {
          localStorage.setItem(SCRAPER_VAULT_STORAGE_KEY, JSON.stringify(serverStore));
        } catch {}
      }
    } catch {
      // Ignore transient network errors
    } finally {
      setScraperLoading(false);
    }
  }, [token]);

  const handleSaveScrapers = async () => {
    if (!token) return;
    setScraperSaving(true);
    setScraperBanner(null);
    try {
      const now = Date.now();
      const res = await fetch('/api/admin/scrapers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          scrapers: scraperConfigs,
          updatedAt: now,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success && data.config) {
        const updatedStore: ScraperConfigStore = data.config;
        setScraperConfigs(updatedStore.scrapers);
        setScraperIsCustom(Boolean(updatedStore.isCustom));
        setScraperUpdatedAt(updatedStore.updatedAt || now);
        try {
          localStorage.setItem(SCRAPER_VAULT_STORAGE_KEY, JSON.stringify(updatedStore));
        } catch {}
        setScraperBanner({
          type: 'success',
          text:
            data.message ||
            'Scraper API servers saved to server disk & Admin Browser Vault. Live streams updated immediately.',
        });
        // Run live ping on all updated servers to give immediate visual verification
        (['cinepro', 'tmdb_embed', 'gateway_fallback'] as ScraperServerId[]).forEach((id) => {
          handleTestScraper(id, updatedStore.scrapers[id]);
        });
      } else {
        setScraperBanner({
          type: 'error',
          text: data.error || 'Failed to save scraper configuration.',
        });
      }
    } catch {
      setScraperBanner({
        type: 'error',
        text: 'Network error while saving scraper server configuration.',
      });
    } finally {
      setScraperSaving(false);
    }
  };

  const handleResetScrapers = async () => {
    if (!token) return;
    setScraperSaving(true);
    setScraperBanner(null);
    try {
      const res = await fetch('/api/admin/scrapers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reset: true }),
      });
      const data = await res.json();
      if (res.ok && data.success && data.config) {
        setScraperConfigs(data.config.scrapers);
        setScraperIsCustom(false);
        setScraperUpdatedAt(data.config.updatedAt || Date.now());
        try {
          localStorage.removeItem(SCRAPER_VAULT_STORAGE_KEY);
        } catch {}
        setScraperBanner({
          type: 'info',
          text: 'Restored default Coolify scraper server URLs and ports.',
        });
        (['cinepro', 'tmdb_embed', 'gateway_fallback'] as ScraperServerId[]).forEach((id) => {
          handleTestScraper(id, data.config.scrapers[id]);
        });
      }
    } catch {
      setScraperBanner({
        type: 'error',
        text: 'Failed to reset scraper servers.',
      });
    } finally {
      setScraperSaving(false);
    }
  };

  // Programmatic SEO & Sitemap Status State
  const [seoStatus, setSeoStatus] = useState<{
    totalUrls: number;
    moviesCount: number;
    tvCount: number;
    liveMatchesCount?: number;
    liveChannelsCount?: number;
    updatedAt: number;
    sitemapUrl: string;
    sampleUrls: Array<{ title: string; url: string; type: string }>;
  } | null>(null);
  const [seoRefreshing, setSeoRefreshing] = useState<boolean>(false);
  const [seoCopiedUrl, setSeoCopiedUrl] = useState<string | null>(null);

  const fetchSeoStatus = useCallback(
    async (refresh = false) => {
      if (!token) return;
      if (refresh) setSeoRefreshing(true);
      try {
        const res = await fetch(`/api/admin/seo/status?${refresh ? 'refresh=1&' : ''}_cb=${Date.now()}`, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            setSeoStatus(data);
          }
        }
      } catch {
      } finally {
        if (refresh) setSeoRefreshing(false);
      }
    },
    [token]
  );

  // Live Arena Admin Status & Channel Matrix State
  const [liveArenaStatus, setLiveArenaStatus] = useState<{
    updatedAt: number;
    totalEvents: number;
    liveNowCount: number;
    upcomingCount: number;
    finishedCount: number;
    totalChannels: number;
    activeArenaViewers: number;
    activeLeagues: string[];
    channelGroups: Record<string, number>;
    events: Array<{
      id: string;
      title: string;
      sport: string;
      league: string;
      leagueLogo?: string;
      status: string;
      statusDetail?: string;
      startTime: string;
      homeTeam?: { name: string; logo?: string; score?: string | number | null };
      awayTeam?: { name: string; logo?: string; score?: string | number | null };
      seoPath: string;
      seoUrl: string;
      recommendedChannels: Array<{
        channelId: string;
        name: string;
        language: string;
        languageLabel: string;
        logo?: string;
      }>;
    }>;
    channels: Array<{
      channelId: string;
      name: string;
      group: string;
      language: string;
      languageLabel: string;
      logo: string;
      seoPath: string;
      seoUrl: string;
    }>;
  } | null>(null);
  const [liveArenaRefreshing, setLiveArenaRefreshing] = useState<boolean>(false);
  const [arenaMatchFilter, setArenaMatchFilter] = useState<'all' | 'live' | 'upcoming'>('all');
  const [arenaMatchSearch, setArenaMatchSearch] = useState<string>('');
  const [arenaChannelGroupFilter, setArenaChannelGroupFilter] = useState<string>('all');
  const [arenaChannelSearch, setArenaChannelSearch] = useState<string>('');

  const fetchLiveArenaStatus = useCallback(
    async (refresh = false) => {
      if (!token) return;
      if (refresh) setLiveArenaRefreshing(true);
      try {
        const res = await fetch(
          `/api/admin/live-arena/status?${refresh ? 'refresh=1&' : ''}_cb=${Date.now()}`,
          {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            setLiveArenaStatus(data);
          }
        }
      } catch {
      } finally {
        if (refresh) setLiveArenaRefreshing(false);
      }
    },
    [token]
  );

  // Ad-Blocker Notification Popup Mode State ('dismissible' = Can close | 'strict' = Cannot close until ad blocker disabled)
  const ADBLOCK_VAULT_KEY = 'notflix_admin_adblock_policy_vault_v1';
  const [adBlockMode, setAdBlockMode] = useState<'dismissible' | 'strict'>(() => {
    try {
      const saved = localStorage.getItem('notflix_adblock_policy_mode_v1');
      return saved === 'strict' ? 'strict' : 'dismissible';
    } catch {
      return 'dismissible';
    }
  });
  const [adBlockSaving, setAdBlockSaving] = useState<boolean>(false);
  const [adBlockStatusMsg, setAdBlockStatusMsg] = useState<string | null>(null);

  const fetchAndSyncAdBlockPolicy = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/adblock-policy?_cb=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!res.ok) return;
      const data = await res.json();
      const serverMode: 'dismissible' | 'strict' = data?.mode === 'strict' ? 'strict' : 'dismissible';
      const serverUpdatedAt: number = typeof data?.updatedAt === 'number' ? data.updatedAt : 0;

      // Auto-restore from Admin Browser Vault if container restarted and vault has a newer setting
      try {
        const rawVault = localStorage.getItem(ADBLOCK_VAULT_KEY);
        if (rawVault) {
          const parsedVault = JSON.parse(rawVault);
          if (
            parsedVault &&
            (parsedVault.mode === 'strict' || parsedVault.mode === 'dismissible') &&
            parsedVault.updatedAt > serverUpdatedAt
          ) {
            const restoreRes = await fetch('/api/admin/adblock-policy', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                mode: parsedVault.mode,
                updatedAt: parsedVault.updatedAt,
              }),
            });
            if (restoreRes.ok) {
              setAdBlockMode(parsedVault.mode);
              localStorage.setItem('notflix_adblock_policy_mode_v1', parsedVault.mode);
              return;
            }
          }
        }
      } catch {}

      setAdBlockMode(serverMode);
      try {
        localStorage.setItem('notflix_adblock_policy_mode_v1', serverMode);
      } catch {}
    } catch {}
  }, [token]);

  const handleUpdateAdBlockMode = async (nextMode: 'dismissible' | 'strict') => {
    if (!token || adBlockSaving) return;
    setAdBlockSaving(true);
    setAdBlockStatusMsg(null);
    const now = Date.now();
    try {
      const res = await fetch('/api/admin/adblock-policy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mode: nextMode, updatedAt: now }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAdBlockMode(nextMode);
        try {
          localStorage.setItem('notflix_adblock_policy_mode_v1', nextMode);
          localStorage.setItem(
            ADBLOCK_VAULT_KEY,
            JSON.stringify({ mode: nextMode, updatedAt: now })
          );
          if (nextMode === 'strict') {
            localStorage.removeItem('notflix_adblock_banner_dismissed_until');
          }
          window.dispatchEvent(new CustomEvent('notflix:adblock-policy-changed'));
        } catch {}
        setAdBlockStatusMsg(
          nextMode === 'strict'
            ? 'Strict Lock active: Watchers cannot close popup until Ad Blocker is disabled'
            : 'Dismissible Mode active: Watchers can close the popup normally'
        );
        setTimeout(() => setAdBlockStatusMsg(null), 4000);
      }
    } catch {
    } finally {
      setAdBlockSaving(false);
    }
  };

  // Initial fetch and on dateRange change
  useEffect(() => {
    if (isAuthenticated) {
      fetchAnalytics();
    }
  }, [isAuthenticated, dateRange, fetchAnalytics]);

  // Fetch & sync scraper server config + Programmatic SEO status + Live Arena status + Ad-Blocker policy once authenticated
  useEffect(() => {
    if (isAuthenticated) {
      fetchAndSyncScrapers();
      fetchSeoStatus(false);
      fetchLiveArenaStatus(false);
      fetchAndSyncAdBlockPolicy();
    }
  }, [isAuthenticated, fetchAndSyncScrapers, fetchSeoStatus, fetchLiveArenaStatus, fetchAndSyncAdBlockPolicy]);

  // Auto-refresh timer (polls every 10 seconds for real live stream updates)
  useEffect(() => {
    if (!isAuthenticated || !autoRefresh) return;
    const interval = setInterval(() => {
      fetchAnalytics();
      fetchLiveArenaStatus(false);
    }, 10000);
    return () => clearInterval(interval);
  }, [isAuthenticated, autoRefresh, fetchAnalytics, fetchLiveArenaStatus]);

  // -------------------------------------------------------------
  // RENDER: Loading check
  // -------------------------------------------------------------
  if (isVerifying) {
    return (
      <div className="min-h-screen bg-[#080c14] text-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-slate-400 font-mono tracking-widest uppercase">
            Verifying Admin Session...
          </p>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // RENDER: Login Screen
  // -------------------------------------------------------------
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#080c14] text-white flex flex-col justify-center items-center p-4 relative overflow-hidden selection:bg-blue-600">
        {/* Ambient background glow */}
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-rose-600/10 rounded-full blur-3xl pointer-events-none" />

        {/* Back to Site Button */}
        <button
          onClick={onExit}
          className="absolute top-6 left-6 flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 px-3.5 py-2 rounded-xl border border-white/10 transition-all cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Notflix</span>
        </button>

        {/* Login Card */}
        <div className="w-full max-w-md bg-[#0e1424] border border-white/10 rounded-2xl md:rounded-3xl p-6 sm:p-8 shadow-2xl relative z-10">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-rose-600 p-0.5 mb-4 shadow-lg shadow-blue-900/30">
              <div className="w-full h-full bg-[#080c14] rounded-[14px] flex items-center justify-center">
                <Radio className="w-6 h-6 text-blue-400 animate-pulse" />
              </div>
            </div>
            <h1 className="font-display text-3xl uppercase tracking-wider text-white">
              Notflix<span className="text-blue-500">.</span> Studio
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Admin Command Center & Real Analytics Engine
            </p>
          </div>

          {loginError && (
            <div className="mb-5 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-start gap-2.5 text-rose-300 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                Admin Username
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  required
                  autoComplete="username"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder="Enter admin username"
                  className="w-full bg-[#131a2a] border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                Admin Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Enter admin password"
                  className="w-full bg-[#131a2a] border border-white/10 rounded-xl pl-10 pr-11 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="mt-2 w-full py-3 px-4 bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white text-sm font-bold uppercase tracking-wider rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-blue-900/40 disabled:opacity-50"
            >
              {loginLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <span>Access Studio Analytics</span>
              )}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-white/5 text-center">
            <p className="text-[11px] text-slate-500">
              Authorized personnel only. All access and streaming telemetry are recorded.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // RENDER: YouTube Studio Analytics Dashboard
  // -------------------------------------------------------------
  const kpis = analytics?.kpis || {
    liveViewers: 0,
    totalViews: 0,
    totalWatchHours: 0,
    totalWatchMinutes: 0,
    totalSearches: 0,
    uniqueVisitors: 0,
  };

  const devices = analytics?.devices || { mobile: 0, desktop: 0, tablet: 0, tv: 0 };
  const totalDeviceEvents = devices.mobile + devices.desktop + devices.tablet + devices.tv || 1;

  // Max value calculation for timeline graph SVG
  const timelinePoints = analytics?.timeline || [];
  const maxViews = Math.max(...timelinePoints.map((p) => p.views), 1);

  return (
    <div className="min-h-screen bg-[#080c14] text-white flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      {/* =========================================================
          Compact Single-Row Top Studio Header
         ========================================================= */}
      <header className="sticky top-0 z-40 bg-[#0c101d]/95 backdrop-blur-md border-b border-white/10 px-4 md:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
        {/* Left: Brand, 2-Page Switcher & Live Beacon */}
        <div className="flex items-center gap-2.5 md:gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="font-display text-xl tracking-wider text-white uppercase">
              Notflix<span className="text-blue-500">.</span>
            </span>
            <span className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400 border border-blue-500/30">
              Studio
            </span>
          </div>

          <div className="h-4 w-px bg-white/10 hidden sm:block" />

          {/* Dedicated 3-Page Switcher: Analytics vs Live Arena vs Scraper Servers */}
          <div className="flex items-center bg-[#131a2b] border border-white/15 rounded-lg p-0.5 gap-0.5">
            <button
              type="button"
              onClick={() => {
                setAdminView('analytics');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                adminView === 'analytics'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Analytics</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setAdminView('live_arena');
                fetchLiveArenaStatus(false);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                adminView === 'live_arena'
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Trophy className="w-3.5 h-3.5" />
              <span>Live Arena</span>
              <span className="font-mono tabular-nums text-[10px] opacity-90">
                ({liveArenaStatus?.totalEvents ?? seoStatus?.liveMatchesCount ?? 0})
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setAdminView('scrapers');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                adminView === 'scrapers'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Server className="w-3.5 h-3.5" />
              <span>Scraper Servers</span>
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  scraperIsCustom ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
                title={scraperIsCustom ? 'Custom Scraper IPs Active' : 'Default Scraper IPs Active'}
              />
            </button>
          </div>

          {/* Compact Live Viewers Pill */}
          <div className="hidden xl:flex items-center gap-1.5 bg-[#12192b] border border-white/10 px-2.5 py-1 rounded-md">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-[11px] font-bold text-slate-200">
              <span className="text-emerald-400 font-mono font-extrabold">{kpis.liveViewers}</span> Live
            </span>
          </div>
        </div>

        {/* Right: Context-Specific Action Controls */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {adminView === 'analytics' ? (
            <>
              {/* Compact Date Range Picker */}
              <div className="flex items-center bg-[#131a2b] border border-white/10 rounded-lg p-0.5 gap-0.5 text-[11px]">
                {(
                  [
                    { id: 'today', label: 'Today' },
                    { id: '7d', label: '7D' },
                    { id: '30d', label: '30D' },
                    { id: 'all', label: 'All' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setDateRange(item.id)}
                    className={`px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer ${
                      dateRange === item.id
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {/* Auto Refresh Toggle */}
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                title="Auto-refresh every 10 seconds"
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer transition-all ${
                  autoRefresh
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                    : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'
                }`}
              >
                <Activity className="w-3 h-3" />
                <span className="hidden sm:inline">10s</span>
              </button>

              {/* Manual Refresh Button */}
              <button
                onClick={() => {
                  fetchAnalytics();
                  fetchLiveArenaStatus(false);
                  fetchSeoStatus(false);
                }}
                disabled={loadingData}
                title="Refresh analytics data"
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 active:scale-95 text-slate-300 hover:text-white border border-white/10 transition-all cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin text-blue-400' : ''}`} />
              </button>

              {/* Export Backup Button */}
              <button
                onClick={handleExportBackup}
                title="Download Analytics JSON Backup"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 text-[11px] font-semibold transition-all cursor-pointer"
              >
                <Download className="w-3 h-3 text-emerald-400" />
                <span className="hidden md:inline">Backup</span>
              </button>

              {/* Import / Restore Backup Button */}
              <label
                title="Restore / Import Analytics JSON Backup"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 text-[11px] font-semibold transition-all cursor-pointer"
              >
                <Upload className="w-3 h-3 text-blue-400" />
                <span className="hidden md:inline">Restore</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleImportBackup}
                  className="hidden"
                />
              </label>
            </>
          ) : adminView === 'live_arena' ? (
            <>
              <button
                type="button"
                onClick={() => setAdminView('analytics')}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 hover:text-white border border-white/10 text-[11px] font-semibold transition-all cursor-pointer whitespace-nowrap shrink-0"
              >
                <BarChart3 className="w-3 h-3 text-blue-400" />
                <span>← Analytics</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  fetchLiveArenaStatus(true);
                  fetchSeoStatus(true);
                }}
                disabled={liveArenaRefreshing}
                title="Force refresh Live Arena matches, channels & SEO sitemap"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${liveArenaRefreshing ? 'animate-spin' : ''}`} />
                <span>{liveArenaRefreshing ? 'Syncing Arena...' : 'Refresh Live Arena'}</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setAdminView('analytics')}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 hover:text-white border border-white/10 text-[11px] font-semibold transition-all cursor-pointer whitespace-nowrap shrink-0"
              >
                <BarChart3 className="w-3 h-3 text-blue-400" />
                <span>← Analytics</span>
              </button>

              <button
                type="button"
                onClick={() => fetchAndSyncScrapers()}
                disabled={scraperLoading}
                title="Reload scraper server configuration"
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 active:scale-95 text-slate-300 hover:text-white border border-white/10 transition-all cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${scraperLoading ? 'animate-spin text-blue-400' : ''}`} />
              </button>
            </>
          )}

          {/* Back to Website */}
          <button
            onClick={onExit}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 text-[11px] font-semibold transition-all cursor-pointer whitespace-nowrap shrink-0"
          >
            <Globe className="w-3 h-3 text-blue-400" />
            <span>Site</span>
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            title="Sign out of Admin Studio"
            className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 transition-all cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* =========================================================
          Main Harmonious Dashboard Container
         ========================================================= */}
      <main className="flex-1 px-4 md:px-6 py-4 max-w-[1440px] w-full mx-auto flex flex-col gap-4">
        {/* Backup Status Banner */}
        {backupMessage && (
          <div className="px-3.5 py-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 text-xs font-semibold flex items-center justify-between">
            <span>{backupMessage}</span>
            <button
              onClick={() => setBackupMessage(null)}
              className="text-slate-400 hover:text-white px-2 py-0.5 rounded cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}

        {/* =========================================================
            PAGE 2: Dedicated Scraper API & Server Configuration Page
           ========================================================= */}
        {adminView === 'scrapers' && (
          <section
            id="scraper-servers-panel"
            className="bg-[#0e1424] border border-blue-500/30 rounded-xl p-4 md:p-5 flex flex-col gap-4 shadow-xl shadow-blue-950/20"
          >
            <div className="flex items-start md:items-center justify-between flex-col md:flex-row gap-3 border-b border-white/10 pb-3.5">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400 shrink-0">
                  <Server className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm font-bold text-white tracking-tight">
                      Backend Scraper API &amp; Server Configuration
                    </h2>
                    <span className="text-[11px] font-mono text-slate-400">
                      · {scraperIsCustom ? 'Custom Admin Endpoints Active' : 'Default Coolify Endpoints'}
                      {scraperUpdatedAt > 0
                        ? ` · Saved ${new Date(scraperUpdatedAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}`
                        : ''}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Replace scraper server IPs, edit ports, or update full URLs directly. Changes apply immediately to live streams and are backed up to Server Disk + Browser Vault.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap shrink-0">
                <button
                  type="button"
                  onClick={handlePingAllScrapers}
                  className="px-3 py-1.5 rounded-lg bg-[#131b2e] hover:bg-[#19233b] text-slate-200 border border-white/10 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Activity className="w-3.5 h-3.5 text-teal-400" />
                  <span>Ping All Servers</span>
                </button>

                <button
                  type="button"
                  onClick={handleResetScrapers}
                  disabled={scraperSaving}
                  className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  Restore Defaults
                </button>

                <button
                  type="button"
                  onClick={handleSaveScrapers}
                  disabled={scraperSaving}
                  className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-blue-950/40 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  {scraperSaving ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Save &amp; Apply Changes</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {scraperBanner && (
              <div
                className={`p-2.5 rounded-lg border text-xs font-medium flex items-center justify-between gap-3 ${
                  scraperBanner.type === 'success'
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                    : scraperBanner.type === 'error'
                    ? 'bg-rose-500/15 border-rose-500/30 text-rose-200'
                    : 'bg-blue-500/15 border-blue-500/30 text-blue-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  {scraperBanner.type === 'error' ? (
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  )}
                  <span>{scraperBanner.text}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setScraperBanner(null)}
                  className="text-slate-400 hover:text-white px-2 py-0.5 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            )}

            {/* 3-Column Scraper Engine Cards */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
              {(['cinepro', 'tmdb_embed', 'gateway_fallback'] as ScraperServerId[]).map((id, idx) => {
                const cfg = scraperConfigs[id] || DEFAULT_SCRAPER_ENDPOINTS[id];
                const mode = scraperEditModes[id] || 'host_port';
                const ping = scraperPings[id] || { loading: false };
                const isModified = cfg.url !== cfg.defaultUrl;

                return (
                  <div
                    key={id}
                    className="bg-[#11182a] border border-white/10 rounded-xl p-3.5 flex flex-col justify-between gap-3.5"
                  >
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-1.5">
                            <span className="font-mono text-blue-400">0{idx + 1}.</span>
                            <span>{cfg.name}</span>
                          </div>
                          <p className="text-[10px] text-slate-400 mt-0.5">{cfg.role}</p>
                        </div>

                        <div className="flex items-center bg-[#0b101d] border border-white/10 rounded-lg p-0.5 text-[10px] shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              setScraperEditModes((prev) => ({ ...prev, [id]: 'host_port' }))
                            }
                            className={`px-2 py-0.5 rounded font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                              mode === 'host_port'
                                ? 'bg-blue-600 text-white'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            IP + Port
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setScraperEditModes((prev) => ({ ...prev, [id]: 'full_url' }))
                            }
                            className={`px-2 py-0.5 rounded font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                              mode === 'full_url'
                                ? 'bg-blue-600 text-white'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            Full URL
                          </button>
                        </div>
                      </div>

                      {mode === 'host_port' ? (
                        <div className="grid grid-cols-12 gap-2">
                          <div className="col-span-3">
                            <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                              Protocol
                            </label>
                            <select
                              value={cfg.protocol}
                              onChange={(e) => handleHostPortChange(id, 'protocol', e.target.value)}
                              className="w-full bg-[#0b101d] border border-white/10 rounded-lg px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
                            >
                              <option value="http">http://</option>
                              <option value="https">https://</option>
                            </select>
                          </div>

                          <div className="col-span-6">
                            <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                              Server Host / IP
                            </label>
                            <input
                              type="text"
                              value={cfg.host}
                              onChange={(e) => handleHostPortChange(id, 'host', e.target.value)}
                              placeholder="62.171.179.144"
                              className="w-full bg-[#0b101d] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono tabular-nums text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
                            />
                          </div>

                          <div className="col-span-3">
                            <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                              Port
                            </label>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={cfg.port}
                              onChange={(e) => handleHostPortChange(id, 'port', e.target.value)}
                              placeholder={id === 'cinepro' ? '3001' : id === 'tmdb_embed' ? '3005' : '80'}
                              className="w-full bg-[#0b101d] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono tabular-nums text-amber-300 placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
                            />
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                            Full Scraper Endpoint URL
                          </label>
                          <input
                            type="text"
                            value={cfg.url}
                            onChange={(e) => handleFullUrlChange(id, e.target.value)}
                            placeholder={cfg.defaultUrl}
                            className="w-full bg-[#0b101d] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono tabular-nums text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
                          />
                        </div>
                      )}

                      <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400 bg-[#0b101d]/70 px-2.5 py-1 rounded-lg border border-white/5">
                        <span className="truncate" title={cfg.url}>
                          Active: <strong className="text-slate-200">{cfg.url}</strong>
                        </span>
                        <span className="shrink-0 ml-2 text-[10px] text-slate-500">
                          {isModified ? 'Edited' : 'Default'}
                        </span>
                      </div>
                    </div>

                    <div className="pt-2.5 border-t border-white/5 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1 text-[11px] font-mono tabular-nums truncate">
                        {ping.loading ? (
                          <span className="text-blue-400 flex items-center gap-1.5">
                            <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                            <span>Pinging upstream...</span>
                          </span>
                        ) : ping.message ? (
                          <span
                            className={
                              ping.reachable ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'
                            }
                            title={ping.message}
                          >
                            {ping.message}
                          </span>
                        ) : (
                          <span className="text-slate-500">Click Test Ping to verify</span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => handleTestScraper(id)}
                        disabled={ping.loading}
                        className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
                      >
                        <Zap className="w-3 h-3 text-amber-400" />
                        <span>Test Ping</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* =========================================================
            PAGE 3: Dedicated Live Arena Command Center & Channel Matrix
           ========================================================= */}
        {adminView === 'live_arena' && (
          <section
            id="live-arena-admin-panel"
            className="flex flex-col gap-4"
          >
            {/* Top Header Card */}
            <div className="bg-[#0e1424] border border-rose-500/30 rounded-xl p-4 md:p-5 flex flex-col gap-4">
              <div className="flex items-start md:items-center justify-between flex-col md:flex-row gap-3 border-b border-white/10 pb-3.5">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                    <Trophy className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-sm font-bold text-white tracking-tight">
                        01. Notflix Live Arena — Broadcast Matrix &amp; SEO Command Center
                      </h2>
                      <span className="text-[11px] font-mono tabular-nums text-slate-400">
                        · {liveArenaStatus?.totalChannels || 102} 24/7 Networks ·{' '}
                        {liveArenaStatus?.totalEvents || 0} Fixtures Indexed
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Real-time monitoring of live &amp; upcoming sports fixtures, synchronized same-event broadcast channels under the player, 102 24/7 TV networks, and Google SportsEvent / BroadcastEvent SEO indexing.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText('https://notflixtv.com/live');
                      setSeoCopiedUrl('https://notflixtv.com/live');
                      setTimeout(() => setSeoCopiedUrl(null), 2500);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-[#131b2e] hover:bg-[#19233b] text-slate-200 border border-white/10 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {seoCopiedUrl === 'https://notflixtv.com/live' ? '✓ Copied /live URL' : 'Copy /live Hub URL'}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      window.history.pushState({}, '', '/live');
                      window.dispatchEvent(new CustomEvent('notflix:open-live-tv'));
                      onExit();
                    }}
                    className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Radio className="w-3.5 h-3.5" />
                    <span>Open Live Arena</span>
                  </button>
                </div>
              </div>

              {/* 5-Column Live Arena KPI Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <div className="bg-[#11182a] border border-white/10 rounded-xl p-3 flex flex-col justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Matches Live Now
                  </span>
                  <div className="text-2xl font-extrabold font-mono tabular-nums text-rose-400 my-1">
                    {liveArenaStatus?.liveNowCount ?? 0}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono tabular-nums">
                    In-play broadcasts · {liveArenaStatus?.activeArenaViewers ?? 0} watching
                  </div>
                </div>

                <div className="bg-[#11182a] border border-white/10 rounded-xl p-3 flex flex-col justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Upcoming Today
                  </span>
                  <div className="text-2xl font-extrabold font-mono tabular-nums text-amber-400 my-1">
                    {liveArenaStatus?.upcomingCount ?? 0}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono tabular-nums">
                    {liveArenaStatus?.finishedCount ?? 0} completed (FT)
                  </div>
                </div>

                <div className="bg-[#11182a] border border-white/10 rounded-xl p-3 flex flex-col justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    24/7 Live Channels
                  </span>
                  <div className="text-2xl font-extrabold font-mono tabular-nums text-blue-400 my-1">
                    {liveArenaStatus?.totalChannels ?? 102}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    beIN · SSC · Sky · ESPN · Cinema
                  </div>
                </div>

                <div className="bg-[#11182a] border border-white/10 rounded-xl p-3 flex flex-col justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Active Leagues
                  </span>
                  <div className="text-2xl font-extrabold font-mono tabular-nums text-emerald-400 my-1">
                    {liveArenaStatus?.activeLeagues?.length ?? 0}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">
                    {liveArenaStatus?.activeLeagues?.slice(0, 3).join(' · ') || 'Global Football & Sports'}
                  </div>
                </div>

                <div className="bg-[#11182a] border border-white/10 rounded-xl p-3 flex flex-col justify-between col-span-2 sm:col-span-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Arena SEO Pages
                  </span>
                  <div className="text-2xl font-extrabold font-mono tabular-nums text-purple-400 my-1">
                    {(liveArenaStatus?.totalEvents ?? 0) + (liveArenaStatus?.totalChannels ?? 102) + 1}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    SportsEvent + BroadcastEvent JSON-LD
                  </div>
                </div>
              </div>
            </div>

            {/* Live & Upcoming Matches + Same-Event Channel Broadcast Matrix */}
            <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                    02. Live &amp; Upcoming Matches — Same-Event Broadcast Channel Matrix
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Verifies the exact channels broadcasting the same event simultaneously under the Live Arena player and their crawlable Google SEO URLs (<code className="text-rose-300">/live/match/:id-:slug</code>).
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    value={arenaMatchSearch}
                    onChange={(e) => setArenaMatchSearch(e.target.value)}
                    placeholder="Search team, league, or channel..."
                    className="bg-[#131a2b] border border-white/10 rounded-lg px-2.5 py-1 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 w-48 sm:w-56"
                  />

                  <div className="flex items-center bg-[#131a2b] border border-white/10 rounded-lg p-0.5 gap-0.5 text-[11px]">
                    {(
                      [
                        { id: 'all', label: `All (${liveArenaStatus?.events?.length || 0})` },
                        { id: 'live', label: `Live (${liveArenaStatus?.liveNowCount || 0})` },
                        { id: 'upcoming', label: `Upcoming (${liveArenaStatus?.upcomingCount || 0})` },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setArenaMatchFilter(tab.id)}
                        className={`px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                          arenaMatchFilter === tab.id
                            ? 'bg-rose-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-white hover:bg-white/5'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 max-h-[420px] overflow-y-auto pr-1">
                {(() => {
                  const rawEvents = liveArenaStatus?.events || [];
                  const q = arenaMatchSearch.trim().toLowerCase();
                  const filtered = rawEvents.filter((ev) => {
                    const st = String(ev.status || '').toUpperCase();
                    if (arenaMatchFilter === 'live' && st !== 'LIVE') return false;
                    if (arenaMatchFilter === 'upcoming' && st !== 'UPCOMING') return false;
                    if (!q) return true;
                    const chText = (ev.recommendedChannels || [])
                      .map((c) => c.name.toLowerCase())
                      .join(' ');
                    return (
                      ev.title.toLowerCase().includes(q) ||
                      ev.league.toLowerCase().includes(q) ||
                      chText.includes(q)
                    );
                  });

                  if (filtered.length === 0) {
                    return (
                      <div className="col-span-full py-8 text-center text-xs text-slate-500 border border-dashed border-white/10 rounded-lg">
                        No matches match your current filter. Click Refresh Live Arena to sync fixtures.
                      </div>
                    );
                  }

                  return filtered.map((ev) => {
                    const isLiveNow = String(ev.status || '').toUpperCase() === 'LIVE';
                    return (
                      <div
                        key={ev.id}
                        className="bg-[#11182a] border border-white/10 rounded-xl p-3 flex flex-col justify-between gap-2.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[11px] text-slate-400 font-medium truncate">
                              {ev.league} · {ev.sport} ·{' '}
                              <span
                                className={
                                  isLiveNow
                                    ? 'text-rose-400 font-bold'
                                    : 'text-amber-300 font-mono tabular-nums'
                                }
                              >
                                {isLiveNow ? `LIVE ${ev.statusDetail || ''}` : ev.statusDetail || ev.status}
                              </span>
                            </div>
                            <div className="text-xs font-bold text-white mt-0.5 truncate">
                              {ev.title}
                              {ev.homeTeam?.score !== null &&
                              ev.homeTeam?.score !== undefined &&
                              ev.awayTeam?.score !== null &&
                              ev.awayTeam?.score !== undefined ? (
                                <span className="ml-2 font-mono tabular-nums text-emerald-400">
                                  ({ev.homeTeam.score} - {ev.awayTeam.score})
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard?.writeText(ev.seoUrl);
                                setSeoCopiedUrl(ev.seoUrl);
                                setTimeout(() => setSeoCopiedUrl(null), 2000);
                              }}
                              className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-semibold text-slate-300 cursor-pointer whitespace-nowrap shrink-0"
                            >
                              {seoCopiedUrl === ev.seoUrl ? '✓ Copied' : 'Copy SEO Link'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                window.history.pushState({}, '', ev.seoPath);
                                window.dispatchEvent(new CustomEvent('notflix:open-live-tv'));
                                onExit();
                              }}
                              className="px-2 py-1 rounded bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/30 text-[10px] font-bold text-rose-300 cursor-pointer whitespace-nowrap shrink-0"
                            >
                              Open Match →
                            </button>
                          </div>
                        </div>

                        <div className="text-[11px] text-slate-300 bg-[#0b101d] border border-white/5 rounded-lg px-2.5 py-1.5">
                          <span className="text-slate-400 text-[10px]">Same-Event Broadcast Channels ({ev.recommendedChannels?.length || 0}): </span>
                          <span className="font-medium text-emerald-300">
                            {ev.recommendedChannels && ev.recommendedChannels.length > 0
                              ? ev.recommendedChannels
                                  .map((c) => c.name.replace(/\s*\([^)]*\)/g, ''))
                                  .join(' · ')
                              : 'Auto-matched by league broadcaster'}
                          </span>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>

            {/* 24/7 Live TV Channel Directory (102 Channels) */}
            <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                    03. 24/7 Live TV Network Directory &amp; Indexed Channel Pages ({liveArenaStatus?.totalChannels || 102})
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    All 102 24/7 sports, cinema &amp; entertainment channels indexed in Google Sitemap (<code className="text-blue-300">/live/channel/:id</code>) with TelevisionChannel Schema.org markup.
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    value={arenaChannelSearch}
                    onChange={(e) => setArenaChannelSearch(e.target.value)}
                    placeholder="Filter 102 channels..."
                    className="bg-[#131a2b] border border-white/10 rounded-lg px-2.5 py-1 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 w-44 sm:w-52"
                  />

                  <select
                    value={arenaChannelGroupFilter}
                    onChange={(e) => setArenaChannelGroupFilter(e.target.value)}
                    className="bg-[#131a2b] border border-white/10 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="all">All Network Groups ({liveArenaStatus?.totalChannels || 102})</option>
                    {Object.entries(liveArenaStatus?.channelGroups || {}).map(([grp, cnt]) => (
                      <option key={grp} value={grp}>
                        {grp} ({cnt})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-80 overflow-y-auto pr-1">
                {(() => {
                  const allCh = liveArenaStatus?.channels || [];
                  const q = arenaChannelSearch.trim().toLowerCase();
                  const filteredCh = allCh.filter((ch) => {
                    if (arenaChannelGroupFilter !== 'all' && ch.group !== arenaChannelGroupFilter) {
                      return false;
                    }
                    if (!q) return true;
                    return (
                      ch.name.toLowerCase().includes(q) ||
                      ch.group.toLowerCase().includes(q) ||
                      ch.languageLabel.toLowerCase().includes(q)
                    );
                  });

                  return filteredCh.map((ch) => (
                    <div
                      key={ch.channelId}
                      className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#11182a] border border-white/5 text-xs gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-white truncate text-[11px]">{ch.name}</div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {ch.group} · {ch.languageLabel}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(ch.seoUrl);
                          setSeoCopiedUrl(ch.seoUrl);
                          setTimeout(() => setSeoCopiedUrl(null), 2000);
                        }}
                        className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-semibold text-slate-300 shrink-0 cursor-pointer whitespace-nowrap"
                      >
                        {seoCopiedUrl === ch.seoUrl ? '✓ Copied' : 'SEO Link'}
                      </button>
                    </div>
                  ));
                })()}
              </div>
            </div>
          </section>
        )}

        {/* =========================================================
            PAGE 1: Harmonious, Compact Analytics & Telemetry Page
           ========================================================= */}
        {adminView === 'analytics' && (
          <>
            {/* 1. Compact 5-Card KPI Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {/* Live Viewers */}
              <div className="bg-[#0e1424] border border-white/10 rounded-xl p-3.5 flex flex-col justify-between hover:border-emerald-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Live Viewers</span>
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                </div>
                <div className="text-2xl font-extrabold font-mono text-white tracking-tight my-1">
                  {kpis.liveViewers}
                </div>
                <div className="text-[10px] text-emerald-400 font-medium">● Active streams now</div>
              </div>

              {/* Total Views */}
              <div className="bg-[#0e1424] border border-white/10 rounded-xl p-3.5 flex flex-col justify-between hover:border-blue-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Total Views</span>
                  <Play className="w-3.5 h-3.5 text-blue-400" />
                </div>
                <div className="text-2xl font-extrabold font-mono text-white tracking-tight my-1">
                  {kpis.totalViews.toLocaleString()}
                </div>
                <div className="text-[10px] text-slate-400 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3 text-blue-400" />
                  <span>Real stream starts</span>
                </div>
              </div>

              {/* Watch Time */}
              <div className="bg-[#0e1424] border border-white/10 rounded-xl p-3.5 flex flex-col justify-between hover:border-amber-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Watch Time</span>
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                </div>
                <div className="text-2xl font-extrabold font-mono text-white tracking-tight my-1">
                  {kpis.totalWatchHours} <span className="text-xs font-normal text-slate-400">hrs</span>
                </div>
                <div className="text-[10px] text-slate-400">
                  {kpis.totalWatchMinutes.toLocaleString()} mins streamed
                </div>
              </div>

              {/* Searches */}
              <div className="bg-[#0e1424] border border-white/10 rounded-xl p-3.5 flex flex-col justify-between hover:border-purple-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Searches</span>
                  <Search className="w-3.5 h-3.5 text-purple-400" />
                </div>
                <div className="text-2xl font-extrabold font-mono text-white tracking-tight my-1">
                  {kpis.totalSearches.toLocaleString()}
                </div>
                <div className="text-[10px] text-slate-400">Queries conducted</div>
              </div>

              {/* Unique Visitors */}
              <div className="bg-[#0e1424] border border-white/10 rounded-xl p-3.5 flex flex-col justify-between col-span-2 sm:col-span-1 hover:border-teal-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Unique Visitors</span>
                  <Users className="w-3.5 h-3.5 text-teal-400" />
                </div>
                <div className="text-2xl font-extrabold font-mono text-white tracking-tight my-1">
                  {kpis.uniqueVisitors.toLocaleString()}
                </div>
                <div className="text-[10px] text-slate-400">Audience sessions</div>
              </div>
            </div>

            {/* 2. Active Live Streams Strip (Only when viewers are actively watching) */}
            {analytics?.liveStreams && analytics.liveStreams.length > 0 && (
              <div className="bg-[#0e1424] border border-emerald-500/30 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    <h3 className="text-[11px] font-extrabold uppercase tracking-wider text-white">
                      Active Live Streams ({analytics.liveStreams.length})
                    </h3>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono">Live · 10s sync</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {analytics.liveStreams.map((stream, idx) => {
                    const isLiveArenaStream = stream.mediaType === 'live';
                    const isTvStream = stream.mediaType === 'tv';
                    return (
                      <div
                        key={stream.sessionId + idx}
                        className="bg-[#131b2e] border border-white/10 rounded-lg p-2 flex items-center gap-2.5"
                      >
                        {stream.poster ? (
                          <img
                            src={stream.poster}
                            alt={stream.title}
                            className="w-8 h-11 object-cover rounded shrink-0 bg-black/40"
                          />
                        ) : (
                          <div
                            className={`w-8 h-11 rounded flex items-center justify-center shrink-0 border ${
                              isLiveArenaStream
                                ? 'bg-rose-600/20 border-rose-500/30 text-rose-400'
                                : isTvStream
                                ? 'bg-purple-600/20 border-purple-500/30 text-purple-400'
                                : 'bg-blue-600/20 border-blue-500/30 text-blue-400'
                            }`}
                          >
                            {isLiveArenaStream ? (
                              <Radio className="w-4 h-4" />
                            ) : isTvStream ? (
                              <Tv className="w-4 h-4" />
                            ) : (
                              <Film className="w-4 h-4" />
                            )}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-white truncate">{stream.title}</div>
                          <div className="flex items-center gap-1.5 mt-0.5 text-[10px] font-mono text-slate-300">
                            <span
                              className={
                                isLiveArenaStream
                                  ? 'text-rose-300 font-bold'
                                  : isTvStream
                                  ? 'text-purple-300'
                                  : 'text-blue-300'
                              }
                            >
                              {isLiveArenaStream
                                ? 'Live Arena'
                                : isTvStream
                                ? `TV S${stream.season || 1}:E${stream.episode || 1}`
                                : 'Movie'}
                            </span>
                            <span>·</span>
                            <span className="text-emerald-400 capitalize">{stream.device}</span>
                            <span>·</span>
                            <span className="text-slate-400">{stream.secondsAgo}s</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 3. Sleek Single-Bar Smart Ad & Monetization Ribbon (Compact & Harmonious) */}
            <div className="bg-[#0e1424] border border-blue-500/20 rounded-xl px-4 py-2.5 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2.5 flex-wrap">
                <div className="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
                  <Zap className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-bold text-white">Smart Ad Engine</span>
                <span
                  className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border flex items-center gap-1 ${
                    smartMetrics.tier === 'discovery'
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : smartMetrics.tier === 'immersive_watch'
                      ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                      : smartMetrics.tier === 'high_friction'
                      ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                      : smartMetrics.tier === 'onboarding'
                      ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                      : 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {smartMetrics.tier === 'discovery' && 'Discovery (0.85x)'}
                  {smartMetrics.tier === 'immersive_watch' && 'Immersive Watch (1.45x)'}
                  {smartMetrics.tier === 'high_friction' && 'Friction Back-off (2.0x)'}
                  {smartMetrics.tier === 'onboarding' && 'Onboarding (1.35x)'}
                  {smartMetrics.tier === 'loyal_viewer' && 'Balanced (1.1x)'}
                </span>
              </div>

              <div className="flex items-center gap-3 md:gap-4 flex-wrap text-xs font-mono">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400 text-[11px] font-sans">Multiplier:</span>
                  <span className="font-bold text-white">{smartMetrics.multiplier.toFixed(2)}x</span>
                </div>
                <span className="text-white/10 hidden sm:inline">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400 text-[11px] font-sans">Served / Protected:</span>
                  <span className="font-bold text-blue-400">{smartMetrics.adsDelivered}</span>
                  <span className="text-slate-500">/</span>
                  <span className="font-bold text-emerald-400">{smartMetrics.adsSuppressed}</span>
                </div>
                <span className="text-white/10 hidden sm:inline">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400 text-[11px] font-sans">Velocity:</span>
                  <span className="font-bold text-white">{smartMetrics.interactionVelocityPerMin}/m</span>
                </div>
                <span className="text-white/10 hidden md:inline">|</span>
                <div className="hidden md:flex items-center gap-1.5">
                  <span className="text-slate-400 text-[11px] font-sans">Friction:</span>
                  <span
                    className={`font-bold ${
                      smartMetrics.frictionScore > 1 ? 'text-amber-400' : 'text-emerald-400'
                    }`}
                  >
                    {smartMetrics.frictionScore.toFixed(1)}/5
                  </span>
                </div>
                <span className="text-white/10 hidden xl:inline">|</span>
                <div className="hidden xl:flex items-center gap-2 text-[11px] text-slate-400">
                  <span>
                    Poster: <strong className="text-blue-400">{Math.round((smartMetrics.effectiveCooldowns.poster || 15000) / 1000)}s</strong>
                  </span>
                  <span>·</span>
                  <span>
                    Dock: <strong className="text-blue-400">{Math.round((smartMetrics.effectiveCooldowns.dock || 20000) / 1000)}s</strong>
                  </span>
                  <span>·</span>
                  <span>
                    Ep: <strong className="text-blue-400">{Math.round((smartMetrics.effectiveCooldowns.episode || 35000) / 1000)}s</strong>
                  </span>
                </div>
              </div>
            </div>

            {/* 3.5. Ad-Blocker Notification Popup Control (2 Modes: Dismissible vs Strict Lock Until Disabled) */}
            <div
              className={`bg-[#0e1424] border rounded-xl px-4 py-3 flex items-center justify-between flex-wrap gap-3 transition-colors ${
                adBlockMode === 'strict'
                  ? 'border-rose-500/35 shadow-lg shadow-rose-950/10'
                  : 'border-amber-500/25'
              }`}
            >
              <div className="flex items-center gap-2.5 flex-wrap">
                <div
                  className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${
                    adBlockMode === 'strict'
                      ? 'bg-rose-500/15 border-rose-500/35 text-rose-400'
                      : 'bg-amber-500/15 border-amber-500/35 text-amber-400'
                  }`}
                >
                  {adBlockMode === 'strict' ? (
                    <Lock className="w-4 h-4" />
                  ) : (
                    <ShieldAlert className="w-4 h-4" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-white uppercase tracking-wider">
                      Ad-Blocker Detection Popup Control
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wider border ${
                        adBlockMode === 'strict'
                          ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                          : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
                      }`}
                    >
                      {adBlockMode === 'strict'
                        ? 'Mode 2: Locked Until Ad Blocker Disabled'
                        : 'Mode 1: Normal (Can Close)'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {adBlockMode === 'strict'
                      ? 'Strict Lock: The "Support Free Streaming" popup cannot be closed or removed until the watcher disables their ad blocker.'
                      : 'Dismissible Mode: Watchers see the "Support Free Streaming" popup and can close it with X or "Later".'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {adBlockStatusMsg && (
                  <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg">
                    {adBlockStatusMsg}
                  </span>
                )}

                <div className="flex items-center bg-[#090d18] border border-white/10 rounded-xl p-1 gap-1">
                  <button
                    type="button"
                    disabled={adBlockSaving}
                    onClick={() => handleUpdateAdBlockMode('dismissible')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                      adBlockMode === 'dismissible'
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Can Close Popup (Normal)</span>
                  </button>

                  <button
                    type="button"
                    disabled={adBlockSaving}
                    onClick={() => handleUpdateAdBlockMode('strict')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                      adBlockMode === 'strict'
                        ? 'bg-rose-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Lock className="w-3.5 h-3.5" />
                    <span>Cannot Close Until Disabled</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 4. Main 12-Column Analytics Bento Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
              {/* LEFT 8 COLUMNS: Trend Chart + Top Content + Activity Feed */}
              <div className="lg:col-span-8 flex flex-col gap-4">
                {/* Views & Watch Duration Trend Chart (Compact Height) */}
                <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h2 className="text-xs font-bold text-white uppercase tracking-wider">
                        Views &amp; Watch Duration Trend
                      </h2>
                      <p className="text-[11px] text-slate-400">
                        Activity progression across the selected period
                      </p>
                    </div>
                    {activeHoverPoint && (
                      <div className="bg-[#141d33] border border-blue-500/40 px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-2.5">
                        <span className="font-bold text-white">{activeHoverPoint.label}</span>
                        <span className="text-blue-400 font-mono font-bold">
                          {activeHoverPoint.views} views
                        </span>
                        <span className="text-amber-400 font-mono">
                          {activeHoverPoint.watchHours} hrs
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="relative w-full h-36 md:h-44">
                    {timelinePoints.length > 0 ? (
                      <div className="w-full h-full flex flex-col justify-between">
                        <svg
                          className="w-full h-4/5 overflow-visible"
                          viewBox="0 0 1000 200"
                          preserveAspectRatio="none"
                        >
                          <defs>
                            <linearGradient id="viewsGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.4" />
                              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
                            </linearGradient>
                          </defs>

                          <line x1="0" y1="50" x2="1000" y2="50" stroke="#ffffff" strokeOpacity="0.05" strokeDasharray="4 4" />
                          <line x1="0" y1="100" x2="1000" y2="100" stroke="#ffffff" strokeOpacity="0.05" strokeDasharray="4 4" />
                          <line x1="0" y1="150" x2="1000" y2="150" stroke="#ffffff" strokeOpacity="0.05" strokeDasharray="4 4" />

                          {(() => {
                            const coords = timelinePoints.map((pt, i) => {
                              const x = (i / Math.max(1, timelinePoints.length - 1)) * 1000;
                              const y = 190 - (pt.views / maxViews) * 160;
                              return { x, y, pt };
                            });

                            const areaPoints = [
                              `0,200`,
                              ...coords.map((c) => `${c.x},${c.y}`),
                              `1000,200`,
                            ].join(' ');

                            const linePoints = coords.map((c) => `${c.x},${c.y}`).join(' ');

                            return (
                              <>
                                <polygon points={areaPoints} fill="url(#viewsGradient)" />
                                <polyline
                                  fill="none"
                                  stroke="#3b82f6"
                                  strokeWidth="3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  points={linePoints}
                                />
                                {coords.map((c, idx) => (
                                  <circle
                                    key={idx}
                                    cx={c.x}
                                    cy={c.y}
                                    r="4"
                                    className="fill-white stroke-blue-600 stroke-2 hover:r-6 transition-all cursor-pointer"
                                    onMouseEnter={() => setActiveHoverPoint(c.pt)}
                                  />
                                ))}
                              </>
                            );
                          })()}
                        </svg>

                        <div className="flex justify-between text-[10px] font-mono text-slate-500 pt-1.5 border-t border-white/5">
                          {timelinePoints.map((pt, idx) => (
                            <span key={idx} className="truncate px-1">
                              {pt.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 text-xs gap-1 border border-dashed border-white/10 rounded-lg">
                        <Calendar className="w-5 h-5 text-slate-600" />
                        <span>No streaming activity logged for this time range yet</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Top Performing Content Table */}
                <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-3">
                  {(() => {
                    const allTopTitles = analytics?.topTitles || [];
                    const movieTitlesCount = allTopTitles.filter((t) => t.mediaType === 'movie').length;
                    const tvTitlesCount = allTopTitles.filter((t) => t.mediaType === 'tv').length;
                    const liveTitlesCount = allTopTitles.filter((t) => t.mediaType === 'live').length;
                    const displayedTopTitles = allTopTitles.filter((item) => {
                      if (mediaFilter === 'movie') return item.mediaType === 'movie';
                      if (mediaFilter === 'tv') return item.mediaType === 'tv';
                      if (mediaFilter === 'live') return item.mediaType === 'live';
                      return true;
                    });

                    return (
                      <>
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div>
                            <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                              Top Performing Content
                            </h3>
                            <p className="text-[11px] text-slate-400">
                              Ranked by viewers and cumulative watch time across Movies, TV &amp; Live Arena
                            </p>
                          </div>

                          <div className="flex items-center bg-[#131a2b] border border-white/10 rounded-lg p-0.5 gap-0.5 text-[11px]">
                            <button
                              onClick={() => setMediaFilter('all')}
                              className={`px-2 py-1 rounded-md font-semibold transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                                mediaFilter === 'all'
                                  ? 'bg-blue-600 text-white shadow-sm'
                                  : 'text-slate-400 hover:text-white hover:bg-white/5'
                              }`}
                            >
                              All ({allTopTitles.length})
                            </button>
                            <button
                              onClick={() => setMediaFilter('movie')}
                              className={`px-2 py-1 rounded-md font-semibold flex items-center gap-1 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                                mediaFilter === 'movie'
                                  ? 'bg-blue-600 text-white shadow-sm'
                                  : 'text-slate-400 hover:text-white hover:bg-white/5'
                              }`}
                            >
                              <Film className="w-3 h-3 text-blue-400" />
                              <span>Movies ({movieTitlesCount})</span>
                            </button>
                            <button
                              onClick={() => setMediaFilter('tv')}
                              className={`px-2 py-1 rounded-md font-semibold flex items-center gap-1 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                                mediaFilter === 'tv'
                                  ? 'bg-purple-600 text-white shadow-sm'
                                  : 'text-slate-400 hover:text-white hover:bg-white/5'
                              }`}
                            >
                              <Tv className="w-3 h-3 text-purple-400" />
                              <span>TV ({tvTitlesCount})</span>
                            </button>
                            <button
                              onClick={() => setMediaFilter('live')}
                              className={`px-2 py-1 rounded-md font-semibold flex items-center gap-1 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                                mediaFilter === 'live'
                                  ? 'bg-rose-600 text-white shadow-sm'
                                  : 'text-slate-400 hover:text-white hover:bg-white/5'
                              }`}
                            >
                              <Trophy className="w-3 h-3 text-rose-400" />
                              <span>Live Arena ({liveTitlesCount})</span>
                            </button>
                          </div>
                        </div>

                        <div className="overflow-x-auto max-h-64 overflow-y-auto pr-1">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead className="sticky top-0 bg-[#0e1424] z-10">
                              <tr className="border-b border-white/10 text-slate-400 text-[10px] uppercase font-bold tracking-wider">
                                <th className="py-2 px-2.5">#</th>
                                <th className="py-2 px-2.5">Title</th>
                                <th className="py-2 px-2.5 text-right">Views</th>
                                <th className="py-2 px-2.5 text-right">Watch Time</th>
                                <th className="py-2 px-2.5 text-right">Avg</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                              {displayedTopTitles.length > 0 ? (
                                displayedTopTitles.map((item, idx) => {
                                  const isLiveItem = item.mediaType === 'live';
                                  const isTvItem = item.mediaType === 'tv';
                                  return (
                                    <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                                      <td className="py-2 px-2.5 font-mono font-bold text-slate-500">
                                        {idx + 1}
                                      </td>
                                      <td className="py-2 px-2.5">
                                        <div className="flex items-center gap-2">
                                          {item.poster ? (
                                            <img
                                              src={item.poster}
                                              alt={item.title}
                                              className="w-6 h-8 object-cover rounded shrink-0"
                                            />
                                          ) : (
                                            <div
                                              className={`w-6 h-8 rounded border flex items-center justify-center shrink-0 ${
                                                isLiveItem
                                                  ? 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                                                  : isTvItem
                                                  ? 'bg-purple-500/10 border-purple-500/20 text-purple-400'
                                                  : 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                                              }`}
                                            >
                                              {isLiveItem ? (
                                                <Radio className="w-3 h-3" />
                                              ) : isTvItem ? (
                                                <Tv className="w-3 h-3" />
                                              ) : (
                                                <Film className="w-3 h-3" />
                                              )}
                                            </div>
                                          )}
                                          <span className="font-bold text-white truncate max-w-[180px] md:max-w-[260px]">
                                            {item.title}
                                          </span>
                                          <span
                                            className={`text-[10px] font-mono shrink-0 ${
                                              isLiveItem
                                                ? 'text-rose-300'
                                                : isTvItem
                                                ? 'text-purple-300'
                                                : 'text-blue-300'
                                            }`}
                                          >
                                            · {isLiveItem ? 'Live Arena' : isTvItem ? 'TV' : 'Movie'}
                                          </span>
                                        </div>
                                      </td>
                                      <td className="py-2 px-2.5 text-right font-mono font-bold text-white">
                                        {item.views.toLocaleString()}
                                      </td>
                                      <td className="py-2 px-2.5 text-right font-mono text-amber-400">
                                        {item.watchMinutes}m
                                      </td>
                                      <td className="py-2 px-2.5 text-right font-mono text-slate-400">
                                        {item.avgMinutes}m
                                      </td>
                                    </tr>
                                  );
                                })
                              ) : (
                                <tr>
                                  <td colSpan={5} className="py-6 text-center text-slate-500 text-xs">
                                    No titles streamed in this timeframe yet.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Recent Stream & Search Activity Feed */}
                <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Activity className="w-3.5 h-3.5 text-blue-400" />
                      <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                        Recent Stream &amp; Search Feed
                      </h3>
                    </div>
                    <span className="text-[10px] text-slate-400 font-mono">Live Telemetry</span>
                  </div>

                  <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1">
                    {analytics?.recentEvents && analytics.recentEvents.length > 0 ? (
                      analytics.recentEvents.map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#11182a] border border-white/5 text-xs gap-2"
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                ev.type === 'play'
                                  ? 'bg-blue-400'
                                  : ev.type === 'heartbeat'
                                  ? 'bg-emerald-400'
                                  : ev.type === 'search'
                                  ? 'bg-purple-400'
                                  : 'bg-slate-400'
                              }`}
                            />
                            <div className="truncate flex items-center gap-1.5">
                              {ev.type === 'play' && (
                                <span className="text-white truncate">
                                  Started{' '}
                                  <strong
                                    className={
                                      ev.mediaType === 'live' ? 'text-rose-300' : 'text-blue-300'
                                    }
                                  >
                                    {ev.title}
                                  </strong>
                                  {ev.mediaType === 'live'
                                    ? ' (Live Arena)'
                                    : ev.mediaType === 'tv'
                                    ? ` (S${ev.season || 1}:E${ev.episode || 1})`
                                    : ''}
                                </span>
                              )}
                              {ev.type === 'heartbeat' && (
                                <span className="text-slate-300 truncate">
                                  Watching{' '}
                                  <strong
                                    className={
                                      ev.mediaType === 'live' ? 'text-rose-300' : 'text-emerald-300'
                                    }
                                  >
                                    {ev.title}
                                  </strong>{' '}
                                  (+{ev.watchMinutes}m)
                                </span>
                              )}
                              {ev.type === 'search' && (
                                <span className="text-slate-300 truncate">
                                  Searched <strong className="text-purple-300">"{ev.searchQuery}"</strong>
                                </span>
                              )}
                              {ev.type === 'pageview' && (
                                <span className="text-slate-400 truncate">Visited {ev.title}</span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0 text-[10px] font-mono text-slate-400">
                            <span className="capitalize">{ev.device}</span>
                            <span>·</span>
                            <span>
                              {new Date(ev.ts).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="py-4 text-center text-xs text-slate-500">
                        Activity feed will populate as viewers watch content.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* RIGHT 4 COLUMNS: Devices, Top Searches & Server Reliability */}
              <div className="lg:col-span-4 flex flex-col gap-4">
                {/* Audience Devices */}
                <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-3">
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <Smartphone className="w-3.5 h-3.5 text-blue-400" />
                    <span>Audience Devices</span>
                  </h3>

                  <div className="flex flex-col gap-2.5">
                    {[
                      { name: 'Mobile Phone', count: devices.mobile, icon: Smartphone, color: 'bg-blue-500' },
                      { name: 'Desktop PC / Mac', count: devices.desktop, icon: Monitor, color: 'bg-emerald-500' },
                      { name: 'Tablet / iPad', count: devices.tablet, icon: Tablet, color: 'bg-purple-500' },
                      { name: 'Smart TV', count: devices.tv, icon: Tv, color: 'bg-amber-500' },
                    ].map((d) => {
                      const percent = Math.round((d.count / totalDeviceEvents) * 100);
                      const Icon = d.icon;
                      return (
                        <div key={d.name} className="flex flex-col gap-1 text-xs">
                          <div className="flex items-center justify-between text-slate-300">
                            <div className="flex items-center gap-1.5">
                              <Icon className="w-3.5 h-3.5 text-slate-400" />
                              <span>{d.name}</span>
                            </div>
                            <span className="font-mono font-bold text-white">{percent}%</span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className={`h-full ${d.color} rounded-full transition-all duration-500`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Top Searches */}
                <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                      <Search className="w-3.5 h-3.5 text-purple-400" />
                      <span>Top Searches</span>
                    </h3>
                    <span className="text-[10px] text-slate-400">User intent</span>
                  </div>

                  <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-1">
                    {analytics?.topSearches && analytics.topSearches.length > 0 ? (
                      analytics.topSearches.map((s, idx) => (
                        <div
                          key={s.query}
                          className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white/5 text-xs"
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span className="text-slate-500 font-mono font-bold w-4">{idx + 1}</span>
                            <span className="text-slate-200 font-medium truncate capitalize">
                              {s.query}
                            </span>
                          </div>
                          <span className="font-mono text-purple-400 font-bold px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/20 text-[10px]">
                            {s.count}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="py-3 text-center text-xs text-slate-500">
                        No searches recorded yet
                      </div>
                    )}
                  </div>
                </div>

                {/* Server Reliability */}
                <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                      <Server className="w-3.5 h-3.5 text-teal-400" />
                      <span>Scraper Reliability</span>
                    </h3>
                    <button
                      type="button"
                      onClick={() => setAdminView('scrapers')}
                      className="text-[10px] font-bold text-blue-400 hover:text-blue-300 cursor-pointer"
                    >
                      Configure →
                    </button>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {[
                      {
                        name: 'CinePro Primary',
                        endpoint: `${scraperConfigs.cinepro.host}${scraperConfigs.cinepro.port ? ':' + scraperConfigs.cinepro.port : ''}`,
                        ping: scraperPings.cinepro,
                      },
                      {
                        name: 'TMDB Embed',
                        endpoint: `${scraperConfigs.tmdb_embed.host}${scraperConfigs.tmdb_embed.port ? ':' + scraperConfigs.tmdb_embed.port : ''}`,
                        ping: scraperPings.tmdb_embed,
                      },
                      {
                        name: 'Coolify Fallback',
                        endpoint: scraperConfigs.gateway_fallback.host,
                        ping: scraperPings.gateway_fallback,
                      },
                    ].map((srv) => (
                      <div
                        key={srv.name}
                        className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#131b2e] border border-white/5 text-xs gap-2"
                      >
                        <div className="flex flex-col min-w-0">
                          <span className="text-slate-200 font-medium truncate">{srv.name}</span>
                          <span className="text-[10px] font-mono tabular-nums text-slate-400 truncate">
                            {srv.endpoint}
                          </span>
                        </div>
                        <span
                          className={`font-mono tabular-nums text-[10px] font-bold shrink-0 ${
                            srv.ping?.reachable === false ? 'text-rose-400' : 'text-emerald-400'
                          }`}
                        >
                          {srv.ping?.latencyMs !== undefined ? `${srv.ping.latencyMs} ms` : 'Online'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* 4.2. Notflix Live Arena — Live Sports & 24/7 Broadcast Overview */}
            <div className="bg-[#0e1424] border border-rose-500/25 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                    <Trophy className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                        Notflix Live Arena — Sports Matches &amp; 24/7 TV Broadcast Status
                      </h3>
                      <span className="text-[11px] font-mono tabular-nums text-slate-400">
                        · {liveArenaStatus?.liveNowCount ?? 0} Live Now ·{' '}
                        {liveArenaStatus?.upcomingCount ?? 0} Upcoming ·{' '}
                        {liveArenaStatus?.totalChannels ?? 102} 24/7 Channels
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Synchronizes same-event broadcast channels directly under the live match player and indexes every match (<code className="text-rose-300">/live/match/:id-:slug</code>) and 24/7 network (<code className="text-rose-300">/live/channel/:id</code>) for Google Search.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => fetchLiveArenaStatus(true)}
                    disabled={liveArenaRefreshing}
                    className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-semibold text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${liveArenaRefreshing ? 'animate-spin text-rose-400' : ''}`} />
                    <span>{liveArenaRefreshing ? 'Syncing...' : 'Sync Matches'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setAdminView('live_arena');
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Trophy className="w-3 h-3" />
                    <span>Manage Live Arena →</span>
                  </button>
                </div>
              </div>

              {liveArenaStatus?.events && liveArenaStatus.events.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 pt-1">
                  {liveArenaStatus.events.slice(0, 6).map((ev) => {
                    const isLiveNow = String(ev.status || '').toUpperCase() === 'LIVE';
                    return (
                      <div
                        key={ev.id}
                        className="flex flex-col justify-between px-3 py-2 rounded-lg bg-[#11182a] border border-white/5 text-xs gap-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-white truncate text-[11px]">{ev.title}</span>
                          <span
                            className={`font-mono tabular-nums text-[10px] shrink-0 ${
                              isLiveNow ? 'text-rose-400 font-bold' : 'text-amber-300'
                            }`}
                          >
                            {isLiveNow ? `LIVE ${ev.statusDetail || ''}` : ev.statusDetail || ev.status}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {ev.league} ·{' '}
                          <span className="text-emerald-300">
                            {ev.recommendedChannels && ev.recommendedChannels.length > 0
                              ? ev.recommendedChannels
                                  .slice(0, 3)
                                  .map((c) => c.name.replace(/\s*\([^)]*\)/g, ''))
                                  .join(' · ')
                              : 'Multi-channel HD'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 4.5. Programmatic SEO & 1,000+ Daily Visitor Growth Engine */}
            <div className="bg-[#0e1424] border border-emerald-500/20 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                    <Globe className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2 flex-wrap">
                      <span>Programmatic SEO &amp; Google Search Indexing Engine</span>
                      <span className="text-[10px] font-mono text-emerald-300">
                        · SSR Meta + Dynamic Sitemap + Live Arena Schema Active
                      </span>
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Auto-generates 500+ crawlable Movie, Series, Anime &amp; Live Arena pages (<code className="text-emerald-300">/live</code>, <code className="text-emerald-300">/live/match/:id-slug</code>, <code className="text-emerald-300">/live/channel/:id</code>, <code className="text-emerald-300">/watch/movie/:id-slug</code>) with Server-Side OpenGraph &amp; Schema.org SportsEvent, BroadcastEvent, TelevisionChannel, Movie &amp; TVSeries Rich Snippets.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap text-xs font-mono tabular-nums">
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-emerald-500/25 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-slate-400">Indexed Sitemap URLs:</span>
                    <span className="font-bold text-emerald-400">
                      {seoStatus?.totalUrls || 519}
                    </span>
                  </div>
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-white/5 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-slate-400">Live Matches:</span>
                    <span className="font-bold text-rose-400">
                      {seoStatus?.liveMatchesCount ?? liveArenaStatus?.totalEvents ?? 0}
                    </span>
                  </div>
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-white/5 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-slate-400">24/7 Channels:</span>
                    <span className="font-bold text-amber-400">
                      {seoStatus?.liveChannelsCount || 102}
                    </span>
                  </div>
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-white/5 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-slate-400">Movies:</span>
                    <span className="font-bold text-blue-400">
                      {seoStatus?.moviesCount || 100}
                    </span>
                  </div>
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-white/5 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-slate-400">TV &amp; Anime:</span>
                    <span className="font-bold text-purple-400">
                      {seoStatus?.tvCount || 100}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const sUrl = seoStatus?.sitemapUrl || 'https://notflixtv.com/sitemap.xml';
                      navigator.clipboard?.writeText(sUrl);
                      setSeoCopiedUrl(sUrl);
                      setTimeout(() => setSeoCopiedUrl(null), 2500);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-sans font-semibold text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {seoCopiedUrl === (seoStatus?.sitemapUrl || 'https://notflixtv.com/sitemap.xml')
                      ? '✓ Copied Sitemap URL'
                      : 'Copy sitemap.xml URL'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      fetchSeoStatus(true);
                      fetchLiveArenaStatus(true);
                    }}
                    disabled={seoRefreshing}
                    className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-[11px] font-sans font-bold text-white flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-3 h-3 ${seoRefreshing ? 'animate-spin' : ''}`} />
                    <span>{seoRefreshing ? 'Refreshing Catalog...' : 'Refresh Sitemap'}</span>
                  </button>
                </div>
              </div>

              {seoStatus?.sampleUrls && seoStatus.sampleUrls.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 pt-1">
                  {seoStatus.sampleUrls.map((item) => (
                    <div
                      key={item.url}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#11182a] border border-white/5 text-xs gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-slate-200 truncate text-[11px]">
                          {item.title}{' '}
                          <span className="font-mono text-[10px] text-slate-400">
                            · {item.type.toUpperCase()}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-emerald-400/90 truncate">{item.url}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(item.url);
                          setSeoCopiedUrl(item.url);
                          setTimeout(() => setSeoCopiedUrl(null), 2000);
                        }}
                        className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-semibold text-slate-300 shrink-0 cursor-pointer whitespace-nowrap"
                      >
                        {seoCopiedUrl === item.url ? '✓ Copied' : 'Copy Link'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 5. Compact 2-Column Anti-Interception & Permanent IP Block Shield */}
            <div className="bg-[#0e1424] border border-white/10 rounded-xl p-4 flex flex-col gap-3.5">
              {/* Top Row: Title + Inline Security KPI Pills */}
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shrink-0">
                    <Shield className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2 flex-wrap">
                      <span>Anti-Interception &amp; Permanent IP Block Shield</span>
                      <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-400">
                        Permanent Ban Active
                      </span>
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Permanently blocks any IP attempting to intercept website data, forge stream tokens, or scrape content.
                    </p>
                  </div>
                </div>

                {/* Compact Inline KPI Pills */}
                <div className="flex items-center gap-2 flex-wrap text-xs font-mono">
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-white/5 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-slate-400">Scrapers:</span>
                    <span className="font-bold text-rose-400">
                      {analytics?.security?.totalBlockedScrapers || 0}
                    </span>
                  </div>
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-white/5 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-slate-400">Interceptions:</span>
                    <span className="font-bold text-purple-400">
                      {(analytics?.security?.totalInterceptionsBlocked || 0) +
                        (analytics?.security?.totalHoneypotTrapped || 0)}
                    </span>
                  </div>
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-white/5 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-slate-400">Rate Strikes:</span>
                    <span className="font-bold text-amber-400">
                      {analytics?.security?.totalRateLimited || 0}
                    </span>
                  </div>
                  <div className="px-2.5 py-1 rounded-lg bg-[#12192b] border border-rose-500/25 flex items-center gap-1.5">
                    <span className="text-[10px] font-sans text-rose-300 font-semibold">Permanent Bans:</span>
                    <span className="font-bold text-rose-400">
                      {analytics?.security?.activeBannedIps || 0}
                    </span>
                  </div>
                </div>
              </div>

              {/* Manual Permanent IP Ban Bar */}
              <form
                onSubmit={handleManualPermanentBan}
                className="p-2.5 rounded-lg bg-[#11182a] border border-white/10 flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
              >
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-300 shrink-0">
                  <Lock className="w-3.5 h-3.5 text-rose-400" />
                  <span>Block IP:</span>
                </div>
                <input
                  type="text"
                  value={manualBanIp}
                  onChange={(e) => setManualBanIp(e.target.value)}
                  placeholder="IP Address (e.g. 185.220.101.4)"
                  className="px-2.5 py-1 rounded-md bg-[#0b101e] border border-white/10 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-rose-500/50 sm:w-44"
                />
                <input
                  type="text"
                  value={manualBanReason}
                  onChange={(e) => setManualBanReason(e.target.value)}
                  placeholder="Reason (optional — e.g. Data interception / Scraper)"
                  className="px-2.5 py-1 rounded-md bg-[#0b101e] border border-white/10 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-rose-500/50 flex-1"
                />
                <button
                  type="submit"
                  disabled={banActionLoading || !manualBanIp.trim()}
                  className="px-3 py-1 rounded-md bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-bold transition-colors cursor-pointer shrink-0"
                >
                  Block Permanently
                </button>
              </form>

              {/* Side-by-Side: Permanently Blocked IPs & Recent Security Incidents */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
                {/* Left: Permanently Blocked IPs */}
                <div className="bg-[#11182a]/60 border border-white/5 rounded-lg p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                      <span>Permanently Blocked IPs ({analytics?.security?.permanentBans?.length || 0})</span>
                    </h4>
                    {analytics?.security?.permanentBans && analytics.security.permanentBans.length > 0 && (
                      <button
                        type="button"
                        onClick={handleUnblockAllIps}
                        disabled={banActionLoading}
                        className="text-[10px] font-bold text-slate-400 hover:text-white px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 transition-colors cursor-pointer"
                      >
                        Unblock All
                      </button>
                    )}
                  </div>

                  <div className="max-h-44 overflow-y-auto flex flex-col gap-1.5 pr-1">
                    {analytics?.security?.permanentBans && analytics.security.permanentBans.length > 0 ? (
                      analytics.security.permanentBans.map((ban) => (
                        <div
                          key={ban.ip}
                          className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#0d1322] border border-rose-500/20 text-xs gap-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/30 text-rose-300 font-mono font-bold text-[10px] shrink-0">
                              {ban.ip}
                            </span>
                            <span className="text-slate-300 truncate text-[11px]" title={ban.reason}>
                              {ban.reason}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono text-[10px] text-slate-500">
                              {ban.blockedAttempts}x
                            </span>
                            <button
                              type="button"
                              onClick={() => handleUnblockIp(ban.ip)}
                              disabled={banActionLoading}
                              className="px-2 py-0.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 font-bold text-[10px] transition-colors cursor-pointer"
                            >
                              Unblock
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="py-4 text-center text-[11px] text-slate-500">
                        No IPs currently blacklisted. Any scraper or interceptor is locked here automatically.
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: Recent Security & Interception Incident Log */}
                <div className="bg-[#11182a]/60 border border-white/5 rounded-lg p-3 flex flex-col gap-2">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Bug className="w-3.5 h-3.5 text-rose-400" />
                    <span>Recent Security &amp; Interception Log</span>
                  </h4>

                  <div className="max-h-44 overflow-y-auto flex flex-col gap-1.5 pr-1">
                    {analytics?.security?.recentEvents && analytics.security.recentEvents.length > 0 ? (
                      analytics.security.recentEvents.map((ev, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#0d1322] border border-white/5 text-xs gap-2"
                        >
                          <div className="flex items-center gap-2 truncate">
                            <ShieldAlert className="w-3 h-3 text-rose-400 shrink-0" />
                            <div className="truncate text-[11px]">
                              <span className="text-rose-300 font-semibold">{ev.reason}</span>
                              <span className="text-slate-500 mx-1">on</span>
                              <span className="font-mono text-slate-300">{ev.path}</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0 font-mono text-[10px] text-slate-400">
                            <span className="text-slate-300">{ev.ip}</span>
                            <span>·</span>
                            <span>
                              {new Date(ev.ts).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="py-4 text-center text-[11px] text-slate-500">
                        Shield active: No scraper attacks or data interception attempts detected.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Compact Footer */}
      <footer className="border-t border-white/5 py-3 px-6 text-center text-[11px] text-slate-500 flex items-center justify-between flex-wrap gap-2">
        <span>Notflix Studio Telemetry Engine v2.5</span>
        <span className="font-mono">
          Last sync: {lastFetchedTime.toLocaleTimeString()}
        </span>
      </footer>
    </div>
  );
};
