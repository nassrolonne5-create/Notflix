import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { MediaItem, UserData, UserPlaybackData } from '../types';
import { fetchUserData, syncUserData, isSafe, getDeviceId, tmdbFetch, formatMediaItem } from '../services/api';
import { triggerAd } from '../services/adService';
import { smartAdController } from '../services/smartAdController';

export type TabType = 'home' | 'movies' | 'tv' | 'anime' | 'library' | 'search';

export function toSeoSlug(text: string): string {
  return (
    (text || 'watch')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'watch'
  );
}

export function buildSeoWatchPath(item: MediaItem, season?: number, episode?: number): string {
  const mediaType = item.type === 'tv' ? 'tv' : 'movie';
  const slug = toSeoSlug(item.title || item.name || 'stream');
  const basePath = `/watch/${mediaType}/${item.id}-${slug}`;
  if (mediaType === 'tv' && season && episode && (season > 1 || episode > 1)) {
    return `${basePath}?s=${season}&e=${episode}`;
  }
  return basePath;
}

export function getTabPath(tab: TabType): string {
  switch (tab) {
    case 'movies':
      return '/movies';
    case 'tv':
      return '/series';
    case 'anime':
      return '/anime';
    case 'library':
      return '/library';
    case 'search':
      return '/search';
    default:
      return '/';
  }
}

interface ToastState {
  show: boolean;
  message: string;
  icon?: string;
}

