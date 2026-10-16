import React, { useState, useEffect } from 'react';
import { Play, Bookmark, Star } from 'lucide-react';
import { MediaItem } from '../types';
import { useApp } from '../context/AppContext';

interface HeroSliderProps {
  items: MediaItem[];
}

export const HeroSlider: React.FC<HeroSliderProps> = ({ items }) => {
  const { openPlayer, toggleWatchlist, userData } = useApp();
  const [currentIdx, setCurrentIdx] = useState(0);

  useEffect(() => {
    if (!items.length) return;
    const timer = setInterval(() => {
      setCurrentIdx((prev) => (prev + 1) % items.length);
    }, 6500);
    return () => clearInterval(timer);
  }, [items.length]);

  if (!items || items.length === 0) return null;
  const current = items[currentIdx];
  const isSaved = userData.watchlist.some((x) => x.id === current.id);

  return (
    <div className="relative w-full h-[32vh] sm:h-[36vh] md:h-[40vh] min-h-[220px] max-h-[320px] overflow-hidden -mt-16 md:-mt-18 mb-3 select-none">
      {/* Background Slides */}
      {items.map((item, idx) => (
        <div
          key={item.id}
          className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${
            idx === currentIdx ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none z-0'
          }`}
        >
          <img
            src={item.backdrop || item.poster}
            alt={item.title || item.name}
            className="w-full h-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#090d16] via-[#090d16]/60 via-40% to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#090d16]/80 via-transparent to-transparent" />
        </div>
      ))}

      {/* Content at Bottom Left */}
      <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col justify-end p-4 sm:p-6 md:p-8 md:pl-10 max-w-2xl pb-4 sm:pb-5">
        <h1 className="font-bold text-xl sm:text-2xl md:text-3xl text-white tracking-tight leading-tight drop-shadow-lg line-clamp-1">
          {current.title || current.name}
        </h1>

        {/* Watch Now Button */}
        <div className="flex items-center gap-3 mt-1.5">
          <button
            onClick={() => openPlayer(current)}
            className="inline-flex items-center gap-2 group cursor-pointer active:scale-95 transition-transform"
          >
            <div className="w-0 h-0 border-y-[5px] border-y-transparent border-l-[10px] border-l-red-600 group-hover:border-l-red-500 transition-colors" />
            <span className="text-white font-bold text-xs sm:text-sm group-hover:text-red-400 transition-colors tracking-wide">
              Watch Now
            </span>
          </button>

          <button
            onClick={() => toggleWatchlist(current)}
            title={isSaved ? 'In Watchlist' : 'Add to Watchlist'}
            className="text-white/60 hover:text-white p-1 rounded-full transition-colors cursor-pointer"
          >
            <Bookmark className={`w-4 h-4 ${isSaved ? 'fill-red-600 text-red-600' : ''}`} />
          </button>
        </div>
      </div>

      {/* Slide Indicators */}
      <div className="absolute bottom-2.5 right-4 md:right-8 z-20 flex items-center gap-1.5">
        {items.map((_, idx) => (
          <button
            key={idx}
            onClick={() => setCurrentIdx(idx)}
            className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
              idx === currentIdx
                ? 'w-4 bg-red-600'
                : 'w-1.5 bg-white/30 hover:bg-white/50'
            }`}
          />
        ))}
      </div>
    </div>
  );
};
