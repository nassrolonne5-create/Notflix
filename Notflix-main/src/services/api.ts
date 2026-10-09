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
export const SCRAPER_CINEPRO = 'http://62.171.179.144:3000';
export const SCRAPER_TMDB_EMBED = ((import.meta.env.VITE_SCRAPER_TMDB_EMBED_URL as string) || (import.meta.env.VITE_SCRAPER_PRIMARY_URL as string) || 'http://62.171.179.144:3005').replace(/^https:\/\//i, 'http://');

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
    if (typeof streamUrl !== 'string') continue;
    streamUrl = streamUrl.replace(/http:\/\/localhost:(3000|10000)/g, SCRAPER_CINEPRO);
    streamUrl = streamUrl.replace(/http:\/\/localhost:3005/g, SCRAPER_TMDB_EMBED);
    streamUrl = streamUrl.replace(/&amp;/g, '&');

    // Relay CinePro proxy through our local HTTPS server to prevent Mixed Content blocking (HTTP or HTTPS)
    streamUrl = streamUrl.replace(/^https?:\/\/62\.171\.179\.144(?::\d+)?\/v1\/proxy/i, '/v1/proxy');
    const cineproOrigin = SCRAPER_CINEPRO.replace(/\/+$/, '');
    if (streamUrl.startsWith(`${cineproOrigin}/v1/proxy`)) {
      streamUrl = streamUrl.slice(cineproOrigin.length);
    }

    if (!streamUrl.startsWith('http') && !streamUrl.startsWith('/v1/proxy') && !streamUrl.startsWith('/api/proxy')) {
      continue;
    }

    const urlLower = streamUrl.toLowerCase();
    const rawProvider = s?.provider;
    const providerName =
      rawProvider && typeof rawProvider === 'object'
        ? rawProvider.name || rawProvider.id || apiName
        : rawProvider || s.source || s.name || apiName;

    const provLower = String(providerName).toLowerCase();
    const headers = s?.headers && typeof s.headers === 'object' ? s.headers : null;

    // Filter out permanently broken scrapers that cannot be resolved client-side:
    // (boomchick/finepulfe return 404/403 expired links, streamflixserver has no DNS)
    // VidRock Orion, Icefy, and LMScript are prioritized and supported via local proxy relays
    if (
      urlLower.includes('finepulfe.xyz') ||
      urlLower.includes('boomchick.org') ||
      urlLower.includes('streamflixserver.site')
    ) {
      continue;
    }

    // Filter out iframe / embed streams completely
    if (
      Boolean(s?.isEmbed) ||
      s?.type === 'embed' ||
      s?.type === 'iframe' ||
      urlLower.includes('/embed/') ||
      urlLower.includes('/e/') ||
      urlLower.includes('cloudorchestranova') ||
      urlLower.includes('vidsrc') ||
      urlLower.includes('autoembed') ||
      urlLower.includes('2embed') ||
      urlLower.includes('superembed') ||
      urlLower.includes('multiembed') ||
      urlLower.includes('embed.su') ||
      urlLower.includes('player.') ||
      urlLower.includes('vidlink')
    ) {
      continue;
    }

    // Filter out sample video shorts, teasers, trailers, and promo clips
    const rawTitleStr = String(s?.title || s?.name || '').toLowerCase();
    const isSampleStream =
      /(?:^|[._\-\/\s])sample(?:[._\-\/\s\d]|$)/i.test(urlLower) ||
      /(?:^|[._\-\/\s])sample(?:[._\-\/\s\d]|$)/i.test(rawTitleStr) ||
      /(?:^|[._\-\/\s])trailer(?:[._\-\/\s\d]|$)/i.test(urlLower) ||
      /(?:^|[._\-\/\s])trailer(?:[._\-\/\s\d]|$)/i.test(rawTitleStr) ||
      /(?:^|[._\-\/\s])teaser(?:[._\-\/\s\d]|$)/i.test(urlLower) ||
      /(?:^|[._\-\/\s])teaser(?:[._\-\/\s\d]|$)/i.test(rawTitleStr) ||
      urlLower.includes('sample.mp4') ||
      urlLower.includes('sample.mkv') ||
      urlLower.includes('sample.webm') ||
      rawTitleStr.includes('sample video') ||
      rawTitleStr.includes('sample short') ||
      rawTitleStr.includes('short sample');

    if (isSampleStream) {
      continue;
    }

    const isDASH =
      Boolean(s?.isDASH) ||
      s?.type === 'dash' ||
      s?.type === 'mpd' ||
      urlLower.includes('.mpd');

    const isM3U8 =
      !isDASH &&
      (s?.type === 'hls' ||
        s?.type === 'm3u8' ||
        urlLower.includes('.m3u8') ||
        (!urlLower.match(/\.(mp4|webm|mkv|ogg|mov)$/i) && !urlLower.includes('.mpd')));

    let proxyUrl = '';
    if (!streamUrl.startsWith('/v1/proxy') && (headers || urlLower.includes('boomchick') || urlLower.includes('hakunaymatata') || urlLower.includes('flwuok') || urlLower.includes('flcwuk') || urlLower.includes('hbsxcn') || urlLower.includes('flowxn') || urlLower.includes('fsonxn') || urlLower.includes('111477.xyz') || urlLower.includes('devcorp.me') || urlLower.includes('crmseraph') || urlLower.includes('1x2.space') || urlLower.includes('neward.cyou') || urlLower.includes('professionaladvisory.sbs'))) {
      proxyUrl = `/api/proxy/stream?url=${encodeURIComponent(streamUrl)}${
        headers ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : ''
      }`;
    }

    const quality = (s?.quality || s?.resolution || s?.label || 'AUTO').toUpperCase();
    const rawTitle = [s?.name, s?.title].filter(Boolean).join(' · ') || '';
    const rawLang =
      s?.lang ||
      s?.language ||
      s?.audio ||
      rawTitle.match(/\b(ENG|ENGLISH|PUNJABI|KANNADA|MALAYALAM|TELUGU|TAMIL|BENGALI|MARATHI|GUJARATI|URDU|HINDI|LATINO|ESPANOL|SPANISH|CASTILIAN|FRENCH|VF|VFF|RUSSIAN|GERMAN|DEUTSCH|ITALIAN|MULTI|DUAL)\b/i)?.[0] ||
      'Unknown';

    let intro = s?.intro;
    if (!intro && (urlLower.includes('professionaladvisory') || urlLower.includes('master.txt'))) {
      intro = { start: 0, end: 28 };
    }

    result.push({
      url: streamUrl,
      proxyUrl: proxyUrl || undefined,
      headers: headers || undefined,
      quality,
      provider: providerName,
      intro,
      apiName,
      isM3U8,
      isDASH,
      rawTitle,
      language: rawLang,
    });
  }
  return result;
}

