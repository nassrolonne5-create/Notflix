import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { MediaItem, UserData, UserPlaybackData } from '../types';
import { fetchUserData, syncUserData, isSafe } from '../services/api';
import { triggerAd } from '../services/adService';

export type TabType = 'home' | 'movies' | 'tv' | 'anime' | 'library' | 'search';

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
  const [activeTab, setActiveTabState] = useState<TabType>('home');

  const setActiveTab = useCallback((tab: TabType, skipAd = false) => {
    setActiveTabState((prev) => {
      if (!skipAd && tab !== prev) {
        triggerAd('tab');
      }
      return tab;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const [activeModalItem, setActiveModalItem] = useState<MediaItem | null>(null);
  const [activeSeason, setActiveSeason] = useState<number>(1);
  const [activeEpisode, setActiveEpisode] = useState<number>(1);
  const [quickViewItem, setQuickViewItem] = useState<MediaItem | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [toast, setToast] = useState<ToastState>({ show: false, message: '' });

  // Initial user data from localStorage + server sync
  const [userData, setUserData] = useState<UserData>(() => {
    try {
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

  // Pull server-stored userdata on mount
  useEffect(() => {
    fetchUserData().then((serverData) => {
      if (serverData) {
        setUserData((prev) => {
          const merged: UserData = {
            watchlist: serverData.watchlist?.length ? serverData.watchlist : prev.watchlist,
            favorites: serverData.favorites?.length ? serverData.favorites : prev.favorites,
            history: serverData.history?.length ? serverData.history : prev.history,
            playbackPosition: { ...prev.playbackPosition, ...serverData.playbackPosition },
            settings: {
              ...prev.settings,
              ...(serverData.settings || {}),
            },
          };
          return merged;
        });
      }
    });
  }, []);

  // Save to localStorage & sync with backend on changes
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
    document.title = `${item.title || item.name} — Watch on Notflix`;
  };

  const closePlayer = () => {
    setActiveModalItem(null);
    document.title = 'Notflix — Movies & TV Shows';
    try {
      localStorage.removeItem('notflix_last_session');
    } catch {}
  };

  const openQuickView = (item: MediaItem) => {
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
