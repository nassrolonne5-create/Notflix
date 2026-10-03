import { MediaItem, Season, Episode, StreamSource, SubtitleTrack, UserData, CastMember } from '../types';

export const TMDB_IMG = 'https://image.tmdb.org/t/p/';

// Explicit adult, romance, and sexually suggestive content classifications
// Blocks pornography, erotic movies/shows, romance, and suggestive themes WITHOUT blocking violent/bloody action movies
const ADULT_BLOCKLIST = [
  'romance', 'romantic', 'rom-com', 'erotic', 'sexy', 'sensual', 'love story', 'erotica', 'nsfw',
  'porn', 'pornography', 'xxx', 'sensuality', 'softcore', 'hardcore porn', 'adult content',
  'strip club', 'striptease', 'sexuality', 'fifty shades', 'nude', 'nudity', 'lust', 'seduction',
  'intimate', 'intimacy', 'kama sutra', 'playboy', 'penthouse', 'brazzers', 'bangbros',
  'busty', 'milf', 'stepmom', 'stepmommy', 'stepdad', 'stepsister', 'stepbrother', 'incest',
  'taboo sex', 'fetish', 'bdsm', 'bondage', 'gay', 'lesbian', 'homosexual', 'queer', 'lgbt',
  'bisexual', 'transgender', 'orgasm', 'menage a trois', 'threesome', 'infidelity',
  'love triangle', 'passionate affair', '365 days', '365 dni', 'voyeur', 'erotic thriller',
  'passion', 'passionate', 'affair', 'affaire', 'dating'
];

// Regex matching adult/romance terms or sexual terms (excluding violent crime phrases like 'sex trafficking')
const pattern = new RegExp(
  `\\b(${ADULT_BLOCKLIST.join('|')})\\b|\\bsex(?!\\s*(trafficking|crime|worker|trade|slave))\\b`,
  'i'
);

// Adult/Romance/Erotic keywords for TMDB deep metadata check
// Excludes crime/action keywords like "prostitute", "call girl", "sex trafficking", "blood", "gore", "assassin", "gangster"
const ADULT_KEYWORDS = [
  'romance', 'romantic', 'erotic', 'erotica', 'pornography', 'porn', 'softcore', 'hardcore porn',
  'explicit sex', 'unsimulated sex', 'sexual content', 'bdsm', 'erotic thriller',
  'fetish', 'kama sutra', 'masturbation', 'orgasm', 'hentai', 'ecchi', 'nude', 'nudity',
  'penetration', 'seduction', 'menage a trois', 'threesome', 'infidelity', 'love triangle',
  'gay', 'lesbian', 'lgbt', 'gay theme', 'sexuality', 'sensuality', 'lust', 'sexy', 'love story',
  'striptease', 'voyeur', 'intimacy', 'adultery', 'affair', 'erotic drama', 'erotic comedy'
];

const ADULT_KW_PATTERN = new RegExp(`\\b(${ADULT_KEYWORDS.join('|')})\\b`, 'i');

export function isSafe(item: any): boolean {
  if (!item) return false;
  if (item.error) return false;
  if (item.adult === true || item.adult === 'true') return false;

  // Romance genre 10749 filter
  if (item.genre_ids && Array.isArray(item.genre_ids) && item.genre_ids.includes(10749)) return false;
  if (item.genres && Array.isArray(item.genres) && item.genres.some((g: any) => g.id === 10749 || (g.name && g.name.toLowerCase() === 'romance'))) return false;

  const title = (item.title || item.name || '').toLowerCase();
  const desc = (item.overview || item.desc || '').toLowerCase();

  // Allow "The Passion of the Christ"
  if (title.includes('passion of the christ')) return true;

  // Explicitly block Spanish teen sex series "Élite"
  if ((title === 'elite' || title === 'élite') && (item.origin_country?.includes('ES') || item.original_name === 'Élite')) {
    return false;
  }

  // Check title and description
  if (pattern.test(title) || pattern.test(desc)) return false;

  // If keywords are available on item, check them
  let kwds: any[] = [];
  if (item.keywords) {
    kwds = item.keywords.results || item.keywords.keywords || [];
  }
  if (kwds.some((k: any) => ADULT_KW_PATTERN.test(k.name))) return false;

  return true;
}

