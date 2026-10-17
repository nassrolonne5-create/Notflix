import express from 'express';
import type { Request, Response, NextFunction } from 'express';
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

const SCRAPER_API_CINEPRO = (process.env.SCRAPER_CINEPRO_URL || 'http://62.171.179.144:3001').replace(/^https:\/\//i, 'http://');
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

// ============================================================================
// Anti-Bot, Anti-Scraping & Stream Protection Subsystem
// ============================================================================
const STREAM_SECURITY_SECRET =
  process.env.STREAM_SECURITY_SECRET ||
  'notflix-stream-secret-' + crypto.randomBytes(16).toString('hex');

// Legitimate Search Engine Crawler Whitelist (Preserves SEO and favicon indexing)
const SEARCH_ENGINE_BOTS = [
  /googlebot/i,
  /bingbot/i,
  /bingpreview/i,
  /duckduckbot/i,
  /yandexbot/i,
  /baiduspider/i,
  /applebot/i,
  /slurp/i,
  /linkedinbot/i,
  /twitterbot/i,
  /facebookexternalhit/i,
];

function isLegitimateSearchCrawler(userAgent: string): boolean {
  if (!userAgent) return false;
  return SEARCH_ENGINE_BOTS.some((pattern) => pattern.test(userAgent));
}

// Known Scraper and Headless User-Agent Signatures
const SCRAPER_USER_AGENTS = [
  /python-requests/i,
  /aiohttp/i,
  /scrapy/i,
  /urllib/i,
  /curl\//i,
  /wget\//i,
  /headlesschrome/i,
  /phantomjs/i,
  /go-http-client/i,
  /libwww-perl/i,
  /httpclient/i,
  /postmanruntime/i,
  /node-fetch\//i,
  /got\//i,
  /playwright/i,
  /puppeteer/i,
  /mechanize/i,
];

function isKnownScraperBot(userAgent: string): boolean {
  if (!userAgent) return true; // Missing User-Agent is standard scraper pattern
  return SCRAPER_USER_AGENTS.some((pattern) => pattern.test(userAgent));
}

interface SecurityMetrics {
  totalBlockedScrapers: number;
  totalRateLimited: number;
  totalHoneypotTrapped: number;
  recentSecurityEvents: Array<{
    ip: string;
    reason: string;
    userAgent: string;
    path: string;
    ts: number;
  }>;
}

const securityMetrics: SecurityMetrics = {
  totalBlockedScrapers: 0,
  totalRateLimited: 0,
  totalHoneypotTrapped: 0,
  recentSecurityEvents: [],
};

function recordSecurityEvent(ip: string, reason: string, userAgent: string, path: string) {
  securityMetrics.recentSecurityEvents.unshift({
    ip,
    reason,
    userAgent: (userAgent || 'unknown').slice(0, 80),
    path,
    ts: Date.now(),
  });
  if (securityMetrics.recentSecurityEvents.length > 50) {
    securityMetrics.recentSecurityEvents.pop();
  }
}

// Active bans (IP -> expiration timestamp)
const bannedIps = new Map<string, number>();

// In-Memory Sliding-Window Rate Limiters (IP -> timestamp[])
const globalApiRateLimiter = new Map<string, number[]>();
const streamRateLimiter = new Map<string, number[]>();

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function checkRateLimit(ip: string, map: Map<string, number[]>, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  let timestamps = map.get(ip) || [];
  timestamps = timestamps.filter((t) => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    map.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  map.set(ip, timestamps);
  return true;
}

// Periodic cleanup of expired rate-limit buckets
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of globalApiRateLimiter.entries()) {
    const valid = timestamps.filter((t) => now - t < 60000);
    if (valid.length === 0) globalApiRateLimiter.delete(ip);
    else globalApiRateLimiter.set(ip, valid);
  }
  for (const [ip, timestamps] of streamRateLimiter.entries()) {
    const valid = timestamps.filter((t) => now - t < 300000);
    if (valid.length === 0) streamRateLimiter.delete(ip);
    else streamRateLimiter.set(ip, valid);
  }
  for (const [ip, expireAt] of bannedIps.entries()) {
    if (now > expireAt) bannedIps.delete(ip);
  }
}, 5 * 60 * 1000);

const antiScraperMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || '';
  const now = Date.now();

  // Allow loopback / internal health checks
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.') || ip === 'localhost') {
    return next();
  }

  // 1. Check if IP is actively banned (e.g. from honeypot trap)
  const banExpiry = bannedIps.get(ip);
  if (banExpiry && now < banExpiry) {
    securityMetrics.totalBlockedScrapers++;
    recordSecurityEvent(ip, 'Banned IP (Honeypot Trigger)', userAgent, req.path);
    return res.status(403).json({
      error: 'Access denied: Automated scraping activity detected from your network.',
      code: 'SCRAPER_BLOCKED',
    });
  }

  // 2. Allow whitelisted legitimate search engine crawlers (Google, Bing)
  if (isLegitimateSearchCrawler(userAgent)) {
    return next();
  }

  // 3. Skip anti-bot checks for health check, honeypot trap itself, and admin auth endpoints
  if (
    req.path === '/health' ||
    req.path === '/api/health' ||
    req.path.startsWith('/trap') ||
    req.path.startsWith('/api/trap') ||
    req.path.startsWith('/admin') ||
    req.path.startsWith('/api/admin')
  ) {
    return next();
  }

  // 4. Block known scraper signatures and headless tools
  if (isKnownScraperBot(userAgent)) {
    securityMetrics.totalBlockedScrapers++;
    recordSecurityEvent(ip, 'Blacklisted Scraper User-Agent', userAgent, req.path);
    return res.status(403).json({
      error: 'Automated scraping forbidden. Please use a standard web browser.',
      code: 'BOT_DETECTED',
    });
  }

  // 5. Global API Rate Limiting: 120 requests per 60 seconds per IP
  const allowed = checkRateLimit(ip, globalApiRateLimiter, 120, 60 * 1000);
  if (!allowed) {
    securityMetrics.totalRateLimited++;
    recordSecurityEvent(ip, 'Global API Rate Limit Exceeded', userAgent, req.path);
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Too many requests. Please slow down and try again shortly.',
      code: 'RATE_LIMITED',
    });
  }

  next();
};

