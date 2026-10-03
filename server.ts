import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

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

const SCRAPER_API_PRIMARY = 'https://tmdb-embed-api-hcz6.onrender.com';
const SCRAPER_API_CINEPRO = 'https://cinepro-core-991g.onrender.com';

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
      streamUrl = streamUrl.replace('http://localhost:10000', SCRAPER_API_CINEPRO);

      // Check format
      const isM3U8 =
        !streamUrl.includes('.mp4') &&
        (streamUrl.includes('.m3u8') || !streamUrl.match(/\.(mp4|webm|mkv)/i));

      // Browser cannot play mkv files in HTML5 video
      if (streamUrl.toLowerCase().endsWith('.mkv') || s?.type === 'mkv') {
        return null;
      }

      const titleLower = (s?.title || s?.name || '').toLowerCase();
      const urlLower = streamUrl.toLowerCase();
      const provLower = String(providerName).toLowerCase();

      // Filter out obvious sample clips, troll videos, or trailers
      if (
        titleLower.includes('sample') ||
        titleLower.includes('trailer') ||
        titleLower.includes('teaser') ||
        titleLower.includes('rickroll') ||
        titleLower.includes('preview') ||
        titleLower.includes('rick astley') ||
        urlLower.includes('sample.mp4') ||
        urlLower.includes('sample.mkv') ||
        urlLower.includes('rickroll') ||
        provLower.includes('trailer')
      ) {
        return null;
      }

      const quality = (s?.quality || s?.resolution || s?.label || 'AUTO').toUpperCase();
      const rawTitle = s?.title || s?.name || '';
      const rawLang = s?.lang || s?.language || s?.audio || (rawTitle.match(/\b(ENG|ENGLISH|HINDI|LATINO|ESPANOL|FRENCH|GERMAN|RUSSIAN|MULTI|DUAL)\b/i)?.[0]) || 'English';

      return {
        url: streamUrl,
        quality,
        provider: providerName,
        intro: s?.intro,
        apiName,
        isM3U8,
        isEmbed: false,
        rawTitle,
        language: rawLang,
      };
    })
    .filter((s): s is NonNullable<typeof s> => Boolean(s && s.url && s.url.startsWith('http')));
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

    const primaryUrl = isTV
      ? `${SCRAPER_API_PRIMARY}/api/streams/tv/${id}?s=${s}&e=${e}`
      : `${SCRAPER_API_PRIMARY}/api/streams/movie/${id}`;

    const cineproUrl = isTV
      ? `${SCRAPER_API_CINEPRO}/v1/tv/${id}/seasons/${s}/episodes/${e}`
      : `${SCRAPER_API_CINEPRO}/v1/movies/${id}`;

    // Scrape from the two original APIs simultaneously
    const results = await Promise.allSettled([
      fetchWithTimeout(primaryUrl, 10000),
      fetchWithTimeout(cineproUrl, 10000),
    ]);

    let combined: any[] = [];
    if (results[0].status === 'fulfilled' && results[0].value) {
      combined = combined.concat(normalizeStreams(results[0].value, 'Primary'));
    }
    if (results[1].status === 'fulfilled' && results[1].value) {
      combined = combined.concat(normalizeStreams(results[1].value, 'CinePro'));
      if (Array.isArray(results[1].value.subtitles)) {
        subtitleCache.set(`${type}-${id}-${s}-${e}`, results[1].value.subtitles);
      }
    }

    // Rank all candidate streams with English language prioritized first
    const sorted = rankStreams(combined, isTV);

    return res.json({
      success: true,
      count: sorted.length,
      streams: sorted,
    });
  } catch (err: any) {
    console.error('Streams fetch error:', err);
    return res.status(500).json({ error: 'Failed to retrieve streams' });
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
// 6. DEV & PROD VITE STATIC INTEGRATION
// ==========================================
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('⚡ Vite dev middleware attached in development mode');
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
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