function isVidRockOrionStream(s: StreamSource): boolean {
  if (!s) return false;
  const prov = (s.provider || '').toString().toLowerCase();
  const rawT = (s.rawTitle || (s as any).title || (s as any).name || '').toString().toLowerCase();
  const url = (s.url || '').toString().toLowerCase();
  const proxyUrl = (s.proxyUrl || '').toString().toLowerCase();
  const server = ((s as any).server || (s as any).source || s.apiName || '').toString().toLowerCase();
  const combined = `${prov} ${rawT} ${server}`.toLowerCase();

  // If it's explicitly Atlas, it is not Orion
  if (combined.includes('atlas')) return false;

  // Direct Orion match or crmseraph CDN host
  if (url.includes('crmseraph') || proxyUrl.includes('crmseraph')) {
    return true;
  }
  if (
    combined.includes('vidrockorion') ||
    combined.includes('vidrock-orion') ||
    combined.includes('vidrock_orion')
  ) {
    return true;
  }
  if (combined.includes('vidrock') && combined.includes('orion')) {
    return true;
  }
  if (prov.includes('vidrock') && (rawT.includes('orion') || url.includes('crmseraph'))) {
    return true;
  }
  if (combined.includes('orion')) {
    return true;
  }
  return false;
}

function isIcefyStream(s: StreamSource): boolean {
  if (!s) return false;
  if (isVidRockOrionStream(s)) return false;

  const prov = (s.provider || '').toString().toLowerCase();
  const rawT = (s.rawTitle || (s as any).title || (s as any).name || '').toString().toLowerCase();
  const url = (s.url || '').toString().toLowerCase();
  const proxyUrl = (s.proxyUrl || '').toString().toLowerCase();
  const server = ((s as any).server || (s as any).source || s.apiName || '').toString().toLowerCase();
  const combined = `${prov} ${rawT} ${server}`.toLowerCase();

  if (combined.includes('icefy')) {
    return true;
  }
  if (
    url.includes('1x2.space') ||
    proxyUrl.includes('1x2.space') ||
    url.includes('mov3.4pa.top') ||
    proxyUrl.includes('mov3.4pa.top') ||
    url.includes('professionaladvisory.sbs') ||
    proxyUrl.includes('professionaladvisory.sbs') ||
    url.includes('tik.1x2') ||
    url.includes('vip.1x2')
  ) {
    return true;
  }
  return false;
}

