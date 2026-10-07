import React from 'react';
import { Play, Heart } from 'lucide-react';
import { MediaItem } from '../types';
import { useApp } from '../context/AppContext';
import { GENRE_ID_TO_NAME } from '../data/genres';
import { isSafe } from '../services/api';

interface MediaCardProps {
  item: MediaItem;
}

export const MediaCard: React.FC<MediaCardProps> = ({ item }) => {
  if (!isSafe(item)) return null;

  const { openPlayer, toggleFavorite, userData } = useApp();

  const isFav = userData.favorites.some((x) => x.id === item.id);
  const vote = item.vote_average || 0;
  const percent = vote > 0 ? Math.round(vote * 10) : 0;
  const ratingText = vote > 0 ? vote.toFixed(1) : '—';
  const yearText = item.year || '';
  const typeText = item.type === 'tv' ? 'Series' : 'Movie';

  // Primary Genre name
  const firstGenreId = item.genre_ids?.[0];
  const genreLabel = firstGenreId ? GENRE_ID_TO_NAME[firstGenreId] : undefined;

  // Rate badge color
  let rateBg = 'bg-emerald-500';
  if (percent > 0 && percent < 50) rateBg = 'bg-rose-500';
  else if (percent >= 50 && percent < 70) rateBg = 'bg-amber-500';

  // Playback Progress
  const trackKey = `${item.type}-${item.id}`;
  const pobj = userData.playbackPosition[trackKey];
  let progressPct = 0;
  let progressLabel = '';

  if (pobj) {
    let ct = 0;
    let dur = 0;
    if (item.type === 'tv') {
      const s = pobj.s || 1;
      const e = pobj.e || 1;
      ct = pobj[`time_${s}_${e}`] || 0;
      dur = pobj[`duration_${s}_${e}`] || 0;
      if (dur > 0) {
        progressPct = Math.min((ct / dur) * 100, 100);
        const rem = Math.max(0, dur - ct);
        const mins = Math.floor(rem / 60);
        progressLabel = `S${s}:E${e} · ${mins}m left`;
      }
    } else {
      ct = pobj.time || 0;
      dur = pobj.duration || 0;
      if (dur > 0) {
        progressPct = Math.min((ct / dur) * 100, 100);
        const rem = Math.max(0, dur - ct);
        const mins = Math.floor(rem / 60);
        progressLabel = `${mins}m left`;
      }
    }
  }

  const handleClick = () => {
    openPlayer(item);
  };

  return (
    <div
      onClick={handleClick}
      className="group flex flex-col w-full cursor-pointer select-none"
    >
      {/* Poster Image Container */}
      <div className="relative aspect-[2/3] w-full rounded-2xl overflow-hidden bg-[#10141f] border border-white/[0.08] group-hover:border-white/20 shadow-md group-hover:shadow-2xl transition-all duration-300 transform group-hover:scale-[1.02]">
        <img
          src={item.poster}
          alt={item.title || item.name || 'Poster'}
          loading="lazy"
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          onError={(e) => {
            (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${item.id}alt/342/513`;
          }}
        />

        {/* Favorite Heart Button (Top-Right) */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(item);
          }}
          title={isFav ? 'Remove from favorites' : 'Add to favorites'}
          className={`absolute top-2 right-2 z-20 w-7 h-7 rounded-full flex items-center justify-center backdrop-blur-md transition-all active:scale-90 ${
            isFav
              ? 'bg-black/60 text-red-500 shadow-md'
              : 'bg-black/45 text-white/80 hover:text-white hover:bg-black/65'
          }`}
        >
          <Heart className={`w-3.5 h-3.5 ${isFav ? 'fill-red-500 text-red-500' : 'text-white'}`} />
        </button>

        {/* Hover Subtle Play Indicator */}
        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center z-10 pointer-events-none">
          <div className="w-10 h-10 rounded-full bg-red-600/90 flex items-center justify-center text-white shadow-lg transform scale-75 group-hover:scale-100 transition-transform duration-200">
            <Play className="w-4 h-4 fill-white ml-0.5" />
          </div>
        </div>

        {/* Progress Bar (if watched) */}
        {progressPct > 0 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/60 z-10">
            <div
              className="h-full bg-red-600 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>

      {/* Metadata Details Below Poster (Matches Screenshots) */}
      <div className="mt-1.5 px-0.5">
        <h3 className="font-bold text-xs sm:text-sm text-white truncate group-hover:text-red-400 transition-colors">
          {item.title || item.name}
        </h3>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5 truncate">
          <span className="text-amber-400 font-bold flex items-center gap-0.5">
            ★ {ratingText}
          </span>
          <span className="text-slate-500 text-[10px]">·</span>
          <span className="text-slate-400 truncate text-[11px]">
            {genreLabel || (item.type === 'tv' ? 'Series' : 'Movie')}
          </span>
        </div>
      </div>
    </div>
  );
};