export async function checkDeepSafety(type: 'movie' | 'tv', id: number): Promise<boolean> {
  try {
    const fullData = await tmdbFetch(`/${type}/${id}`, {
      append_to_response: 'release_dates,content_ratings,keywords',
    });
    if (!fullData || fullData.error || !fullData.id || fullData.adult) return false;

    // Check romance genre
    if (fullData.genres && fullData.genres.some((g: any) => g.id === 10749 || (g.name && g.name.toLowerCase() === 'romance'))) {
      return false;
    }

    if (!isSafe(fullData)) return false;

    let kwds: any[] = [];
    if (fullData.keywords) {
      kwds = fullData.keywords.results || fullData.keywords.keywords || [];
    }

    // Check keywords specifically against genuine adult entertainment/pornographic terms, NOT crime/violence terms
    if (kwds.some((k: any) => ADULT_KW_PATTERN.test(k.name))) {
      return false;
    }

    // Check certifications (specifically NC-17, XXX explicit adult ratings)
    let certs: string[] = [];
    if (type === 'movie' && fullData.release_dates && fullData.release_dates.results) {
      fullData.release_dates.results.forEach((r: any) => {
        if (r.release_dates) r.release_dates.forEach((rd: any) => certs.push(rd.certification));
      });
    } else if (type === 'tv' && fullData.content_ratings && fullData.content_ratings.results) {
      fullData.content_ratings.results.forEach((r: any) => certs.push(r.rating));
    }

    const badCerts = ['NC-17', 'XXX'];
    if (certs.some((c: any) => typeof c === 'string' && badCerts.includes(c.toUpperCase()))) {
      return false;
    }

    return true;
  } catch (e) {
    return false;
  }
}

export function formatMediaItem(raw: any, defaultType: 'movie' | 'tv' = 'movie'): MediaItem {
  const isTv = defaultType === 'tv' || raw.media_type === 'tv' || (!raw.title && Boolean(raw.name));
  const type = isTv ? 'tv' : 'movie';
  const title = raw.title || raw.name || 'Untitled';
  const year = (raw.release_date || raw.first_air_date || raw.year || '').toString().slice(0, 4);
  const voteAmt = raw.vote_average || 0;
  const rating = voteAmt ? voteAmt.toFixed(1) : '—';
  const poster = raw.poster_path
    ? `${TMDB_IMG}w342${raw.poster_path}`
    : raw.poster || `https://picsum.photos/seed/${raw.id || title}/342/513`;
  const backdrop = raw.backdrop_path
    ? `${TMDB_IMG}w1280${raw.backdrop_path}`
    : raw.backdrop || '';

  return {
    id: raw.id,
    title,
    name: raw.name,
    year,
    rating,
    vote_average: raw.vote_average,
    type,
    media_type: raw.media_type || type,
    poster,
    poster_path: raw.poster_path,
    backdrop,
    backdrop_path: raw.backdrop_path,
    overview: raw.overview || raw.desc || '',
    genre_ids: raw.genre_ids || [],
    adult: raw.adult,
  };
}

const TMDB_DIRECT_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const TMDB_DIRECT_BASE = 'https://api.themoviedb.org/3';
export const SCRAPER_PRIMARY = 'https://tmdb-embed-api-hcz6.onrender.com';
export const SCRAPER_CINEPRO = 'https://cinepro-core-991g.onrender.com';

