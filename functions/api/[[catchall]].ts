// Cloudflare Pages Functions API Handler
// Routes all /api/* requests on Cloudflare's global edge network

interface Env {
  TMDB_API_KEY?: string;
  NOTFLIX_KV?: any;
  SCRAPER_PRIMARY_URL?: string;
  SCRAPER_CINEPRO_URL?: string;
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const DEFAULT_SCRAPER_PRIMARY = 'https://tmdb-embed-api-hcz6.onrender.com';
const DEFAULT_SCRAPER_CINEPRO = 'https://cinepro-core-991g.onrender.com';

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
const safePattern = new RegExp(
  `\\b(${ADULT_BLOCKLIST.join('|')})\\b|\\bsex(?!\\s*(trafficking|crime|worker|trade|slave))\\b`,
  'i'
);

const ADULT_KEYWORDS = [
  'romance', 'romantic', 'erotic', 'erotica', 'pornography', 'porn', 'softcore', 'hardcore porn',
  'explicit sex', 'unsimulated sex', 'sexual content', 'bdsm', 'erotic thriller',
  'fetish', 'kama sutra', 'masturbation', 'orgasm', 'hentai', 'ecchi', 'nude', 'nudity',
  'penetration', 'seduction', 'menage a trois', 'threesome', 'infidelity', 'love triangle',
  'gay', 'lesbian', 'lgbt', 'gay theme', 'sexuality', 'sensuality', 'lust', 'sexy', 'love story',
  'striptease', 'voyeur', 'intimacy', 'adultery', 'affair', 'erotic drama', 'erotic comedy'
];
const kwPattern = new RegExp(`\\b(${ADULT_KEYWORDS.join('|')})\\b`, 'i');

function isSafe(item: any): boolean {
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

  if (safePattern.test(title) || safePattern.test(desc)) return false;

  let kwds: any[] = [];
  if (item.keywords) {
    kwds = item.keywords.results || item.keywords.keywords || [];
  }
  if (kwds.some((k: any) => kwPattern.test(k.name))) return false;

  return true;
}

async function fetchWithTimeout(url: string, ms = 4500): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function normalizeStreams(data: any, apiName: string, cineproBaseUrl: string = DEFAULT_SCRAPER_CINEPRO) {
  let list: any[] = [];
  if (!data) return list;
  if (Array.isArray(data.streams)) list = data.streams;
  else if (Array.isArray(data.sources)) list = data.sources;
  else if (Array.isArray(data.results)) list = data.results;
  else if (Array.isArray(data.data)) list = data.data;
  else if (Array.isArray(data)) list = data;

  return list
    .map((s) => {
      const rawProvider = s?.provider;
      const providerName =
        rawProvider && typeof rawProvider === 'object'
          ? rawProvider.name || rawProvider.id || apiName
          : rawProvider || s.source || s.name || apiName;

      let streamUrl = s?.url || s?.stream_url || s?.link || s?.playlist || '';
      streamUrl = streamUrl.replace('http://localhost:10000', cineproBaseUrl);

      if (streamUrl.toLowerCase().endsWith('.mkv') || s?.type === 'mkv') {
        return null;
      }

      const quality = (s?.quality || s?.resolution || s?.label || 'AUTO').toUpperCase();
      const isM3U8 =
        !streamUrl.includes('.mp4') &&
        (streamUrl.includes('.m3u8') || !streamUrl.match(/\.(mp4|webm|mkv)/i));

      return {
        url: streamUrl,
        quality,
        provider: providerName,
        intro: s?.intro,
        apiName,
        isM3U8,
        isEmbed: false,
        rawTitle: s?.title || s?.name || '',
      };
    })
    .filter((s): s is NonNullable<typeof s> => Boolean(s && s.url && s.url.startsWith('http')));
}

export async function onRequest(context: { request: Request; env: Env; params: { catchall?: string[] } }) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // 1. Health check
  if (pathname === '/api/health') {
    return new Response(
      JSON.stringify({
        status: 'ok',
        platform: 'Cloudflare Pages Functions',
        timestamp: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // 2. TMDB Proxy
  if (pathname.startsWith('/api/tmdb/')) {
    const tmdbEndpoint = pathname.replace('/api/tmdb/', '');
    const searchParams = new URLSearchParams(url.search);
    const tmdbKey = env.TMDB_API_KEY || DEFAULT_TMDB_KEY;

    searchParams.set('api_key', tmdbKey);
    searchParams.set('language', searchParams.get('language') || 'en-US');
    searchParams.set('include_adult', 'false');
    if (!searchParams.has('without_genres')) {
      searchParams.set('without_genres', '10749');
    }

    const targetUrl = `${TMDB_BASE}/${tmdbEndpoint}?${searchParams.toString()}`;
    const tmdbRes = await fetch(targetUrl);
    if (!tmdbRes.ok) {
      return new Response(JSON.stringify({ error: `TMDB error: ${tmdbRes.statusText}` }), {
        status: tmdbRes.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await tmdbRes.json();
    if (Array.isArray(data.results)) {
      data.results = data.results.filter(isSafe);
    } else if (data.id && !isSafe(data)) {
      return new Response(JSON.stringify({ error: 'This title is restricted by safety filters.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // 3. Streams Aggregation
  if (pathname.startsWith('/api/streams/')) {
    const parts = pathname.replace('/api/streams/', '').split('/');
    const type = parts[0] || 'movie';
    const id = parts[1] || '';
    const isTV = type === 'tv';
    const s = url.searchParams.get('s') || '1';
    const e = url.searchParams.get('e') || '1';

    const scraperPrimary = env.SCRAPER_PRIMARY_URL || DEFAULT_SCRAPER_PRIMARY;
    const scraperCinepro = env.SCRAPER_CINEPRO_URL || DEFAULT_SCRAPER_CINEPRO;

    const primaryUrl = isTV
      ? `${scraperPrimary}/api/streams/tv/${id}?s=${s}&e=${e}`
      : `${scraperPrimary}/api/streams/movie/${id}`;

    const cineproUrl = isTV
      ? `${scraperCinepro}/v1/tv/${id}/seasons/${s}/episodes/${e}`
      : `${scraperCinepro}/v1/movies/${id}`;

    const results = await Promise.allSettled([
      fetchWithTimeout(primaryUrl, 10000),
      fetchWithTimeout(cineproUrl, 10000),
    ]);

    let combined: any[] = [];
    if (results[0].status === 'fulfilled' && results[0].value) {
      combined = combined.concat(normalizeStreams(results[0].value, 'Primary', scraperCinepro));
    }
    if (results[1].status === 'fulfilled' && results[1].value) {
      combined = combined.concat(normalizeStreams(results[1].value, 'CinePro', scraperCinepro));
    }

    // MULTI Filter matching original HTML
    const multiFiltered = combined.filter((st) => {
      const str = `${st.provider || ''} ${st.quality || ''} ${st.rawTitle || ''}`.toUpperCase();
      return str.includes('MULTI') || str.includes('DUAL');
    });

    const candidateList = multiFiltered.length > 0 ? multiFiltered : combined;

    return new Response(
      JSON.stringify({
        success: true,
        count: candidateList.length,
        streams: candidateList,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // 4. Subtitles Search & Proxy
  if (pathname === '/api/subtitles/search') {
    const imdbId = url.searchParams.get('imdbId');
    const type = url.searchParams.get('type') || 'movie';
    const s = url.searchParams.get('s') || '1';
    const e = url.searchParams.get('e') || '1';

    if (!imdbId) {
      return new Response(JSON.stringify({ subtitles: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const subUrl =
      type === 'tv'
        ? `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${s}:${e}.json`
        : `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`;

    const data = await fetchWithTimeout(subUrl, 6000).catch(() => ({ subtitles: [] }));
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (pathname === '/api/subtitles/proxy') {
    const subUrl = url.searchParams.get('url');
    if (!subUrl) {
      return new Response('URL required', { status: 400 });
    }

    const subRes = await fetch(subUrl);
    let text = await subRes.text();
    if (!text.trim().startsWith('WEBVTT')) {
      text =
        'WEBVTT\n\n' +
        text
          .replace(/\{\\([ibu])\}/g, '<$1>')
          .replace(/\{\\\/([ibu])\}/g, '</$1>')
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    return new Response(text, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/vtt; charset=utf-8',
      },
    });
  }

  // 5. User data
  if (pathname === '/api/user/data' || pathname === '/api/user/sync') {
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
