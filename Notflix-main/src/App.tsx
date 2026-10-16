import React, { useState, useEffect } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Header } from './components/Header';
import { Dock } from './components/Dock';
import { HomePage } from './pages/HomePage';
import { MoviesPage } from './pages/MoviesPage';
import { SeriesPage } from './pages/SeriesPage';
import { AnimePage } from './pages/AnimePage';
import { LibraryPage } from './pages/LibraryPage';
import { SearchPage } from './pages/SearchPage';
import { AdminPage } from './pages/AdminPage';
import { VideoPlayerModal } from './components/VideoPlayerModal';
import { SettingsModal } from './components/SettingsModal';
import { Toast } from './components/Toast';
import { ResumeBanner } from './components/ResumeBanner';
import { telemetry } from './services/telemetry';

const checkIsAdmin = (): boolean => {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  return (
    path === '/admin' ||
    path.startsWith('/admin') ||
    hash === '#admin' ||
    hash.startsWith('#admin') ||
    hash === '#/admin' ||
    hash.startsWith('#/admin')
  );
};

const AppContent: React.FC = () => {
  const { activeTab, activeModalItem, quickViewItem } = useApp();
  const [isAdmin, setIsAdmin] = useState<boolean>(checkIsAdmin);

  // Sync routing on popstate and hashchange
  useEffect(() => {
    const handleNavigation = () => {
      setIsAdmin(checkIsAdmin());
    };
    window.addEventListener('popstate', handleNavigation);
    window.addEventListener('hashchange', handleNavigation);

    // Track initial page view for analytics
    telemetry.trackPageView(window.location.pathname);

    return () => {
      window.removeEventListener('popstate', handleNavigation);
      window.removeEventListener('hashchange', handleNavigation);
    };
  }, []);

  // Dynamic SEO Title & Meta Description update per view / movie
  useEffect(() => {
    let title = 'Notflix — Movies & TV Shows';
    let desc =
      'Discover and stream trending movies, popular TV shows, and anime in HD on Notflix. Enjoy high-speed playback, multi-language subtitles, and personalized recommendations.';

    if (activeModalItem) {
      const name = activeModalItem.title || activeModalItem.name || 'Movie';
      const year = activeModalItem.year ? ` (${activeModalItem.year})` : '';
      title = `Watch ${name}${year} in HD — Notflix`;
      if (activeModalItem.overview) {
        desc = activeModalItem.overview.slice(0, 155);
      }
    } else {
      switch (activeTab) {
        case 'movies':
          title = 'Movies — Stream Blockbusters & Trending Films | Notflix';
          desc =
            'Browse popular, top-rated, and newly released movies in 1080p and 4K on Notflix with multi-language audio and subtitles.';
          break;
        case 'tv':
          title = 'TV Series — Binge Popular Shows & Episodes | Notflix';
          desc =
            'Stream full seasons and latest episodes of trending TV series on Notflix. Seamless episode switching and playback tracking.';
          break;
        case 'anime':
          title = 'Anime — Top Japanese Animation & Series | Notflix';
          desc = 'Explore top-rated and trending anime series with Japanese and English audio on Notflix.';
          break;
        case 'search':
          title = 'Search Movies & TV Shows | Notflix';
          desc = 'Find any movie, series, or actor across our extensive streaming catalog on Notflix.';
          break;
        case 'library':
          title = 'My Library & Watchlist | Notflix';
          desc = 'Manage your personal watchlist, favorites, and continue watching history on Notflix.';
          break;
        default:
          title = 'Notflix — Movies & TV Shows';
          desc =
            'Discover and stream trending movies, popular TV shows, and anime in HD on Notflix.';
          break;
      }
    }

    document.title = title;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', desc);
  }, [activeTab, activeModalItem]);

  // Dedicated Admin Analytics Command Center
  if (isAdmin) {
    return (
      <AdminPage
        onExit={() => {
          window.history.pushState({}, '', '/');
          window.location.hash = '';
          setIsAdmin(false);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0f19] text-[#f8fafc] flex flex-col selection:bg-rose-600 selection:text-white relative">
      {/* Top Header */}
      <Header />

      {/* Main Content Area */}
      <main className="flex-1 pt-16 md:pt-18 md:pl-20">
        {activeTab === 'home' && <HomePage />}
        {activeTab === 'movies' && <MoviesPage />}
        {activeTab === 'tv' && <SeriesPage />}
        {activeTab === 'anime' && <AnimePage />}
        {activeTab === 'library' && <LibraryPage />}
        {activeTab === 'search' && <SearchPage />}
      </main>

      {/* Footer */}
      <footer className="md:pl-20 py-8 px-4 text-center border-t border-white/[0.04] bg-[#080c14] mt-auto">
        <div className="font-display text-2xl tracking-wider text-white uppercase mb-1">
          Notflix<span className="text-blue-500">.</span>
        </div>
        <p className="text-xs text-slate-500 max-w-sm mx-auto">
          Powered by TMDB API · Safe Filter Shield Locked On
        </p>
      </footer>

      {/* Navigation Dock */}
      <Dock />

      {/* Video Player Modal */}
      {activeModalItem && <VideoPlayerModal />}

      {/* Settings Modal */}
      <SettingsModal />

      {/* Toast Notifications */}
      <Toast />

      {/* Browser Resume Banner */}
      <ResumeBanner />
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
