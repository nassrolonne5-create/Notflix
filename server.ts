import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

// Prevent container crashes from unhandled network exceptions or socket resets
process.on('uncaughtException', (err) => {
  console.error('🛡️ Handled uncaughtException:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('🛡️ Handled unhandledRejection:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// TMDB Backend Configuration
const TMDB_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const TMDB_API_KEY = process.env.TMDB_API_KEY || DEFAULT_TMDB_KEY;

const SCRAPER_API_CINEPRO = (process.env.SCRAPER_CINEPRO_URL || 'http://62.171.179.144:3000').replace(/^https:\/\//i, 'http://');
const SCRAPER_API_TMDB_EMBED = (process.env.SCRAPER_TMDB_EMBED_URL || process.env.SCRAPER_PRIMARY_URL || 'http://62.171.179.144:3005').replace(/^https:\/\//i, 'http://');

// Allow connecting to upstream scrapers using HTTPS with self-signed / internal certificates
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// In-Memory Server Cache with 5-minute TTL
interface CacheEntry {
  timestamp: number;
  data: any;
}
const apiCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Persistent User Data storage
const DATA_DIR = path.join(__dirname, 'data');
const USER_DATA_FILE = path.join(DATA_DIR, 'userdata.json');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('Error creating data directory:', e);
  }
}

interface UserData {
  watchlist: any[];
  favorites: any[];
  history: any[];
  playbackPosition: Record<string, any>;
  settings: {
    autoSkip: boolean;
    globalSubtitles: boolean;
  };
}

const defaultUserData: UserData = {
  watchlist: [],
  favorites: [],
  history: [],
  playbackPosition: {},
  settings: {
    autoSkip: true,
    globalSubtitles: true,
  },
};

function readUserData(): UserData {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const content = fs.readFileSync(USER_DATA_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      return {
        ...defaultUserData,
        ...parsed,
        settings: {
          ...defaultUserData.settings,
          ...(parsed.settings || {}),
        },
      };
    }
  } catch (err) {
    console.warn('Could not read user data file, returning defaults', err);
  }
  return defaultUserData;
}

function writeUserData(data: UserData) {
  try {
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write user data file:', err);
  }
}

// Server-side SafeFilter matching client constitution
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

// ==========================================
// 1. HEALTH CHECK
// ==========================================
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'Notflix Backend',
    timestamp: new Date().toISOString(),
    cacheEntries: apiCache.size,
  });
});

