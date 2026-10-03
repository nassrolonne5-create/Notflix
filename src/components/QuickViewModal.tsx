import React from 'react';
import { X, Play, Heart, Bookmark, Star } from 'lucide-react';
import { useApp } from '../context/AppContext';

export const QuickViewModal: React.FC = () => {
  const { quickViewItem, closeQuickView, openPlayer, toggleWatchlist, toggleFavorite, userData } = useApp();

  if (!quickViewItem) return null;

  const isSaved = userData.watchlist.some((x) => x.id === quickViewItem.id);
  const isFav = userData.favorites.some((x) => x.id === quickViewItem.id);

  return (
    <div
      onClick={closeQuickView}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-[#131a2a] border border-white/15 rounded-3xl overflow-hidden shadow-2xl flex flex-col transform transition-transform"
      >
        {/* Backdrop Banner */}
        <div className="relative aspect-video w-full bg-black">
          <img
            src={quickViewItem.backdrop || quickViewItem.poster}
            alt={quickViewItem.title || quickViewItem.name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#131a2a] via-transparent to-transparent" />
          <button
            onClick={closeQuickView}
            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-all cursor-pointer backdrop-blur-xs"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 flex flex-col gap-3">
          <div>
            <h3 className="font-display text-2xl text-white uppercase tracking-wider line-clamp-1">
              {quickViewItem.title || quickViewItem.name}
            </h3>
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300 mt-1">
              <span className="flex items-center gap-1 text-amber-400">
                <Star className="w-3.5 h-3.5 fill-amber-400" />
                {quickViewItem.vote_average ? quickViewItem.vote_average.toFixed(1) : '8.0'}
              </span>
              <span>·</span>
              <span>{quickViewItem.year}</span>
              <span>·</span>
              <span className="capitalize">{quickViewItem.type === 'tv' ? 'Series' : 'Movie'}</span>
            </div>
          </div>

          <p className="text-xs text-slate-300 line-clamp-4 leading-relaxed">
            {quickViewItem.overview || 'No synopsis provided for this title.'}
          </p>

          {/* Action Row */}
          <div className="flex items-center gap-2.5 mt-2">
            <button
              onClick={() => {
                closeQuickView();
                openPlayer(quickViewItem);
              }}
              className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-[#FF0055] to-[#FF8800] hover:brightness-110 active:scale-95 text-white font-extrabold text-xs uppercase tracking-wider py-3 rounded-full transition-all cursor-pointer shadow-md"
            >
              <Play className="w-3.5 h-3.5 fill-white" />
              <span>Play Now</span>
            </button>

            <button
              onClick={() => toggleWatchlist(quickViewItem)}
              title="Watchlist"
              className={`w-10 h-10 rounded-full flex items-center justify-center border transition-all cursor-pointer ${
                isSaved ? 'bg-rose-600 text-white border-rose-500' : 'bg-white/10 hover:bg-white/20 text-white border-white/20'
              }`}
            >
              <Bookmark className={`w-4 h-4 ${isSaved ? 'fill-white' : ''}`} />
            </button>

            <button
              onClick={() => toggleFavorite(quickViewItem)}
              title="Favorite"
              className={`w-10 h-10 rounded-full flex items-center justify-center border transition-all cursor-pointer ${
                isFav ? 'bg-rose-600 text-white border-rose-500' : 'bg-white/10 hover:bg-white/20 text-white border-white/20'
              }`}
            >
              <Heart className={`w-4 h-4 ${isFav ? 'fill-white' : ''}`} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
