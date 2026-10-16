import React, { useEffect, useState } from 'react';
import { Film, Tv, List } from 'lucide-react';
import { fetchHomeContent } from '../services/api';
import { MediaItem } from '../types';
import { HeroSlider } from '../components/HeroSlider';
import { MediaCard } from '../components/MediaCard';

export const HomePage: React.FC = () => {
  const [heroItems, setHeroItems] = useState<MediaItem[]>([]);
  const [trendingTodayMovies, setTrendingTodayMovies] = useState<MediaItem[]>([]);
  const [trendingTodayTv, setTrendingTodayTv] = useState<MediaItem[]>([]);
  const [hboShows, setHboShows] = useState<MediaItem[]>([]);
  const [disneyShows, setDisneyShows] = useState<MediaItem[]>([]);
  const [marvelMovies, setMarvelMovies] = useState<MediaItem[]>([]);
  const [appleShows, setAppleShows] = useState<MediaItem[]>([]);
  const [amazonShows, setAmazonShows] = useState<MediaItem[]>([]);
  const [topRated, setTopRated] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Section Toggle for Trending Today
  const [todayTab, setTodayTab] = useState<'movies' | 'tv'>('movies');

  useEffect(() => {
    let isMounted = true;
    fetchHomeContent()
      .then((data: any) => {
        if (!isMounted) return;
        setHeroItems(data.heroItems);
        setTrendingTodayMovies(data.trendingTodayMovies);
        setTrendingTodayTv(data.trendingTodayTv);
        setHboShows(data.hbo || []);
        setDisneyShows(data.disney || []);
        setMarvelMovies(data.marvel || []);
        setAppleShows(data.apple || []);
        setAmazonShows(data.amazon || []);
        setTopRated(data.topRated);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load home content:', err);
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <div className="w-full pb-24">
      {/* Big Hero Banner (Matches Screenshot 1) */}
      <HeroSlider items={heroItems} />

      <div className="px-4 md:px-8 max-w-7xl mx-auto flex flex-col gap-8">
        {/* Section: Trending Today (Matches Screenshot 1) */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
              Trending Today
            </h2>
            <span className="bg-red-600 text-white font-extrabold text-[10px] px-2.5 py-0.5 rounded-full uppercase tracking-wider">
              LIVE
            </span>
          </div>

          {/* Toggle Movies / TV Shows */}
          <div className="flex items-center gap-2 mb-3.5">
            <div className="p-1 text-slate-400">
              <List className="w-4 h-4" />
            </div>

            <button
              onClick={() => setTodayTab('movies')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
                todayTab === 'movies'
                  ? 'bg-gradient-to-r from-rose-500 to-pink-600 text-white shadow-md shadow-rose-900/30'
                  : 'bg-slate-800/80 hover:bg-slate-700/80 text-slate-300'
              }`}
            >
              <Film className="w-3.5 h-3.5" />
              <span>Movies</span>
            </button>

            <button
              onClick={() => setTodayTab('tv')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
                todayTab === 'tv'
                  ? 'bg-gradient-to-r from-rose-500 to-pink-600 text-white shadow-md shadow-rose-900/30'
                  : 'bg-slate-800/80 hover:bg-slate-700/80 text-slate-300'
              }`}
            >
              <Tv className="w-3.5 h-3.5" />
              <span>TV Shows</span>
            </button>
          </div>

          {/* Cards Row (Fits 3 cards nicely on mobile) */}
          {loading ? (
            <div className="flex gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="w-28 sm:w-36 md:w-44 shrink-0 aspect-[2/3] rounded-2xl skeleton-shimmer" />
              ))}
            </div>
          ) : (
            <div className="flex gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none scroll-smooth">
              {(todayTab === 'movies' ? trendingTodayMovies : trendingTodayTv).map((item) => (
                <div key={item.id} className="w-28 sm:w-36 md:w-44 shrink-0">
                  <MediaCard item={item} />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Section: On HBO (Matches Screenshot 2) */}
        {hboShows.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-500 shrink-0" />
              <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                On HBO
              </h2>
            </div>
            <div className="flex gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none scroll-smooth">
              {hboShows.map((item) => (
                <div key={item.id} className="w-28 sm:w-36 md:w-44 shrink-0">
                  <MediaCard item={item} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Section: Disney+ (Matches Screenshot 2 & 3) */}
        {disneyShows.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0" />
              <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                Disney+
              </h2>
            </div>
            <div className="flex gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none scroll-smooth">
              {disneyShows.map((item) => (
                <div key={item.id} className="w-28 sm:w-36 md:w-44 shrink-0">
                  <MediaCard item={item} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Section: Marvel Studios (Matches Screenshot 3 & 4) */}
        {marvelMovies.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2.5 h-2.5 rounded-full bg-red-600 shrink-0" />
              <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                Marvel Studios
              </h2>
            </div>
            <div className="flex gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none scroll-smooth">
              {marvelMovies.map((item) => (
                <div key={item.id} className="w-28 sm:w-36 md:w-44 shrink-0">
                  <MediaCard item={item} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Section: Apple TV+ (Matches Screenshot 4) */}
        {appleShows.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300 shrink-0" />
              <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                Apple TV+
              </h2>
            </div>
            <div className="flex gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none scroll-smooth">
              {appleShows.map((item) => (
                <div key={item.id} className="w-28 sm:w-36 md:w-44 shrink-0">
                  <MediaCard item={item} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Section: Amazon Prime (Matches Screenshot 5) */}
        {amazonShows.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-500 shrink-0" />
              <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                Amazon Prime
              </h2>
            </div>
            <div className="flex gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none scroll-smooth">
              {amazonShows.map((item) => (
                <div key={item.id} className="w-28 sm:w-36 md:w-44 shrink-0">
                  <MediaCard item={item} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Section: Top Rated (Matches Screenshot 5) */}
        {topRated.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                Top Rated
              </h2>
            </div>
            <div className="flex gap-2.5 sm:gap-3 overflow-x-auto pb-2 scrollbar-none scroll-smooth">
              {topRated.map((item) => (
                <div key={item.id} className="w-28 sm:w-36 md:w-44 shrink-0">
                  <MediaCard item={item} />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
