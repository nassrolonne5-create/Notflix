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
const DATA_DIR = path.join(__dirname, "data");
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
  "romance",
  "romantic",
  "rom-com",
  "erotic",
  "sexy",
  "sensual",
  "love story",
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
  "intimate",
  "intimacy",
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
  "love triangle",
  "passionate affair",
  "365 days",
  "365 dni",
  "voyeur",
  "erotic thriller",
  "passion",
  "passionate",
  "affair",
  "affaire",
  "dating"
];
const safePattern = new RegExp(
  `\\b(${ADULT_BLOCKLIST.join("|")})\\b|\\bsex(?!\\s*(trafficking|crime|worker|trade|slave))\\b`,
  "i"
);
const ADULT_KEYWORDS = [
  "romance",
  "romantic",
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
  "love triangle",
  "gay",
  "lesbian",
  "lgbt",
  "gay theme",
  "sexuality",
  "sensuality",
  "lust",
  "sexy",
  "love story",
  "striptease",
  "voyeur",
  "intimacy",
  "adultery",
  "affair",
  "erotic drama",
  "erotic comedy"
];
const kwPattern = new RegExp(`\\b(${ADULT_KEYWORDS.join("|")})\\b`, "i");
function isSafe(item) {
  if (!item) return false;
  if (item.error) return false;
  if (item.adult === true || item.adult === "true") return false;
  if (item.genre_ids && Array.isArray(item.genre_ids) && item.genre_ids.includes(10749)) return false;
  if (item.genres && Array.isArray(item.genres) && item.genres.some((g) => g.id === 10749 || g.name && g.name.toLowerCase() === "romance")) return false;
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
  if (kwds.some((k) => kwPattern.test(k.name))) return false;
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
    if (!queryParams.has("without_genres")) {
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
    console.error("TMDB Proxy Error:", err);
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
    if (
      urlLower.includes("finepulfe.xyz") ||
      urlLower.includes("boomchick.org") ||
      urlLower.includes("streamflixserver.site")
    ) {
      return null;
    }
    if (Boolean(s?.isEmbed) || s?.type === "embed" || s?.type === "iframe" || urlLower.includes("/embed/") || urlLower.includes("/e/") || urlLower.includes("cloudorchestranova") || urlLower.includes("vidsrc") || urlLower.includes("autoembed") || urlLower.includes("2embed") || urlLower.includes("superembed") || urlLower.includes("multiembed") || urlLower.includes("embed.su") || urlLower.includes("player.") || urlLower.includes("vidlink")) {
      return null;
    }
    const headers = s?.headers && typeof s.headers === "object" ? s.headers : null;
    const isDASH = Boolean(s?.isDASH) || s?.type === "dash" || s?.type === "mpd" || urlLower.includes(".mpd");
    const isM3U8 = !isDASH && (s?.type === "hls" || s?.type === "m3u8" || urlLower.includes(".m3u8") || !urlLower.match(/\.(mp4|webm|mkv|ogg|mov)$/i) && !urlLower.includes(".mpd"));
    let proxyUrl = "";
    if (!streamUrl.startsWith("/v1/proxy") && (headers || urlLower.includes("boomchick") || urlLower.includes("hakunaymatata") || urlLower.includes("flwuok") || urlLower.includes("flcwuk") || urlLower.includes("hbsxcn") || urlLower.includes("flowxn") || urlLower.includes("fsonxn") || urlLower.includes("111477.xyz") || urlLower.includes("devcorp.me") || urlLower.includes("crmseraph") || urlLower.includes("1x2.space") || urlLower.includes("neward.cyou") || urlLower.includes("professionaladvisory.sbs"))) {
      proxyUrl = `/api/proxy/stream?url=${encodeURIComponent(streamUrl)}${headers ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : ""}`;
    }
    const quality = (s?.quality || s?.resolution || s?.label || "AUTO").toUpperCase();
    const rawTitle = s?.title || s?.name || "";
    const rawLang = s?.lang || s?.language || s?.audio || rawTitle.match(/\b(ENG|ENGLISH|HINDI|LATINO|ESPANOL|FRENCH|GERMAN|RUSSIAN|MULTI|DUAL)\b/i)?.[0] || "English";
    return {
      url: streamUrl,
      proxyUrl: proxyUrl || void 0,
      headers: headers || void 0,
      quality,
      provider: providerName,
      intro: s?.intro,
      apiName,
      isM3U8,
      isDASH,
      rawTitle,
      language: rawLang
    };
  }).filter((s) => Boolean(s && s.url && (s.url.startsWith("http") || s.url.startsWith("/v1/proxy") || s.url.startsWith("/api/proxy"))));
}
function isVidRockOrionStream(s) {
  if (!s) return false;
  const prov = (s.provider || "").toString().toLowerCase();
  const rawT = (s.rawTitle || s.title || s.name || "").toString().toLowerCase();
  const url = (s.url || "").toString().toLowerCase();
  if (prov.includes("vidrock") && (prov.includes("orion") || rawT.includes("orion") || url.includes("crmseraph"))) {
    return true;
  }
  if (rawT.includes("vidrock orion") || rawT.includes("vidrockorion") || prov.includes("vidrockorion") || prov.includes("vidrock (orion)")) {
    return true;
  }
  if (url.includes("crmseraph.site")) {
    return true;
  }
  if ((prov.includes("orion") || rawT.includes("orion")) && !prov.includes("atlas")) {
    return true;
  }
  return false;
}
function isIcefyStream(s) {
  if (!s) return false;
  const prov = (s.provider || "").toString().toLowerCase();
  const rawT = (s.rawTitle || s.title || s.name || "").toString().toLowerCase();
  const url = (s.url || "").toString().toLowerCase();
  if (prov.includes("icefy") || rawT.includes("icefy")) {
    return true;
  }
  if (url.includes("1x2.space") || url.includes("mov3.4pa.top") || url.includes("professionaladvisory.sbs")) {
    return true;
  }
  return false;
}
function isLMScriptStream(s) {
  if (!s) return false;
  const prov = (s.provider || "").toString().toLowerCase();
  const rawT = (s.rawTitle || s.title || s.name || "").toString().toLowerCase();
  const url = (s.url || "").toString().toLowerCase();
  if (prov.includes("lmscript") || prov.includes("lm script") || rawT.includes("lmscript") || rawT.includes("lm script")) {
    return true;
  }
  if (url.includes("neward.cyou")) {
    return true;
  }
  return false;
}
function rankStreams(streams, isTV) {
  const getRank = (s) => {
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
    const rawT = (s.rawTitle || "").toString().toUpperCase();
    const prov = (s.provider || "").toString().toUpperCase();
    const lang = (s.language || "").toString().toUpperCase();
    const q = (s.quality || "").toString().toUpperCase();
    const aName = (s.apiName || "").toString().toLowerCase();
    const fullText = `${rawT} ${prov} ${lang}`;
    const isExplicitForeignOnly = (fullText.includes("HINDI") || fullText.includes("LATINO") || fullText.includes("ESPANOL") || fullText.includes("CASTILIAN") || fullText.includes("FRENCH") || fullText.includes("VF") || fullText.includes("VFF") || fullText.includes("RUSSIAN") || fullText.includes("GERMAN") || fullText.includes("DEUTSCH") || fullText.includes("ITALIAN") || fullText.includes("TAMIL") || fullText.includes("TELUGU")) && !fullText.includes("ENG") && !fullText.includes("ENGLISH");
    const isExplicitEnglish = fullText.includes("ENG") || fullText.includes("ENGLISH") || fullText.includes("ORIGINAL") || fullText.includes("VO") || lang === "EN" || lang === "ENG" || lang === "ENGLISH";
    const isMultiAudio = fullText.includes("MULTI") || fullText.includes("DUAL");
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
    let pScore = 50;
    if (aName.includes("cinepro") || prov.includes("CINEPRO")) pScore = 1;
    else if (aName.includes("primary") || prov.includes("PRIMARY")) pScore = 2;
    else if (prov.includes("TORRENTIO")) pScore = 3;
    let qScore = 500;
    if (q.includes("LORDFIX")) qScore = 0;
    else if (q.includes("1080") || q.includes("FHD")) qScore = 10;
    else if (q.includes("2160") || q.includes("4K") || q.includes("UHD")) qScore = 20;
    else if (q.includes("720") || q.includes("HD")) qScore = 30;
    else if (q.includes("480")) qScore = 40;
    else if (q.includes("360")) qScore = 50;
    else if (q === "AUTO") qScore = 60;
    return tierScore * 1e11 + langScore * 1e7 + pScore * 1e4 + qScore;
  };
  const sorted = [...streams].sort((a, b) => getRank(a) - getRank(b));
  return sorted.map((s, idx) => ({
    ...s,
    provider: `Server ${idx + 1}`,
    rawTitle: `Server ${idx + 1}`,
  }));
}
app.get("/api/streams/:type/:id", async (req, res) => {
  try {
    const { type, id } = req.params;
    const isTV = type === "tv";
    const s = parseInt(req.query.s || "1", 10);
    const e = parseInt(req.query.e || "1", 10);
    const forceRefresh = req.query.refresh === "1" || req.query._t !== void 0;
    const cacheKey = `streams-${type}-${id}-${s}-${e}`;
    const cached = apiCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.timestamp < 15 * 60 * 1e3 && Array.isArray(cached.data?.streams) && cached.data.streams.length > 0) {
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");
      return res.json(cached.data);
    }
    const cineproUrl = isTV ? `${SCRAPER_API_CINEPRO}/v1/tv/${id}/seasons/${s}/episodes/${e}` : `${SCRAPER_API_CINEPRO}/v1/movies/${id}`;
    const tasks = [fetchWithRetry(cineproUrl, 25e3, 1)];
    let tmdbEmbedUrl = "";
    if (SCRAPER_API_TMDB_EMBED && SCRAPER_API_TMDB_EMBED !== SCRAPER_API_CINEPRO) {
      tmdbEmbedUrl = isTV ? `${SCRAPER_API_TMDB_EMBED}/api/streams/series/${id}?s=${s}&e=${e}` : `${SCRAPER_API_TMDB_EMBED}/api/streams/movie/${id}`;
      tasks.push(fetchWithRetry(tmdbEmbedUrl, 25e3, 1));
    }
    const results = await Promise.allSettled(tasks);
    let combined = [];
    if (results[0].status === "fulfilled" && results[0].value) {
      combined = combined.concat(normalizeStreams(results[0].value, "CinePro"));
      if (Array.isArray(results[0].value.subtitles)) {
        subtitleCache.set(`${type}-${id}-${s}-${e}`, results[0].value.subtitles);
      }
    }
    if (results[1] && results[1].status === "fulfilled" && results[1].value) {
      combined = combined.concat(normalizeStreams(results[1].value, "TMDB Embed"));
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
    if (combined.length === 0) {
      const query = isTV ? `?s=${s}&e=${e}` : "";
      const gatewayData = await fetchWithRetry(
        `http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io/api/streams/${type}/${id}${query}`,
        15e3,
        1
      );
      if (gatewayData && Array.isArray(gatewayData.streams) && gatewayData.streams.length > 0) {
        combined = gatewayData.streams;
      }
    }
    const sorted = rankStreams(combined, isTV);
    const responseData = {
      success: true,
      count: sorted.length,
      streams: sorted
    };
    if (sorted.length > 0) {
      apiCache.set(cacheKey, { timestamp: Date.now(), data: responseData });
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");
    } else {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
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
    console.error("Subtitles search error:", err);
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
    console.error("Subtitle proxy error:", err);
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
    if (targetUrl.startsWith("/v1/proxy")) {
      const queryString = targetUrl.includes("?") ? targetUrl.slice(targetUrl.indexOf("?")) : "";
      targetUrl = `${SCRAPER_API_CINEPRO}/v1/proxy${queryString}`;
    } else if (targetUrl.startsWith("/")) {
      targetUrl = `http://127.0.0.1:3000${targetUrl}`;
    }
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      return res.status(400).send("Invalid target URL scheme");
    }
    const forwardHeaders = {
      "User-Agent": customHeaders["User-Agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      Accept: "*/*"
    };
    if (customHeaders["Referer"]) forwardHeaders["Referer"] = customHeaders["Referer"];
    if (customHeaders["Origin"]) forwardHeaders["Origin"] = customHeaders["Origin"];
    if (req.headers.range) {
      forwardHeaders["Range"] = req.headers.range;
    }
    const upstream = await fetch(targetUrl, {
      headers: forwardHeaders
    });
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    const contentType = upstream.headers.get("content-type") || "";
    if (contentType) res.set("Content-Type", contentType);
    if (upstream.headers.get("content-range")) res.set("Content-Range", upstream.headers.get("content-range"));
    if (upstream.headers.get("accept-ranges")) res.set("Accept-Ranges", upstream.headers.get("accept-ranges"));
    if (upstream.headers.get("content-length")) res.set("Content-Length", upstream.headers.get("content-length"));
    res.status(upstream.status);
    const isPlaylist = targetUrl.includes(".m3u8") || contentType.includes("mpegurl") || contentType.includes("application/x-mpegURL");
    if (isPlaylist && upstream.status === 200) {
      const text = await upstream.text();
      const baseUrl = new URL(targetUrl);
      const lines = text.split("\n");
      const rewritten = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("#")) {
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
              const full2 = new URL(uri, baseUrl).toString();
              return `URI="/api/proxy/stream?url=${encodeURIComponent(full2)}&headers=${encodeURIComponent(
                JSON.stringify(customHeaders)
              )}"`;
            });
          }
          return line;
        }
        const full = new URL(trimmed, baseUrl).toString();
        return `/api/proxy/stream?url=${encodeURIComponent(full)}&headers=${encodeURIComponent(
          JSON.stringify(customHeaders)
        )}`;
      }).join("\n");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      return res.send(rewritten);
    }
    if (upstream.body) {
      const { Readable } = await import("node:stream");
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("Stream proxy error:", err);
    if (!res.headersSent) {
      res.status(502).send("Upstream stream proxy failed");
    }
  }
});
app.get("/v1/proxy", async (req, res) => {
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
    const upstream = await fetch(targetUrl, {
      headers: forwardHeaders
    });
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    const contentType = upstream.headers.get("content-type") || "";
    if (contentType) res.set("Content-Type", contentType);
    if (upstream.headers.get("content-range")) res.set("Content-Range", upstream.headers.get("content-range"));
    if (upstream.headers.get("accept-ranges")) res.set("Accept-Ranges", upstream.headers.get("accept-ranges"));
    if (upstream.headers.get("content-length")) res.set("Content-Length", upstream.headers.get("content-length"));
    res.status(upstream.status);
    if (upstream.body) {
      const { Readable } = await import("node:stream");
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("CinePro proxy relay error:", err);
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
function readAnalyticsData() {
  try {
    if (fs.existsSync(ANALYTICS_DATA_FILE)) {
      const content = fs.readFileSync(ANALYTICS_DATA_FILE, "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.events)) {
        return parsed;
      }
    }
  } catch (e) {
    console.error("Error reading analytics data:", e);
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
    if (eventType === "heartbeat" || eventType === "play") {
      activeLiveViewers.set(sessionId, {
        lastPing: now,
        title: title || "Unknown Title",
        device: device || "desktop",
        mediaType,
        season,
        episode,
        poster
      });
    }
    const event = {
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
      device: device || "desktop",
      browser: browser || "Unknown",
      os: os || "Unknown",
      serverIndex,
      serverName,
      searchQuery
    };
    analyticsStore.events.push(event);
    scheduleSaveAnalytics();
    return res.json({ ok: true });
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
        if (devicesMap[d] !== void 0) devicesMap[d]++;
        else devicesMap.desktop++;
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
          const tKey = `${e.title}_${e.mediaType || "movie"}`;
          if (!titlesMap.has(tKey)) {
            titlesMap.set(tKey, {
              title: e.title,
              mediaType: e.mediaType,
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
          const tKey = `${e.title}_${e.mediaType || "movie"}`;
          if (!titlesMap.has(tKey)) {
            titlesMap.set(tKey, {
              title: e.title,
              mediaType: e.mediaType,
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
    const recentEvents = [...filteredEvents].reverse().slice(0, 30).map((ev) => ({
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
      searchQuery: ev.searchQuery
    }));
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
      operatingSystems: osMap,
      serverHealth
    });
  } catch (err) {
    console.error("Error generating analytics:", err);
    return res.status(500).json({ error: "Failed to compute analytics" });
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
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    return res.status(200).send(SITEMAP_XML);
  });
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
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
