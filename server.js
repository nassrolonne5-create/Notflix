import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();
process.on("uncaughtException", (err) => {
  console.error("\u{1F6E1}\uFE0F Handled uncaughtException:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("\u{1F6E1}\uFE0F Handled unhandledRejection:", reason);
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
const TMDB_BASE = "https://api.themoviedb.org/3";
const DEFAULT_TMDB_KEY = "8265bd1679663a7ea12ac168da84d2e8";
const TMDB_API_KEY = process.env.TMDB_API_KEY || DEFAULT_TMDB_KEY;
const SCRAPER_API_CINEPRO = (process.env.SCRAPER_CINEPRO_URL || "http://62.171.179.144:3001").replace(/^https:\/\//i, "http://");
const SCRAPER_API_TMDB_EMBED = (process.env.SCRAPER_TMDB_EMBED_URL || process.env.SCRAPER_PRIMARY_URL || "http://62.171.179.144:3005").replace(/^https:\/\//i, "http://");
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
const apiCache = /* @__PURE__ */ new Map();
const CACHE_TTL_MS = 5 * 60 * 1e3;
const STREAM_SECURITY_SECRET = process.env.STREAM_SECURITY_SECRET || "notflix-stream-secret-" + crypto.randomBytes(16).toString("hex");
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
  /facebookexternalhit/i
];
function isLegitimateSearchCrawler(userAgent) {
  if (!userAgent) return false;
  return SEARCH_ENGINE_BOTS.some((pattern) => pattern.test(userAgent));
}
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
  /mechanize/i
];
function isKnownScraperBot(userAgent) {
  if (!userAgent) return true;
  return SCRAPER_USER_AGENTS.some((pattern) => pattern.test(userAgent));
}
const securityMetrics = {
  totalBlockedScrapers: 0,
  totalRateLimited: 0,
  totalHoneypotTrapped: 0,
  recentSecurityEvents: []
};
function recordSecurityEvent(ip, reason, userAgent, path2) {
  securityMetrics.recentSecurityEvents.unshift({
    ip,
    reason,
    userAgent: (userAgent || "unknown").slice(0, 80),
    path: path2,
    ts: Date.now()
  });
  if (securityMetrics.recentSecurityEvents.length > 50) {
    securityMetrics.recentSecurityEvents.pop();
  }
}
const bannedIps = /* @__PURE__ */ new Map();
const globalApiRateLimiter = /* @__PURE__ */ new Map();
const streamRateLimiter = /* @__PURE__ */ new Map();
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}
function checkRateLimit(ip, map, maxRequests, windowMs) {
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
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of globalApiRateLimiter.entries()) {
    const valid = timestamps.filter((t) => now - t < 6e4);
    if (valid.length === 0) globalApiRateLimiter.delete(ip);
    else globalApiRateLimiter.set(ip, valid);
  }
  for (const [ip, timestamps] of streamRateLimiter.entries()) {
    const valid = timestamps.filter((t) => now - t < 3e5);
    if (valid.length === 0) streamRateLimiter.delete(ip);
    else streamRateLimiter.set(ip, valid);
  }
  for (const [ip, expireAt] of bannedIps.entries()) {
    if (now > expireAt) bannedIps.delete(ip);
  }
}, 5 * 60 * 1e3);
const antiScraperMiddleware = (req, res, next) => {
  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] || "";
  const now = Date.now();
  if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.") || ip === "localhost") {
    return next();
  }
  const banExpiry = bannedIps.get(ip);
  if (banExpiry && now < banExpiry) {
    securityMetrics.totalBlockedScrapers++;
    recordSecurityEvent(ip, "Banned IP (Honeypot Trigger)", userAgent, req.path);
    return res.status(403).json({
      error: "Access denied: Automated scraping activity detected from your network.",
      code: "SCRAPER_BLOCKED"
    });
  }
  if (isLegitimateSearchCrawler(userAgent)) {
    return next();
  }
  if (req.path === "/health" || req.path === "/api/health" || req.path.startsWith("/trap") || req.path.startsWith("/api/trap") || req.path.startsWith("/admin") || req.path.startsWith("/api/admin")) {
    return next();
  }
  if (isKnownScraperBot(userAgent)) {
    securityMetrics.totalBlockedScrapers++;
    recordSecurityEvent(ip, "Blacklisted Scraper User-Agent", userAgent, req.path);
    return res.status(403).json({
      error: "Automated scraping forbidden. Please use a standard web browser.",
      code: "BOT_DETECTED"
    });
  }
  const allowed = checkRateLimit(ip, globalApiRateLimiter, 120, 60 * 1e3);
  if (!allowed) {
    securityMetrics.totalRateLimited++;
    recordSecurityEvent(ip, "Global API Rate Limit Exceeded", userAgent, req.path);
    res.setHeader("Retry-After", "60");
    return res.status(429).json({
      error: "Too many requests. Please slow down and try again shortly.",
      code: "RATE_LIMITED"
    });
  }
  next();
};
app.use("/api", antiScraperMiddleware);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USER_DATA_FILE = path.join(DATA_DIR, "userdata.json");
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("Error creating data directory:", e);
  }
}
const defaultUserData = {
  watchlist: [],
  favorites: [],
  history: [],
  playbackPosition: {},
  settings: {
    autoSkip: true,
    globalSubtitles: true
  }
};
function readUserData() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const content = fs.readFileSync(USER_DATA_FILE, "utf-8");
      const parsed = JSON.parse(content);
      return {
        ...defaultUserData,
        ...parsed,
        settings: {
          ...defaultUserData.settings,
          ...parsed.settings || {}
        }
      };
    }
  } catch (err) {
    console.warn("Could not read user data file, returning defaults", err);
  }
  return defaultUserData;
}
function writeUserData(data) {
  try {
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write user data file:", err);
  }
}
const ADULT_BLOCKLIST = [
  "erotic",
  "erotica",
  "nsfw",
  "porn",
  "pornography",
  "xxx",
  "sensuality",
  "softcore",
  "hardcore porn",
  "adult content",
  "strip club",
  "striptease",
  "sexuality",
  "fifty shades",
  "nude",
  "nudity",
  "lust",
  "seduction",
  "kama sutra",
  "playboy",
  "penthouse",
  "brazzers",
  "bangbros",
  "busty",
  "milf",
  "stepmom",
  "stepmommy",
  "stepdad",
  "stepsister",
  "stepbrother",
  "incest",
  "taboo sex",
  "fetish",
  "bdsm",
  "bondage",
  "gay",
  "lesbian",
  "homosexual",
  "queer",
  "lgbt",
  "bisexual",
  "transgender",
  "orgasm",
  "menage a trois",
  "threesome",
  "infidelity",
  "passionate affair",
  "365 days",
  "365 dni",
  "voyeur",
  "erotic thriller",
  "hentai",
  "ecchi"
];
const safePattern = new RegExp(
  `\\b(${ADULT_BLOCKLIST.join("|")})\\b|\\bsex(?!\\s*(trafficking|crime|worker|trade|slave))\\b`,
  "i"
);
const ADULT_KEYWORDS = [
  "erotic",
  "erotica",
  "pornography",
  "porn",
  "softcore",
  "hardcore porn",
  "explicit sex",
  "unsimulated sex",
  "sexual content",
  "bdsm",
  "erotic thriller",
  "fetish",
  "kama sutra",
  "masturbation",
  "orgasm",
  "hentai",
  "ecchi",
  "nude",
  "nudity",
  "penetration",
  "seduction",
  "menage a trois",
  "threesome",
  "infidelity",
  "gay",
  "lesbian",
  "lgbt",
  "gay theme",
  "sexuality",
  "sensuality",
  "lust",
  "sexy",
  "striptease",
  "voyeur",
  "adultery",
  "erotic drama",
  "erotic comedy"
];
const kwPattern = new RegExp(`\\b(${ADULT_KEYWORDS.join("|")})\\b`, "i");
const EXPLICIT_ADULT_KEYWORDS = [
  "erotic",
  "erotica",
  "pornography",
  "porn",
  "softcore",
  "hardcore porn",
  "explicit sex",
  "unsimulated sex",
  "sexual content",
  "bdsm",
  "fetish",
  "kama sutra",
  "masturbation",
  "orgasm",
  "hentai",
  "ecchi",
  "nude",
  "nudity",
  "penetration",
  "menage a trois",
  "threesome"
];
const explicitKwPattern = new RegExp(`\\b(${EXPLICIT_ADULT_KEYWORDS.join("|")})\\b`, "i");
function isSafe(item) {
  if (!item) return false;
  if (item.error) return false;
  if (item.adult === true || item.adult === "true") return false;
  const isAnimation = item.genre_ids && Array.isArray(item.genre_ids) && (item.genre_ids.includes(16) || item.genre_ids.includes(10751)) || item.genres && Array.isArray(item.genres) && item.genres.some((g) => g.id === 16 || g.id === 10751 || g.name && (g.name.toLowerCase() === "animation" || g.name.toLowerCase() === "family"));
  if (!isAnimation) {
    if (item.genre_ids && Array.isArray(item.genre_ids) && item.genre_ids.includes(10749)) return false;
    if (item.genres && Array.isArray(item.genres) && item.genres.some((g) => g.id === 10749 || g.name && g.name.toLowerCase() === "romance")) return false;
  }
  const title = (item.title || item.name || "").toLowerCase();
  const desc = (item.overview || item.desc || "").toLowerCase();
  if (title.includes("passion of the christ")) return true;
  if ((title === "elite" || title === "\xE9lite") && (item.origin_country?.includes("ES") || item.original_name === "\xC9lite")) {
    return false;
  }
  if (safePattern.test(title) || safePattern.test(desc)) return false;
  let kwds = [];
  if (item.keywords) {
    kwds = item.keywords.results || item.keywords.keywords || [];
  }
  const kwTester = isAnimation ? explicitKwPattern : kwPattern;
  if (kwds.some((k) => kwTester.test(k.name))) return false;
  return true;
}
app.get(["/api/health", "/health", "/healthz"], (req, res) => {
  res.json({
    status: "ok",
    service: "Notflix Backend",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    cacheEntries: apiCache.size
  });
});
app.get("/api/tmdb/*", async (req, res) => {
  try {
    const tmdbPath = req.params[0];
    const queryParams = new URLSearchParams(req.query);
    queryParams.set("api_key", TMDB_API_KEY);
    queryParams.set("language", queryParams.get("language") || "en-US");
    queryParams.set("include_adult", "false");
    const isAnimationOrTitleQuery = queryParams.get("with_genres")?.includes("16") || queryParams.get("with_genres")?.includes("10751") || queryParams.get("with_keywords")?.includes("210024") || tmdbPath.includes("search") || tmdbPath.startsWith("movie/") || tmdbPath.startsWith("tv/");
    if (!isAnimationOrTitleQuery && !queryParams.has("without_genres")) {
      queryParams.set("without_genres", "10749");
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
      return res.status(403).json({ error: "This title is restricted by safety filters." });
    }
    apiCache.set(cacheKey, { timestamp: Date.now(), data });
    return res.json(data);
  } catch (err) {
    console.warn("TMDB Proxy Error:", err?.message || err);
    return res.status(500).json({ error: "Failed to fetch from TMDB" });
  }
});
async function fetchWithTimeout(url, ms = 25e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}
async function fetchWithRetry(url, ms = 25e3, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const data = await fetchWithTimeout(url, ms);
    if (data) {
      const hasStreams = Array.isArray(data.streams) && data.streams.length > 0 || Array.isArray(data.sources) && data.sources.length > 0 || Array.isArray(data.results) && data.results.length > 0 || Array.isArray(data.data) && data.data.length > 0;
      if (hasStreams) return data;
      if (attempt === maxRetries) return data;
    }
    if (attempt < maxRetries) {
      console.log(`[Scraper Retry] API timeout or empty response from ${url.slice(0, 60)}... Auto-retrying (Attempt ${attempt + 2}/${maxRetries + 1})...`);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  return null;
}
const subtitleCache = /* @__PURE__ */ new Map();
function normalizeStreams(data, apiName) {
  let list = [];
  if (!data) return list;
  if (Array.isArray(data.streams)) list = data.streams;
  else if (Array.isArray(data.sources)) list = data.sources;
  else if (Array.isArray(data.results)) list = data.results;
  else if (Array.isArray(data.data)) list = data.data;
  else if (Array.isArray(data)) list = data;
  return list.map((s) => {
    const rawProvider = s?.provider;
    const providerName = rawProvider && typeof rawProvider === "object" ? rawProvider.name || rawProvider.id || apiName : rawProvider || s.source || s.name || apiName;
    let streamUrl = s?.url || s?.stream_url || s?.link || s?.playlist || "";
    streamUrl = streamUrl.replace(/http:\/\/localhost:(3000|10000)/g, SCRAPER_API_CINEPRO);
    streamUrl = streamUrl.replace(/http:\/\/localhost:3005/g, SCRAPER_API_TMDB_EMBED);
    streamUrl = streamUrl.replace(/&amp;/g, "&");
    streamUrl = streamUrl.replace(/^https?:\/\/62\.171\.179\.144(?::\d+)?\/v1\/proxy/i, "/v1/proxy");
    const cineproOrigin = SCRAPER_API_CINEPRO.replace(/\/+$/, "");
    if (streamUrl.startsWith(`${cineproOrigin}/v1/proxy`)) {
      streamUrl = streamUrl.slice(cineproOrigin.length);
    }
    const urlLower = streamUrl.toLowerCase();
    const provLower = String(providerName).toLowerCase();
    const titleLower = (s?.title || s?.name || "").toLowerCase();
    if (titleLower.includes("rickroll") || titleLower.includes("rick astley") || urlLower.includes("rickroll")) {
      return null;
    }
    if (urlLower.includes("streamflixserver.site")) {
      return null;
    }
    if (Boolean(s?.isEmbed) || s?.type === "embed" || s?.type === "iframe" || urlLower.includes("/embed/") || urlLower.includes("/e/") || urlLower.includes("cloudorchestranova") || urlLower.includes("vidsrc") || urlLower.includes("autoembed") || urlLower.includes("2embed") || urlLower.includes("superembed") || urlLower.includes("multiembed") || urlLower.includes("embed.su") || urlLower.includes("player.") || urlLower.includes("vidlink")) {
      return null;
    }
    let headers = s?.headers && typeof s.headers === "object" ? { ...s.headers } : null;
    if (urlLower.includes("boomchick") || provLower.includes("vidrock") || urlLower.includes("sprintspeedlight")) {
      headers = {
        Referer: "https://vidrock.to/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...headers || {}
      };
      if (!headers.Referer) {
        headers.Referer = "https://vidrock.to/";
      }
    }
    const isDASH = Boolean(s?.isDASH) || s?.type === "dash" || s?.type === "mpd" || urlLower.includes(".mpd");
    const isM3U8 = !isDASH && (s?.type === "hls" || s?.type === "m3u8" || urlLower.includes(".m3u8") || !urlLower.match(/\.(mp4|webm|mkv|ogg|mov)$/i) && !urlLower.includes(".mpd"));
    const isPriorityProxyStream = urlLower.includes("crmseraph") || urlLower.includes("1x2.space") || urlLower.includes("mov3.4pa.top") || urlLower.includes("neward.cyou") || urlLower.includes("professionaladvisory.sbs") || urlLower.includes("boomchick") || urlLower.includes("sprintspeedlight") || provLower.includes("vidrock") || provLower.includes("icefy") || provLower.includes("orion") || provLower.includes("lmscript") || provLower.includes("lm script");
    let proxyUrl = "";
    if (!streamUrl.startsWith("/v1/proxy") && (isPriorityProxyStream || headers || urlLower.includes("boomchick") || urlLower.includes("sprintspeedlight") || urlLower.includes("hakunaymatata") || urlLower.includes("flwuok") || urlLower.includes("flcwuk") || urlLower.includes("hbsxcn") || urlLower.includes("flowxn") || urlLower.includes("fsonxn") || urlLower.includes("111477.xyz") || urlLower.includes("devcorp.me"))) {
      proxyUrl = `/api/proxy/stream?url=${encodeURIComponent(streamUrl)}${headers ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : ""}`;
    }
    const quality = (s?.quality || s?.resolution || s?.label || "AUTO").toUpperCase();
    const rawTitle = [s?.name, s?.title].filter(Boolean).join(" \xB7 ") || "";
    const rawLang = s?.lang || s?.language || s?.audio || rawTitle.match(/\b(ENG|ENGLISH|PUNJABI|KANNADA|MALAYALAM|TELUGU|TAMIL|BENGALI|MARATHI|GUJARATI|URDU|HINDI|LATINO|ESPANOL|SPANISH|CASTILIAN|FRENCH|VF|VFF|RUSSIAN|GERMAN|DEUTSCH|ITALIAN|MULTI|DUAL)\b/i)?.[0] || "Unknown";
    let intro = s?.intro;
    if (!intro && (urlLower.includes("professionaladvisory") || urlLower.includes("master.txt"))) {
      intro = { start: 0, end: 28 };
    }
    return {
      url: streamUrl,
      proxyUrl: proxyUrl || void 0,
      headers: headers || void 0,
      quality,
      provider: providerName,
      intro,
      apiName,
      isM3U8,
      isDASH,
      rawTitle,
      language: rawLang
    };
  }).filter((s) => Boolean(s && s.url && (s.url.startsWith("http") || s.url.startsWith("/v1/proxy") || s.url.startsWith("/api/proxy"))));
}
function getStreamDeduplicationKey(s) {
  if (!s || !s.url) return "";
  const url = String(s.url || "").trim();
  const rawProv = s.provider || s.source || s.name || "";
  const prov = typeof rawProv === "object" && rawProv !== null ? String(rawProv.name || rawProv.id || "").trim().toLowerCase() : String(rawProv).trim().toLowerCase();
  const q = String(s.quality || "AUTO").trim().toUpperCase();
  const cleanUrl = url.toLowerCase().split("?")[0].trim();
  return `${prov}_${q}_${cleanUrl}`;
}
async function rankStreams(streams, _isTV = false) {
  if (!Array.isArray(streams) || streams.length === 0) return [];
  const seenUrls = /* @__PURE__ */ new Set();
  const uniqueStreams = [];
  for (const s of streams) {
    if (!s || !s.url) continue;
    const urlKey = getStreamDeduplicationKey(s);
    if (!seenUrls.has(urlKey)) {
      seenUrls.add(urlKey);
      uniqueStreams.push(s);
    }
  }
  if (uniqueStreams.length === 0) return [];
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
      title: anonymousName
    };
  });
}
app.get("/api/security/stream-token", (req, res) => {
  const type = req.query.type || "movie";
  const id = req.query.id || "0";
  const ip = getClientIp(req);
  const ts = Date.now();
  const signature = crypto.createHmac("sha256", STREAM_SECURITY_SECRET).update(`${ts}:${type}:${id}:${ip}`).digest("hex");
  const token = `${ts}.${signature}`;
  return res.json({
    token,
    expiresAt: ts + 9e4
  });
});
app.get("/api/trap/probe", (req, res) => {
  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] || "";
  bannedIps.set(ip, Date.now() + 24 * 60 * 60 * 1e3);
  securityMetrics.totalHoneypotTrapped++;
  recordSecurityEvent(ip, "Honeypot Trap Triggered", userAgent, req.path);
  console.warn(`\u{1F6A8} Anti-Scraper Honeypot triggered by ${ip} (UA: ${userAgent})`);
  return res.status(403).json({
    error: "Access blocked: Automated crawler activity detected.",
    code: "TRAP_TRIGGERED"
  });
});
app.get("/api/streams/:type/:id", async (req, res) => {
  try {
    const { type, id } = req.params;
    const ip = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "";
    const streamAllowed = checkRateLimit(ip, streamRateLimiter, 30, 5 * 60 * 1e3);
    if (!streamAllowed) {
      securityMetrics.totalRateLimited++;
      recordSecurityEvent(ip, "Stream Rate Limit Exceeded", userAgent, req.path);
      res.setHeader("Retry-After", "120");
      return res.status(429).json({
        error: "Stream resolution limit reached. Please wait before switching streams.",
        code: "STREAM_RATE_LIMITED"
      });
    }
    const token = req.query.token || req.headers["x-stream-token"];
    let isTokenValid = false;
    if (token && token.includes(".")) {
      const [tsStr, sig] = token.split(".");
      const tokenTs = parseInt(tsStr, 10);
      const age = Date.now() - tokenTs;
      if (!isNaN(tokenTs) && age >= 0 && age <= 12e4) {
        const expectedSigWithIp = crypto.createHmac("sha256", STREAM_SECURITY_SECRET).update(`${tokenTs}:${type}:${id}:${ip}`).digest("hex");
        const expectedSigGeneral = crypto.createHmac("sha256", STREAM_SECURITY_SECRET).update(`${tokenTs}:${type}:${id}`).digest("hex");
        if (sig === expectedSigWithIp || sig === expectedSigGeneral) {
          isTokenValid = true;
        }
      }
    }
    const referer = req.headers["referer"] || "";
    const host = req.headers["host"] || "";
    const isDirectBrowser = !referer || referer.includes(host) || referer.includes("localhost") || referer.includes("127.0.0.1") || referer.includes("run.app");
    if (!isTokenValid && !isDirectBrowser) {
      securityMetrics.totalBlockedScrapers++;
      recordSecurityEvent(ip, "Hotlinking / Invalid Stream Token", userAgent, req.path);
      return res.status(403).json({
        error: "Unauthorized stream request. Direct scraping or hotlinking is prohibited.",
        code: "STREAM_FORBIDDEN"
      });
    }
    const isTV = type === "tv";
    const s = parseInt(req.query.s || "1", 10);
    const e = parseInt(req.query.e || "1", 10);
    const forceRefresh = req.query.refresh === "1" || req.query._t !== void 0;
    const cacheKey = `streams-${type}-${id}-${s}-${e}`;
    const cached = apiCache.get(cacheKey);
    if (!forceRefresh && cached) {
      const isZero = Array.isArray(cached.data?.streams) && cached.data.streams.length === 0;
      const ttl = isZero ? 35 * 1e3 : 15 * 60 * 1e3;
      if (Date.now() - cached.timestamp < ttl) {
        if (!isZero) {
          res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
        return res.json(cached.data);
      }
    }
    const cineproUrl = isTV ? `${SCRAPER_API_CINEPRO}/v1/tv/${id}/seasons/${s}/episodes/${e}` : `${SCRAPER_API_CINEPRO}/v1/movies/${id}`;
    const tmdbEmbedUrl = isTV ? `${SCRAPER_API_TMDB_EMBED}/api/streams/series/${id}?s=${s}&e=${e}` : `${SCRAPER_API_TMDB_EMBED}/api/streams/movie/${id}`;
    const cineproTask = fetchWithTimeout(cineproUrl, 7500);
    const tmdbTask = SCRAPER_API_TMDB_EMBED && SCRAPER_API_TMDB_EMBED !== SCRAPER_API_CINEPRO ? fetchWithTimeout(tmdbEmbedUrl, 1e4) : Promise.resolve(null);
    let combined = [];
    const cineproData = await cineproTask.catch(() => null);
    if (cineproData) {
      combined = combined.concat(normalizeStreams(cineproData, "CinePro"));
      if (Array.isArray(cineproData.subtitles)) {
        subtitleCache.set(`${type}-${id}-${s}-${e}`, cineproData.subtitles);
      }
    }
    if (combined.length >= 15) {
      const quickTmdb = await Promise.race([
        tmdbTask,
        new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 1500))
      ]);
      if (quickTmdb && quickTmdb !== "TIMEOUT") {
        const tmdbStreams = normalizeStreams(quickTmdb, "TMDB Embed");
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
        tmdbTask.then((bgTmdb) => {
          if (bgTmdb) {
            const extra = normalizeStreams(bgTmdb, "TMDB Embed");
            if (extra.length > 0) {
              rankStreams([...combined, ...extra], isTV).then((merged) => {
                apiCache.set(cacheKey, {
                  timestamp: Date.now(),
                  data: { success: true, count: merged.length, streams: merged }
                });
              });
            }
          }
        }).catch(() => {
        });
      }
    } else {
      const tmdbData = await tmdbTask.catch(() => null);
      if (tmdbData) {
        const tmdbStreams = normalizeStreams(tmdbData, "TMDB Embed");
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
    if (combined.length === 0) {
      const query = isTV ? `?s=${s}&e=${e}` : "";
      try {
        const gatewayData = await fetchWithTimeout(
          `http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io/api/streams/${type}/${id}${query}`,
          2500
        );
        if (gatewayData && Array.isArray(gatewayData.streams) && gatewayData.streams.length > 0) {
          combined = gatewayData.streams;
        }
      } catch {
      }
    }
    const sorted = await rankStreams(combined, isTV);
    const responseData = {
      success: true,
      count: sorted.length,
      streams: sorted
    };
    apiCache.set(cacheKey, { timestamp: Date.now(), data: responseData });
    if (sorted.length > 0) {
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");
    } else {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=30");
    }
    return res.json(responseData);
  } catch {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    return res.json({ success: true, count: 0, streams: [] });
  }
});
app.get("/api/subtitles/search", async (req, res) => {
  try {
    const imdbId = req.query.imdbId;
    const tmdbId = req.query.tmdbId;
    const type = req.query.type || "movie";
    const s = req.query.s || "1";
    const e = req.query.e || "1";
    let cachedList = [];
    if (tmdbId && subtitleCache.has(`${type}-${tmdbId}-${s}-${e}`)) {
      cachedList = subtitleCache.get(`${type}-${tmdbId}-${s}-${e}`) || [];
    }
    if (cachedList.length > 0) {
      return res.json({
        subtitles: cachedList.map((c) => ({
          id: c.label || c.url,
          lang: c.label || "Unknown",
          url: c.url
        }))
      });
    }
    if (!imdbId) {
      return res.json({ subtitles: [] });
    }
    let url = "";
    if (type === "tv") {
      url = `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${s}:${e}.json`;
    } else {
      url = `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`;
    }
    const data = await fetchWithTimeout(url, 6e3).catch(() => ({ subtitles: [] }));
    return res.json(data);
  } catch (err) {
    console.warn("Subtitles search error:", err?.message || err);
    return res.json({ subtitles: [] });
  }
});
app.get("/api/subtitles/proxy", async (req, res) => {
  try {
    const subUrl = req.query.url;
    if (!subUrl) {
      return res.status(400).send("url query param required");
    }
    const response = await fetch(subUrl);
    if (!response.ok) {
      return res.status(response.status).send("Failed to fetch subtitle from upstream");
    }
    let text = await response.text();
    if (!text.trim().startsWith("WEBVTT")) {
      text = "WEBVTT\n\n" + text.replace(/\{\\([ibu])\}/g, "<$1>").replace(/\{\\\/([ibu])\}/g, "</$1>").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    }
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(text);
  } catch (err) {
    console.warn("Subtitle proxy error:", err?.message || err);
    return res.status(500).send("Error proxying subtitle");
  }
});
app.get("/api/proxy/stream", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) {
      return res.status(400).send("Missing url parameter");
    }
    let customHeaders = {};
    if (req.query.headers) {
      try {
        customHeaders = JSON.parse(req.query.headers);
      } catch (e) {
      }
    }
    let targetUrl = decodeURIComponent(rawUrl);
    if (targetUrl.includes("/v1/proxy")) {
      const queryString = targetUrl.includes("?") ? targetUrl.slice(targetUrl.indexOf("?")) : "";
      targetUrl = `${SCRAPER_API_CINEPRO}/v1/proxy${queryString}`;
    } else if (targetUrl.startsWith("/")) {
      targetUrl = `http://127.0.0.1:3000${targetUrl}`;
    }
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      return res.status(400).send("Invalid target URL scheme");
    }
    const forwardHeaders = {
      "User-Agent": customHeaders["User-Agent"] || req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      Accept: "*/*"
    };
    if (customHeaders["Referer"]) forwardHeaders["Referer"] = customHeaders["Referer"];
    if (customHeaders["Origin"]) forwardHeaders["Origin"] = customHeaders["Origin"];
    if (!forwardHeaders["Referer"]) {
      if (targetUrl.includes("boomchick.org") || targetUrl.includes("sprintspeedlight.lol") || targetUrl.includes("vidrock")) {
        forwardHeaders["Referer"] = "https://vidrock.to/";
      }
    }
    if (req.headers.range) {
      forwardHeaders["Range"] = req.headers.range;
    }
    const abortController = new AbortController();
    const abortTimeout = setTimeout(() => abortController.abort(), 2e4);
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        headers: forwardHeaders,
        signal: abortController.signal
      });
    } finally {
      clearTimeout(abortTimeout);
    }
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
    }
    const contentType = upstream.headers.get("content-type") || "";
    const arrayBuffer = await upstream.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);
    const headerPrefix = buffer.subarray(0, 15).toString("utf8");
    const isM3u8Content = headerPrefix.startsWith("#EXTM3U") || headerPrefix.startsWith("#EXT");
    const isPlaylist = isM3u8Content || targetUrl.includes(".m3u8") || targetUrl.includes("master.txt") || contentType.includes("mpegurl") || contentType.includes("application/x-mpegURL");
    if (isPlaylist && !isM3u8Content) {
      const textPreview = buffer.subarray(0, 200).toString("utf8").trim();
      const isErrorPayload = textPreview.includes("WRONG HASH") || textPreview.includes("Link expired") || textPreview.includes("Invalid link") || textPreview.includes("Forbidden") || textPreview.includes("Access Denied") || textPreview.includes("Cloudflare") || textPreview.startsWith("<!DOCTYPE html") || textPreview.startsWith("<html") || buffer.length < 50;
      if (isErrorPayload) {
        console.debug("[Stream Proxy] Discarding invalid/unverified upstream playlist payload");
        res.setHeader("Content-Type", "text/plain");
        return res.status(502).send("Upstream stream is unavailable");
      }
    }
    if (isPlaylist && buffer.length > 0) {
      const text = buffer.toString("utf8");
      if (text.includes("#EXTINF") || text.includes("#EXT-X-STREAM-INF") || text.startsWith("#EXT")) {
        const baseUrl = new URL(targetUrl);
        const lines = text.split("\n");
        const effectiveHeaders = { ...customHeaders };
        if (!effectiveHeaders["Referer"] && (targetUrl.includes("boomchick.org") || targetUrl.includes("sprintspeedlight.lol") || targetUrl.includes("vidrock"))) {
          effectiveHeaders["Referer"] = "https://vidrock.to/";
        }
        const rewritten = lines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith("#")) {
            if (trimmed.includes('URI="')) {
              return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                let full = uri;
                try {
                  full = new URL(uri, baseUrl).toString();
                } catch (e) {
                }
                return `URI="/api/proxy/stream?url=${encodeURIComponent(full)}&headers=${encodeURIComponent(
                  JSON.stringify(effectiveHeaders)
                )}"`;
              });
            }
            return line;
          }
          let fullUrl = trimmed;
          if (trimmed.includes("/v1/proxy") && trimmed.includes("data=")) {
            try {
              const dummy = trimmed.startsWith("http") ? trimmed : `http://127.0.0.1${trimmed}`;
              const parsed = new URL(dummy);
              const dataParam = parsed.searchParams.get("data");
              if (dataParam) {
                const unpacked = JSON.parse(dataParam);
                if (unpacked.url) {
                  fullUrl = unpacked.url;
                }
              }
            } catch (e) {
            }
          } else {
            try {
              fullUrl = new URL(trimmed, baseUrl).toString();
            } catch (e) {
            }
          }
          return `/api/proxy/stream?url=${encodeURIComponent(fullUrl)}&headers=${encodeURIComponent(
            JSON.stringify(effectiveHeaders)
          )}`;
        }).join("\n");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        return res.send(rewritten);
      }
    }
    const isFakeHeader = buffer.length >= 4 && buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71 || buffer.length >= 3 && buffer[0] === 73 && buffer[1] === 68 && buffer[2] === 51 || buffer.length >= 4 && buffer[0] === 71 && buffer[1] === 73 && buffer[2] === 70 && buffer[3] === 56 || buffer.length > 0 && buffer[0] !== 71;
    if (isFakeHeader && buffer.length > 188) {
      let syncIdx = -1;
      const maxScan = Math.min(buffer.length - 376, 4096);
      for (let i = 1; i < maxScan; i++) {
        if (buffer[i] === 71 && buffer[i + 188] === 71 && buffer[i + 376] === 71) {
          syncIdx = i;
          break;
        }
      }
      if (syncIdx === -1) {
        const fallbackScan = Math.min(buffer.length - 188, 4096);
        for (let i = 1; i < fallbackScan; i++) {
          if (buffer[i] === 71 && buffer[i + 188] === 71) {
            syncIdx = i;
            break;
          }
        }
      }
      if (syncIdx === -1) {
        const ftypIdx = buffer.indexOf(Buffer.from("ftyp"), 0);
        if (ftypIdx >= 4 && ftypIdx <= 2048) {
          syncIdx = ftypIdx - 4;
        }
      }
      if (syncIdx > 0) {
        buffer = buffer.subarray(syncIdx);
      }
    }
    if (buffer.length > 0 && buffer[0] === 71) {
      res.setHeader("Content-Type", "video/mp2t");
    } else if (buffer.length > 8 && buffer.subarray(4, 8).toString("latin1") === "ftyp") {
      res.setHeader("Content-Type", "video/mp4");
    } else if (contentType) {
      res.setHeader("Content-Type", contentType);
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
    }
    if (upstream.headers.get("content-range")) {
      res.setHeader("Content-Range", upstream.headers.get("content-range"));
    }
    if (upstream.headers.get("accept-ranges")) {
      res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges"));
    }
    res.setHeader("Content-Length", buffer.length.toString());
    res.status(upstream.status);
    return res.end(buffer);
  } catch (err) {
    const isUnreachable = err?.name === "AbortError" || err?.code === "ENOTFOUND" || err?.cause?.code === "ENOTFOUND" || err?.code === "ECONNREFUSED" || err?.cause?.code === "ECONNREFUSED" || err?.code === "ETIMEDOUT" || err?.cause?.code === "ETIMEDOUT";
    if (isUnreachable) {
      console.warn(`[Stream Proxy] Upstream unreachable (${err?.cause?.code || err?.code || err?.name})`);
    } else {
      console.warn("[Stream Proxy] Proxy issue:", err?.message || err);
    }
    if (!res.headersSent) {
      res.status(502).send("Upstream stream proxy failed");
    }
  }
});
app.all(["/v1/proxy", "/v1/proxy/*"], async (req, res) => {
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    return res.sendStatus(204);
  }
  try {
    const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const targetUrl = `${SCRAPER_API_CINEPRO}/v1/proxy${queryString}`;
    const forwardHeaders = {
      "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      Accept: "*/*"
    };
    if (req.headers.range) {
      forwardHeaders["Range"] = req.headers.range;
    }
    const abortController = new AbortController();
    const abortTimeout = setTimeout(() => abortController.abort(), 15e3);
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        headers: forwardHeaders,
        signal: abortController.signal,
        redirect: "follow"
      });
    } finally {
      clearTimeout(abortTimeout);
    }
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
    }
    const contentType = upstream.headers.get("content-type") || "";
    const arrayBuffer = await upstream.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);
    const headerPrefix = buffer.subarray(0, 15).toString("utf8");
    const isM3u8Content = headerPrefix.startsWith("#EXTM3U") || headerPrefix.startsWith("#EXT");
    const isPlaylist = isM3u8Content || targetUrl.includes(".m3u8") || targetUrl.includes("master.txt") || contentType.includes("mpegurl") || contentType.includes("application/x-mpegURL");
    if (isPlaylist && !isM3u8Content) {
      const textPreview = buffer.subarray(0, 200).toString("utf8").trim();
      const isErrorPayload = textPreview.includes("WRONG HASH") || textPreview.includes("Link expired") || textPreview.includes("Invalid link") || textPreview.includes("Forbidden") || textPreview.includes("Access Denied") || textPreview.includes("Cloudflare") || textPreview.startsWith("<!DOCTYPE html") || textPreview.startsWith("<html") || buffer.length < 50;
      if (isErrorPayload) {
        console.debug("[CinePro Relay] Discarding invalid/unverified upstream playlist payload");
        res.setHeader("Content-Type", "text/plain");
        return res.status(502).send("Upstream stream is unavailable");
      }
    }
    if (isPlaylist && buffer.length > 0) {
      const text = buffer.toString("utf8");
      if (text.includes("#EXTINF") || text.includes("#EXT-X-STREAM-INF") || text.startsWith("#EXT")) {
        const baseUrl = new URL(targetUrl);
        const lines = text.split("\n");
        const rewritten = lines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith("#")) {
            if (trimmed.includes('URI="')) {
              return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                let full = uri;
                try {
                  full = new URL(uri, baseUrl).toString();
                } catch (e) {
                }
                return `URI="/api/proxy/stream?url=${encodeURIComponent(full)}&headers=${encodeURIComponent(
                  JSON.stringify(forwardHeaders)
                )}"`;
              });
            }
            return line;
          }
          let fullUrl = trimmed;
          if (trimmed.includes("/v1/proxy") && trimmed.includes("data=")) {
            try {
              const dummy = trimmed.startsWith("http") ? trimmed : `http://127.0.0.1${trimmed}`;
              const parsed = new URL(dummy);
              const dataParam = parsed.searchParams.get("data");
              if (dataParam) {
                const unpacked = JSON.parse(dataParam);
                if (unpacked.url) {
                  fullUrl = unpacked.url;
                }
              }
            } catch (e) {
            }
          } else {
            try {
              fullUrl = new URL(trimmed, baseUrl).toString();
            } catch (e) {
            }
          }
          return `/api/proxy/stream?url=${encodeURIComponent(fullUrl)}&headers=${encodeURIComponent(
            JSON.stringify(forwardHeaders)
          )}`;
        }).join("\n");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        return res.send(rewritten);
      }
    }
    const isFakeHeader = buffer.length >= 4 && buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71 || buffer.length >= 3 && buffer[0] === 73 && buffer[1] === 68 && buffer[2] === 51 || buffer.length >= 4 && buffer[0] === 71 && buffer[1] === 73 && buffer[2] === 70 && buffer[3] === 56 || buffer.length > 0 && buffer[0] !== 71;
    if (isFakeHeader && buffer.length > 188) {
      let syncIdx = -1;
      const maxScan = Math.min(buffer.length - 376, 4096);
      for (let i = 1; i < maxScan; i++) {
        if (buffer[i] === 71 && buffer[i + 188] === 71 && buffer[i + 376] === 71) {
          syncIdx = i;
          break;
        }
      }
      if (syncIdx === -1) {
        const fallbackScan = Math.min(buffer.length - 188, 4096);
        for (let i = 1; i < fallbackScan; i++) {
          if (buffer[i] === 71 && buffer[i + 188] === 71) {
            syncIdx = i;
            break;
          }
        }
      }
      if (syncIdx === -1) {
        const ftypIdx = buffer.indexOf(Buffer.from("ftyp"), 0);
        if (ftypIdx >= 4 && ftypIdx <= 2048) {
          syncIdx = ftypIdx - 4;
        }
      }
      if (syncIdx > 0) {
        buffer = buffer.subarray(syncIdx);
      }
    }
    if (buffer.length > 0 && buffer[0] === 71) {
      res.setHeader("Content-Type", "video/mp2t");
    } else if (buffer.length > 8 && buffer.subarray(4, 8).toString("latin1") === "ftyp") {
      res.setHeader("Content-Type", "video/mp4");
    } else if (contentType) {
      res.setHeader("Content-Type", contentType);
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
    }
    if (upstream.headers.get("content-range")) {
      res.setHeader("Content-Range", upstream.headers.get("content-range"));
    }
    if (upstream.headers.get("accept-ranges")) {
      res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges"));
    }
    res.setHeader("Content-Length", buffer.length.toString());
    res.status(upstream.status);
    return res.end(buffer);
  } catch (err) {
    console.warn("[CinePro Relay] Upstream unreachable:", err?.cause?.code || err?.code || err?.message);
    if (!res.headersSent) {
      res.status(502).send("CinePro proxy relay failed");
    }
  }
});
app.options("/v1/proxy", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.sendStatus(204);
});
app.get("/api/user/data", (req, res) => {
  const data = readUserData();
  return res.json(data);
});
app.post("/api/user/sync", (req, res) => {
  try {
    const incoming = req.body;
    const current = readUserData();
    const updated = {
      watchlist: Array.isArray(incoming.watchlist) ? incoming.watchlist : current.watchlist,
      favorites: Array.isArray(incoming.favorites) ? incoming.favorites : current.favorites,
      history: Array.isArray(incoming.history) ? incoming.history : current.history,
      playbackPosition: incoming.playbackPosition && typeof incoming.playbackPosition === "object" ? incoming.playbackPosition : current.playbackPosition,
      settings: incoming.settings && typeof incoming.settings === "object" ? { ...current.settings, ...incoming.settings } : current.settings
    };
    writeUserData(updated);
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("Error syncing user data:", err);
    return res.status(500).json({ error: "Failed to sync user data" });
  }
});
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "Linotte17";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "LinotteM1704&@";
const activeAdminTokens = /* @__PURE__ */ new Map();
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing or invalid token" });
  }
  const token = authHeader.slice(7).trim();
  const session = activeAdminTokens.get(token);
  if (!session || Date.now() > session.expiresAt) {
    if (session) activeAdminTokens.delete(token);
    return res.status(401).json({ error: "Unauthorized: Session expired or invalid" });
  }
  next();
}
const ANALYTICS_DATA_FILE = path.join(DATA_DIR, "analytics.json");
let analyticsStore = {
  events: [],
  lastUpdated: Date.now()
};
function sanitizeAnalyticsEvents(events) {
  return events.map((ev) => {
    const isMovie = ev.mediaType === "movie" || !ev.mediaType && !ev.season || ev.title && /spider-man|oppenheimer|avatar|batman|avengers|barbie|dune|gladiator|wicked|interstellar|inception|deadpool|joker/i.test(ev.title);
    if (isMovie) {
      return {
        ...ev,
        mediaType: "movie",
        season: void 0,
        episode: void 0
      };
    }
    if (ev.mediaType === "tv") {
      return {
        ...ev,
        mediaType: "tv",
        season: ev.season || 1,
        episode: ev.episode || 1
      };
    }
    return ev;
  });
}
function readAnalyticsData() {
  const candidatePaths = [
    ANALYTICS_DATA_FILE,
    path.join(process.cwd(), "data", "analytics.json"),
    path.join(__dirname, "data", "analytics.json"),
    "/app/data/analytics.json",
    "/data/analytics.json"
  ];
  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, "utf-8");
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed.events) && parsed.events.length > 0) {
          console.log(`\u{1F4CA} Loaded analytics data from ${candidate} (${parsed.events.length} events)`);
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
let saveAnalyticsTimeout = null;
function scheduleSaveAnalytics() {
  if (saveAnalyticsTimeout) return;
  saveAnalyticsTimeout = setTimeout(() => {
    saveAnalyticsTimeout = null;
    try {
      analyticsStore.lastUpdated = Date.now();
      if (analyticsStore.events.length > 2e4) {
        analyticsStore.events = analyticsStore.events.slice(-2e4);
      }
      fs.writeFileSync(ANALYTICS_DATA_FILE, JSON.stringify(analyticsStore), "utf-8");
    } catch (err) {
      console.error("Error saving analytics data:", err);
    }
  }, 2e3);
}
const activeLiveViewers = /* @__PURE__ */ new Map();
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1e3;
  activeAdminTokens.set(token, { createdAt: Date.now(), expiresAt, username: ADMIN_USERNAME });
  return res.json({
    success: true,
    token,
    expiresAt,
    username: ADMIN_USERNAME
  });
});
app.get("/api/admin/verify", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
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
app.post("/api/admin/logout", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    activeAdminTokens.delete(token);
  }
  return res.json({ success: true });
});
app.post("/api/analytics/ping", (req, res) => {
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
      searchQuery
    } = body;
    if (!sessionId || !eventType) {
      return res.status(400).json({ error: "Missing sessionId or eventType" });
    }
    const now = Date.now();
    const isTv = mediaType === "tv" && !/spider-man|oppenheimer|avatar|batman|avengers|barbie|dune|gladiator|wicked|interstellar|inception|deadpool|joker/i.test(title || "");
    const normalizedMediaType = eventType === "play" || eventType === "heartbeat" ? isTv ? "tv" : "movie" : void 0;
    const normalizedSeason = isTv ? season ? Number(season) : 1 : void 0;
    const normalizedEpisode = isTv ? episode ? Number(episode) : 1 : void 0;
    if (eventType === "heartbeat" || eventType === "play") {
      activeLiveViewers.set(sessionId, {
        lastPing: now,
        title: title || "Unknown Title",
        device: device || "desktop",
        mediaType: normalizedMediaType || "movie",
        season: normalizedSeason,
        episode: normalizedEpisode,
        poster
      });
    }
    const event = {
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
      device: device || "desktop",
      browser: browser || "Unknown",
      os: os || "Unknown",
      serverIndex,
      serverName,
      searchQuery
    };
    analyticsStore.events.push(event);
    scheduleSaveAnalytics();
    return res.json({ success: true });
  } catch (err) {
    console.error("Error logging analytics event:", err);
    return res.status(500).json({ error: "Failed to record event" });
  }
});
app.get("/api/admin/analytics", requireAdminAuth, (req, res) => {
  try {
    const range = req.query.range || "7d";
    const now = Date.now();
    const liveTimeout = 75 * 1e3;
    const currentLiveList = [];
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
          secondsAgo: Math.round(diff / 1e3)
        });
      } else {
        activeLiveViewers.delete(sessId);
      }
    });
    const liveViewersCount = currentLiveList.length;
    let cutoffTs = 0;
    if (range === "today") {
      const startOfToday = /* @__PURE__ */ new Date();
      startOfToday.setHours(0, 0, 0, 0);
      cutoffTs = startOfToday.getTime();
    } else if (range === "7d") {
      cutoffTs = now - 7 * 24 * 60 * 60 * 1e3;
    } else if (range === "30d") {
      cutoffTs = now - 30 * 24 * 60 * 60 * 1e3;
    } else {
      cutoffTs = 0;
    }
    const filteredEvents = analyticsStore.events.filter((e) => e.ts >= cutoffTs);
    const uniqueSessions = /* @__PURE__ */ new Set();
    let totalViews = 0;
    let totalWatchSeconds = 0;
    let totalSearches = 0;
    const titlesMap = /* @__PURE__ */ new Map();
    const searchQueriesMap = /* @__PURE__ */ new Map();
    const devicesMap = { mobile: 0, desktop: 0, tablet: 0, tv: 0 };
    const browsersMap = {};
    const osMap = {};
    const serverHealthMap = {};
    const hourlyDistribution = new Array(24).fill(0);
    const timelineMap = /* @__PURE__ */ new Map();
    filteredEvents.forEach((e) => {
      uniqueSessions.add(e.sessionId);
      if (e.device) {
        const d = e.device.toLowerCase();
        if (devicesMap[d] !== void 0) {
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
      const evDate = new Date(e.ts);
      const hour = evDate.getHours();
      hourlyDistribution[hour]++;
      const dateKey = evDate.toISOString().slice(0, 10);
      const dateLabel = evDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (!timelineMap.has(dateKey)) {
        timelineMap.set(dateKey, { date: dateKey, label: dateLabel, views: 0, watchHours: 0 });
      }
      const dayData = timelineMap.get(dateKey);
      if (e.type === "play") {
        totalViews++;
        dayData.views++;
        if (e.title) {
          const effectiveMediaType = e.mediaType === "tv" ? "tv" : "movie";
          const tKey = `${e.title}_${effectiveMediaType}`;
          if (!titlesMap.has(tKey)) {
            titlesMap.set(tKey, {
              title: e.title,
              mediaType: effectiveMediaType,
              poster: e.poster,
              views: 0,
              watchSeconds: 0
            });
          }
          titlesMap.get(tKey).views++;
        }
      } else if (e.type === "heartbeat") {
        const secs = e.watchSeconds || 0;
        totalWatchSeconds += secs;
        dayData.watchHours = Number((dayData.watchHours + secs / 3600).toFixed(2));
        if (e.title) {
          const effectiveMediaType = e.mediaType === "tv" ? "tv" : "movie";
          const tKey = `${e.title}_${effectiveMediaType}`;
          if (!titlesMap.has(tKey)) {
            titlesMap.set(tKey, {
              title: e.title,
              mediaType: effectiveMediaType,
              poster: e.poster,
              views: 0,
              watchSeconds: 0
            });
          }
          titlesMap.get(tKey).watchSeconds += secs;
        }
      } else if (e.type === "search") {
        totalSearches++;
        if (e.searchQuery) {
          const q = e.searchQuery.trim().toLowerCase();
          if (q) {
            const current = searchQueriesMap.get(q) || { count: 0, lastSearched: e.ts };
            searchQueriesMap.set(q, {
              count: current.count + 1,
              lastSearched: Math.max(current.lastSearched, e.ts)
            });
          }
        }
      } else if (e.type === "server_status") {
        const sName = e.serverName || `Server ${(e.serverIndex || 0) + 1}`;
        if (!serverHealthMap[sName]) {
          serverHealthMap[sName] = { success: 0, error: 0 };
        }
        if (e.title === "success") {
          serverHealthMap[sName].success++;
        } else {
          serverHealthMap[sName].error++;
        }
      }
    });
    const topTitles = Array.from(titlesMap.values()).sort((a, b) => b.views - a.views || b.watchSeconds - a.watchSeconds).slice(0, 15).map((item) => ({
      ...item,
      watchMinutes: Math.round(item.watchSeconds / 60),
      avgMinutes: item.views > 0 ? Math.round(item.watchSeconds / item.views / 60) : 0
    }));
    const topSearches = Array.from(searchQueriesMap.entries()).map(([query, data]) => ({ query, count: data.count, lastSearched: data.lastSearched })).sort((a, b) => b.count - a.count).slice(0, 15);
    const timeline = Array.from(timelineMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const recentEvents = [...filteredEvents].reverse().slice(0, 30).map((ev) => {
      const effectiveMediaType = ev.type === "play" || ev.type === "heartbeat" ? ev.mediaType === "tv" ? "tv" : "movie" : void 0;
      return {
        id: ev.id,
        ts: ev.ts,
        type: ev.type,
        title: ev.title,
        mediaType: effectiveMediaType,
        season: effectiveMediaType === "tv" ? ev.season : void 0,
        episode: effectiveMediaType === "tv" ? ev.episode : void 0,
        poster: ev.poster,
        device: ev.device,
        browser: ev.browser,
        watchMinutes: ev.watchSeconds ? Math.round(ev.watchSeconds / 60) : 0,
        searchQuery: ev.searchQuery
      };
    });
    const serverHealth = Object.entries(serverHealthMap).map(([server, stats]) => {
      const total = stats.success + stats.error;
      const rate = total > 0 ? Math.round(stats.success / total * 100) : 100;
      return {
        server,
        success: stats.success,
        error: stats.error,
        total,
        rate
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
        uniqueVisitors: uniqueSessions.size
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
        recentEvents: securityMetrics.recentSecurityEvents.slice(0, 20)
      }
    });
  } catch (err) {
    console.error("Error generating analytics:", err);
    return res.status(500).json({ error: "Failed to compute analytics" });
  }
});
app.get("/api/admin/analytics/export", requireAdminAuth, (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="notflix-analytics-backup-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json"`);
  return res.send(JSON.stringify(analyticsStore, null, 2));
});
app.post("/api/admin/analytics/import", requireAdminAuth, (req, res) => {
  try {
    const payload = req.body;
    let newEvents = [];
    if (Array.isArray(payload)) {
      newEvents = payload;
    } else if (payload && Array.isArray(payload.events)) {
      newEvents = payload.events;
    } else {
      return res.status(400).json({ error: "Invalid format. Expected JSON with { events: [...] } or an array of events." });
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
      fs.writeFileSync(ANALYTICS_DATA_FILE, JSON.stringify(analyticsStore, null, 2), "utf-8");
    } catch (writeErr) {
      console.error("Error persisting imported analytics:", writeErr);
    }
    return res.json({
      success: true,
      message: `Successfully imported ${addedCount} analytics events. Total in database: ${analyticsStore.events.length}`,
      importedCount: addedCount,
      totalEvents: analyticsStore.events.length
    });
  } catch (err) {
    console.error("Error importing analytics:", err);
    return res.status(500).json({ error: "Failed to import analytics: " + (err?.message || err) });
  }
});
const SERVER_BOOT_TIME = Date.now().toString();
const DEPLOYMENT_VERSION = process.env.COOLIFY_COMMIT_SHA || process.env.SOURCE_COMMIT || process.env.GIT_COMMIT_SHA || process.env.BUILD_ID || SERVER_BOOT_TIME;
app.get("/api/version", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Cloudflare-CDN-Cache-Control", "no-store");
  res.json({
    version: DEPLOYMENT_VERSION,
    deployedAt: SERVER_BOOT_TIME
  });
});
async function startServer() {
  const distPath = path.join(__dirname, "dist");
  const hasDist = fs.existsSync(path.join(distPath, "index.html"));
  const isProd = process.env.NODE_ENV === "production" || hasDist && process.env.NODE_ENV !== "development";
  const downloadsPath = path.join(__dirname, "downloads");
  if (!fs.existsSync(downloadsPath)) {
    try {
      fs.mkdirSync(downloadsPath, { recursive: true });
    } catch {
    }
  }
  app.use("/downloads", express.static(downloadsPath));
  app.get(["/download/app", "/download/apk", "/notflix.apk", "/app.apk"], (req, res) => {
    const candidates = [
      path.join(downloadsPath, "notflix.apk"),
      path.join(downloadsPath, "app.apk"),
      path.join(__dirname, "public", "notflix.apk"),
      path.join(distPath, "notflix.apk")
    ];
    let foundFile = candidates.find((p) => fs.existsSync(p));
    if (!foundFile && fs.existsSync(downloadsPath)) {
      try {
        const allFiles = fs.readdirSync(downloadsPath);
        const apk = allFiles.find((f) => f.toLowerCase().endsWith(".apk"));
        if (apk) foundFile = path.join(downloadsPath, apk);
      } catch {
      }
    }
    if (foundFile) {
      res.setHeader("Content-Type", "application/vnd.android.package-archive");
      res.setHeader("Content-Disposition", 'attachment; filename="Notflix.apk"');
      return res.sendFile(foundFile);
    }
    res.status(404).send("APK file not uploaded yet. Place your .apk file in the /app/downloads persistent storage folder.");
  });
  const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://notflixtv.com/</loc>
    <lastmod>${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://notflixtv.com/movies</loc>
    <lastmod>${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://notflixtv.com/series</loc>
    <lastmod>${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://notflixtv.com/anime</loc>
    <lastmod>${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://notflixtv.com/search</loc>
    <lastmod>${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}</lastmod>
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
  app.get("/robots.txt", (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    return res.status(200).send(ROBOTS_TXT);
  });
  app.get("/sitemap.xml", (req, res) => {
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.status(200).send(SITEMAP_XML);
  });
  app.use(express.static(path.join(__dirname, "public")));
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
    app.use("*", async (req, res, next) => {
      if (req.originalUrl.startsWith("/api") || req.originalUrl.startsWith("/downloads")) {
        return next();
      }
      try {
        const indexPath = path.resolve(__dirname, "index.html");
        let template = fs.readFileSync(indexPath, "utf-8");
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e) {
        next(e);
      }
    });
    console.log("\u26A1 Vite dev middleware attached in development mode");
  } else {
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log(`\u{1F4E6} Serving production build from ${distPath}`);
  }
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`\u{1F680} Notflix Full-Stack Server running on http://0.0.0.0:${PORT}`);
  });
  server.on("error", (err) => {
    console.error("\u274C Server listen error:", err);
  });
}
startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