function isLMScriptStream(s: StreamSource): boolean {
  if (!s) return false;
  if (isVidRockOrionStream(s) || isIcefyStream(s)) return false;

  const prov = (s.provider || '').toString().toLowerCase();
  const rawT = (s.rawTitle || (s as any).title || (s as any).name || '').toString().toLowerCase();
  const url = (s.url || '').toString().toLowerCase();
  const proxyUrl = (s.proxyUrl || '').toString().toLowerCase();
  const server = ((s as any).server || (s as any).source || s.apiName || '').toString().toLowerCase();
  const combined = `${prov} ${rawT} ${server}`.toLowerCase();

  if (
    combined.includes('lmscript') ||
    combined.includes('lm script') ||
    combined.includes('lm-script') ||
    combined.includes('lm_script')
  ) {
    return true;
  }
  if (url.includes('neward.cyou') || proxyUrl.includes('neward.cyou')) {
    return true;
  }
  return false;
}

export function rankClientStreams(streams: StreamSource[], isTV: boolean): StreamSource[] {
  const foreignRegex =
    /\b(PUNJABI|KANNADA|MALAYALAM|TELUGU|TAMIL|BENGALI|MARATHI|GUJARATI|URDU|HINDI|LATINO|ESPANOL|SPANISH|CASTILIAN|FRENCH|VF|VFF|RUSSIAN|GERMAN|DEUTSCH|ITALIAN)\b/i;
  const englishRegex = /\b(ENG|ENGLISH|ORIGINAL|VO)\b/i;
  const multiRegex = /\b(MULTI|DUAL)\b/i;

  const getRank = (s: StreamSource) => {
    // 1. Primary Source Prioritization Tier:
    // Tier 0: VidRock Orion (Highest Priority - Always First if available)
    // Tier 1: Icefy (Second Priority - Follows VidRock Orion if available)
    // Tier 2: LMScript (Third Priority - Follows Icefy if available)
    // Tier 3: Other providers (TMDB Embed, Primary, etc.)
    let tierScore = 3;
    if (isVidRockOrionStream(s)) {
      tierScore = 0;
    } else if (isIcefyStream(s)) {
      tierScore = 1;
    } else if (isLMScriptStream(s)) {
      tierScore = 2;
    } else {
      tierScore = 3;
    }

    const rawT = (s.rawTitle || (s as any).title || (s as any).name || '').toString().toUpperCase();
    const prov = (s.provider || '').toString().toUpperCase();
    const lang = (s.language || '').toString().toUpperCase();
    const q = (s.quality || '').toString().toUpperCase();
    const aName = (s.apiName || '').toString().toLowerCase();

    const fullText = `${rawT} ${prov} ${lang}`;

    const isExplicitEnglish =
      englishRegex.test(fullText) ||
      lang === 'EN' ||
      lang === 'ENG' ||
      lang === 'ENGLISH';

    const isExplicitForeignOnly = foreignRegex.test(fullText) && !isExplicitEnglish;
    const isMultiAudio = multiRegex.test(fullText);

    let langScore = 2;
    if (isExplicitEnglish) {
      langScore = 0;
    } else if (isMultiAudio) {
      langScore = 1;
    } else if (isExplicitForeignOnly) {
      langScore = 4;
    } else {
      langScore = 2;
    }

    const isTMDBEmbed =
      aName.includes('tmdb') ||
      aName.includes('embed') ||
      prov.includes('TMDB') ||
      prov.includes('CASTLE') ||
      prov.includes('ONETOUCH') ||
      prov.includes('STREAMFLIX') ||
      prov.includes('VAPLAYER');

    let pScore = 50;
    if (!isTV) {
      // Prioritize TMDB Embed API servers to show first for movies in tier 3
      if (isTMDBEmbed) {
        pScore = 1;
      } else if (aName.includes('cinepro') || prov.includes('CINEPRO')) {
        pScore = 10;
      } else if (aName.includes('primary') || prov.includes('PRIMARY')) {
        pScore = 15;
      } else if (prov.includes('TORRENTIO')) {
        pScore = 20;
      }
    } else {
      // TV Series
      if (aName.includes('cinepro') || prov.includes('CINEPRO')) {
        pScore = 1;
      } else if (isTMDBEmbed) {
        pScore = 5;
      } else if (aName.includes('primary') || prov.includes('PRIMARY')) {
        pScore = 10;
      } else if (prov.includes('TORRENTIO')) {
        pScore = 20;
      }
    }

    let qScore = 500;
    if (q.includes('LORDFIX')) qScore = 0;
    else if (q.includes('1080') || q.includes('FHD')) qScore = 10;
    else if (q.includes('2160') || q.includes('4K') || q.includes('UHD')) qScore = 20;
    else if (q.includes('720') || q.includes('HD')) qScore = 30;
    else if (q.includes('480')) qScore = 40;
    else if (q.includes('360')) qScore = 50;
    else if (q === 'AUTO') qScore = 60;

    return tierScore * 100000000000 + langScore * 10000000 + pScore * 10000 + qScore;
  };

  const sorted = [...streams].sort((a, b) => getRank(a) - getRank(b));

  // Keep server names completely anonymous as Server 1, Server 2, Server 3, etc.
  return sorted.map((s, idx) => {
    const anonymousName = `Server ${idx + 1}`;
    const cleaned = { ...s };
    delete (cleaned as any).rawTitle;
    delete (cleaned as any).title;
    delete (cleaned as any).name;
    delete (cleaned as any).source;
    delete (cleaned as any).server;
    delete (cleaned as any).apiName;
    return {
      ...cleaned,
      provider: anonymousName,
      rawTitle: anonymousName,
      name: anonymousName,
      title: anonymousName,
    };
  });
}