app.use('/api', antiScraperMiddleware);

// Persistent Per-Device User Data storage (strictly isolated by deviceId)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USER_PROFILES_FILE = path.join(DATA_DIR, 'user_profiles.json');
const LEGACY_GLOBAL_USER_DATA_FILE = path.join(DATA_DIR, 'userdata.json');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('Error creating data directory:', e);
  }
}

// Clean up any legacy global userdata.json so global watch positions never leak across users
if (fs.existsSync(LEGACY_GLOBAL_USER_DATA_FILE)) {
  try {
    fs.unlinkSync(LEGACY_GLOBAL_USER_DATA_FILE);
  } catch (e) {
    console.warn('Could not remove legacy global userdata.json:', e);
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

function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function readAllUserProfiles(): Record<string, UserData & { updatedAt?: number }> {
  try {
    if (fs.existsSync(USER_PROFILES_FILE)) {
      const content = fs.readFileSync(USER_PROFILES_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('Could not read user profiles file, returning empty map', err);
  }
  return {};
}

function readUserData(deviceId: string | null): UserData {
  if (!deviceId) return defaultUserData;
  const profiles = readAllUserProfiles();
  const parsed = profiles[deviceId];
  if (!parsed) return defaultUserData;
  return {
    watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
    favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    history: Array.isArray(parsed.history) ? parsed.history : [],
    playbackPosition:
      parsed.playbackPosition && typeof parsed.playbackPosition === 'object'
        ? parsed.playbackPosition
        : {},
    settings: {
      ...defaultUserData.settings,
      ...(parsed.settings || {}),
    },
  };
}

function writeUserData(deviceId: string | null, data: UserData) {
  if (!deviceId) return;
  try {
    const profiles = readAllUserProfiles();
    profiles[deviceId] = {
      ...data,
      updatedAt: Date.now(),
    };
    // Cap stored device profiles to 2000 most recently active devices
    const keys = Object.keys(profiles);
    if (keys.length > 2000) {
      keys
        .sort((a, b) => (profiles[a].updatedAt || 0) - (profiles[b].updatedAt || 0))
        .slice(0, keys.length - 2000)
        .forEach((k) => delete profiles[k]);
    }
    fs.writeFileSync(USER_PROFILES_FILE, JSON.stringify(profiles), 'utf-8');
  } catch (err) {
    console.error('Failed to write user profiles file:', err);
  }
}

// Server-side SafeFilter matching client constitution
// Blocks pornography, erotic movies/shows, and suggestive themes WITHOUT blocking violent/bloody action movies, mainstream animation, or family romance subplots
const ADULT_BLOCKLIST = [
  'erotic', 'erotica', 'nsfw', 'porn', 'pornography', 'xxx', 'sensuality', 'softcore', 'hardcore porn',
  'adult content', 'strip club', 'striptease', 'sexuality', 'fifty shades', 'nude', 'nudity', 'lust',
  'seduction', 'kama sutra', 'playboy', 'penthouse', 'brazzers', 'bangbros', 'busty', 'milf',
  'stepmom', 'stepmommy', 'stepdad', 'stepsister', 'stepbrother', 'incest', 'taboo sex', 'fetish',
  'bdsm', 'bondage', 'gay', 'lesbian', 'homosexual', 'queer', 'lgbt', 'bisexual', 'transgender',
  'orgasm', 'menage a trois', 'threesome', 'infidelity', 'passionate affair', '365 days', '365 dni',
  'voyeur', 'erotic thriller', 'hentai', 'ecchi'
];
const safePattern = new RegExp(
  `\\b(${ADULT_BLOCKLIST.join('|')})\\b|\\bsex(?!\\s*(trafficking|crime|worker|trade|slave))\\b`,
  'i'
);

const ADULT_KEYWORDS = [
  'erotic', 'erotica', 'pornography', 'porn', 'softcore', 'hardcore porn',
  'explicit sex', 'unsimulated sex', 'sexual content', 'bdsm', 'erotic thriller',
  'fetish', 'kama sutra', 'masturbation', 'orgasm', 'hentai', 'ecchi', 'nude', 'nudity',
  'penetration', 'seduction', 'menage a trois', 'threesome', 'infidelity',
  'gay', 'lesbian', 'lgbt', 'gay theme', 'sexuality', 'sensuality', 'lust', 'sexy',
  'striptease', 'voyeur', 'adultery', 'erotic drama', 'erotic comedy'
];
const kwPattern = new RegExp(`\\b(${ADULT_KEYWORDS.join('|')})\\b`, 'i');

const EXPLICIT_ADULT_KEYWORDS = [
  'erotic', 'erotica', 'pornography', 'porn', 'softcore', 'hardcore porn',
  'explicit sex', 'unsimulated sex', 'sexual content', 'bdsm', 'fetish',
  'kama sutra', 'masturbation', 'orgasm', 'hentai', 'ecchi', 'nude', 'nudity',
  'penetration', 'menage a trois', 'threesome'
];
const explicitKwPattern = new RegExp(`\\b(${EXPLICIT_ADULT_KEYWORDS.join('|')})\\b`, 'i');

function isSafe(item: any): boolean {
  if (!item) return false;
  if (item.error) return false;
  if (item.adult === true || item.adult === 'true') return false;

  const isAnimation =
    (item.genre_ids && Array.isArray(item.genre_ids) && (item.genre_ids.includes(16) || item.genre_ids.includes(10751))) ||
    (item.genres && Array.isArray(item.genres) && item.genres.some((g: any) => g.id === 16 || g.id === 10751 || (g.name && (g.name.toLowerCase() === 'animation' || g.name.toLowerCase() === 'family'))));

  // Romance genre 10749 filter: Animation & Family titles are exempt from genre 10749 blocking
  if (!isAnimation) {
    if (item.genre_ids && Array.isArray(item.genre_ids) && item.genre_ids.includes(10749)) return false;
    if (item.genres && Array.isArray(item.genres) && item.genres.some((g: any) => g.id === 10749 || (g.name && g.name.toLowerCase() === 'romance'))) return false;
  }

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
  const kwTester = isAnimation ? explicitKwPattern : kwPattern;
  if (kwds.some((k: any) => kwTester.test(k.name))) return false;

  return true;
}

// ==========================================
// 1. HEALTH CHECK
// ==========================================
app.get(['/api/health', '/health', '/healthz'], (req: Request, res: Response) => {
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
    const isAnimationOrTitleQuery =
      queryParams.get('with_genres')?.includes('16') ||
      queryParams.get('with_genres')?.includes('10751') ||
      queryParams.get('with_keywords')?.includes('210024') ||
      tmdbPath.includes('search') ||
      tmdbPath.startsWith('movie/') ||
      tmdbPath.startsWith('tv/');

    if (!isAnimationOrTitleQuery && !queryParams.has('without_genres')) {
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
    console.warn('TMDB Proxy Error:', err?.message || err);
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

      // Filter out permanently broken dead domains with no DNS
      if (
        urlLower.includes('streamflixserver.site')
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

      let headers = s?.headers && typeof s.headers === 'object' ? { ...s.headers } : null;

      // Ensure Vidrock / BoomChick streams include required Referer header (vidrock.to/vidrock.net/vidrock.ru)
      if (urlLower.includes('boomchick') || provLower.includes('vidrock') || urlLower.includes('sprintspeedlight')) {
        headers = {
          Referer: 'https://vidrock.to/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...(headers || {}),
        };
        if (!headers.Referer) {
          headers.Referer = 'https://vidrock.to/';
        }
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

      // Build streaming proxy URL for streams that require custom headers or restricted CDNs
      const isPriorityProxyStream =
        urlLower.includes('crmseraph') ||
        urlLower.includes('1x2.space') ||
        urlLower.includes('mov3.4pa.top') ||
        urlLower.includes('neward.cyou') ||
        urlLower.includes('professionaladvisory.sbs') ||
        urlLower.includes('boomchick') ||
        urlLower.includes('sprintspeedlight') ||
        provLower.includes('vidrock') ||
        provLower.includes('icefy') ||
        provLower.includes('orion') ||
        provLower.includes('lmscript') ||
        provLower.includes('lm script');

      let proxyUrl = '';
      if (
        !streamUrl.startsWith('/v1/proxy') &&
        (isPriorityProxyStream ||
          headers ||
          urlLower.includes('boomchick') ||
          urlLower.includes('sprintspeedlight') ||
          urlLower.includes('hakunaymatata') ||
          urlLower.includes('flwuok') ||
          urlLower.includes('flcwuk') ||
          urlLower.includes('hbsxcn') ||
          urlLower.includes('flowxn') ||
          urlLower.includes('fsonxn') ||
          urlLower.includes('111477.xyz') ||
          urlLower.includes('devcorp.me'))
      ) {
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

      // Attach auto-skip offset for streams with known black leaders (e.g. FIL 1 on professionaladvisory.sbs)
      let intro = s?.intro;
      if (!intro && (urlLower.includes('professionaladvisory') || urlLower.includes('master.txt'))) {
        intro = { start: 0, end: 28 };
      }

      return {
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
      };
    })
    .filter((s): s is NonNullable<typeof s> => Boolean(s && s.url && (s.url.startsWith('http') || s.url.startsWith('/v1/proxy') || s.url.startsWith('/api/proxy'))));
}

function getStreamDeduplicationKey(s: any): string {
  if (!s || !s.url) return '';
  const url = String(s.url || '').trim();
  const rawProv = s.provider || s.source || s.name || '';
  const prov =
    typeof rawProv === 'object' && rawProv !== null
      ? String(rawProv.name || rawProv.id || '').trim().toLowerCase()
      : String(rawProv).trim().toLowerCase();
  const q = String(s.quality || 'AUTO').trim().toUpperCase();
  const cleanUrl = url.toLowerCase().split('?')[0].trim();
  return `${prov}_${q}_${cleanUrl}`;
}

// Process streams preserving natural discovery order without server bias or blocking network probes
async function rankStreams(streams: any[], _isTV = false): Promise<any[]> {
  if (!Array.isArray(streams) || streams.length === 0) return [];

  // Deduplicate exact same provider + quality + URL duplicates
  const seenUrls = new Set<string>();
  const uniqueStreams: any[] = [];
  for (const s of streams) {
    if (!s || !s.url) continue;
    const urlKey = getStreamDeduplicationKey(s);
    if (!seenUrls.has(urlKey)) {
      seenUrls.add(urlKey);
      uniqueStreams.push(s);
    }
  }

  if (uniqueStreams.length === 0) return [];

  // Keep ALL discovered streams (restores full 40-70+ server counts!)
  return uniqueStreams.map((s, idx) => {
    const anonymousName = `Server ${idx + 1}`;
    const cleaned = { ...s };
    delete cleaned.rawTitle;
    delete cleaned.title;
    delete cleaned.name;
    delete cleaned.source;
    delete cleaned.server;
    delete cleaned.apiName;
    return {
      ...cleaned,
      provider: anonymousName,
      rawTitle: anonymousName,
      name: anonymousName,
      title: anonymousName,
    };
  });
}

// GET /api/security/stream-token - Issues short-lived HMAC token for playback
app.get('/api/security/stream-token', (req: Request, res: Response) => {
  const type = (req.query.type as string) || 'movie';
  const id = (req.query.id as string) || '0';
  const ip = getClientIp(req);

  const ts = Date.now();
  const signature = crypto
    .createHmac('sha256', STREAM_SECURITY_SECRET)
    .update(`${ts}:${type}:${id}:${ip}`)
    .digest('hex');

  const token = `${ts}.${signature}`;
  return res.json({
    token,
    expiresAt: ts + 90000,
  });
});

// GET /api/trap/probe - Honeypot Trap for automated DOM scrapers
app.get('/api/trap/probe', (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || '';
  // Ban IP for 24 hours
  bannedIps.set(ip, Date.now() + 24 * 60 * 60 * 1000);
  securityMetrics.totalHoneypotTrapped++;
  recordSecurityEvent(ip, 'Honeypot Trap Triggered', userAgent, req.path);
  console.warn(`🚨 Anti-Scraper Honeypot triggered by ${ip} (UA: ${userAgent})`);
  return res.status(403).json({
    error: 'Access blocked: Automated crawler activity detected.',
    code: 'TRAP_TRIGGERED',
  });
});

app.get('/api/streams/:type/:id', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const ip = getClientIp(req);
    const userAgent = (req.headers['user-agent'] as string) || '';

    // 1. Stream Rate Limit: Max 30 stream resolutions per 5 minutes per IP
    const streamAllowed = checkRateLimit(ip, streamRateLimiter, 30, 5 * 60 * 1000);
    if (!streamAllowed) {
      securityMetrics.totalRateLimited++;
      recordSecurityEvent(ip, 'Stream Rate Limit Exceeded', userAgent, req.path);
      res.setHeader('Retry-After', '120');
      return res.status(429).json({
        error: 'Stream resolution limit reached. Please wait before switching streams.',
        code: 'STREAM_RATE_LIMITED',
      });
    }

    // 2. Token Signature & Hotlink Protection Check
    const token = (req.query.token as string) || (req.headers['x-stream-token'] as string);
    let isTokenValid = false;
    if (token && token.includes('.')) {
      const [tsStr, sig] = token.split('.');
      const tokenTs = parseInt(tsStr, 10);
      const age = Date.now() - tokenTs;
      if (!isNaN(tokenTs) && age >= 0 && age <= 120000) {
        const expectedSigWithIp = crypto
          .createHmac('sha256', STREAM_SECURITY_SECRET)
          .update(`${tokenTs}:${type}:${id}:${ip}`)
          .digest('hex');
        const expectedSigGeneral = crypto
          .createHmac('sha256', STREAM_SECURITY_SECRET)
          .update(`${tokenTs}:${type}:${id}`)
          .digest('hex');

        if (sig === expectedSigWithIp || sig === expectedSigGeneral) {
          isTokenValid = true;
        }
      }
    }

    // Referer / Origin verification for hotlinking prevention
    const referer = (req.headers['referer'] as string) || '';
    const host = (req.headers['host'] as string) || '';
    const isDirectBrowser =
      !referer ||
      referer.includes(host) ||
      referer.includes('localhost') ||
      referer.includes('127.0.0.1') ||
      referer.includes('run.app');

    if (!isTokenValid && !isDirectBrowser) {
      securityMetrics.totalBlockedScrapers++;
      recordSecurityEvent(ip, 'Hotlinking / Invalid Stream Token', userAgent, req.path);
      return res.status(403).json({
        error: 'Unauthorized stream request. Direct scraping or hotlinking is prohibited.',
        code: 'STREAM_FORBIDDEN',
      });
    }
    const isTV = type === 'tv';
    const s = parseInt((req.query.s as string) || '1', 10);
    const e = parseInt((req.query.e as string) || '1', 10);
    const forceRefresh = req.query.refresh === '1' || req.query._t !== undefined;

    const cacheKey = `streams-${type}-${id}-${s}-${e}`;
    const cached = apiCache.get(cacheKey);
    // Use 15m TTL for valid streams, and 35s negative cache for empty results to prevent duplicate scraper hammering
    if (!forceRefresh && cached) {
      const isZero = Array.isArray(cached.data?.streams) && cached.data.streams.length === 0;
      const ttl = isZero ? 35 * 1000 : 15 * 60 * 1000;
      if (Date.now() - cached.timestamp < ttl) {
        if (!isZero) {
          res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
        return res.json(cached.data);
      }
    }

    const cineproUrl = isTV
      ? `${SCRAPER_API_CINEPRO}/v1/tv/${id}/seasons/${s}/episodes/${e}`
      : `${SCRAPER_API_CINEPRO}/v1/movies/${id}`;

    const tmdbEmbedUrl = isTV
      ? `${SCRAPER_API_TMDB_EMBED}/api/streams/series/${id}?s=${s}&e=${e}`
      : `${SCRAPER_API_TMDB_EMBED}/api/streams/movie/${id}`;

    // Parallel Dual-Engine Scraping: CinePro + TMDB Embed (Port 3005)
    const cineproTask = fetchWithTimeout(cineproUrl, 7500);
    const tmdbTask =
      SCRAPER_API_TMDB_EMBED && SCRAPER_API_TMDB_EMBED !== SCRAPER_API_CINEPRO
        ? fetchWithTimeout(tmdbEmbedUrl, 10000)
        : Promise.resolve(null);

    let combined: any[] = [];

    // Wait for CinePro first (typically returns in 0.3s - 3.5s with 30-50 streams)
    const cineproData = await cineproTask.catch(() => null);
    if (cineproData) {
      combined = combined.concat(normalizeStreams(cineproData, 'CinePro'));
      if (Array.isArray(cineproData.subtitles)) {
        subtitleCache.set(`${type}-${id}-${s}-${e}`, cineproData.subtitles);
      }
    }

    // If CinePro already returned a healthy pool of streams (>= 15), give TMDB Embed a 1.5s grace period
    // so we don't block playback for 12+ seconds; if TMDB Embed responds in that window, merge immediately!
    if (combined.length >= 15) {
      const quickTmdb: any = await Promise.race([
        tmdbTask,
        new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1500)),
      ]);
      if (quickTmdb && quickTmdb !== 'TIMEOUT') {
        const tmdbStreams = normalizeStreams(quickTmdb, 'TMDB Embed');
        combined = combined.concat(tmdbStreams);
        if (Array.isArray(quickTmdb.streams)) {
          for (const sItem of quickTmdb.streams) {
            if (Array.isArray(sItem.subtitles) && sItem.subtitles.length > 0) {
              subtitleCache.set(`${type}-${id}-${s}-${e}`, sItem.subtitles);
              break;
            }
          }
        }
      } else {
        // Background merge: when TMDB Embed finishes in background, merge into apiCache
        tmdbTask
          .then((bgTmdb) => {
            if (bgTmdb) {
              const extra = normalizeStreams(bgTmdb, 'TMDB Embed');
              if (extra.length > 0) {
                rankStreams([...combined, ...extra], isTV).then((merged) => {
                  apiCache.set(cacheKey, {
                    timestamp: Date.now(),
                    data: { success: true, count: merged.length, streams: merged },
                  });
                });
              }
            }
          })
          .catch(() => {});
      }
    } else {
      // If CinePro had few or 0 streams, wait fully for TMDB Embed (up to 10s)
      const tmdbData = await tmdbTask.catch(() => null);
      if (tmdbData) {
        const tmdbStreams = normalizeStreams(tmdbData, 'TMDB Embed');
        combined = combined.concat(tmdbStreams);
        if (Array.isArray(tmdbData.streams)) {
          for (const sItem of tmdbData.streams) {
            if (Array.isArray(sItem.subtitles) && sItem.subtitles.length > 0) {
              subtitleCache.set(`${type}-${id}-${s}-${e}`, sItem.subtitles);
              break;
            }
          }
        }
      }
    }

    // Step 3: Coolify gateway mirror fallback if still 0
    if (combined.length === 0) {
      const query = isTV ? `?s=${s}&e=${e}` : '';
      try {
        const gatewayData = await fetchWithTimeout(
          `http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io/api/streams/${type}/${id}${query}`,
          2500
        );
        if (gatewayData && Array.isArray(gatewayData.streams) && gatewayData.streams.length > 0) {
          combined = gatewayData.streams;
        }
      } catch {}
    }

    // Rank candidate streams without server prioritizing, deduplicated, fast-verified and capped
    const sorted = await rankStreams(combined, isTV);

    const responseData = {
      success: true,
      count: sorted.length,
      streams: sorted,
    };

    // Store in cache (valid for 15m if streams found, 35s negative cache if 0 found)
    apiCache.set(cacheKey, { timestamp: Date.now(), data: responseData });

    if (sorted.length > 0) {
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    } else {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=30');
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
    console.warn('Subtitles search error:', err?.message || err);
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
    console.warn('Subtitle proxy error:', err?.message || err);
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

    // Forward CinePro proxy URLs directly to CinePro remote proxy with original queryString
    if (targetUrl.includes('/v1/proxy')) {
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
        (req.headers['user-agent'] as string) ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
    if (customHeaders['Referer']) forwardHeaders['Referer'] = customHeaders['Referer'];
    if (customHeaders['Origin']) forwardHeaders['Origin'] = customHeaders['Origin'];

    // Auto-inject Referer for Vidrock CDN hosts and segment servers if missing
    if (!forwardHeaders['Referer']) {
      if (
        targetUrl.includes('boomchick.org') ||
        targetUrl.includes('sprintspeedlight.lol') ||
        targetUrl.includes('vidrock')
      ) {
        forwardHeaders['Referer'] = 'https://vidrock.to/';
      }
    }

    if (req.headers.range) {
      forwardHeaders['Range'] = req.headers.range as string;
    }

    const abortController = new AbortController();
    const abortTimeout = setTimeout(() => abortController.abort(), 20000);

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, {
        headers: forwardHeaders,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(abortTimeout);
    }

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const arrayBuffer = await upstream.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);

    // 1. Detect if it's an M3U8 Playlist (including disguised files like master.txt)
    const headerPrefix = buffer.subarray(0, 15).toString('utf8');
    const isM3u8Content = headerPrefix.startsWith('#EXTM3U') || headerPrefix.startsWith('#EXT');
    const isPlaylist =
      isM3u8Content ||
      targetUrl.includes('.m3u8') ||
      targetUrl.includes('master.txt') ||
      contentType.includes('mpegurl') ||
      contentType.includes('application/x-mpegURL');

    // Intercept non-M3U8 error bodies on playlist requests (e.g. LMScript "WRONG HASH!", BoomChick "Link expired", Cloudflare blocks)
    if (isPlaylist && !isM3u8Content) {
      const textPreview = buffer.subarray(0, 200).toString('utf8').trim();
      const isErrorPayload =
        textPreview.includes('WRONG HASH') ||
        textPreview.includes('Link expired') ||
        textPreview.includes('Invalid link') ||
        textPreview.includes('Forbidden') ||
        textPreview.includes('Access Denied') ||
        textPreview.includes('Cloudflare') ||
        textPreview.startsWith('<!DOCTYPE html') ||
        textPreview.startsWith('<html') ||
        buffer.length < 50;

      if (isErrorPayload) {
        console.debug('[Stream Proxy] Discarding invalid/unverified upstream playlist payload');
        res.setHeader('Content-Type', 'text/plain');
        return res.status(502).send('Upstream stream is unavailable');
      }
    }

    if (isPlaylist && buffer.length > 0) {
      const text = buffer.toString('utf8');
      if (text.includes('#EXTINF') || text.includes('#EXT-X-STREAM-INF') || text.startsWith('#EXT')) {
        const baseUrl = new URL(targetUrl);
        const lines = text.split('\n');

        // Propagate headers (especially Vidrock Referer) to all child segments
        const effectiveHeaders = { ...customHeaders };
        if (
          !effectiveHeaders['Referer'] &&
          (targetUrl.includes('boomchick.org') ||
            targetUrl.includes('sprintspeedlight.lol') ||
            targetUrl.includes('vidrock'))
        ) {
          effectiveHeaders['Referer'] = 'https://vidrock.to/';
        }

        const rewritten = lines
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              if (trimmed.includes('URI="')) {
                return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                  let full = uri;
                  try {
                    full = new URL(uri, baseUrl).toString();
                  } catch (e) {}
                  return `URI="/api/proxy/stream?url=${encodeURIComponent(full)}&headers=${encodeURIComponent(
                    JSON.stringify(effectiveHeaders)
                  )}"`;
                });
              }
              return line;
            }

            // Segment or child playlist URL
            let fullUrl = trimmed;
            if (trimmed.includes('/v1/proxy') && trimmed.includes('data=')) {
              try {
                const dummy = trimmed.startsWith('http') ? trimmed : `http://127.0.0.1${trimmed}`;
                const parsed = new URL(dummy);
                const dataParam = parsed.searchParams.get('data');
                if (dataParam) {
                  const unpacked = JSON.parse(dataParam);
                  if (unpacked.url) {
                    fullUrl = unpacked.url;
                  }
                }
              } catch (e) {}
            } else {
              try {
                fullUrl = new URL(trimmed, baseUrl).toString();
              } catch (e) {}
            }

            return `/api/proxy/stream?url=${encodeURIComponent(fullUrl)}&headers=${encodeURIComponent(
              JSON.stringify(effectiveHeaders)
            )}`;
          })
          .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        return res.send(rewritten);
      }
    }

    // 2. Binary Segment Processing: Strip Fake Headers (PNG \x89PNG, ID3, GIF, JPEG, or HTML wrappers)
    const isFakeHeader =
      (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) ||
      (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ||
      (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) ||
      (buffer.length > 0 && buffer[0] !== 0x47);

    if (isFakeHeader && buffer.length > 188) {
      let syncIdx = -1;
      // Search for 3 consecutive MPEG-TS sync bytes (0x47) spaced exactly 188 bytes apart
      const maxScan = Math.min(buffer.length - 376, 4096);
      for (let i = 1; i < maxScan; i++) {
        if (buffer[i] === 0x47 && buffer[i + 188] === 0x47 && buffer[i + 376] === 0x47) {
          syncIdx = i;
          break;
        }
      }
      // Fallback: 2 consecutive sync bytes
      if (syncIdx === -1) {
        const fallbackScan = Math.min(buffer.length - 188, 4096);
        for (let i = 1; i < fallbackScan; i++) {
          if (buffer[i] === 0x47 && buffer[i + 188] === 0x47) {
            syncIdx = i;
            break;
          }
        }
      }
      // Fallback: MP4 ftyp atom box
      if (syncIdx === -1) {
        const ftypIdx = buffer.indexOf(Buffer.from('ftyp'), 0);
        if (ftypIdx >= 4 && ftypIdx <= 2048) {
          syncIdx = ftypIdx - 4;
        }
      }

      if (syncIdx > 0) {
        buffer = buffer.subarray(syncIdx);
      }
    }

    // 3. MIME Normalization for video segments (even if disguised as .woff2, .html, .png, .txt)
    if (buffer.length > 0 && buffer[0] === 0x47) {
      res.setHeader('Content-Type', 'video/mp2t');
    } else if (buffer.length > 8 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
      res.setHeader('Content-Type', 'video/mp4');
    } else if (contentType) {
      res.setHeader('Content-Type', contentType);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }

    if (upstream.headers.get('content-range')) {
      res.setHeader('Content-Range', upstream.headers.get('content-range')!);
    }
    if (upstream.headers.get('accept-ranges')) {
      res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges')!);
    }
    res.setHeader('Content-Length', buffer.length.toString());

    res.status(upstream.status);
    return res.end(buffer);
  } catch (err: any) {
    const isUnreachable =
      err?.name === 'AbortError' ||
      err?.code === 'ENOTFOUND' ||
      err?.cause?.code === 'ENOTFOUND' ||
      err?.code === 'ECONNREFUSED' ||
      err?.cause?.code === 'ECONNREFUSED' ||
      err?.code === 'ETIMEDOUT' ||
      err?.cause?.code === 'ETIMEDOUT';

    if (isUnreachable) {
      console.warn(`[Stream Proxy] Upstream unreachable (${err?.cause?.code || err?.code || err?.name})`);
    } else {
      console.warn('[Stream Proxy] Proxy issue:', err?.message || err);
    }
    if (!res.headersSent) {
      res.status(502).send('Upstream stream proxy failed');
    }
  }
});

// CinePro Proxy Relay (Eliminates Mixed Content HTTP/HTTPS blocks & direct binary unpacking)
app.all(['/v1/proxy', '/v1/proxy/*'], async (req: Request, res: Response) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    return res.sendStatus(204);
  }

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

    const abortController = new AbortController();
    const abortTimeout = setTimeout(() => abortController.abort(), 15000);

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, {
        headers: forwardHeaders,
        signal: abortController.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(abortTimeout);
    }

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const arrayBuffer = await upstream.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);

    // 1. Detect if it's an M3U8 Playlist
    const headerPrefix = buffer.subarray(0, 15).toString('utf8');
    const isM3u8Content = headerPrefix.startsWith('#EXTM3U') || headerPrefix.startsWith('#EXT');
    const isPlaylist =
      isM3u8Content ||
      targetUrl.includes('.m3u8') ||
      targetUrl.includes('master.txt') ||
      contentType.includes('mpegurl') ||
      contentType.includes('application/x-mpegURL');

    // Intercept non-M3U8 error bodies on playlist requests
    if (isPlaylist && !isM3u8Content) {
      const textPreview = buffer.subarray(0, 200).toString('utf8').trim();
      const isErrorPayload =
        textPreview.includes('WRONG HASH') ||
        textPreview.includes('Link expired') ||
        textPreview.includes('Invalid link') ||
        textPreview.includes('Forbidden') ||
        textPreview.includes('Access Denied') ||
        textPreview.includes('Cloudflare') ||
        textPreview.startsWith('<!DOCTYPE html') ||
        textPreview.startsWith('<html') ||
        buffer.length < 50;

      if (isErrorPayload) {
        console.debug('[CinePro Relay] Discarding invalid/unverified upstream playlist payload');
        res.setHeader('Content-Type', 'text/plain');
        return res.status(502).send('Upstream stream is unavailable');
      }
    }

    if (isPlaylist && buffer.length > 0) {
      const text = buffer.toString('utf8');
      if (text.includes('#EXTINF') || text.includes('#EXT-X-STREAM-INF') || text.startsWith('#EXT')) {
        const baseUrl = new URL(targetUrl);
        const lines = text.split('\n');
        const rewritten = lines
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              if (trimmed.includes('URI="')) {
                return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                  let full = uri;
                  try {
                    full = new URL(uri, baseUrl).toString();
                  } catch (e) {}
                  return `URI="/api/proxy/stream?url=${encodeURIComponent(full)}&headers=${encodeURIComponent(
                    JSON.stringify(forwardHeaders)
                  )}"`;
                });
              }
              return line;
            }

            let fullUrl = trimmed;
            if (trimmed.includes('/v1/proxy') && trimmed.includes('data=')) {
              try {
                const dummy = trimmed.startsWith('http') ? trimmed : `http://127.0.0.1${trimmed}`;
                const parsed = new URL(dummy);
                const dataParam = parsed.searchParams.get('data');
                if (dataParam) {
                  const unpacked = JSON.parse(dataParam);
                  if (unpacked.url) {
                    fullUrl = unpacked.url;
                  }
                }
              } catch (e) {}
            } else {
              try {
                fullUrl = new URL(trimmed, baseUrl).toString();
              } catch (e) {}
            }

            return `/api/proxy/stream?url=${encodeURIComponent(fullUrl)}&headers=${encodeURIComponent(
              JSON.stringify(forwardHeaders)
            )}`;
          })
          .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        return res.send(rewritten);
      }
    }

    // 2. Binary Segment Processing: Strip Fake Headers
    const isFakeHeader =
      (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) ||
      (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ||
      (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) ||
      (buffer.length > 0 && buffer[0] !== 0x47);

    if (isFakeHeader && buffer.length > 188) {
      let syncIdx = -1;
      const maxScan = Math.min(buffer.length - 376, 4096);
      for (let i = 1; i < maxScan; i++) {
        if (buffer[i] === 0x47 && buffer[i + 188] === 0x47 && buffer[i + 376] === 0x47) {
          syncIdx = i;
          break;
        }
      }
      if (syncIdx === -1) {
        const fallbackScan = Math.min(buffer.length - 188, 4096);
        for (let i = 1; i < fallbackScan; i++) {
          if (buffer[i] === 0x47 && buffer[i + 188] === 0x47) {
            syncIdx = i;
            break;
          }
        }
      }
      if (syncIdx === -1) {
        const ftypIdx = buffer.indexOf(Buffer.from('ftyp'), 0);
        if (ftypIdx >= 4 && ftypIdx <= 2048) {
          syncIdx = ftypIdx - 4;
        }
      }

      if (syncIdx > 0) {
        buffer = buffer.subarray(syncIdx);
      }
    }

    // 3. Set correct MIME type
    if (buffer.length > 0 && buffer[0] === 0x47) {
      res.setHeader('Content-Type', 'video/mp2t');
    } else if (buffer.length > 8 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
      res.setHeader('Content-Type', 'video/mp4');
    } else if (contentType) {
      res.setHeader('Content-Type', contentType);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }

    if (upstream.headers.get('content-range')) {
      res.setHeader('Content-Range', upstream.headers.get('content-range')!);
    }
    if (upstream.headers.get('accept-ranges')) {
      res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges')!);
    }
    res.setHeader('Content-Length', buffer.length.toString());

    res.status(upstream.status);
    return res.end(buffer);
  } catch (err: any) {
    console.warn('[CinePro Relay] Upstream unreachable:', err?.cause?.code || err?.code || err?.message);
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
// 5. USER DATA PERSISTENCE & SYNC (PER-DEVICE ISOLATED)
// ==========================================
app.get('/api/user/data', (req: Request, res: Response) => {
  const deviceId = sanitizeDeviceId(req.headers['x-device-id'] || req.query.deviceId);
  const data = readUserData(deviceId);
  return res.json(data);
});

app.post('/api/user/sync', (req: Request, res: Response) => {
  try {
    const incoming = req.body || {};
    const deviceId = sanitizeDeviceId(req.headers['x-device-id'] || incoming.deviceId || req.query.deviceId);
    if (!deviceId) {
      return res.json({ success: true, data: defaultUserData });
    }
    const current = readUserData(deviceId);

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

    writeUserData(deviceId, updated);
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

function sanitizeAnalyticsEvents(events: AnalyticsEvent[]): AnalyticsEvent[] {
  return events.map((ev) => {
    // If it's a known movie or explicitly marked movie
    const isMovie =
      ev.mediaType === 'movie' ||
      (!ev.mediaType && !ev.season) ||
      (ev.title && /spider-man|oppenheimer|avatar|batman|avengers|barbie|dune|gladiator|wicked|interstellar|inception|deadpool|joker/i.test(ev.title));

    if (isMovie) {
      return {
        ...ev,
        mediaType: 'movie',
        season: undefined,
        episode: undefined,
      };
    }

    if (ev.mediaType === 'tv') {
      return {
        ...ev,
        mediaType: 'tv',
        season: ev.season || 1,
        episode: ev.episode || 1,
      };
    }

    return ev;
  });
}

function readAnalyticsData(): AnalyticsData {
  const candidatePaths = [
    ANALYTICS_DATA_FILE,
    path.join(process.cwd(), 'data', 'analytics.json'),
    path.join(__dirname, 'data', 'analytics.json'),
    '/app/data/analytics.json',
    '/data/analytics.json',
  ];

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed.events) && parsed.events.length > 0) {
          console.log(`📊 Loaded analytics data from ${candidate} (${parsed.events.length} events)`);
          parsed.events = sanitizeAnalyticsEvents(parsed.events);
          return parsed;
        }
      }
    } catch (e) {
      console.warn(`Could not read analytics candidate ${candidate}:`, e);
    }
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

    const isTv =
      mediaType === 'tv' &&
      !/spider-man|oppenheimer|avatar|batman|avengers|barbie|dune|gladiator|wicked|interstellar|inception|deadpool|joker/i.test(title || '');

    const normalizedMediaType: 'movie' | 'tv' | undefined =
      eventType === 'play' || eventType === 'heartbeat' ? (isTv ? 'tv' : 'movie') : undefined;

    const normalizedSeason = isTv ? (season ? Number(season) : 1) : undefined;
    const normalizedEpisode = isTv ? (episode ? Number(episode) : 1) : undefined;

    // Track active live stream state (viewer currently playing)
    if (eventType === 'heartbeat' || eventType === 'play') {
      activeLiveViewers.set(sessionId, {
        lastPing: now,
        title: title || 'Unknown Title',
        device: device || 'desktop',
        mediaType: normalizedMediaType || 'movie',
        season: normalizedSeason,
        episode: normalizedEpisode,
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
      mediaType: normalizedMediaType,
      season: normalizedSeason,
      episode: normalizedEpisode,
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

    return res.json({ success: true });
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
      platform?: string;
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
        if (devicesMap[d] !== undefined) {
          devicesMap[d]++;
        } else {
          devicesMap.desktop++;
        }
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
          const effectiveMediaType: 'movie' | 'tv' = e.mediaType === 'tv' ? 'tv' : 'movie';
          const tKey = `${e.title}_${effectiveMediaType}`;
          if (!titlesMap.has(tKey)) {
            titlesMap.set(tKey, {
              title: e.title,
              mediaType: effectiveMediaType,
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
          const effectiveMediaType: 'movie' | 'tv' = e.mediaType === 'tv' ? 'tv' : 'movie';
          const tKey = `${e.title}_${effectiveMediaType}`;
          if (!titlesMap.has(tKey)) {
            titlesMap.set(tKey, {
              title: e.title,
              mediaType: effectiveMediaType,
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
      .map((ev) => {
        const effectiveMediaType: 'movie' | 'tv' | undefined =
          ev.type === 'play' || ev.type === 'heartbeat' ? (ev.mediaType === 'tv' ? 'tv' : 'movie') : undefined;
        return {
          id: ev.id,
          ts: ev.ts,
          type: ev.type,
          title: ev.title,
          mediaType: effectiveMediaType,
          season: effectiveMediaType === 'tv' ? ev.season : undefined,
          episode: effectiveMediaType === 'tv' ? ev.episode : undefined,
          poster: ev.poster,
          device: ev.device,
          browser: ev.browser,
          watchMinutes: ev.watchSeconds ? Math.round(ev.watchSeconds / 60) : 0,
          searchQuery: ev.searchQuery,
        };
      });

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
      serverHealth,
      security: {
        totalBlockedScrapers: securityMetrics.totalBlockedScrapers,
        totalRateLimited: securityMetrics.totalRateLimited,
        totalHoneypotTrapped: securityMetrics.totalHoneypotTrapped,
        activeBannedIps: bannedIps.size,
        recentEvents: securityMetrics.recentSecurityEvents.slice(0, 20),
      },
    });
  } catch (err) {
    console.error('Error generating analytics:', err);
    return res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// GET /api/admin/analytics/export (Export raw analytics.json backup)
app.get('/api/admin/analytics/export', requireAdminAuth, (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="notflix-analytics-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.send(JSON.stringify(analyticsStore, null, 2));
});

// POST /api/admin/analytics/import (Restore or merge analytics backup)
app.post('/api/admin/analytics/import', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const payload = req.body;
    let newEvents: AnalyticsEvent[] = [];
    if (Array.isArray(payload)) {
      newEvents = payload;
    } else if (payload && Array.isArray(payload.events)) {
      newEvents = payload.events;
    } else {
      return res.status(400).json({ error: 'Invalid format. Expected JSON with { events: [...] } or an array of events.' });
    }

    const existingIds = new Set(analyticsStore.events.map((e) => e.id));
    let addedCount = 0;
    for (const ev of newEvents) {
      if (ev && ev.id && !existingIds.has(ev.id)) {
        analyticsStore.events.push(ev);
        existingIds.add(ev.id);
        addedCount++;
      } else if (ev && !ev.id && ev.ts) {
        analyticsStore.events.push({ ...ev, id: crypto.randomUUID() });
        addedCount++;
      }
    }

    analyticsStore.events.sort((a, b) => a.ts - b.ts);
    analyticsStore.lastUpdated = Date.now();

    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(ANALYTICS_DATA_FILE, JSON.stringify(analyticsStore, null, 2), 'utf-8');
    } catch (writeErr) {
      console.error('Error persisting imported analytics:', writeErr);
    }

    return res.json({
      success: true,
      message: `Successfully imported ${addedCount} analytics events. Total in database: ${analyticsStore.events.length}`,
      importedCount: addedCount,
      totalEvents: analyticsStore.events.length,
    });
  } catch (err: any) {
    console.error('Error importing analytics:', err);
    return res.status(500).json({ error: 'Failed to import analytics: ' + (err?.message || err) });
  }
});

// Deployment version & instant cache invalidation endpoint
const SERVER_BOOT_TIME = Date.now().toString();
const DEPLOYMENT_VERSION =
  process.env.COOLIFY_COMMIT_SHA ||
  process.env.SOURCE_COMMIT ||
  process.env.GIT_COMMIT_SHA ||
  process.env.BUILD_ID ||
  SERVER_BOOT_TIME;

app.get('/api/version', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.json({
    version: DEPLOYMENT_VERSION,
    deployedAt: SERVER_BOOT_TIME,
  });
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
    return res.status(200).send(SITEMAP_XML);
  });

  // Serve static assets from public directory (favicons, manifest, robots, etc.)
  app.use(express.static(path.join(__dirname, 'public')));

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Single-Page Application (SPA) catch-all route for development mode
    app.use('*', async (req: Request, res: Response, next: NextFunction) => {
      if (req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/downloads')) {
        return next();
      }
      try {
        const indexPath = path.resolve(__dirname, 'index.html');
        let template = fs.readFileSync(indexPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        next(e);
      }
    });

    console.log('⚡ Vite dev middleware attached in development mode');
  } else {
    app.use(express.static(distPath));

    // Single-Page Application (SPA) catch-all route
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });

    console.log(`📦 Serving production build from ${distPath}`);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Notflix Full-Stack Server running on http://0.0.0.0:${PORT}`);
  });

  server.on('error', (err) => {
    console.error('❌ Server listen error:', err);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
