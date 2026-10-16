import React from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../context/AppContext';

export const Header: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    openSettings,
    searchQuery,
    setSearchQuery,
  } = useApp();

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    if (activeTab !== 'search' && val.trim().length > 0) {
      setActiveTab('search');
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-16 md:h-18 px-4 md:px-8 flex items-center justify-between bg-gradient-to-b from-[#0b0f19]/95 via-[#0b0f19]/80 to-transparent backdrop-blur-md border-b border-white/[0.04] transition-all">
      {/* Brand Logo */}
      <div
        onClick={() => setActiveTab('home')}
        className="flex items-center gap-2 cursor-pointer select-none group"
      >
        <svg
          className="w-6 h-6 md:w-7 md:h-7 transition-transform group-hover:scale-105 group-active:scale-95"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M4,2 L8,2 L16,14 L16,2 L20,2 L20,22 L16,22 L8,10 L8,22 L4,22 Z" fill="#E50914" />
        </svg>
        <span className="font-display text-2xl md:text-3xl tracking-wider text-slate-100 uppercase">
          Notflix<span className="text-[#E50914]">.</span>
        </span>
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
      <div className="flex items-center gap-2.5 shrink-0">
        <div
          title="Safe Filter Shield Locked On"
          className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] px-2.5 py-1 rounded-full font-extrabold flex items-center gap-1.5 uppercase tracking-wider select-none"
        >
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span className="hidden sm:inline">SafeFilter</span>
        </div>

        <button
          onClick={openSettings}
          title="Notflix Settings"
          aria-label="Settings"
          className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-600 p-[1.5px] cursor-pointer hover:scale-105 active:scale-95 transition-all shadow-lg shadow-blue-900/30 flex items-center justify-center"
        >
          <div className="w-full h-full rounded-full bg-[#131a2a]/40 backdrop-blur-xs flex items-center justify-center text-white">
            <SlidersHorizontal className="w-4 h-4" />
          </div>
        </button>
      </div>
    </header>
  );
};