// ==========================================
// 2. TMDB PROXY WITH CACHING & SAFE FILTER
// ==========================================
app.get('/api/tmdb/*', async (req: Request, res: Response) => {
  try {
    const tmdbPath = req.params[0];
    const queryParams = new URLSearchParams(req.query as Record<string, string>);
    
    // Enforce include_adult=false & without_genres=10749 at the TMDB source
    queryParams.set('api_key', TMDB_API_KEY);
    queryParams.set('language', queryParams.get('language') || 'en-US');
    queryParams.set('include_adult', 'false');
    if (!queryParams.has('without_genres')) {
      queryParams.set('without_genres', '10749');
    }

    const cacheKey = `${tmdbPath}?${queryParams.toString()}`;
    const cached = apiCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const url = `${TMDB_BASE}/${tmdbPath}?${queryParams.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: `TMDB error: ${response.statusText}` });
    }

    const data = await response.json();

    if (Array.isArray(data.results)) {
      data.results = data.results.filter(isSafe);
    } else if (data.id && !isSafe(data)) {
      return res.status(403).json({ error: 'This title is restricted by safety filters.' });
    }

    apiCache.set(cacheKey, { timestamp: Date.now(), data });
    return res.json(data);
  } catch (err: any) {
    console.error('TMDB Proxy Error:', err);
    return res.status(500).json({ error: 'Failed to fetch from TMDB' });
  }
});

// ==========================================
// 3. STREAM AGGREGATION & RESOLUTION PROXY
// ==========================================
async function fetchWithTimeout(url: string, ms = 25000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function fetchWithRetry(url: string, ms = 25000, maxRetries = 1): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const data = await fetchWithTimeout(url, ms);
    if (data) {
      const hasStreams =
        (Array.isArray(data.streams) && data.streams.length > 0) ||
        (Array.isArray(data.sources) && data.sources.length > 0) ||
        (Array.isArray(data.results) && data.results.length > 0) ||
        (Array.isArray(data.data) && data.data.length > 0);
      if (hasStreams) return data;
      // If data is returned but streams list is empty, keep if last attempt
      if (attempt === maxRetries) return data;
    }
    if (attempt < maxRetries) {
      console.log(`[Scraper Retry] API timeout or empty response from ${url.slice(0, 60)}... Auto-retrying (Attempt ${attempt + 2}/${maxRetries + 1})...`);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  return null;
}

// In-memory cache for cinepro subtitles
const subtitleCache = new Map<string, any[]>();

function normalizeStreams(data: any, apiName: string) {
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
      streamUrl = streamUrl.replace(/http:\/\/localhost:(3000|10000)/g, SCRAPER_API_CINEPRO);
      streamUrl = streamUrl.replace(/http:\/\/localhost:3005/g, SCRAPER_API_TMDB_EMBED);
      streamUrl = streamUrl.replace(/&amp;/g, '&');

      // Relay CinePro proxy through our local HTTPS server to prevent Mixed Content blocking (HTTP or HTTPS)
      streamUrl = streamUrl.replace(/^https?:\/\/62\.171\.179\.144(?::\d+)?\/v1\/proxy/i, '/v1/proxy');
      const cineproOrigin = SCRAPER_API_CINEPRO.replace(/\/+$/, '');
      if (streamUrl.startsWith(`${cineproOrigin}/v1/proxy`)) {
        streamUrl = streamUrl.slice(cineproOrigin.length);
      }

      const urlLower = streamUrl.toLowerCase();
      const provLower = String(providerName).toLowerCase();
      const titleLower = (s?.title || s?.name || '').toLowerCase();

      // Filter out obvious rickroll troll videos only
      if (
        titleLower.includes('rickroll') ||
        titleLower.includes('rick astley') ||
        urlLower.includes('rickroll')
      ) {
        return null;
      }

      // Filter out dead CinePro scrapers (LMScript returns WRONG HASH, Icefy returns 500, finepulfe is Cloudflare blocked)
      if (
        provLower.includes('lmscript') ||
        provLower.includes('icefy') ||
        urlLower.includes('finepulfe.xyz')
      ) {
        return null;
      }

      // Filter out iframe / embed players completely
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
        return null;
      }

      const headers = s?.headers && typeof s.headers === 'object' ? s.headers : null;

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

      // Build streaming proxy URL for streams that require custom headers or restricted CDNs (skip if already using /v1/proxy)
      let proxyUrl = '';
      if (!streamUrl.startsWith('/v1/proxy') && (headers || urlLower.includes('boomchick') || urlLower.includes('hakunaymatata') || urlLower.includes('flwuok') || urlLower.includes('flcwuk') || urlLower.includes('hbsxcn') || urlLower.includes('flowxn') || urlLower.includes('fsonxn') || urlLower.includes('111477.xyz') || urlLower.includes('devcorp.me'))) {
        proxyUrl = `/api/proxy/stream?url=${encodeURIComponent(streamUrl)}${
          headers ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : ''
        }`;
      }

      const quality = (s?.quality || s?.resolution || s?.label || 'AUTO').toUpperCase();
      const rawTitle = s?.title || s?.name || '';
      const rawLang =
        s?.lang ||
        s?.language ||
        s?.audio ||
        rawTitle.match(/\b(ENG|ENGLISH|HINDI|LATINO|ESPANOL|FRENCH|GERMAN|RUSSIAN|MULTI|DUAL)\b/i)?.[0] ||
        'English';

      return {
        url: streamUrl,
        proxyUrl: proxyUrl || undefined,
        headers: headers || undefined,
        quality,
        provider: providerName,
        intro: s?.intro,
        apiName,
        isM3U8,
        isDASH,
        rawTitle,
        language: rawLang,
      };
    })
    .filter((s): s is NonNullable<typeof s> => Boolean(s && s.url && (s.url.startsWith('http') || s.url.startsWith('/v1/proxy') || s.url.startsWith('/api/proxy'))));
}

function rankStreams(streams: any[], isTV: boolean) {
  const getRank = (s: any) => {
    const rawT = (s.rawTitle || '').toString().toUpperCase();
    const prov = (s.provider || '').toString().toUpperCase();
    const lang = (s.language || '').toString().toUpperCase();
    const q = (s.quality || '').toString().toUpperCase();
    const aName = (s.apiName || '').toString().toLowerCase();

    // Full text of stream metadata
    const fullText = `${rawT} ${prov} ${lang}`;

    // Explicit foreign-only indicators (Hindi, Latino, Spanish, French, German, Russian etc.)
    const isExplicitForeignOnly =
      (fullText.includes('HINDI') ||
       fullText.includes('LATINO') ||
       fullText.includes('ESPANOL') ||
       fullText.includes('CASTILIAN') ||
       fullText.includes('FRENCH') ||
       fullText.includes('VF') ||
       fullText.includes('VFF') ||
       fullText.includes('RUSSIAN') ||
       fullText.includes('GERMAN') ||
       fullText.includes('DEUTSCH') ||
       fullText.includes('ITALIAN') ||
       fullText.includes('TAMIL') ||
       fullText.includes('TELUGU')) &&
      !fullText.includes('ENG') &&
      !fullText.includes('ENGLISH');

    const isExplicitEnglish =
      fullText.includes('ENG') ||
      fullText.includes('ENGLISH') ||
      fullText.includes('ORIGINAL') ||
      fullText.includes('VO') ||
      lang === 'EN' ||
      lang === 'ENG' ||
      lang === 'ENGLISH';

    const isMultiAudio = fullText.includes('MULTI') || fullText.includes('DUAL');

    // Language Priority Score:
    // 0: Confirmed English Audio (highest priority)
    // 1: Multi-Audio (includes English)
    // 2: Standard/Default Server (CinePro / Primary default is English)
    // 4: Foreign dubbed only (lowest priority)
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

    // Provider preference: CinePro and Primary provide high-reliability English streams
    let pScore = 50;
    if (aName.includes('cinepro') || prov.includes('CINEPRO')) pScore = 1;
    else if (aName.includes('primary') || prov.includes('PRIMARY')) pScore = 2;
    else if (prov.includes('TORRENTIO')) pScore = 3;

    // Quality preference: 1080p > 4K > 720p > Auto
    let qScore = 500;
    if (q.includes('LORDFIX')) qScore = 0;
    else if (q.includes('1080') || q.includes('FHD')) qScore = 10;
    else if (q.includes('2160') || q.includes('4K') || q.includes('UHD')) qScore = 20;
    else if (q.includes('720') || q.includes('HD')) qScore = 30;
    else if (q.includes('480')) qScore = 40;
    else if (q.includes('360')) qScore = 50;
    else if (q === 'AUTO') qScore = 60;

    return langScore * 10000000 + pScore * 10000 + qScore;
  };

  return [...streams].sort((a, b) => getRank(a) - getRank(b));
}

app.get('/api/streams/:type/:id', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const isTV = type === 'tv';
    const s = parseInt((req.query.s as string) || '1', 10);
    const e = parseInt((req.query.e as string) || '1', 10);
    const forceRefresh = req.query.refresh === '1' || req.query._t !== undefined;

    const cacheKey = `streams-${type}-${id}-${s}-${e}`;
    const cached = apiCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.timestamp < 15 * 60 * 1000 && Array.isArray(cached.data?.streams) && cached.data.streams.length > 0) {
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
      return res.json(cached.data);
    }

    const cineproUrl = isTV
      ? `${SCRAPER_API_CINEPRO}/v1/tv/${id}/seasons/${s}/episodes/${e}`
      : `${SCRAPER_API_CINEPRO}/v1/movies/${id}`;

    // 25-second timeout gives multi-provider scrapers sufficient time to resolve with auto-retry
    const tasks: Promise<any>[] = [fetchWithRetry(cineproUrl, 25000, 1)];

    let tmdbEmbedUrl = '';
    if (SCRAPER_API_TMDB_EMBED && SCRAPER_API_TMDB_EMBED !== SCRAPER_API_CINEPRO) {
      tmdbEmbedUrl = isTV
        ? `${SCRAPER_API_TMDB_EMBED}/api/streams/series/${id}?s=${s}&e=${e}`
        : `${SCRAPER_API_TMDB_EMBED}/api/streams/movie/${id}`;
      tasks.push(fetchWithRetry(tmdbEmbedUrl, 25000, 1));
    }

    const results = await Promise.allSettled(tasks);
    let combined: any[] = [];

    // CinePro streams
    if (results[0].status === 'fulfilled' && results[0].value) {
      combined = combined.concat(normalizeStreams(results[0].value, 'CinePro'));
      if (Array.isArray(results[0].value.subtitles)) {
        subtitleCache.set(`${type}-${id}-${s}-${e}`, results[0].value.subtitles);
      }
    }

    // TMDB Embed Scraper streams
    if (results[1] && results[1].status === 'fulfilled' && results[1].value) {
      combined = combined.concat(normalizeStreams(results[1].value, 'TMDB Embed'));
      if (Array.isArray(results[1].value.streams)) {
        for (const sItem of results[1].value.streams) {
          if (Array.isArray(sItem.subtitles) && sItem.subtitles.length > 0) {
            const existing = subtitleCache.get(`${type}-${id}-${s}-${e}`) || [];
            subtitleCache.set(`${type}-${id}-${s}-${e}`, [...existing, ...sItem.subtitles]);
            break;
          }
        }
      }
    }

    // If scrapers returned 0 streams, check Coolify gateway mirror with retry
    if (combined.length === 0) {
      const query = isTV ? `?s=${s}&e=${e}` : '';
      const gatewayData = await fetchWithRetry(
        `http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io/api/streams/${type}/${id}${query}`,
        15000,
        1
      );
      if (gatewayData && Array.isArray(gatewayData.streams) && gatewayData.streams.length > 0) {
        combined = gatewayData.streams;
      }
    }

    // Rank all candidate streams with English language prioritized first
    const sorted = rankStreams(combined, isTV);

    const responseData = {
      success: true,
      count: sorted.length,
      streams: sorted,
    };

    if (sorted.length > 0) {
      apiCache.set(cacheKey, { timestamp: Date.now(), data: responseData });
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    } else {
      // CRITICAL: NEVER cache 0-stream responses!
      // Prevents Cloudflare and browsers from caching empty results for famous titles
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }

    return res.json(responseData);
  } catch {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.json({ success: true, count: 0, streams: [] });
  }
});

// ==========================================
// 4. SUBTITLES SEARCH & PROXY CONVERTER
// ==========================================
app.get('/api/subtitles/search', async (req: Request, res: Response) => {
  try {
    const imdbId = req.query.imdbId as string;
    const tmdbId = req.query.tmdbId as string;
    const type = (req.query.type as string) || 'movie';
    const s = req.query.s || '1';
    const e = req.query.e || '1';

    let cachedList: any[] = [];
    if (tmdbId && subtitleCache.has(`${type}-${tmdbId}-${s}-${e}`)) {
      cachedList = subtitleCache.get(`${type}-${tmdbId}-${s}-${e}`) || [];
    }

    if (cachedList.length > 0) {
      return res.json({
        subtitles: cachedList.map((c: any) => ({
          id: c.label || c.url,
          lang: c.label || 'Unknown',
          url: c.url,
        })),
      });
    }

    if (!imdbId) {
      return res.json({ subtitles: [] });
    }

    let url = '';
    if (type === 'tv') {
      url = `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${s}:${e}.json`;
    } else {
      url = `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`;
    }

    const data = await fetchWithTimeout(url, 6000).catch(() => ({ subtitles: [] }));
    return res.json(data);
  } catch (err: any) {
    console.error('Subtitles search error:', err);
    return res.json({ subtitles: [] });
  }
});

app.get('/api/subtitles/proxy', async (req: Request, res: Response) => {
  try {
    const subUrl = req.query.url as string;
    if (!subUrl) {
      return res.status(400).send('url query param required');
    }

    const response = await fetch(subUrl);
    if (!response.ok) {
      return res.status(response.status).send('Failed to fetch subtitle from upstream');
    }

    let text = await response.text();
    // Convert SRT to WebVTT if needed
    if (!text.trim().startsWith('WEBVTT')) {
      text =
        'WEBVTT\n\n' +
        text
          .replace(/\{\\([ibu])\}/g, '<$1>')
          .replace(/\{\\\/([ibu])\}/g, '</$1>')
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(text);
  } catch (err: any) {
    console.error('Subtitle proxy error:', err);
    return res.status(500).send('Error proxying subtitle');
  }
});

// Universal Video Stream Proxy with M3U8 rewrite and HTTP Range support
app.get('/api/proxy/stream', async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string;
    if (!rawUrl) {
      return res.status(400).send('Missing url parameter');
    }

    let customHeaders: Record<string, string> = {};
    if (req.query.headers) {
      try {
        customHeaders = JSON.parse(req.query.headers as string);
      } catch (e) {}
    }

    let targetUrl = decodeURIComponent(rawUrl);
    if (targetUrl.startsWith('/v1/proxy')) {
      const queryString = targetUrl.includes('?') ? targetUrl.slice(targetUrl.indexOf('?')) : '';
      targetUrl = `${SCRAPER_API_CINEPRO}/v1/proxy${queryString}`;
    } else if (targetUrl.startsWith('/')) {
      targetUrl = `http://127.0.0.1:3000${targetUrl}`;
    }

    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      return res.status(400).send('Invalid target URL scheme');
    }

    const forwardHeaders: Record<string, string> = {
      'User-Agent':
        customHeaders['User-Agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
    if (customHeaders['Referer']) forwardHeaders['Referer'] = customHeaders['Referer'];
    if (customHeaders['Origin']) forwardHeaders['Origin'] = customHeaders['Origin'];
    if (req.headers.range) {
      forwardHeaders['Range'] = req.headers.range as string;
    }

    const upstream = await fetch(targetUrl, {
      headers: forwardHeaders,
    });

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType) res.set('Content-Type', contentType);
    if (upstream.headers.get('content-range')) res.set('Content-Range', upstream.headers.get('content-range')!);
    if (upstream.headers.get('accept-ranges')) res.set('Accept-Ranges', upstream.headers.get('accept-ranges')!);
    if (upstream.headers.get('content-length')) res.set('Content-Length', upstream.headers.get('content-length')!);

    res.status(upstream.status);

    const isPlaylist =
      targetUrl.includes('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('application/x-mpegURL');

    if (isPlaylist && upstream.status === 200) {
      const text = await upstream.text();
      const baseUrl = new URL(targetUrl);
      const lines = text.split('\n');
      const rewritten = lines
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith('#')) {
            // Rewrite URI="..." inside tags like #EXT-X-KEY or #EXT-X-MEDIA
            if (trimmed.includes('URI="')) {
              return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                const full = new URL(uri, baseUrl).toString();
                return `URI="/api/proxy/stream?url=${encodeURIComponent(full)}&headers=${encodeURIComponent(
                  JSON.stringify(customHeaders)
                )}"`;
              });
            }
            return line;
          }
          // Segment URL or child playlist URL
          const full = new URL(trimmed, baseUrl).toString();
          return `/api/proxy/stream?url=${encodeURIComponent(full)}&headers=${encodeURIComponent(
            JSON.stringify(customHeaders)
          )}`;
        })
        .join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.send(rewritten);
    }

    // Binary video chunk or range stream
    if (upstream.body) {
      const { Readable } = await import('node:stream');
      // @ts-ignore
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error('Stream proxy error:', err);
    if (!res.headersSent) {
      res.status(502).send('Upstream stream proxy failed');
    }
  }
});