// In-memory client stream cache (15-min TTL) to prevent duplicate scraper hits
const streamClientCache = new Map<string, { streams: StreamSource[]; timestamp: number }>();

// Dual-Engine Stream Finder (Server Edge Proxy + Fast Direct Scraper Fallback)
export async function fetchStreams(
  type: 'movie' | 'tv',
  id: number,
  s = 1,
  e = 1,
  forceRefresh = false
): Promise<StreamSource[]> {
  const cacheKey = `${type}-${id}-${s}-${e}`;
  if (!forceRefresh) {
    const cached = streamClientCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 15 * 60 * 1000 && cached.streams.length > 0) {
      return cached.streams;
    }
  } else {
    streamClientCache.delete(cacheKey);
  }

  const queryParts = [];
  if (type === 'tv') {
    queryParts.push(`s=${s}`, `e=${e}`);
  }
  if (forceRefresh) {
    queryParts.push(`refresh=1`, `_t=${Date.now()}`);
  }
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  // 1. Try Backend Server Proxy first with increased timeout (28s) and automatic retry
  for (let backendAttempt = 1; backendAttempt <= 2; backendAttempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 28000);
      const res = await fetch(`/api/streams/${type}/${id}${queryString}`, {
        signal: controller.signal,
        cache: forceRefresh || backendAttempt > 1 ? 'no-cache' : 'default',
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.streams) && data.streams.length > 0) {
          streamClientCache.set(cacheKey, { streams: data.streams, timestamp: Date.now() });
          return data.streams;
        }
      }
    } catch {
      // If attempt 1 timed out or failed, brief backoff then retry backend before falling back to direct scrapers
      if (backendAttempt < 2) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }

  // 2. Direct Scraper Fallback with 25s timeout and auto-retry
  for (let directAttempt = 1; directAttempt <= 2; directAttempt++) {
    try {
      const isTV = type === 'tv';
      const cineproUrl = isTV
        ? `${SCRAPER_CINEPRO}/v1/tv/${id}/seasons/${s}/episodes/${e}`
        : `${SCRAPER_CINEPRO}/v1/movies/${id}`;

      const fetchDirect = (url: string) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 25000);
        return fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
          .then((r) => {
            clearTimeout(t);
            return r.ok ? r.json() : null;
          })
          .catch(() => {
            clearTimeout(t);
            return null;
          });
      };

      const tasks: Promise<any>[] = [fetchDirect(cineproUrl)];

      if (SCRAPER_TMDB_EMBED && SCRAPER_TMDB_EMBED !== SCRAPER_CINEPRO) {
        const tmdbEmbedUrl = isTV
          ? `${SCRAPER_TMDB_EMBED}/api/streams/series/${id}?s=${s}&e=${e}`
          : `${SCRAPER_TMDB_EMBED}/api/streams/movie/${id}`;
        tasks.push(fetchDirect(tmdbEmbedUrl));
      }

      const results = await Promise.allSettled(tasks);
      let combined: StreamSource[] = [];

      // CinePro streams
      if (results[0].status === 'fulfilled' && results[0].value) {
        combined = combined.concat(normalizeClientStreams(results[0].value, 'CinePro'));
      }

      // TMDB Embed Scraper streams
      if (results[1] && results[1].status === 'fulfilled' && results[1].value) {
        combined = combined.concat(normalizeClientStreams(results[1].value, 'TMDB Embed'));
      }

      if (combined.length > 0) {
        const sorted = rankClientStreams(combined, isTV);
        streamClientCache.set(cacheKey, { streams: sorted, timestamp: Date.now() });
        return sorted;
      }

      if (directAttempt < 2) {
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch {
      if (directAttempt < 2) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }

  // Return empty list if no valid media streams found (iframe fallbacks completely removed)
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
