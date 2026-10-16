import React, { useEffect, useState } from 'react';
import { Home, Film, Tv, Sparkles, Bookmark, Search } from 'lucide-react';
import { useApp, TabType } from '../context/AppContext';

interface NavItem {
  id: TabType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

export const Dock: React.FC = () => {
  const { activeTab, setActiveTab, userData } = useApp();
  const [isVisible, setIsVisible] = useState(true);

  // Auto-hide dock on mobile when input/keyboard is active
  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (window.innerWidth < 768 && target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        setIsVisible(false);
      }
    };

    const handleFocusOut = () => {
      if (window.innerWidth < 768) {
        setIsVisible(true);
      }
    };

    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('focusout', handleFocusOut);

    return () => {
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  // Auto-hide dock on rapid scroll down on mobile, reappear on idle/scroll up
  useEffect(() => {
    let lastY = window.scrollY;
    let timer: number | null = null;

    const handleScroll = () => {
      const currentY = window.scrollY;
      if (currentY > lastY + 15 && currentY > 100) {
        setIsVisible(false);
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => setIsVisible(true), 1500);
      } else if (currentY < lastY - 5) {
        setIsVisible(true);
        if (timer) window.clearTimeout(timer);
      }
      lastY = currentY;
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const totalSaved = (userData.watchlist?.length || 0) + (userData.favorites?.length || 0);

  const items: NavItem[] = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'movies', label: 'Movies', icon: Film },
    { id: 'tv', label: 'Series', icon: Tv },
    { id: 'anime', label: 'Anime', icon: Sparkles },
    { id: 'library', label: 'Library', icon: Bookmark, badge: totalSaved > 0 ? totalSaved : undefined },
    { id: 'search', label: 'Search', icon: Search },
  ];

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 md:top-0 md:bottom-auto md:left-0 md:right-auto md:w-20 md:h-screen pointer-events-none z-40 flex items-end justify-center md:items-center md:justify-center p-3 md:p-4 pb-safe transition-all duration-300 ${
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-24 opacity-0 md:translate-y-0 md:opacity-100'
      }`}
    >
      <nav
        aria-label="Main Navigation"
        className="pointer-events-auto flex md:flex-col items-center justify-between md:justify-center gap-1 md:gap-3 bg-[#0f141e]/90 md:bg-[#131a2a]/95 backdrop-blur-xl border border-white/10 rounded-full md:rounded-3xl p-1.5 md:p-3 shadow-2xl shadow-black/80 w-[94vw] max-w-md md:w-auto"
      >
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                if ('vibrate' in navigator) navigator.vibrate(10);
                setActiveTab(item.id);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className={`relative flex flex-col items-center justify-center flex-1 md:flex-initial py-1 md:py-2.5 px-2.5 md:px-2 rounded-2xl md:rounded-xl text-[10px] md:text-xs font-semibold transition-all group ${
                isActive ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {/* Active Indicator Pip */}
              {isActive && (
                <span className="absolute -top-1 md:top-auto md:-left-1.5 w-1.5 h-1.5 bg-blue-500 rounded-full shadow-[0_0_8px_#3b82f6]" />
              )}

              <div
                className={`w-9 h-7 md:w-10 md:h-9 rounded-xl flex items-center justify-center transition-all ${
                  isActive
                    ? 'bg-blue-500/15 text-blue-400 scale-105'
                    : 'group-hover:bg-white/5 text-inherit'
                }`}
              >
                <Icon className="w-4 h-4 md:w-5 md:h-5" />
              </div>

              <span className="mt-0.5 tracking-tight">{item.label}</span>

              {/* Badge for library */}
              {item.badge !== undefined && (
                <span className="absolute top-0 right-1 md:right-1 bg-rose-600 text-white text-[9px] font-bold px-1.5 py-0.2 rounded-full leading-tight">
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
};