interface AppContextType {
  activeTab: TabType;
  setActiveTab: (tab: TabType, skipAd?: boolean) => void;
  activeModalItem: MediaItem | null;
  activeSeason: number;
  activeEpisode: number;
  openPlayer: (item: MediaItem, season?: number, episode?: number) => void;
  closePlayer: () => void;
  quickViewItem: MediaItem | null;
  openQuickView: (item: MediaItem) => void;
  closeQuickView: () => void;
  isSettingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  userData: UserData;
  toggleWatchlist: (item: MediaItem) => void;
  toggleFavorite: (item: MediaItem) => void;
  addToHistory: (item: MediaItem) => void;
  removeHistory: (id: number) => void;
  updatePlaybackPosition: (key: string, data: Partial<UserPlaybackData>) => void;
  clearWatchHistory: () => void;
  resetAppData: () => void;
  toggleAutoSkip: () => void;
  toggleGlobalSubtitles: () => void;
  toast: ToastState;
  showToast: (message: string, icon?: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

const defaultUserData: UserData = {
  watchlist: [],
  favorites: [],
  history: [],
  playbackPosition: {},
  settings: {
    autoSkip: true,
    globalSubtitles: true,
  },
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [activeTab, setActiveTabState] = useState<TabType>(() => {
    if (typeof window === 'undefined') return 'home';
    const p = window.location.pathname.toLowerCase();
    if (p.startsWith('/movies')) return 'movies';
    if (p.startsWith('/series') || p.startsWith('/tv')) return 'tv';
    if (p.startsWith('/anime')) return 'anime';
    if (p.startsWith('/library')) return 'library';
    if (p.startsWith('/search')) return 'search';
    return 'home';
  });

  const setActiveTab = useCallback((tab: TabType, skipAd = false) => {
    setActiveTabState((prev) => {
      if (!skipAd && tab !== prev) {
        triggerAd('tab');
      }
      return tab;
    });
    if (typeof window !== 'undefined' && !window.location.pathname.toLowerCase().startsWith('/admin')) {
      const nextPath = getTabPath(tab);
      if (window.location.pathname !== nextPath) {
        try {
          window.history.pushState({ tab }, '', nextPath);
        } catch {}
      }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const [activeModalItem, setActiveModalItem] = useState<MediaItem | null>(null);
  const [activeSeason, setActiveSeason] = useState<number>(1);
  const [activeEpisode, setActiveEpisode] = useState<number>(1);
  const [quickViewItem, setQuickViewItem] = useState<MediaItem | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('q') || '';
    } catch {
      return '';
    }
  });
  const playerOpenTimeRef = useRef<number>(0);

  const [toast, setToast] = useState<ToastState>({ show: false, message: '' });

  // Initial user data from localStorage (strictly isolated per device)
  const [userData, setUserData] = useState<UserData>(() => {
    try {
      // Ensure this browser has a unique deviceId
      getDeviceId();

      // One-time cleanup of any legacy global playback/history data that leaked from old shared userdata.json
      if (localStorage.getItem('notflix_device_isolated_v2') !== 'true') {
        localStorage.removeItem('notflix_playback');
        localStorage.removeItem('notflix_history');
        localStorage.removeItem('notflix_last_session');
        localStorage.setItem('notflix_device_isolated_v2', 'true');
      }

      const savedWl = localStorage.getItem('notflix_watchlist');
      const savedFav = localStorage.getItem('notflix_favorites');
      const savedHist = localStorage.getItem('notflix_history');
      const savedPb = localStorage.getItem('notflix_playback');
      const autoSkip = localStorage.getItem('auto_skip') !== 'false';
      const globalSubtitles = localStorage.getItem('global_subtitles') !== 'false';

      return {
        watchlist: savedWl ? JSON.parse(savedWl) : [],
        favorites: savedFav ? JSON.parse(savedFav) : [],
        history: savedHist ? JSON.parse(savedHist) : [],
        playbackPosition: savedPb ? JSON.parse(savedPb) : {},
        settings: { autoSkip, globalSubtitles },
      };
    } catch {
      return defaultUserData;
    }
  });

  // Pull per-device server-stored userdata on mount (only for this deviceId)
  useEffect(() => {
    fetchUserData().then((serverData) => {
      if (serverData) {
        setUserData((prev) => {
          const merged: UserData = {
            watchlist: prev.watchlist.length ? prev.watchlist : (serverData.watchlist || []),
            favorites: prev.favorites.length ? prev.favorites : (serverData.favorites || []),
            history: prev.history.length ? prev.history : (serverData.history || []),
            playbackPosition: { ...(serverData.playbackPosition || {}), ...prev.playbackPosition },
            settings: {
              ...(serverData.settings || {}),
              ...prev.settings,
            },
          };
          return merged;
        });
      }
    });
  }, []);

  // Save to localStorage & sync with backend for this device on changes
  const saveUserData = (newData: UserData) => {
    setUserData(newData);
    try {
      localStorage.setItem('notflix_watchlist', JSON.stringify(newData.watchlist));
      localStorage.setItem('notflix_favorites', JSON.stringify(newData.favorites));
      localStorage.setItem('notflix_history', JSON.stringify(newData.history));
      localStorage.setItem('notflix_playback', JSON.stringify(newData.playbackPosition));
      localStorage.setItem('auto_skip', String(newData.settings.autoSkip));
      localStorage.setItem('global_subtitles', String(newData.settings.globalSubtitles));
    } catch (e) {
      console.warn('LocalStorage save error:', e);
    }
    syncUserData(newData);
  };

  const showToast = useCallback((message: string, icon = '') => {
    setToast({ show: true, message, icon });
    window.clearTimeout((window as any)._toastTimeout);
    (window as any)._toastTimeout = window.setTimeout(() => {
      setToast({ show: false, message: '' });
    }, 3000);
  }, []);

  const openPlayer = (item: MediaItem, season?: number, episode?: number) => {
    playerOpenTimeRef.current = Date.now();
    triggerAd('poster');
    if ('vibrate' in navigator) navigator.vibrate(12);

    if (!isSafe(item)) {
      showToast('This content is restricted by active Safety Filters.', '🛡️');
      return;
    }

    const trackKey = `${item.type}-${item.id}`;
    const pobj = userData.playbackPosition[trackKey];

    const s = season ?? (item.type === 'tv' && pobj?.s ? pobj.s : 1);
    const e = episode ?? (item.type === 'tv' && pobj?.e ? pobj.e : 1);

    setActiveSeason(s);
    setActiveEpisode(e);
    setActiveModalItem(item);

    addToHistory(item);
    if (typeof window !== 'undefined' && !window.location.pathname.toLowerCase().startsWith('/admin')) {
      try {
        const seoPath = buildSeoWatchPath(item, s, e);
        if (window.location.pathname + window.location.search !== seoPath) {
          window.history.pushState({ watchId: item.id, mediaType: item.type }, '', seoPath);
        }
      } catch {}
    }
  };

  const closePlayer = () => {
    // Detect fast modal bounce/abandonment within 6s (indicates UX friction)
    if (playerOpenTimeRef.current > 0 && Date.now() - playerOpenTimeRef.current < 6000) {
      smartAdController.recordFriction(1.0, 'quick_player_exit');
    }
    smartAdController.setPlaybackActive(false);

    setActiveModalItem(null);
    if (typeof window !== 'undefined' && window.location.pathname.toLowerCase().startsWith('/watch/')) {
      try {
        window.history.pushState({}, '', getTabPath(activeTab));
      } catch {}
    }
    try {
      localStorage.removeItem('notflix_last_session');
    } catch {}
  };

  // Resolve SEO Deep-Links (/watch/movie/:id-slug, /watch/tv/:id-slug?s=1&e=1) from Google Search & Social Shares
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const resolveDeepLink = async () => {
      const path = window.location.pathname;
      const watchMatch = path.match(/^\/watch\/(movie|tv)\/(\d+)/i);
      if (watchMatch) {
        const mediaType = watchMatch[1].toLowerCase() === 'tv' ? 'tv' : 'movie';
        const tmdbId = parseInt(watchMatch[2], 10);
        if (!isNaN(tmdbId) && tmdbId > 0) {
          const params = new URLSearchParams(window.location.search);
          const s = parseInt(params.get('s') || '1', 10) || 1;
          const e = parseInt(params.get('e') || '1', 10) || 1;
          try {
            const raw = await tmdbFetch(`${mediaType}/${tmdbId}`);
            if (raw && raw.id && isSafe(raw)) {
              const formatted = formatMediaItem(raw, mediaType);
              setActiveSeason(s);
              setActiveEpisode(e);
              setActiveModalItem(formatted);
            }
          } catch {}
        }
        return;
      }

      const lower = path.toLowerCase();
      if (lower.startsWith('/movies')) setActiveTabState('movies');
      else if (lower.startsWith('/series') || lower.startsWith('/tv')) setActiveTabState('tv');
      else if (lower.startsWith('/anime')) setActiveTabState('anime');
      else if (lower.startsWith('/library')) setActiveTabState('library');
      else if (lower.startsWith('/search')) {
        setActiveTabState('search');
        const params = new URLSearchParams(window.location.search);
        const q = params.get('q');
        if (q) setSearchQuery(q);
      }
    };

    resolveDeepLink();

    const handlePopState = () => {
      if (!window.location.pathname.toLowerCase().startsWith('/watch/')) {
        setActiveModalItem(null);
      }
      resolveDeepLink();
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const openQuickView = (item: MediaItem) => {
    triggerAd('poster');
    if ('vibrate' in navigator) navigator.vibrate(25);
    setQuickViewItem(item);
  };

  const closeQuickView = () => {
    setQuickViewItem(null);
  };

  const openSettings = () => setIsSettingsOpen(true);
  const closeSettings = () => setIsSettingsOpen(false);

  const toggleWatchlist = (item: MediaItem) => {
    if (!isSafe(item)) return;
    if ('vibrate' in navigator) navigator.vibrate(10);
    const exists = userData.watchlist.some((x) => x.id === item.id);
    let updatedWl = [...userData.watchlist];
    if (exists) {
      updatedWl = updatedWl.filter((x) => x.id !== item.id);
      showToast('Removed from Watchlist');
    } else {
      updatedWl.unshift(item);
      showToast('Added to Watchlist', '🎬');
    }
    saveUserData({ ...userData, watchlist: updatedWl });
  };

  const toggleFavorite = (item: MediaItem) => {
    if (!isSafe(item)) return;
    if ('vibrate' in navigator) navigator.vibrate(10);
    const exists = userData.favorites.some((x) => x.id === item.id);
    let updatedFav = [...userData.favorites];
    if (exists) {
      updatedFav = updatedFav.filter((x) => x.id !== item.id);
      showToast('Removed from Favorites');
    } else {
      updatedFav.unshift(item);
      showToast('Added to Favorites', '❤️');
    }
    saveUserData({ ...userData, favorites: updatedFav });
  };

  const addToHistory = (item: MediaItem) => {
    if (!isSafe(item)) return;
    const list = userData.history.filter((x) => x.id !== item.id);
    list.unshift({ ...item, watchedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    if (list.length > 100) list.pop();
    saveUserData({ ...userData, history: list });
  };

  const removeHistory = (id: number) => {
    const list = userData.history.filter((x) => x.id !== id);
    saveUserData({ ...userData, history: list });
    showToast('Removed from history');
  };

  const updatePlaybackPosition = useCallback((key: string, data: Partial<UserPlaybackData>) => {
    setUserData((prev) => {
      const current = prev.playbackPosition[key] || {};
      const updated = { ...current, ...data };
      const newPositions = { ...prev.playbackPosition, [key]: updated };
      const updatedUserData = { ...prev, playbackPosition: newPositions };
      try {
        localStorage.setItem('notflix_playback', JSON.stringify(newPositions));
      } catch (e) {
        console.warn('LocalStorage save error:', e);
      }
      return updatedUserData;
    });
  }, []);

  const clearWatchHistory = () => {
    saveUserData({ ...userData, history: [] });
    showToast('Playback history cleared', '🗑️');
  };

  const resetAppData = () => {
    localStorage.clear();
    saveUserData(defaultUserData);
    showToast('Database reset to defaults', '🔥');
    setTimeout(() => window.location.reload(), 600);
  };

  const toggleAutoSkip = () => {
    const newVal = !userData.settings.autoSkip;
    const newSettings = { ...userData.settings, autoSkip: newVal };
    saveUserData({ ...userData, settings: newSettings });
    showToast(newVal ? 'Auto-skip Intros Enabled' : 'Auto-skip Intros Disabled', '⚡');
  };

  const toggleGlobalSubtitles = () => {
    const newVal = !userData.settings.globalSubtitles;
    const newSettings = { ...userData.settings, globalSubtitles: newVal };
    saveUserData({ ...userData, settings: newSettings });
    showToast(newVal ? 'Global Subtitles Enabled' : 'Global Subtitles Disabled', 'CC');
  };

  return (
    <AppContext.Provider
      value={{
        activeTab,
        setActiveTab,
        activeModalItem,
        activeSeason,
        activeEpisode,
        openPlayer,
        closePlayer,
        quickViewItem,
        openQuickView,
        closeQuickView,
        isSettingsOpen,
        openSettings,
        closeSettings,
        userData,
        toggleWatchlist,
        toggleFavorite,
        addToHistory,
        removeHistory,
        updatePlaybackPosition,
        clearWatchHistory,
        resetAppData,
        toggleAutoSkip,
        toggleGlobalSubtitles,
        toast,
        showToast,
        searchQuery,
        setSearchQuery,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within an AppProvider');
  return context;
};