// CinePro Proxy Relay (Eliminates Mixed Content HTTP/HTTPS blocks & routes relative /v1/proxy segments)
app.get('/v1/proxy', async (req: Request, res: Response) => {
  try {
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const targetUrl = `${SCRAPER_API_CINEPRO}/v1/proxy${queryString}`;

    const forwardHeaders: Record<string, string> = {
      'User-Agent':
        (req.headers['user-agent'] as string) ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
    if (req.headers.range) {
      forwardHeaders['Range'] = req.headers.range as string;
    }

    const upstream = await fetch(targetUrl, {
      headers: forwardHeaders,
    });

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType) res.set('Content-Type', contentType);
    if (upstream.headers.get('content-range')) res.set('Content-Range', upstream.headers.get('content-range')!);
    if (upstream.headers.get('accept-ranges')) res.set('Accept-Ranges', upstream.headers.get('accept-ranges')!);
    if (upstream.headers.get('content-length')) res.set('Content-Length', upstream.headers.get('content-length')!);

    res.status(upstream.status);

    if (upstream.body) {
      const { Readable } = await import('node:stream');
      // @ts-ignore
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error('CinePro proxy relay error:', err);
    if (!res.headersSent) {
      res.status(502).send('CinePro proxy relay failed');
    }
  }
});

app.options('/v1/proxy', (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.sendStatus(204);
});

// ==========================================
// 5. USER DATA PERSISTENCE & SYNC
// ==========================================
app.get('/api/user/data', (req: Request, res: Response) => {
  const data = readUserData();
  return res.json(data);
});

app.post('/api/user/sync', (req: Request, res: Response) => {
  try {
    const incoming = req.body;
    const current = readUserData();

    const updated: UserData = {
      watchlist: Array.isArray(incoming.watchlist) ? incoming.watchlist : current.watchlist,
      favorites: Array.isArray(incoming.favorites) ? incoming.favorites : current.favorites,
      history: Array.isArray(incoming.history) ? incoming.history : current.history,
      playbackPosition:
        incoming.playbackPosition && typeof incoming.playbackPosition === 'object'
          ? incoming.playbackPosition
          : current.playbackPosition,
      settings:
        incoming.settings && typeof incoming.settings === 'object'
          ? { ...current.settings, ...incoming.settings }
          : current.settings,
    };

    writeUserData(updated);
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('Error syncing user data:', err);
    return res.status(500).json({ error: 'Failed to sync user data' });
  }
});

// ==========================================
// 5.5 ADMIN & REAL ANALYTICS API (YOUTUBE STUDIO ENGINE)
// ==========================================

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Linotte17';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'LinotteM1704&@';

// Admin active sessions: token -> { createdAt, expiresAt, username }
const activeAdminTokens = new Map<string, { createdAt: number; expiresAt: number; username: string }>();

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.slice(7).trim();
  const session = activeAdminTokens.get(token);
  if (!session || Date.now() > session.expiresAt) {
    if (session) activeAdminTokens.delete(token);
    return res.status(401).json({ error: 'Unauthorized: Session expired or invalid' });
  }
  next();
}

