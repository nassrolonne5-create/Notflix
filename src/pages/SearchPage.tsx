import React, { useEffect, useState } from 'react';
import { Search, X, Sparkles, Film, Tv, LayoutGrid, Calendar, ShieldCheck } from 'lucide-react';
import { searchMedia, tmdbFetch, formatMediaItem, isSafe } from '../services/api';
import { MediaItem } from '../types';
import { MediaCard } from '../components/MediaCard';
import { useApp } from '../context/AppContext';

export const SearchPage: React.FC = () => {
  const { searchQuery, setSearchQuery } = useApp();
  const [typeFilter, setTypeFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [decadeFilter, setDecadeFilter] = useState<string>('all');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [recommendations, setRecommendations] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // Prohibited safety words check
  const isSafetyFilteredQuery = () => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return false;
    const prohibitedWords = ['erotic', 'porn', 'xxx', 'erotica', 'fifty shades', 'hentai', 'brazzers', 'bangbros', 'playboy', 'kama sutra', '365 days', '365 dni', 'softcore porn', 'hardcore porn'];
    return prohibitedWords.some((word) => q.includes(word));
  };

  // Load default featured recommendations if query is blank
  useEffect(() => {
    let isMounted = true;
    tmdbFetch('/trending/all/week')
      .then((data) => {
        if (!isMounted) return;
        const list = (data.results || [])
          .filter(isSafe)
          .slice(0, 18)
          .map((i: any) => formatMediaItem(i, i.media_type || 'movie'));
        setRecommendations(list);
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  // Run search when query or filters change (debounced)
  useEffect(() => {
    if (!searchQuery.trim()) {
      setResults([]);
      return;
    }

    setLoading(true);
    const timer = setTimeout(() => {
      searchMedia(searchQuery, typeFilter, decadeFilter)
        .then((items) => {
          setResults(items);
          setLoading(false);
        })
        .catch(() => {
          setResults([]);
          setLoading(false);
        });
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery, typeFilter, decadeFilter]);

  const isQueryActive = searchQuery.trim().length > 0;
  const isBlocked = isSafetyFilteredQuery();
  const displayList = isQueryActive ? results : recommendations;

  return (
    <div className="w-full px-4 md:px-8 max-w-7xl mx-auto pt-2 md:pt-4 pb-28 flex flex-col gap-6">
      {/* Search Header Hero */}
      <div className="flex flex-col items-center text-center max-w-2xl mx-auto w-full pt-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[11px] font-bold tracking-wider uppercase mb-3">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Search & Explore</span>
        </div>

        <h1 className="font-display text-4xl sm:text-5xl text-white uppercase tracking-wider text-glow">
          Search Notflix
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-md">
          Instantly discover movies, television series, anime, directors and titles
        </p>

        {/* Sleek Glowing Search Input */}
        <div className="relative flex items-center w-full mt-6 bg-[#131a2a]/80 backdrop-blur-xl border border-white/15 hover:border-white/25 focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-500/20 rounded-full px-5 py-3.5 shadow-2xl transition-all group">
          <Search className="w-5 h-5 text-slate-400 group-focus-within:text-blue-400 mr-3 shrink-0 transition-colors" />
          <input
            type="text"
            placeholder="Type a movie, TV show, anime, or person..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
            className="w-full bg-transparent text-sm sm:text-base text-white placeholder:text-slate-400 focus:outline-none"
          />

          {/* Loading spinner */}
          {loading && (
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0 ml-2" />
          )}

          {/* Clear button */}
          {searchQuery && !loading && (
            <button
              onClick={() => setSearchQuery('')}
              title="Clear search"
              className="text-slate-400 hover:text-white bg-white/10 hover:bg-white/20 rounded-full w-5 h-5 flex items-center justify-center text-xs shrink-0 ml-2 cursor-pointer transition-all active:scale-95"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Interactive Filter Pills */}
        <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
          <div className="flex items-center gap-1.5 p-1 bg-white/5 rounded-full border border-white/10">
            <button
              onClick={() => setTypeFilter('all')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold transition-all cursor-pointer ${
                typeFilter === 'all'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-900/40'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <LayoutGrid className="w-3 h-3" />
              <span>All</span>
            </button>

            <button
              onClick={() => setTypeFilter('movie')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold transition-all cursor-pointer ${
                typeFilter === 'movie'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-900/40'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Film className="w-3 h-3" />
              <span>Movies</span>
            </button>

            <button
              onClick={() => setTypeFilter('tv')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold transition-all cursor-pointer ${
                typeFilter === 'tv'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-900/40'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Tv className="w-3 h-3" />
              <span>TV Series</span>
            </button>
          </div>

          {/* Era / Decade Filter */}
          <div className="relative flex items-center">
            <Calendar className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
            <select
              value={decadeFilter}
              onChange={(e) => setDecadeFilter(e.target.value)}
              className="bg-[#131a2a] border border-white/10 text-slate-200 text-xs font-bold rounded-full pl-8 pr-4 py-1.5 outline-none cursor-pointer hover:border-white/20 transition-all"
            >
              <option value="all">Any Release Year</option>
              <option value="2020">2020s</option>
              <option value="2010">2010s</option>
              <option value="2000">2000s</option>
              <option value="1990">1990s</option>
              <option value="1980">1980s or older</option>
            </select>
          </div>
        </div>
      </div>

      {/* Results / Recommendations Section */}
      <section className="mt-2">
        <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-3">
          <div className="flex items-center gap-2">
            {!isQueryActive && <Sparkles className="w-4 h-4 text-blue-400" />}
            <h2 className="font-display text-xl sm:text-2xl text-white tracking-wide uppercase">
              {isQueryActive ? `Matches for "${searchQuery}"` : 'Featured Hits & Recommendations'}
            </h2>
          </div>

          {isQueryActive && !loading && (
            <span className="text-xs font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2.5 py-0.5 rounded-full">
              {results.length} {results.length === 1 ? 'title' : 'titles'}
            </span>
          )}
        </div>

        {/* Loading Skeleton */}
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 md:gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-[2/3] rounded-2xl skeleton-shimmer" />
            ))}
          </div>
        ) : isBlocked ? (
          /* SafeFilter Notice Card */
          <div className="py-16 px-4 flex flex-col items-center justify-center text-center max-w-md mx-auto">
            <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4 shadow-xl shadow-emerald-950/40">
              <ShieldCheck className="w-7 h-7" />
            </div>
            <h3 className="font-display text-2xl text-white uppercase tracking-wider">Safety Filter Active</h3>
            <p className="text-xs text-slate-300 mt-2 leading-relaxed">
              No matching entries found. Explicit and adult-restricted content is filtered by SafeFilter. Mainstream action movies, series, and anime remain fully accessible.
            </p>
            <button
              onClick={() => setSearchQuery('')}
              className="mt-5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-5 py-2.5 rounded-xl transition-all cursor-pointer shadow-lg active:scale-95"
            >
              Clear Search
            </button>
          </div>
        ) : displayList.length === 0 ? (
          /* Empty Search Results */
          <div className="py-16 px-4 flex flex-col items-center justify-center text-center max-w-sm mx-auto">
            <div className="w-12 h-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 mb-3">
              <Search className="w-6 h-6" />
            </div>
            <h3 className="font-display text-2xl text-white uppercase tracking-wider">No matching results</h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              We couldn't find any results for "{searchQuery}". Try checking for spelling errors or search for another movie, show, or actor.
            </p>
            <button
              onClick={() => setSearchQuery('')}
              className="mt-4 bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2 rounded-xl transition-all cursor-pointer"
            >
              Clear Search
            </button>
          </div>
        ) : (
          /* Active Cards Grid */
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 md:gap-4">
            {displayList.map((item) => (
              <MediaCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
