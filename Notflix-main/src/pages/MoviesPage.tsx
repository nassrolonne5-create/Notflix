import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { CLEAN_MOVIE_GENRES } from '../data/genres';
import { fetchMoviesCatalog } from '../services/api';
import { MediaItem } from '../types';
import { MediaCard } from '../components/MediaCard';

export const MoviesPage: React.FC = () => {
  const [selectedGenre, setSelectedGenre] = useState<number>(0);
  const [sortBy, setSortBy] = useState<string>('popularity.desc');
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [trending, setTrending] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    fetchMoviesCatalog(selectedGenre, sortBy, page)
      .then((data) => {
        if (!isMounted) return;
        setItems(data.items);
        setTotalPages(data.totalPages);
        if (data.trending.length > 0) setTrending(data.trending);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load movies:', err);
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedGenre, sortBy, page]);

  const handleGenreChange = (id: number) => {
    setSelectedGenre(id);
    setPage(1);
  };

  const handleSortChange = (val: string) => {
    setSortBy(val);
    setPage(1);
  };

  return (
    <div className="w-full px-4 md:px-8 max-w-7xl mx-auto pt-4 pb-24 flex flex-col gap-6">
      {/* Page Title (Matches Screenshots 6 & 7) */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
          Trending Movies
        </h1>
      </div>

      {/* Filter Row: Genre Pills & Sort Dropdown */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-b border-white/5 pb-3">
        {/* Genre Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none flex-1">
          {CLEAN_MOVIE_GENRES.map((g) => {
            const isSelected = selectedGenre === g.id;
            return (
              <button
                key={g.id}
                onClick={() => handleGenreChange(g.id)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-rose-500/15 border border-rose-500 text-white shadow-sm'
                    : 'bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 border border-transparent'
                }`}
              >
                {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />}
                <span>{g.name}</span>
              </button>
            );
          })}
        </div>

        {/* Sort Select */}
        <div className="shrink-0 self-end sm:self-center">
          <select
            value={sortBy}
            onChange={(e) => handleSortChange(e.target.value)}
            className="bg-[#131a2a] border border-white/10 text-slate-200 text-xs font-semibold rounded-xl px-3 py-1.5 outline-none cursor-pointer"
          >
            <option value="popularity.desc">🔥 Most Popular</option>
            <option value="vote_average.desc">⭐ Highest Rated</option>
            <option value="primary_release_date.desc">🗓️ Newest Released</option>
          </select>
        </div>
      </div>

      {/* Main Catalog Grid: 3 columns on mobile matching screenshots */}
      <section>
        {loading ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2.5 sm:gap-3 md:gap-4">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="aspect-[2/3] rounded-2xl skeleton-shimmer" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2.5 sm:gap-3 md:gap-4">
            {items.map((item) => (
              <MediaCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
          <button
            disabled={page <= 1}
            onClick={() => {
              setPage((p) => Math.max(1, p - 1));
              window.scrollTo({ top: 300, behavior: 'smooth' });
            }}
            className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:pointer-events-none text-white flex items-center justify-center transition-all cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* First page button */}
          <button
            onClick={() => {
              setPage(1);
              window.scrollTo({ top: 300, behavior: 'smooth' });
            }}
            className={`w-9 h-9 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              page === 1 ? 'bg-blue-600 text-white shadow-md' : 'bg-white/5 hover:bg-white/10 text-slate-300'
            }`}
          >
            1
          </button>

          {page > 3 && <span className="text-slate-500 font-bold px-1">...</span>}

          {/* Middle pages */}
          {Array.from({ length: 3 }, (_, idx) => page - 1 + idx)
            .filter((p) => p > 1 && p < totalPages)
            .map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPage(p);
                  window.scrollTo({ top: 300, behavior: 'smooth' });
                }}
                className={`w-9 h-9 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  page === p ? 'bg-blue-600 text-white shadow-md' : 'bg-white/5 hover:bg-white/10 text-slate-300'
                }`}
              >
                {p}
              </button>
            ))}

          {page < totalPages - 2 && <span className="text-slate-500 font-bold px-1">...</span>}

          {/* Last page button */}
          {totalPages > 1 && (
            <button
              onClick={() => {
                setPage(totalPages);
                window.scrollTo({ top: 300, behavior: 'smooth' });
              }}
              className={`w-9 h-9 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                page === totalPages
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'bg-white/5 hover:bg-white/10 text-slate-300'
              }`}
            >
              {totalPages}
            </button>
          )}

          <button
            disabled={page >= totalPages}
            onClick={() => {
              setPage((p) => Math.min(totalPages, p + 1));
              window.scrollTo({ top: 300, behavior: 'smooth' });
            }}
            className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:pointer-events-none text-white flex items-center justify-center transition-all cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};