// Persistent Analytics storage
const ANALYTICS_DATA_FILE = path.join(DATA_DIR, 'analytics.json');

interface AnalyticsEvent {
  id: string;
  ts: number;
  type: 'pageview' | 'play' | 'heartbeat' | 'search' | 'server_status';
  sessionId: string;
  title?: string;
  mediaType?: 'movie' | 'tv';
  season?: number;
  episode?: number;
  poster?: string;
  watchSeconds?: number;
  device?: string;
  browser?: string;
  os?: string;
  serverIndex?: number;
  serverName?: string;
  searchQuery?: string;
}

interface AnalyticsData {
  events: AnalyticsEvent[];
  lastUpdated: number;
}

let analyticsStore: AnalyticsData = {
  events: [],
  lastUpdated: Date.now(),
};

function readAnalyticsData(): AnalyticsData {
  try {
    if (fs.existsSync(ANALYTICS_DATA_FILE)) {
      const content = fs.readFileSync(ANALYTICS_DATA_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.events)) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Error reading analytics data:', e);
  }
  return { events: [], lastUpdated: Date.now() };
}

analyticsStore = readAnalyticsData();

let saveAnalyticsTimeout: NodeJS.Timeout | null = null;
function scheduleSaveAnalytics() {
  if (saveAnalyticsTimeout) return;
  saveAnalyticsTimeout = setTimeout(() => {
    saveAnalyticsTimeout = null;
    try {
      analyticsStore.lastUpdated = Date.now();
      // Cap at 20,000 events to prevent disk bloating while preserving rich real history
      if (analyticsStore.events.length > 20000) {
        analyticsStore.events = analyticsStore.events.slice(-20000);
      }
      fs.writeFileSync(ANALYTICS_DATA_FILE, JSON.stringify(analyticsStore), 'utf-8');
    } catch (err) {
      console.error('Error saving analytics data:', err);
    }
  }, 2000);
}

