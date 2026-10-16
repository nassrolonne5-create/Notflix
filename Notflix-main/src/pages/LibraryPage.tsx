import React, { useState } from 'react';
import { Bookmark, Heart, Clock, Trash2, Film } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { MediaCard } from '../components/MediaCard';

export const LibraryPage: React.FC = () => {
  const { userData, removeHistory, openPlayer } = useApp();
  const [activeTab, setActiveTab] = useState<'watchlist' | 'favorites' | 'history'>('watchlist');

  const watchlist = userData.watchlist || [];
  const favorites = userData.favorites || [];
  const history = userData.history || [];

  return (
    <div className="w-full px-4 md:px-8 max-w-7xl mx-auto pt-4 pb-24 flex flex-col gap-6">
      {/* Hero Header */}
      <div className="border-b border-white/5 pb-6">
        <h1 className="font-display text-3xl md:text-5xl text-white uppercase tracking-wider">My Library</h1>
        <p className="text-xs md:text-sm text-slate-400 mt-1">
          Synced with backend. Track your saved watchlist, favorited titles, and watch history.
        </p>

        {/* Tab Buttons */}
        <div className="flex items-center gap-2 mt-5 overflow-x-auto pb-2 no-scrollbar">
          <button
            onClick={() => setActiveTab('watchlist')}
            className={`flex items-center gap-2 px-3.5 py-1.5 md:px-4 md:py-2 rounded-full text-xs font-bold shrink-0 transition-all cursor-pointer ${
              activeTab === 'watchlist'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-900/30'
                : 'bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5" />
            <span>Watchlist</span>
            <span className="bg-white/20 text-white text-[10px] px-1.5 py-0.2 rounded-full font-mono">
              {watchlist.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('favorites')}
            className={`flex items-center gap-2 px-3.5 py-1.5 md:px-4 md:py-2 rounded-full text-xs font-bold shrink-0 transition-all cursor-pointer ${
              activeTab === 'favorites'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-900/30'
                : 'bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white'
            }`}
          >
            <Heart className="w-3.5 h-3.5" />
            <span>Favorites</span>
            <span className="bg-white/20 text-white text-[10px] px-1.5 py-0.2 rounded-full font-mono">
              {favorites.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-2 px-3.5 py-1.5 md:px-4 md:py-2 rounded-full text-xs font-bold shrink-0 transition-all cursor-pointer ${
              activeTab === 'history'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-900/30'
                : 'bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>History</span>
            <span className="bg-white/20 text-white text-[10px] px-1.5 py-0.2 rounded-full font-mono">
              {history.length}
            </span>
          </button>
        </div>
      </div>

      {/* Watchlist Tab */}
      {activeTab === 'watchlist' && (
        <div>
          {watchlist.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-3">
                <Bookmark className="w-8 h-8" />
              </div>
              <h3 className="font-display text-2xl text-white uppercase tracking-wider">Watchlist is empty</h3>
              <p className="text-xs text-slate-400 max-w-xs mt-1">
                Keep track of movies and TV shows you plan to watch by adding them to your watchlist.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 md:gap-4">
              {watchlist.map((item) => (
                <MediaCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Favorites Tab */}
      {activeTab === 'favorites' && (
        <div>
          {favorites.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 mb-3">
                <Heart className="w-8 h-8" />
              </div>
              <h3 className="font-display text-2xl text-white uppercase tracking-wider">No favorites yet</h3>
              <p className="text-xs text-slate-400 max-w-xs mt-1">
                Heart your favorite stories, movies, and animations to keep them quick to access.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 md:gap-4">
              {favorites.map((item) => (
                <MediaCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <div>
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-3">
                <Clock className="w-8 h-8" />
              </div>
              <h3 className="font-display text-2xl text-white uppercase tracking-wider">No watch history</h3>
              <p className="text-xs text-slate-400 max-w-xs mt-1">
                Titles you play will automatically appear here so you can easily resume watching.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 md:gap-4">
              {history.map((item) => (
                <div key={item.id} className="relative group/hist">
                  <MediaCard item={item} />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeHistory(item.id);
                    }}
                    title="Remove from history"
                    className="absolute top-2 left-2 z-30 w-7 h-7 rounded-full bg-black/70 hover:bg-rose-600 text-white flex items-center justify-center transition-all cursor-pointer shadow border border-white/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
