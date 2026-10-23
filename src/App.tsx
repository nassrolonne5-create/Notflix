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
import { AdBlockerBanner } from './components/AdBlockerBanner';
import { LiveTvArena } from './components/LiveTvArena';
import { telemetry } from './services/telemetry';
import { securitySentinel, PermanentBlockInfo } from './services/securitySentinel';
import { ensurePopunderScriptLoaded } from './services/adService';

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
  const { activeTab, setActiveTab, activeModalItem, quickViewItem } = useApp();
  const [isAdmin, setIsAdmin] = useState<boolean>(checkIsAdmin);
  const [blockInfo, setBlockInfo] = useState<PermanentBlockInfo>(() =>
    securitySentinel.getBlockState()
  );

  useEffect(() => {
    securitySentinel.init();
    return securitySentinel.subscribe((state) => {
      setBlockInfo(state);
    });
  }, []);

  // Sync routing on popstate and hashchange
  useEffect(() => {
    const handleNavigation = () => {
      const adminState = checkIsAdmin();
      // Do not accidentally exit admin mode if an internal anchor hash is clicked while already in admin
      setIsAdmin((prev) => {
        const next = adminState || (prev && window.location.hash.startsWith('#scraper'));
        if (typeof window !== 'undefined') {
          (window as any).__NOTFLIX_IS_ADMIN__ = next;
        }
        return next;
      });
    };
    const initialAdmin = checkIsAdmin();
    setIsAdmin(initialAdmin);
    if (typeof window !== 'undefined') {
      (window as any).__NOTFLIX_IS_ADMIN__ = initialAdmin;
    }

    window.addEventListener('popstate', handleNavigation);
    window.addEventListener('hashchange', handleNavigation);
    window.addEventListener('notflix:open-admin', () => {
      window.history.pushState({}, '', '/admin');
      (window as any).__NOTFLIX_IS_ADMIN__ = true;
      setIsAdmin(true);
    });

    // Track initial page view for analytics
    telemetry.trackPageView(window.location.pathname);

    return () => {
      window.removeEventListener('popstate', handleNavigation);
      window.removeEventListener('hashchange', handleNavigation);
    };
  }, []);

  // Dynamic SEO Title, Meta Description, OpenGraph, Twitter Cards & Schema.org JSON-LD update per view / movie
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      !activeModalItem &&
      /^\/(live|arena)(\/|$)/i.test(window.location.pathname)
    ) {
      return;
    }

    let title = 'Notflix — Watch Movies, TV Series & Anime Online Free in HD';
    let desc =
      'Stream trending movies, full TV series seasons, and anime online free in 1080p & 4K HD on Notflix with English, Arabic, Spanish & multi-language subtitles.';
    let ogImage = 'https://image.tmdb.org/t/p/w1280/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg';
    const canonicalUrl =
      typeof window !== 'undefined'
        ? `${window.location.origin}${window.location.pathname}`
        : 'https://notflixtv.com/';

    if (activeModalItem) {
      const name = activeModalItem.title || activeModalItem.name || 'Movie';
      const year = activeModalItem.year ? ` (${activeModalItem.year})` : '';
      const isTv = activeModalItem.type === 'tv';
      title = `Watch ${name}${year} ${isTv ? 'Full Series' : 'Full Movie'} Online Free HD — Notflix`;
      const plot = activeModalItem.overview ? ` ${activeModalItem.overview}` : '';
      desc = `Stream ${name}${year} online in 1080p HD with multi-language subtitles on Notflix.${plot}`.slice(0, 158);
      if (activeModalItem.backdrop || activeModalItem.poster) {
        ogImage = activeModalItem.backdrop || activeModalItem.poster;
      }

      // Inject dynamic Schema.org Movie / TVSeries Rich Snippet JSON-LD
      try {
        const schemaId = 'notflix-dynamic-title-jsonld';
        let scriptEl = document.getElementById(schemaId) as HTMLScriptElement | null;
        if (!scriptEl) {
          scriptEl = document.createElement('script');
          scriptEl.id = schemaId;
          scriptEl.type = 'application/ld+json';
          document.head.appendChild(scriptEl);
        }
        const ratingVal = Number(activeModalItem.vote_average || activeModalItem.rating) || 7.8;
        const jsonLd: Record<string, any> = {
          '@context': 'https://schema.org',
          '@type': isTv ? 'TVSeries' : 'Movie',
          name,
          url: canonicalUrl,
          image: [activeModalItem.poster, activeModalItem.backdrop].filter(Boolean),
          description: activeModalItem.overview || desc,
          datePublished: activeModalItem.year || undefined,
          inLanguage: 'en',
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: ratingVal > 0 ? ratingVal.toFixed(1) : '7.8',
            bestRating: '10',
            worstRating: '1',
            ratingCount: Math.max(120, Math.round(ratingVal * 450)),
          },
          potentialAction: {
            '@type': 'WatchAction',
            target: {
              '@type': 'EntryPoint',
              urlTemplate: canonicalUrl,
              actionPlatform: [
                'http://schema.org/DesktopWebPlatform',
                'http://schema.org/MobileWebPlatform',
                'http://schema.org/IOSPlatform',
                'http://schema.org/AndroidPlatform',
              ],
            },
          },
        };
        scriptEl.textContent = JSON.stringify(jsonLd);
      } catch {}
    } else {
      const existingSchema = document.getElementById('notflix-dynamic-title-jsonld');
      if (existingSchema) existingSchema.remove();

      switch (activeTab) {
        case 'movies':
          title = 'Watch Movies Online Free in HD (1080p & 4K) | Notflix';
          desc =
            'Browse and stream newly released blockbusters, top-rated movies, and trending films in 1080p and 4K HD with multi-language subtitles on Notflix.';
          break;
        case 'tv':
          title = 'Watch TV Series & Full Seasons Online Free in HD | Notflix';
          desc =
            'Binge-watch full seasons and latest episodes of popular TV shows in HD on Notflix with multi-server playback and instant subtitles.';
          break;
        case 'anime':
          title = 'Watch Anime Online Free in HD (English Sub & Dub) | Notflix';
          desc =
            'Stream top-rated and trending Japanese anime series and movies in 1080p HD with English, Arabic, and multi-language subtitles on Notflix.';
          break;
        case 'search':
          title = 'Search Movies, TV Shows & Anime Online | Notflix';
          desc =
            'Search and stream any movie, TV series, or anime across our high-speed HD catalog with multi-language subtitles on Notflix.';
          break;
        case 'library':
          title = 'My Library, Watchlist & Continue Watching | Notflix';
          desc =
            'Access your saved watchlist, favorite movies, and automatic episode resume history on Notflix.';
          break;
        default:
          title = 'Notflix — Watch Movies, TV Series & Anime Online Free in HD';
          desc =
            'Stream trending movies, full TV series seasons, and anime online free in 1080p & 4K HD on Notflix with multi-language subtitles.';
          break;
      }
    }

    document.title = title;
    const setMeta = (selector: string, attr: string, value: string) => {
      const el = document.querySelector(selector);
      if (el) el.setAttribute(attr, value);
    };
    setMeta('meta[name="description"]', 'content', desc);
    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', desc);
    setMeta('meta[property="og:url"]', 'content', canonicalUrl);
    setMeta('meta[property="og:image"]', 'content', ogImage);
    setMeta('meta[name="twitter:title"]', 'content', title);
    setMeta('meta[name="twitter:description"]', 'content', desc);
    setMeta('meta[name="twitter:image"]', 'content', ogImage);
    setMeta('link[rel="canonical"]', 'href', canonicalUrl);
  }, [activeTab, activeModalItem]);

  // Dedicated Admin Analytics Command Center
  if (isAdmin) {
    return (
      <AdminPage
        onExit={() => {
          window.history.pushState({}, '', '/');
          window.location.hash = '';
          (window as any).__NOTFLIX_IS_ADMIN__ = false;
          setIsAdmin(false);
          setTimeout(ensurePopunderScriptLoaded, 100);
        }}
      />
    );
  }

  // Permanent IP Block Lockout Screen for Scrapers / Data Interceptors
  if (blockInfo.blocked) {
    return (
      <div
        onContextMenu={(e) => e.preventDefault()}
        className="min-h-screen bg-[#070a12] text-white flex items-center justify-center p-6 select-none"
      >
        <div className="max-w-lg w-full bg-[#0e1424] border border-rose-500/40 rounded-2xl p-8 text-center shadow-2xl shadow-rose-950/30">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center mx-auto mb-5 text-rose-400 font-mono text-2xl font-extrabold">
            403
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-rose-500/15 border border-rose-500/30 text-rose-300 text-[11px] font-mono font-bold uppercase tracking-widest mb-3">
            Permanent IP Blacklist Active
          </div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight mb-2">
            Access Permanently Terminated
          </h1>
          <p className="text-xs text-slate-300 leading-relaxed mb-6">
            Your network IP address has been permanently blocked by the Notflix Anti-Interception &amp; Anti-Scraping Security Shield due to unauthorized data interception, developer mode inspection, or automated extraction activity.
          </p>
          <div className="bg-[#090d18] border border-white/10 rounded-xl p-4 text-left font-mono text-xs space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">STATUS CODE:</span>
              <span className="text-rose-400 font-bold">IP_PERMANENTLY_BLOCKED (HTTP 403)</span>
            </div>
            {blockInfo.ip && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">CLIENT IP:</span>
                <span className="text-slate-200 font-bold">{blockInfo.ip}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">VIOLATION:</span>
              <span className="text-amber-300 truncate max-w-[260px]">
                {blockInfo.reason || 'Data Interception / Automated Scraping'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">BAN DURATION:</span>
              <span className="text-rose-400 font-bold uppercase">Permanent</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Anti-Page-Inspection & Developer Mode Lockdown Screen (Unmounts all DOM & Streams immediately)
  if (blockInfo.inspectionLocked) {
    return (
      <div
        onContextMenu={(e) => e.preventDefault()}
        className="min-h-screen bg-[#070a12] text-white flex items-center justify-center p-6 select-none"
      >
        <div className="max-w-lg w-full bg-[#0e1424] border border-amber-500/40 rounded-2xl p-8 text-center shadow-2xl shadow-amber-950/20">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mx-auto mb-5 text-amber-400 font-mono text-xl font-extrabold">
            LOCKED
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-mono font-bold uppercase tracking-widest mb-3">
            Anti-Inspection &amp; Anti-DevTools Shield
          </div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight mb-2">
            Developer Mode &amp; Page Inspection Prohibited
          </h1>
          <p className="text-xs text-slate-300 leading-relaxed mb-6">
            Opening Developer Tools, inspecting page elements, viewing page source, or capturing network streams is strictly forbidden on Notflix. All active media streams and DOM payloads have been unloaded to protect website data.
          </p>
          <div className="bg-[#090d18] border border-white/10 rounded-xl p-4 text-left font-mono text-xs space-y-2 mb-6">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">PROTECTION STATE:</span>
              <span className="text-amber-400 font-bold">DOM_AND_STREAM_PURGED</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">DETECTED EVENT:</span>
              <span className="text-slate-200 truncate max-w-[250px]">
                {blockInfo.inspectionReason || 'Developer Mode / Page Inspection Attempt'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">SECURITY STRIKE:</span>
              <span className="text-rose-400 font-bold">
                {blockInfo.strikeCount || 1} / 3 (3 Strikes = Permanent IP Ban)
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => securitySentinel.dismissInspectionLock()}
            className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold text-xs uppercase tracking-wider transition-colors cursor-pointer"
          >
            I Have Closed Developer Tools — Resume Session
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      className="min-h-screen bg-[#0b0f19] text-[#f8fafc] flex flex-col selection:bg-rose-600 selection:text-white relative select-none"
    >
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
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          Stream Trending Movies, Full TV Series &amp; Anime Online in 1080p &amp; 4K HD with Multi-Language Subtitles
        </p>
        <nav
          aria-label="Streaming Categories and Sitemap"
          className="mt-3 flex items-center justify-center flex-wrap gap-3 text-[11px] text-slate-400"
        >
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('home');
            }}
            className="hover:text-white transition-colors"
          >
            Home
          </a>
          <span className="text-slate-700">·</span>
          <a
            href="/movies"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('movies');
            }}
            className="hover:text-white transition-colors"
          >
            HD Movies
          </a>
          <span className="text-slate-700">·</span>
          <a
            href="/series"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('tv');
            }}
            className="hover:text-white transition-colors"
          >
            TV Series
          </a>
          <span className="text-slate-700">·</span>
          <a
            href="/anime"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('anime');
            }}
            className="hover:text-white transition-colors"
          >
            Anime HD
          </a>
          <span className="text-slate-700">·</span>
          <a
            href="/search"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('search');
            }}
            className="hover:text-white transition-colors"
          >
            Search Catalog
          </a>
          <span className="text-slate-700">·</span>
          <a
            href="/sitemap.xml"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-blue-400 transition-colors"
          >
            XML Sitemap
          </a>
          <span className="text-slate-700">·</span>
          <a
            href="/live"
            onClick={(e) => {
              e.preventDefault();
              window.history.pushState({}, '', '/live');
              window.dispatchEvent(new CustomEvent('notflix:open-live-tv'));
            }}
            className="text-rose-400 hover:text-rose-300 font-semibold transition-colors cursor-pointer"
          >
            Live TV &amp; Sports Arena
          </a>
          <span className="text-slate-700">·</span>
          <a
            href="https://t.me/Notflix_tv"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#2AABEE] hover:text-sky-300 font-semibold transition-colors"
          >
            Telegram Channel
          </a>
        </nav>
      </footer>

      {/* Navigation Dock */}
      <Dock />

      {/* Movable Floating Live TV Icon & Live Sports Broadcast Arena */}
      <LiveTvArena />

      {/* Video Player Modal */}
      {activeModalItem && <VideoPlayerModal />}

      {/* Settings Modal */}
      <SettingsModal />

      {/* Toast Notifications */}
      <Toast />

      {/* Browser Resume Banner */}
      <ResumeBanner />

      {/* Non-intrusive Ad-Blocker Support Banner */}
      <AdBlockerBanner />
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