// Fetch from Backend TMDB proxy, with seamless direct client fallback for static hosting (Drag & Drop)
export async function tmdbFetch(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const searchParams = new URLSearchParams(params);
  if (!searchParams.has('include_adult')) searchParams.set('include_adult', 'false');
  if (!searchParams.has('without_genres')) searchParams.set('without_genres', '10749');

  // Try backend proxy first (/api/tmdb/...)
  try {
    const url = `/api/tmdb/${cleanEndpoint}${searchParams.toString() ? '?' + searchParams.toString() : ''}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results)) {
        data.results = data.results.filter(isSafe);
      }
      return data;
    }
  } catch {
    // Backend not available (e.g. static drag & drop), continue to direct TMDB API
  }

  // Direct client-side TMDB fallback (works in pure static drag & drop environments)
  searchParams.set('api_key', TMDB_DIRECT_KEY);
  searchParams.set('language', searchParams.get('language') || 'en-US');
  const directUrl = `${TMDB_DIRECT_BASE}/${cleanEndpoint}?${searchParams.toString()}`;
  const directRes = await fetch(directUrl);
  if (!directRes.ok) {
    throw new Error(`TMDB Error: ${directRes.status} ${directRes.statusText}`);
  }
  const data = await directRes.json();
  if (Array.isArray(data.results)) {
    data.results = data.results.filter(isSafe);
  }
  return data;
}

// Home content aggregator
export async function fetchHomeContent() {
  const [
    trendDayM,
    trendDayT,
    trendWeekM,
    trendWeekT,
    topR,
    hboData,
    disneyData,
    marvelData,
    appleData,
    amazonData,
  ] = await Promise.all([
    tmdbFetch('/trending/movie/day'),
    tmdbFetch('/trending/tv/day'),
    tmdbFetch('/trending/movie/week'),
    tmdbFetch('/trending/tv/week'),
    tmdbFetch('/movie/top_rated'),
    tmdbFetch('/discover/tv', { with_networks: '49', sort_by: 'popularity.desc' }).catch(() => ({ results: [] })),
    tmdbFetch('/discover/tv', { with_networks: '2739', sort_by: 'popularity.desc' }).catch(() => ({ results: [] })),
    tmdbFetch('/discover/movie', { with_companies: '420', sort_by: 'popularity.desc' }).catch(() => ({ results: [] })),
    tmdbFetch('/discover/tv', { with_networks: '2552', sort_by: 'popularity.desc' }).catch(() => ({ results: [] })),
    tmdbFetch('/discover/tv', { with_networks: '1024', sort_by: 'popularity.desc' }).catch(() => ({ results: [] })),
  ]);

  return {
    heroItems: (trendDayM.results || []).filter(isSafe).slice(0, 5).map((i: any) => formatMediaItem(i, 'movie')),
    trendingTodayMovies: (trendDayM.results || []).filter(isSafe).slice(5).map((i: any) => formatMediaItem(i, 'movie')),
    trendingTodayTv: (trendDayT.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'tv')),
    trendingWeekMovies: (trendWeekM.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'movie')),
    trendingWeekTv: (trendWeekT.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'tv')),
    topRated: (topR.results || []).filter(isSafe).slice(0, 18).map((i: any) => formatMediaItem(i, 'movie')),
    hbo: (hboData.results || []).filter(isSafe).slice(0, 15).map((i: any) => formatMediaItem(i, 'tv')),
    disney: (disneyData.results || []).filter(isSafe).slice(0, 15).map((i: any) => formatMediaItem(i, 'tv')),
    marvel: (marvelData.results || []).filter(isSafe).slice(0, 15).map((i: any) => formatMediaItem(i, 'movie')),
    apple: (appleData.results || []).filter(isSafe).slice(0, 15).map((i: any) => formatMediaItem(i, 'tv')),
    amazon: (amazonData.results || []).filter(isSafe).slice(0, 15).map((i: any) => formatMediaItem(i, 'tv')),
  };
}

// Movies Catalog fetcher
export async function fetchMoviesCatalog(genreId: number, sortBy = 'popularity.desc', page = 1) {
  const params: Record<string, string> = {
    sort_by: sortBy,
    page: page.toString(),
  };
  if (genreId !== 0) {
    params.with_genres = genreId.toString();
  }

  const [catalog, trending] = await Promise.all([
    tmdbFetch('/discover/movie', params),
    page === 1 ? tmdbFetch('/trending/movie/day') : Promise.resolve(null),
  ]);

  return {
    items: (catalog.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'movie')),
    totalPages: Math.min(catalog.total_pages || 1, 500),
    trending: trending ? (trending.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'movie')) : [],
  };
}

// TV Series Catalog fetcher
export async function fetchTvCatalog(genreId: number, sortBy = 'popularity.desc', page = 1) {
  const params: Record<string, string> = {
    sort_by: sortBy,
    page: page.toString(),
  };
  if (genreId !== 0) {
    params.with_genres = genreId.toString();
  }

  const [catalog, trending] = await Promise.all([
    tmdbFetch('/discover/tv', params),
    page === 1 ? tmdbFetch('/trending/tv/day') : Promise.resolve(null),
  ]);

  return {
    items: (catalog.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'tv')),
    totalPages: Math.min(catalog.total_pages || 1, 500),
    trending: trending ? (trending.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'tv')) : [],
  };
}

// Anime Catalog fetcher (Japanese animation)
export async function fetchAnimeCatalog(genreId: number, sortBy = 'popularity.desc', page = 1) {
  const params: Record<string, string> = {
    with_genres: genreId !== 0 ? `16,${genreId}` : '16',
    with_original_language: 'ja',
    sort_by: sortBy,
    page: page.toString(),
  };

  const [catalog, trending] = await Promise.all([
    tmdbFetch('/discover/tv', params),
    page === 1 ? tmdbFetch('/discover/tv', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc' }) : Promise.resolve(null),
  ]);

  return {
    items: (catalog.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'tv')),
    totalPages: Math.min(catalog.total_pages || 1, 500),
    trending: trending ? (trending.results || []).filter(isSafe).map((i: any) => formatMediaItem(i, 'tv')) : [],
  };
}

// Search
export async function searchMedia(query: string, typeFilter = 'all', decadeFilter = 'all') {
  if (!query.trim()) return [];

  const normalizedQuery = query.toLowerCase();
  const prohibitedWords = ['erotic', 'porn', 'xxx', 'erotica', 'fifty shades', 'hentai', 'brazzers', 'bangbros', 'playboy', 'kama sutra', '365 days', '365 dni', 'softcore porn', 'hardcore porn'];
  if (prohibitedWords.some((word) => normalizedQuery.includes(word))) {
    return [];
  }

  const [movieRes, tvRes] = await Promise.all([
    tmdbFetch('/search/movie', { query }),
    tmdbFetch('/search/tv', { query }),
  ]);

  const movies = (movieRes.results || []).map((i: any) => formatMediaItem({ ...i, media_type: 'movie' }, 'movie'));
  const tvs = (tvRes.results || []).map((i: any) => formatMediaItem({ ...i, media_type: 'tv' }, 'tv'));

  let combined = [...movies, ...tvs].filter(isSafe);

  if (typeFilter !== 'all') {
    combined = combined.filter((i) => i.type === typeFilter);
  }

  if (decadeFilter !== 'all') {
    const targetDecade = parseInt(decadeFilter, 10);
    combined = combined.filter((i) => {
      const y = parseInt(i.year || '0', 10);
      if (!y) return false;
      if (targetDecade === 1980) return y <= 1989;
      return y >= targetDecade && y < targetDecade + 10;
    });
  }

  // Sort by popularity/rating
  return combined.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
}

// TV Seasons Details
export async function fetchTvSeasons(tvId: number): Promise<Season[]> {
  try {
    const data = await tmdbFetch(`/tv/${tvId}`);
    const today = new Date().toISOString().split('T')[0];
    return (data.seasons || []).filter(
      (s: any) => s.season_number > 0 && (!s.air_date || s.air_date <= today)
    );
  } catch (err) {
    console.warn('Failed to fetch TV seasons', err);
    return [];
  }
}

// TV Episodes for Season
export async function fetchTvEpisodes(tvId: number, seasonNumber: number): Promise<Episode[]> {
  try {
    const data = await tmdbFetch(`/tv/${tvId}/season/${seasonNumber}`);
    const today = new Date().toISOString().split('T')[0];
    return (data.episodes || []).filter((ep: any) => !ep.air_date || ep.air_date <= today);
  } catch (err) {
    console.warn('Failed to fetch season episodes', err);
    return [];
  }
}

// Media Credits (Cast) & Recommendations
export async function fetchMediaDetails(type: 'movie' | 'tv', id: number) {
  try {
    const [credits, recommendations, extIds] = await Promise.all([
      tmdbFetch(`/${type}/${id}/credits`).catch(() => ({ cast: [] })),
      tmdbFetch(`/${type}/${id}/recommendations`).catch(() => ({ results: [] })),
      tmdbFetch(`/${type}/${id}/external_ids`).catch(() => ({})),
    ]);

    const cast: CastMember[] = (credits.cast || []).slice(0, 10).map((c: any) => ({
      id: c.id,
      name: c.name,
      character: c.character,
      profile_path: c.profile_path ? `${TMDB_IMG}w185${c.profile_path}` : undefined,
    }));

    const similar = (recommendations.results || [])
      .filter(isSafe)
      .slice(0, 12)
      .map((i: any) => formatMediaItem(i, type));

    return {
      cast,
      similar,
      imdbId: extIds.imdb_id || extIds.tvdb_id,
    };
  } catch (e) {
    return { cast: [], similar: [], imdbId: undefined };
  }
}

function normalizeClientStreams(data: any, apiName: string): StreamSource[] {
  let list: any[] = [];
  if (!data) return list;
  if (Array.isArray(data.streams)) list = data.streams;
  else if (Array.isArray(data.sources)) list = data.sources;
  else if (Array.isArray(data.results)) list = data.results;
  else if (Array.isArray(data.data)) list = data.data;
  else if (Array.isArray(data)) list = data;

  const result: StreamSource[] = [];
  for (const s of list) {
    if (!s) continue;
    let streamUrl = s?.url || s?.stream_url || s?.link || s?.playlist || '';
    if (typeof streamUrl !== 'string' || !streamUrl.startsWith('http')) continue;
    streamUrl = streamUrl.replace('http://localhost:10000', SCRAPER_CINEPRO);

    if (streamUrl.toLowerCase().endsWith('.mkv') || s?.type === 'mkv') {
      continue;
    }

    const rawProvider = s?.provider;
    const providerName =
      rawProvider && typeof rawProvider === 'object'
        ? rawProvider.name || rawProvider.id || apiName
        : rawProvider || s.source || s.name || apiName;

    const quality = (s?.quality || s?.resolution || s?.label || 'AUTO').toUpperCase();
    const isM3U8 =
      !streamUrl.includes('.mp4') &&
      (streamUrl.includes('.m3u8') || !streamUrl.match(/\.(mp4|webm|mkv)/i));

    result.push({
      url: streamUrl,
      quality,
      provider: providerName,
      intro: s?.intro,
      apiName,
      isM3U8,
      isEmbed: false,
      rawTitle: s?.title || s?.name || '',
      language: s?.language || 'English',
    });
  }
  return result;
}

// In-memory client stream cache (15-min TTL) to prevent duplicate scraper hits
const streamClientCache = new Map<string, { streams: StreamSource[]; timestamp: number }>();

// Dual-Engine Stream Finder (Server Edge Proxy + Fast Direct Scraper Fallback)
export async function fetchStreams(type: 'movie' | 'tv', id: number, s = 1, e = 1): Promise<StreamSource[]> {
  const cacheKey = `${type}-${id}-${s}-${e}`;
  const cached = streamClientCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 15 * 60 * 1000 && cached.streams.length > 0) {
    return cached.streams;
  }

  const query = type === 'tv' ? `?s=${s}&e=${e}` : '';

  // 1. Try Backend Server Proxy first (up to 5s)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`/api/streams/${type}/${id}${query}`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.streams) && data.streams.length > 0) {
        streamClientCache.set(cacheKey, { streams: data.streams, timestamp: Date.now() });
        return data.streams;
      }
    }
  } catch {
    // Backend unavailable or slow, immediately fallback to direct scrapers
  }

  // 2. Direct Scraper Fallback (Ensures 100% reliability on any host: Cloudflare Pages, Netlify, Preview, Mobile)
  try {
    const isTV = type === 'tv';
    const primaryUrl = isTV
      ? `${SCRAPER_PRIMARY}/api/streams/tv/${id}?s=${s}&e=${e}`
      : `${SCRAPER_PRIMARY}/api/streams/movie/${id}`;
    const cineproUrl = isTV
      ? `${SCRAPER_CINEPRO}/v1/tv/${id}/seasons/${s}/episodes/${e}`
      : `${SCRAPER_CINEPRO}/v1/movies/${id}`;

    const [res1, res2] = await Promise.allSettled([
      fetch(primaryUrl, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)),
      fetch(cineproUrl, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)),
    ]);

    let combined: StreamSource[] = [];
    if (res1.status === 'fulfilled' && res1.value) {
      combined = combined.concat(normalizeClientStreams(res1.value, 'Primary'));
    }
    if (res2.status === 'fulfilled' && res2.value) {
      combined = combined.concat(normalizeClientStreams(res2.value, 'CinePro'));
    }

    if (combined.length > 0) {
      const multiFiltered = combined.filter((st) => {
        const str = `${st.provider || ''} ${st.quality || ''} ${st.rawTitle || ''}`.toUpperCase();
        return str.includes('MULTI') || str.includes('DUAL');
      });
      const finalStreams = multiFiltered.length > 0 ? multiFiltered : combined;
      streamClientCache.set(cacheKey, { streams: finalStreams, timestamp: Date.now() });
      return finalStreams;
    }
  } catch (err) {
    console.error('Direct scraper fallback error:', err);
  }

  return [];
}

// Subtitles Finder with Direct Client Fallback (Drag & Drop Compatible)
export async function fetchSubtitles(
  imdbId: string | undefined,
  tmdbId: number,
  type: 'movie' | 'tv',
  s = 1,
  e = 1
): Promise<Record<string, SubtitleTrack[]>> {
  if (!imdbId) return {};

  const params = new URLSearchParams({
    type,
    s: s.toString(),
    e: e.toString(),
    tmdbId: tmdbId.toString(),
    imdbId,
  });

  // 1. Try Backend Proxy
  try {
    const res = await fetch(`/api/subtitles/search?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      const groups: Record<string, SubtitleTrack[]> = {};
      if (Array.isArray(data.subtitles)) {
        data.subtitles.forEach((sub: any) => {
          const lang = sub.lang || 'Unknown';
          if (!groups[lang]) groups[lang] = [];
          groups[lang].push({
            id: sub.id,
            lang,
            url: sub.url.startsWith('/api')
              ? sub.url
              : `/api/subtitles/proxy?url=${encodeURIComponent(sub.url)}`,
          });
        });
        return groups;
      }
    }
  } catch {
    // Backend unavailable, fallback to direct OpenSubtitles
  }

  // 2. Direct OpenSubtitles Fallback
  try {
    const subUrl =
      type === 'tv'
        ? `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${s}:${e}.json`
        : `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`;

    const res = await fetch(subUrl);
    if (!res.ok) return {};
    const data = await res.json();
    const groups: Record<string, SubtitleTrack[]> = {};
    if (Array.isArray(data.subtitles)) {
      data.subtitles.forEach((sub: any) => {
        const lang = sub.lang || 'Unknown';
        if (!groups[lang]) groups[lang] = [];
        groups[lang].push({
          id: sub.id,
          lang,
          url: sub.url,
        });
      });
    }
    return groups;
  } catch (err) {
    console.warn('Failed to fetch subtitles directly:', err);
    return {};
  }
}

// User Data Sync API
export async function fetchUserData(): Promise<UserData | null> {
  try {
    const res = await fetch('/api/user/data');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function syncUserData(data: Partial<UserData>): Promise<boolean> {
  try {
    const res = await fetch('/api/user/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch {
    return false;
  }
}
