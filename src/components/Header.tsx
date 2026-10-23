import React, { useState, useEffect } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../context/AppContext';

const TELEGRAM_CHANNEL_URL = 'https://t.me/Notflix_tv';

export const Header: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    openSettings,
    searchQuery,
    setSearchQuery,
  } = useApp();

  const [showTelegram, setShowTelegram] = useState<boolean>(false);
  const [isFlipPaused, setIsFlipPaused] = useState<boolean>(false);

  // Flip between Notflix and Join Telegram every 4 seconds (pauses on hover/touch)
  useEffect(() => {
    if (isFlipPaused) return;
    const interval = window.setInterval(() => {
      setShowTelegram((prev) => !prev);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [isFlipPaused]);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    if (activeTab !== 'search' && val.trim().length > 0) {
      setActiveTab('search');
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-16 md:h-18 px-4 md:px-8 flex items-center justify-between bg-gradient-to-b from-[#0b0f19]/95 via-[#0b0f19]/80 to-transparent backdrop-blur-md border-b border-white/[0.04] transition-all">
      {/* Zone 1: Smooth Vertical Slot-Reel Slide + Blur-Morph Brand / Telegram Switcher */}
      <div
        className="relative min-h-[44px] h-11 w-[148px] sm:w-[168px] md:w-[184px] shrink-0 flex items-center overflow-hidden select-none"
        onMouseEnter={() => setIsFlipPaused(true)}
        onMouseLeave={() => setIsFlipPaused(false)}
        onTouchStart={() => setIsFlipPaused(true)}
        onTouchEnd={() => {
          window.setTimeout(() => setIsFlipPaused(false), 1500);
        }}
      >
        {/* State A: NOTFLIX Brand Logo (Slides cleanly in/out vertically with soft motion blur) */}
        <button
          type="button"
          onClick={() => setActiveTab('home')}
          aria-hidden={showTelegram}
          tabIndex={showTelegram ? -1 : 0}
          title="Notflix Home"
          className={`absolute inset-0 flex items-center gap-2 cursor-pointer group text-left whitespace-nowrap transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
            showTelegram
              ? '-translate-y-6 opacity-0 blur-[3px] scale-95 pointer-events-none'
              : 'translate-y-0 opacity-100 blur-0 scale-100 pointer-events-auto'
          }`}
        >
          <svg
            className={`w-6 h-6 md:w-7 md:h-7 shrink-0 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-105 group-active:scale-95 ${
              showTelegram ? 'scale-75 -rotate-12' : 'scale-100 rotate-0'
            }`}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M4,2 L8,2 L16,14 L16,2 L20,2 L20,22 L16,22 L8,10 L8,22 L4,22 Z" fill="#E50914" />
          </svg>
          <span className="font-display text-2xl md:text-3xl tracking-wider text-slate-100 uppercase leading-none">
            Notflix<span className="text-[#E50914]">.</span>
          </span>
        </button>

        {/* State B: Official Telegram Channel Link (Glides up from below with staggered icon pop) */}
        <a
          href={TELEGRAM_CHANNEL_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-hidden={!showTelegram}
          tabIndex={showTelegram ? 0 : -1}
          title="Join Notflix Official Telegram Channel (@Notflix_tv)"
          className={`absolute inset-0 flex items-center gap-2 cursor-pointer group no-underline whitespace-nowrap transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
            showTelegram
              ? 'translate-y-0 opacity-100 blur-0 scale-100 pointer-events-auto'
              : 'translate-y-6 opacity-0 blur-[3px] scale-95 pointer-events-none'
          }`}
        >
          <div className="relative flex items-center justify-center shrink-0">
            <span className="absolute inset-0 rounded-full bg-[#2AABEE]/30 blur-sm group-hover:bg-[#2AABEE]/50 transition-colors" />
            <svg
              className={`relative w-6 h-6 md:w-7 md:h-7 shrink-0 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-105 group-active:scale-95 ${
                showTelegram ? 'scale-100 rotate-0' : 'scale-75 rotate-12'
              }`}
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="12" cy="12" r="11" fill="#2AABEE" />
              <path
                d="M16.95 7.45L15.12 16.52C14.98 17.16 14.59 17.31 14.06 17.01L11.12 14.84L9.7 16.21C9.54 16.37 9.41 16.5 9.1 16.5L9.31 13.51L14.76 8.59C15 8.38 14.71 8.26 14.39 8.47L7.66 12.71L4.76 11.8C4.13 11.6 4.12 11.17 4.89 10.87L16.22 6.5C16.75 6.31 17.21 6.62 16.95 7.45Z"
                fill="#FFFFFF"
              />
            </svg>
          </div>
          <span className="font-display text-xl sm:text-2xl md:text-[26px] tracking-wider text-[#2AABEE] group-hover:text-sky-300 uppercase leading-none transition-colors">
            Join Telegram
          </span>
        </a>
      </div>

      {/* Global Quick Search - Hidden when on Search page to avoid duplicate search bars */}
      {activeTab !== 'search' ? (
        <div className="flex-1 max-w-xs sm:max-w-sm md:max-w-md mx-2 sm:mx-4 md:mx-8">
          <div
            onClick={() => setActiveTab('search')}
            className="relative flex items-center bg-white/[0.06] hover:bg-white/[0.09] focus-within:bg-white/[0.12] border border-white/10 hover:border-blue-500/50 focus-within:border-blue-500 rounded-full px-3 py-1.5 transition-all shadow-inner cursor-pointer"
          >
            <Search className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 mr-2 shrink-0" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => {
                setActiveTab('search');
              }}
              className="w-full bg-transparent text-xs sm:text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none cursor-pointer"
            />
            {searchQuery && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setSearchQuery('');
                }}
                className="text-xs text-slate-400 hover:text-white bg-white/10 rounded-full w-4 h-4 flex items-center justify-center shrink-0 ml-1"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* Right Controls: SafeFilter & Settings */}
      <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
        <div
          title="Safe Filter Shield Locked On"
          className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] px-2.5 py-1.5 sm:py-1 rounded-full font-extrabold flex items-center gap-1.5 uppercase tracking-wider select-none"
        >
          <svg className="w-3 h-3 sm:w-2.5 sm:h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span className="hidden sm:inline">SafeFilter</span>
        </div>

        <button
          onClick={openSettings}
          title="Notflix Settings"
          aria-label="Settings"
          className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-600 p-[1.5px] cursor-pointer hover:scale-105 active:scale-95 transition-all shadow-lg shadow-blue-900/30 flex items-center justify-center shrink-0"
        >
          <div className="w-full h-full rounded-full bg-[#131a2a]/40 backdrop-blur-xs flex items-center justify-center text-white">
            <SlidersHorizontal className="w-4 h-4" />
          </div>
        </button>
      </div>
    </header>
  );
};