// In-memory active live viewers tracker: sessionId -> { lastPing, title, device, mediaType, season, episode, poster }
const activeLiveViewers = new Map<
  string,
  {
    lastPing: number;
    title: string;
    device: string;
    mediaType?: string;
    season?: number;
    episode?: number;
    poster?: string;
  }
>();

// POST /api/admin/login
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days session
  activeAdminTokens.set(token, { createdAt: Date.now(), expiresAt, username: ADMIN_USERNAME });

  return res.json({
    success: true,
    token,
    expiresAt,
    username: ADMIN_USERNAME,
  });
});

// GET /api/admin/verify
app.get('/api/admin/verify', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false });
  }
  const token = authHeader.slice(7).trim();
  const session = activeAdminTokens.get(token);
  if (!session || Date.now() > session.expiresAt) {
    if (session) activeAdminTokens.delete(token);
    return res.status(401).json({ valid: false });
  }
  return res.json({ valid: true, username: session.username });
});

// POST /api/admin/logout
app.post('/api/admin/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    activeAdminTokens.delete(token);
  }
  return res.json({ success: true });
});

// POST /api/analytics/ping (Ingests real anonymous telemetry)
app.post('/api/analytics/ping', (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const {
      sessionId,
      eventType,
      title,
      mediaType,
      season,
      episode,
      poster,
      watchSeconds,
      device,
      browser,
      os,
      serverIndex,
      serverName,
      searchQuery,
    } = body;

    if (!sessionId || !eventType) {
      return res.status(400).json({ error: 'Missing sessionId or eventType' });
    }

    const now = Date.now();

    // Track active live stream state (viewer currently playing)
    if (eventType === 'heartbeat' || eventType === 'play') {
      activeLiveViewers.set(sessionId, {
        lastPing: now,
        title: title || 'Unknown Title',
        device: device || 'desktop',
        mediaType,
        season,
        episode,
        poster,
      });
    }

    // Save event
    const event: AnalyticsEvent = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random().toString(36).slice(2, 9)}`,
      ts: now,
      type: eventType,
      sessionId,
      title,
      mediaType,
      season,
      episode,
      poster,
      watchSeconds: Number(watchSeconds) || 0,
      device: device || 'desktop',
      browser: browser || 'Unknown',
      os: os || 'Unknown',
      serverIndex,
      serverName,
      searchQuery,
    };

    analyticsStore.events.push(event);
    scheduleSaveAnalytics();

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error logging analytics event:', err);
    return res.status(500).json({ error: 'Failed to record event' });
  }
});

// GET /api/admin/analytics (Computes real YouTube Studio analytics)
app.get('/api/admin/analytics', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) || '7d';
    const now = Date.now();

    // 1. Calculate live viewers (active in last 75 seconds)
    const liveTimeout = 75 * 1000;
    const currentLiveList: Array<{
      sessionId: string;
      title: string;
      device: string;
      mediaType?: string;
      season?: number;
      episode?: number;
      poster?: string;
      secondsAgo: number;
    }> = [];

    activeLiveViewers.forEach((data, sessId) => {
      const diff = now - data.lastPing;
      if (diff <= liveTimeout) {
        currentLiveList.push({
          sessionId: sessId,
          title: data.title,
          device: data.device,
          mediaType: data.mediaType,
          season: data.season,
          episode: data.episode,
          poster: data.poster,
          secondsAgo: Math.round(diff / 1000),
        });
      } else {
        // Clean up stale sessions
        activeLiveViewers.delete(sessId);
      }
    });

    const liveViewersCount = currentLiveList.length;

    // 2. Filter events by selected date range
    let cutoffTs = 0;
    if (range === 'today') {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      cutoffTs = startOfToday.getTime();
    } else if (range === '7d') {
      cutoffTs = now - 7 * 24 * 60 * 60 * 1000;
    } else if (range === '30d') {
      cutoffTs = now - 30 * 24 * 60 * 60 * 1000;
    } else {
      cutoffTs = 0; // All time
    }

    const filteredEvents = analyticsStore.events.filter((e) => e.ts >= cutoffTs);

    // 3. Aggregate totals
    const uniqueSessions = new Set<string>();
    let totalViews = 0;
    let totalWatchSeconds = 0;
    let totalSearches = 0;

    const titlesMap = new Map<
      string,
      {
        title: string;
        mediaType?: string;
        poster?: string;
        views: number;
        watchSeconds: number;
      }
    >();

    const searchQueriesMap = new Map<string, { count: number; lastSearched: number }>();
    const devicesMap: Record<string, number> = { mobile: 0, desktop: 0, tablet: 0, tv: 0 };
    const browsersMap: Record<string, number> = {};
    const osMap: Record<string, number> = {};
    const serverHealthMap: Record<string, { success: number; error: number }> = {};
    const hourlyDistribution = new Array(24).fill(0);

    // Timeline buckets: date string (YYYY-MM-DD) -> { views, watchSeconds }
    const timelineMap = new Map<string, { date: string; label: string; views: number; watchHours: number }>();

    filteredEvents.forEach((e) => {
      uniqueSessions.add(e.sessionId);

      // Devices, browsers, OS
      if (e.device) {
        const d = e.device.toLowerCase();
        if (devicesMap[d] !== undefined) devicesMap[d]++;
        else devicesMap.desktop++;
      }
      if (e.browser) {
        browsersMap[e.browser] = (browsersMap[e.browser] || 0) + 1;
      }
      if (e.os) {
        osMap[e.os] = (osMap[e.os] || 0) + 1;
      }

      // Hour of day (0-23)
      const evDate = new Date(e.ts);
      const hour = evDate.getHours();
      hourlyDistribution[hour]++;

      // Date key for timeline
      const dateKey = evDate.toISOString().slice(0, 10);
      const dateLabel = evDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (!timelineMap.has(dateKey)) {
        timelineMap.set(dateKey, { date: dateKey, label: dateLabel, views: 0, watchHours: 0 });
      }
      const dayData = timelineMap.get(dateKey)!;

      // Event types
      if (e.type === 'play') {
        totalViews++;
        dayData.views++;

        if (e.title) {
          const tKey = `${e.title}_${e.mediaType || 'movie'}`;
          if (!titlesMap.has(tKey)) {
            titlesMap.set(tKey, {
              title: e.title,
              mediaType: e.mediaType,
              poster: e.poster,
              views: 0,
              watchSeconds: 0,
            });
          }
          titlesMap.get(tKey)!.views++;
        }
      } else if (e.type === 'heartbeat') {
        const secs = e.watchSeconds || 0;
        totalWatchSeconds += secs;
        dayData.watchHours = Number((dayData.watchHours + secs / 3600).toFixed(2));

        if (e.title) {
          const tKey = `${e.title}_${e.mediaType || 'movie'}`;
          if (!titlesMap.has(tKey)) {
            titlesMap.set(tKey, {
              title: e.title,
              mediaType: e.mediaType,
              poster: e.poster,
              views: 0,
              watchSeconds: 0,
            });
          }
          titlesMap.get(tKey)!.watchSeconds += secs;
        }
      } else if (e.type === 'search') {
        totalSearches++;
        if (e.searchQuery) {
          const q = e.searchQuery.trim().toLowerCase();
          if (q) {
            const current = searchQueriesMap.get(q) || { count: 0, lastSearched: e.ts };
            searchQueriesMap.set(q, {
              count: current.count + 1,
              lastSearched: Math.max(current.lastSearched, e.ts),
            });
          }
        }
      } else if (e.type === 'server_status') {
        const sName = e.serverName || `Server ${(e.serverIndex || 0) + 1}`;
        if (!serverHealthMap[sName]) {
          serverHealthMap[sName] = { success: 0, error: 0 };
        }
        if (e.title === 'success') {
          serverHealthMap[sName].success++;
        } else {
          serverHealthMap[sName].error++;
        }
      }
    });

    // Sort Top Titles (by views, then watch seconds)
    const topTitles = Array.from(titlesMap.values())
      .sort((a, b) => b.views - a.views || b.watchSeconds - a.watchSeconds)
      .slice(0, 15)
      .map((item) => ({
        ...item,
        watchMinutes: Math.round(item.watchSeconds / 60),
        avgMinutes: item.views > 0 ? Math.round(item.watchSeconds / item.views / 60) : 0,
      }));

    // Sort Top Searches
    const topSearches = Array.from(searchQueriesMap.entries())
      .map(([query, data]) => ({ query, count: data.count, lastSearched: data.lastSearched }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Timeline array sorted by date
    const timeline = Array.from(timelineMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Recent activity feed (latest 30 events)
    const recentEvents = [...filteredEvents]
      .reverse()
      .slice(0, 30)
      .map((ev) => ({
        id: ev.id,
        ts: ev.ts,
        type: ev.type,
        title: ev.title,
        mediaType: ev.mediaType,
        season: ev.season,
        episode: ev.episode,
        poster: ev.poster,
        device: ev.device,
        browser: ev.browser,
        watchMinutes: ev.watchSeconds ? Math.round(ev.watchSeconds / 60) : 0,
        searchQuery: ev.searchQuery,
      }));

    // Server health summary
    const serverHealth = Object.entries(serverHealthMap).map(([server, stats]) => {
      const total = stats.success + stats.error;
      const rate = total > 0 ? Math.round((stats.success / total) * 100) : 100;
      return {
        server,
        success: stats.success,
        error: stats.error,
        total,
        rate,
      };
    });

    return res.json({
      success: true,
      range,
      kpis: {
        liveViewers: liveViewersCount,
        totalViews,
        totalWatchHours: Number((totalWatchSeconds / 3600).toFixed(1)),
        totalWatchMinutes: Math.round(totalWatchSeconds / 60),
        totalSearches,
        uniqueVisitors: uniqueSessions.size,
      },
      liveStreams: currentLiveList,
      timeline,
      hourlyDistribution,
      topTitles,
      topSearches,
      recentEvents,
      devices: devicesMap,
      browsers: browsersMap,
      operatingSystems: osMap,
      serverHealth,
    });
  } catch (err) {
    console.error('Error generating analytics:', err);
    return res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// ==========================================
// 6. DEV & PROD VITE STATIC INTEGRATION
// ==========================================
async function startServer() {
  const distPath = path.join(__dirname, 'dist');
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));
  const isProd = process.env.NODE_ENV === 'production' || (hasDist && process.env.NODE_ENV !== 'development');

  // Persistent downloads folder (mount target for Coolify persistent storage)
  const downloadsPath = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadsPath)) {
    try {
      fs.mkdirSync(downloadsPath, { recursive: true });
    } catch {}
  }
  app.use('/downloads', express.static(downloadsPath));

  // Android APK direct download endpoint with mobile-friendly headers
  app.get(['/download/app', '/download/apk', '/notflix.apk', '/app.apk'], (req: Request, res: Response) => {
    const candidates = [
      path.join(downloadsPath, 'notflix.apk'),
      path.join(downloadsPath, 'app.apk'),
      path.join(__dirname, 'public', 'notflix.apk'),
      path.join(distPath, 'notflix.apk'),
    ];

    let foundFile = candidates.find((p) => fs.existsSync(p));
    if (!foundFile && fs.existsSync(downloadsPath)) {
      try {
        const allFiles = fs.readdirSync(downloadsPath);
        const apk = allFiles.find((f) => f.toLowerCase().endsWith('.apk'));
        if (apk) foundFile = path.join(downloadsPath, apk);
      } catch {}
    }

    if (foundFile) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="Notflix.apk"');
      return res.sendFile(foundFile);
    }

    res.status(404).send('APK file not uploaded yet. Place your .apk file in the /app/downloads persistent storage folder.');
  });

  // Search Engine Optimization (SEO) Endpoints for Googlebot & Crawlers
  const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://notflixtv.com/</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://notflixtv.com/movies</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://notflixtv.com/series</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://notflixtv.com/anime</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://notflixtv.com/search</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
</urlset>`;

  const ROBOTS_TXT = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/admin/

Sitemap: https://notflixtv.com/sitemap.xml
`;

  app.get('/robots.txt', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.status(200).send(ROBOTS_TXT);
  });

  app.get('/sitemap.xml', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.status(200).send(SITEMAP_XML);
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('⚡ Vite dev middleware attached in development mode');
  } else {
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          } else if (filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log(`📦 Serving production build from ${distPath}`);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Notflix Full-Stack Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
