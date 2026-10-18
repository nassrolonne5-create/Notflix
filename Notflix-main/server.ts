import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import zlib from 'zlib';
import { execSync } from 'child_process';
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

// Disable ETag to prevent browsers (especially Chrome) from serving stale 304 Not Modified HTML after deployments
app.set('etag', false);

const SERVER_BOOT_TIME = Date.now().toString();
const DEPLOYMENT_VERSION =
  process.env.COOLIFY_COMMIT_SHA ||
  process.env.SOURCE_COMMIT ||
  process.env.GIT_COMMIT_SHA ||
  process.env.BUILD_ID ||
  SERVER_BOOT_TIME;

let isShuttingDown = false;
let activeHttpServer: any = null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Global Deployment Transition & Anti-Stale-Cache Guard
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Deployment-Version', DEPLOYMENT_VERSION);

  // When container is stopping during an update, force Chrome/proxies to drop Keep-Alive connections immediately
  if (isShuttingDown) {
    res.setHeader('Connection', 'close');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  }

  // Expire any stale proxy/sticky-session cookies on HTML navigation requests so Traefik never pins a browser to a dead container
  const accept = (req.headers.accept || '').toLowerCase();
  const isHtmlNav =
    req.method === 'GET' &&
    !req.path.startsWith('/api/') &&
    !req.path.startsWith('/assets/') &&
    !req.path.startsWith('/v1/') &&
    (accept.includes('text/html') || req.path === '/' || req.path.startsWith('/admin'));

  if (isHtmlNav && req.headers.cookie) {
    try {
      const cookiePairs = req.headers.cookie.split(';');
      const clearHeaders: string[] = [];
      for (const pair of cookiePairs) {
        const eqIdx = pair.indexOf('=');
        const name = (eqIdx > -1 ? pair.slice(0, eqIdx) : pair).trim();
        if (name && /^[a-zA-Z0-9_.-]+$/.test(name)) {
          clearHeaders.push(`${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`);
        }
      }
      if (clearHeaders.length > 0) {
        res.setHeader('Set-Cookie', clearHeaders);
      }
    } catch {}
  }

  next();
});

// TMDB Backend Configuration
const TMDB_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const TMDB_API_KEY = process.env.TMDB_API_KEY || DEFAULT_TMDB_KEY;

const DEFAULT_SCRAPER_CINEPRO_URL = (process.env.SCRAPER_CINEPRO_URL || 'http://62.171.179.144:3001')
  .replace(/^https:\/\//i, 'http://')
  .replace(/\/+$/, '');
const DEFAULT_SCRAPER_TMDB_EMBED_URL = (
  process.env.SCRAPER_TMDB_EMBED_URL ||
  process.env.SCRAPER_PRIMARY_URL ||
  'http://62.171.179.144:3005'
)
  .replace(/^https:\/\//i, 'http://')
  .replace(/\/+$/, '');
const DEFAULT_SCRAPER_GATEWAY_URL = (
  process.env.SCRAPER_GATEWAY_URL || 'http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io'
).replace(/\/+$/, '');

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

// Persistent Data Directory Setup
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USER_PROFILES_FILE = path.join(DATA_DIR, 'user_profiles.json');
const LEGACY_GLOBAL_USER_DATA_FILE = path.join(DATA_DIR, 'userdata.json');
const BLOCKED_IPS_FILE = path.join(DATA_DIR, 'blocked_ips.json');
const BLOCKED_IPS_BACKUP_MIRROR_FILE = '/var/tmp/notflix_blocked_ips_backup.json';

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

// ============================================================================
// Anti-Interception, Anti-Scraping & Permanent IP Block Subsystem (v2 Zero-False-Positive)
// ============================================================================
const BAN_STORAGE_SCHEMA_VERSION = 2;
const STREAM_SECURITY_SECRET =
  process.env.STREAM_SECURITY_SECRET ||
  'notflix-stream-hmac-secret-v2-persistent';

export type BanCategory =
  | 'scraper'
  | 'interception'
  | 'honeypot'
  | 'hotlink'
  | 'burst_abuse'
  | 'manual';

export interface PermanentBanRecord {
  ip: string;
  reason: string;
  category: BanCategory;
  userAgent: string;
  path: string;
  bannedAt: number;
  permanent: true;
  blockedAttempts: number;
  lastAttemptAt: number;
}

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

// Known Scraper, CLI Extractor & Headless Automation Signatures
const SCRAPER_USER_AGENTS = [
  /python-requests/i,
  /python-httpx/i,
  /aiohttp/i,
  /scrapy/i,
  /urllib/i,
  /pycurl/i,
  /curl\//i,
  /wget\//i,
  /httpie/i,
  /headlesschrome/i,
  /phantomjs/i,
  /slimerjs/i,
  /casperjs/i,
  /go-http-client/i,
  /libwww-perl/i,
  /lwp-trivial/i,
  /httpclient/i,
  /postmanruntime/i,
  /insomnia/i,
  /node-fetch/i,
  /got\//i,
  /playwright/i,
  /puppeteer/i,
  /selenium/i,
  /webdriver/i,
  /mechanize/i,
  /httrack/i,
  /webreaper/i,
  /webcopier/i,
  /sitegrabber/i,
];

// Known Network Interception, MITM Proxy & Vulnerability Scanner Signatures
const INTERCEPTION_USER_AGENTS = [
  /burpsuite/i,
  /burpcollaborator/i,
  /mitmproxy/i,
  /fiddler/i,
  /charlesproxy/i,
  /owasp/i,
  /\bzap\b/i,
  /sqlmap/i,
  /nikto/i,
  /nmap/i,
  /zgrab/i,
  /masscan/i,
  /gobuster/i,
  /dirbuster/i,
  /feroxbuster/i,
  /nuclei/i,
  /ffuf/i,
  /wfuzz/i,
  /acunetix/i,
  /nessus/i,
  /openvas/i,
  /commix/i,
  /arachni/i,
  /w3af/i,
];

function isKnownInterceptionTool(userAgent: string): boolean {
  if (!userAgent) return false;
  return INTERCEPTION_USER_AGENTS.some((pattern) => pattern.test(userAgent));
}

function isKnownScraperBot(userAgent: string): boolean {
  if (!userAgent) return false; // Never ban for missing User-Agent (some browser media/range requests omit UA)
  return SCRAPER_USER_AGENTS.some((pattern) => pattern.test(userAgent));
}

function isStandardHumanBrowser(userAgent: string): boolean {
  if (!userAgent) return false;
  if (isKnownScraperBot(userAgent) || isKnownInterceptionTool(userAgent)) return false;
  return (
    /Mozilla\/5\.0/i.test(userAgent) &&
    /(Firefox\/|FxiOS\/|Chrome\/|CriOS\/|Safari\/|Edg\/|OPR\/|SamsungBrowser\/|Mobile|Android|iPhone|iPad|Macintosh|Windows NT|X11)/i.test(
      userAgent
    )
  );
}

// Sensitive paths that only data interceptors, source-dumpers, or scanners probe
const DATA_INTERCEPTION_TRAP_PATHS = [
  /^\/\.env/i,
  /^\/\.git/i,
  /^\/server\.ts/i,
  /^\/package\.json/i,
  /^\/tsconfig\.json/i,
  /^\/data\//i,
  /analytics\.json/i,
  /scrapers\.json/i,
  /user_profiles\.json/i,
  /blocked_ips\.json/i,
  /^\/wp-admin/i,
  /^\/wp-login/i,
  /^\/phpmyadmin/i,
  /^\/actuator/i,
  /^\/api\/dump/i,
  /^\/api\/v1\/dump-streams/i,
  /^\/api\/internal\/keys/i,
  /^\/config\.json/i,
  /^\/backup\.json/i,
];

function isDataInterceptionProbePath(reqPath: string): boolean {
  return DATA_INTERCEPTION_TRAP_PATHS.some((pattern) => pattern.test(reqPath));
}

interface SecurityMetrics {
  totalBlockedScrapers: number;
  totalInterceptionsBlocked: number;
  totalRateLimited: number;
  totalHoneypotTrapped: number;
  recentSecurityEvents: Array<{
    ip: string;
    reason: string;
    category?: string;
    userAgent: string;
    path: string;
    ts: number;
    permanent?: boolean;
  }>;
}

const securityMetrics: SecurityMetrics = {
  totalBlockedScrapers: 0,
  totalInterceptionsBlocked: 0,
  totalRateLimited: 0,
  totalHoneypotTrapped: 0,
  recentSecurityEvents: [],
};

function recordSecurityEvent(
  ip: string,
  reason: string,
  userAgent: string,
  reqPath: string,
  category: BanCategory = 'scraper',
  permanent = true
) {
  securityMetrics.recentSecurityEvents.unshift({
    ip,
    reason,
    category,
    userAgent: (userAgent || 'unknown').slice(0, 80),
    path: reqPath,
    ts: Date.now(),
    permanent,
  });
  if (securityMetrics.recentSecurityEvents.length > 60) {
    securityMetrics.recentSecurityEvents.pop();
  }
}

// Persistent Permanent IP Blacklist Map (IP -> PermanentBanRecord)
const permanentlyBannedIps = new Map<string, PermanentBanRecord>();
// Whitelisted Admin IPs (automatically populated when admin logs in or verifies session)
const whitelistedAdminIps = new Set<string>();
// Rate-limit strike counter per IP (escalates repeated rate-limit violations into a permanent IP ban)
const rateLimitStrikes = new Map<string, number>();

function isInternalOrLoopbackIp(ip: string): boolean {
  const cleanIp = (ip || '').replace(/^::ffff:/i, '').trim();
  return (
    !cleanIp ||
    cleanIp === '127.0.0.1' ||
    cleanIp === '::1' ||
    cleanIp === 'localhost' ||
    cleanIp.startsWith('127.') ||
    cleanIp.startsWith('10.') ||
    cleanIp.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp)
  );
}

function loadPermanentBansFromDisk() {
  const candidatePaths = [
    BLOCKED_IPS_FILE,
    BLOCKED_IPS_BACKUP_MIRROR_FILE,
    '/data/blocked_ips.json',
    '/app/data/blocked_ips.json',
    path.join(process.cwd(), 'data', 'blocked_ips.json'),
    path.join(__dirname, 'data', 'blocked_ips.json'),
  ];

  let purgedLegacyV1Bans = false;

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);

        // Automatically purge v1 ban files that could contain false-positive browser bans (e.g. Firefox prefetch/viewport)
        if (!parsed || parsed.schemaVersion !== BAN_STORAGE_SCHEMA_VERSION) {
          purgedLegacyV1Bans = true;
          continue;
        }

        const list: PermanentBanRecord[] = Array.isArray(parsed?.bans) ? parsed.bans : [];
        for (const item of list) {
          if (item && item.ip && !isInternalOrLoopbackIp(item.ip)) {
            const cleanIp = item.ip.replace(/^::ffff:/i, '').trim();
            if (!permanentlyBannedIps.has(cleanIp)) {
              permanentlyBannedIps.set(cleanIp, {
                ip: cleanIp,
                reason: item.reason || 'Permanent Security Ban',
                category: item.category || 'scraper',
                userAgent: item.userAgent || 'unknown',
                path: item.path || '/',
                bannedAt: item.bannedAt || Date.now(),
                permanent: true,
                blockedAttempts: item.blockedAttempts || 1,
                lastAttemptAt: item.lastAttemptAt || item.bannedAt || Date.now(),
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Could not read blocked_ips candidate ${candidate}:`, e);
    }
  }

  if (purgedLegacyV1Bans) {
    savePermanentBansToDiskSync();
    console.log('🧹 Purged legacy v1 false-positive IP bans and upgraded ban store to v2.');
  }

  if (permanentlyBannedIps.size > 0) {
    console.log(`🛡️ Loaded ${permanentlyBannedIps.size} verified permanently blocked IPs from persistent storage.`);
  }
}

function savePermanentBansToDiskSync() {
  try {
    const serialized = JSON.stringify(
      {
        schemaVersion: BAN_STORAGE_SCHEMA_VERSION,
        updatedAt: Date.now(),
        bans: Array.from(permanentlyBannedIps.values()),
      },
      null,
      2
    );
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(BLOCKED_IPS_FILE, serialized, 'utf-8');
    try {
      fs.writeFileSync(BLOCKED_IPS_BACKUP_MIRROR_FILE, serialized, 'utf-8');
    } catch {}
  } catch (err) {
    console.error('Error saving permanent IP bans to disk:', err);
  }
}

loadPermanentBansFromDisk();

let saveBansTimeout: NodeJS.Timeout | null = null;
function scheduleSavePermanentBans() {
  if (saveBansTimeout) return;
  saveBansTimeout = setTimeout(() => {
    saveBansTimeout = null;
    savePermanentBansToDiskSync();
  }, 1000);
}

function banIpPermanently(
  rawIp: string,
  reason: string,
  category: BanCategory = 'scraper',
  userAgent = 'unknown',
  reqPath = '/'
): PermanentBanRecord | null {
  const cleanIp = (rawIp || '').replace(/^::ffff:/i, '').trim();
  if (isInternalOrLoopbackIp(cleanIp)) return null;
  if (whitelistedAdminIps.has(cleanIp) && category !== 'manual') return null;
  if (isLegitimateSearchCrawler(userAgent) && category !== 'manual') return null;

  const now = Date.now();
  const existing = permanentlyBannedIps.get(cleanIp);
  if (existing) {
    existing.blockedAttempts += 1;
    existing.lastAttemptAt = now;
    scheduleSavePermanentBans();
    return existing;
  }

  const record: PermanentBanRecord = {
    ip: cleanIp,
    reason,
    category,
    userAgent: (userAgent || 'unknown').slice(0, 120),
    path: reqPath,
    bannedAt: now,
    permanent: true,
    blockedAttempts: 1,
    lastAttemptAt: now,
  };

  permanentlyBannedIps.set(cleanIp, record);
  savePermanentBansToDiskSync();

  securityMetrics.totalBlockedScrapers++;
  if (category === 'interception' || category === 'hotlink') {
    securityMetrics.totalInterceptionsBlocked++;
  } else if (category === 'honeypot') {
    securityMetrics.totalHoneypotTrapped++;
  }

  recordSecurityEvent(cleanIp, `PERMANENT BAN: ${reason}`, userAgent, reqPath, category, true);
  console.warn(`🚨 [PERMANENT IP BLOCK] Blocked ${cleanIp} permanently | Reason: ${reason} | Path: ${reqPath}`);
  return record;
}

function unblockIpPermanently(rawIp: string): boolean {
  const cleanIp = (rawIp || '').replace(/^::ffff:/i, '').trim();
  const deleted = permanentlyBannedIps.delete(cleanIp);
  rateLimitStrikes.delete(cleanIp);
  if (deleted) {
    savePermanentBansToDiskSync();
  }
  return deleted;
}

// In-Memory Sliding-Window Rate Limiters (IP -> timestamp[])
const globalApiRateLimiter = new Map<string, number[]>();
const streamRateLimiter = new Map<string, number[]>();

function getClientIp(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim().replace(/^::ffff:/i, '');
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim().replace(/^::ffff:/i, '');
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().replace(/^::ffff:/i, '');
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].trim().replace(/^::ffff:/i, '');
  }
  return (req.socket.remoteAddress || '127.0.0.1').replace(/^::ffff:/i, '');
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

// Periodic cleanup of expired rate-limit buckets (Permanent IP bans NEVER expire)
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
}, 5 * 60 * 1000);

function renderPermanentBlockHtml(record: PermanentBanRecord): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>403 Access Permanently Terminated — Security Shield</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #070a12;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      max-width: 520px;
      width: 100%;
      background: #0e1424;
      border: 1px solid rgba(244, 63, 94, 0.4);
      border-radius: 16px;
      padding: 32px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(136, 19, 55, 0.35);
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(244, 63, 94, 0.15);
      border: 1px solid rgba(244, 63, 94, 0.35);
      color: #fda4af;
      font-family: monospace;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 14px;
    }
    h1 { font-size: 24px; font-weight: 800; margin-bottom: 10px; color: #ffffff; }
    p { font-size: 13px; color: #cbd5e1; line-height: 1.6; margin-bottom: 22px; }
    .meta {
      background: #090d18;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 16px;
      text-align: left;
      font-family: monospace;
      font-size: 12px;
    }
    .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .row:last-child { border-bottom: none; }
    .lbl { color: #64748b; }
    .val { color: #f43f5e; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Permanent IP Blacklist Active</div>
    <h1>Access Permanently Terminated</h1>
    <p>Your network IP address has been permanently blocked by the Anti-Interception &amp; Anti-Scraping Security Shield due to unauthorized data interception or automated scraping activity.</p>
    <div class="meta">
      <div class="row"><span class="lbl">STATUS:</span><span class="val">HTTP 403 FORBIDDEN (PERMANENT)</span></div>
      <div class="row"><span class="lbl">BLOCKED IP:</span><span class="val" style="color:#e2e8f0">${record.ip}</span></div>
      <div class="row"><span class="lbl">VIOLATION:</span><span class="val" style="color:#fcd34d">${record.reason}</span></div>
      <div class="row"><span class="lbl">TIMESTAMP:</span><span class="val" style="color:#94a3b8">${new Date(record.bannedAt).toISOString()}</span></div>
    </div>
  </div>
</body>
</html>`;
}

function sendPermanentBlockResponse(req: Request, res: Response, record: PermanentBanRecord) {
  const isApiOrJson =
    req.path.startsWith('/api/') ||
    req.path.startsWith('/v1/') ||
    (req.headers.accept || '').includes('application/json');

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  if (isApiOrJson) {
    return res.status(403).json({
      error:
        'PERMANENT IP BLOCK: Your IP address has been permanently blacklisted for attempting to intercept website data or scrape content.',
      code: 'IP_PERMANENTLY_BLOCKED',
      ip: record.ip,
      reason: record.reason,
      category: record.category,
      bannedAt: record.bannedAt,
      permanent: true,
    });
  }

  return res.status(403).type('text/html').send(renderPermanentBlockHtml(record));
}

// Global Anti-Interception & Permanent IP Block Middleware (Protects entire website + APIs + Streams)
const globalSecurityShieldMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || '';

  // 1. Always allow internal/loopback Docker/Coolify/Traefik health probes
  if (isInternalOrLoopbackIp(ip)) {
    return next();
  }

  // 2. Always allow health checks, Admin UI, Admin API, and static JS/CSS/font assets so Admin Dashboard is always reachable
  if (
    req.path === '/health' ||
    req.path === '/api/health' ||
    req.path === '/healthz' ||
    req.path.startsWith('/admin') ||
    req.path.startsWith('/api/admin') ||
    req.path.startsWith('/assets/') ||
    req.path.startsWith('/src/') ||
    req.path.startsWith('/@') ||
    req.path.startsWith('/node_modules/')
  ) {
    return next();
  }

  // 3. Allow whitelisted Admin IPs
  if (whitelistedAdminIps.has(ip)) {
    return next();
  }

  // 4. Enforce Permanent IP Blacklist across the entire website (HTML pages, APIs, and Stream Proxies)
  const existingBan = permanentlyBannedIps.get(ip);
  if (existingBan) {
    existingBan.blockedAttempts += 1;
    existingBan.lastAttemptAt = Date.now();
    securityMetrics.totalBlockedScrapers++;
    scheduleSavePermanentBans();
    return sendPermanentBlockResponse(req, res, existingBan);
  }

  // 5. Allow whitelisted legitimate search engine crawlers (Googlebot, Bingbot, etc.)
  if (isLegitimateSearchCrawler(userAgent)) {
    return next();
  }

  // 6. Let explicit trap routes handle their own permanent ban logic
  if (
    req.path.startsWith('/trap') ||
    req.path.startsWith('/api/trap') ||
    req.path === '/api/security/intercept-report'
  ) {
    return next();
  }

  // 7. Immediate Permanent IP Ban if probing sensitive backend files, configs, or data-dump endpoints
  if (isDataInterceptionProbePath(req.path)) {
    const record = banIpPermanently(
      ip,
      'Attempted Backend Data / Config Interception Probe',
      'interception',
      userAgent,
      req.path
    );
    if (record) return sendPermanentBlockResponse(req, res, record);
  }

  // 8. Immediate Permanent IP Ban for known MITM Interception Proxies & Vulnerability Scanners on any route
  if (isKnownInterceptionTool(userAgent)) {
    const record = banIpPermanently(
      ip,
      'Network Interception Proxy / Security Scanner Detected',
      'interception',
      userAgent,
      req.path
    );
    if (record) return sendPermanentBlockResponse(req, res, record);
  }

  // 9. Immediate Permanent IP Ban for known Scraper Bots / CLI Extractors on API, Stream, or Page routes
  if (isKnownScraperBot(userAgent)) {
    const record = banIpPermanently(
      ip,
      'Automated Scraper / Extraction Tool Signature Detected',
      'scraper',
      userAgent,
      req.path
    );
    if (record) return sendPermanentBlockResponse(req, res, record);
  }

  // 10. API Rate Limiting (Never bans normal browsers watching video segments, subtitles, or TMDB catalog)
  if (
    req.path.startsWith('/api/') &&
    !req.path.startsWith('/api/proxy/') &&
    !req.path.startsWith('/api/subtitles/') &&
    !req.path.startsWith('/api/analytics/') &&
    !req.path.startsWith('/api/user/') &&
    !req.path.startsWith('/api/security/')
  ) {
    const allowed = checkRateLimit(ip, globalApiRateLimiter, 450, 60 * 1000);
    if (!allowed) {
      securityMetrics.totalRateLimited++;
      recordSecurityEvent(ip, 'High API Request Rate Throttled (429)', userAgent, req.path, 'burst_abuse', false);
      res.setHeader('Retry-After', '30');
      return res.status(429).json({
        error: 'Too many requests. Please slow down.',
        code: 'RATE_LIMITED',
      });
    }
  }

  next();
};

app.use(globalSecurityShieldMiddleware);

// ============================================================================
// Dynamic Scraper Server Configuration Subsystem (Admin Editable + Persistent)
// ============================================================================
export type ScraperServerId = 'cinepro' | 'tmdb_embed' | 'gateway_fallback';

export interface ScraperEndpointConfig {
  id: ScraperServerId;
  name: string;
  role: string;
  protocol: 'http' | 'https';
  host: string;
  port: string;
  url: string;
  defaultUrl: string;
}

export interface ScraperConfigStore {
  scrapers: Record<ScraperServerId, ScraperEndpointConfig>;
  updatedAt: number;
  isCustom: boolean;
}

const SCRAPERS_CONFIG_FILE = path.join(DATA_DIR, 'scrapers.json');
const SCRAPERS_BACKUP_MIRROR_FILE = '/var/tmp/notflix_scrapers_backup.json';

function parseUrlIntoEndpoint(
  id: ScraperServerId,
  name: string,
  role: string,
  rawInput: { url?: string; protocol?: string; host?: string; port?: string } | string,
  defaultUrl: string
): ScraperEndpointConfig {
  let candidateUrl = '';
  if (typeof rawInput === 'string') {
    candidateUrl = rawInput.trim();
  } else if (rawInput && typeof rawInput === 'object') {
    if (rawInput.host && String(rawInput.host).trim()) {
      const proto = String(rawInput.protocol || 'http')
        .toLowerCase()
        .replace(/[^a-z]/g, '') === 'https'
        ? 'https'
        : 'http';
      let cleanHost = String(rawInput.host)
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '');
      let cleanPort = rawInput.port !== undefined ? String(rawInput.port).trim().replace(/[^0-9]/g, '') : '';
      if (cleanHost.includes(':')) {
        const [hPart, pPart] = cleanHost.split(':');
        cleanHost = hPart;
        if (!cleanPort && pPart) cleanPort = pPart.replace(/[^0-9]/g, '');
      }
      candidateUrl = `${proto}://${cleanHost}${cleanPort ? ':' + cleanPort : ''}`;
    } else if (rawInput.url && String(rawInput.url).trim()) {
      candidateUrl = String(rawInput.url).trim();
    }
  }

  if (!candidateUrl) {
    candidateUrl = defaultUrl;
  }
  if (!/^https?:\/\//i.test(candidateUrl)) {
    candidateUrl = `http://${candidateUrl}`;
  }
  candidateUrl = candidateUrl.replace(/\/+$/, '');

  try {
    const parsed = new URL(candidateUrl);
    const protocol: 'http' | 'https' = parsed.protocol === 'https:' ? 'https' : 'http';
    const host = parsed.hostname;
    const port = parsed.port || '';
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
    const normalizedUrl = `${protocol}://${host}${port ? ':' + port : ''}${pathname}`;
    return {
      id,
      name,
      role,
      protocol,
      host,
      port,
      url: normalizedUrl,
      defaultUrl,
    };
  } catch {
    const fallbackParsed = new URL(defaultUrl);
    return {
      id,
      name,
      role,
      protocol: fallbackParsed.protocol === 'https:' ? 'https' : 'http',
      host: fallbackParsed.hostname,
      port: fallbackParsed.port || '',
      url: defaultUrl,
      defaultUrl,
    };
  }
}

function getDefaultScraperConfigStore(): ScraperConfigStore {
  return {
    scrapers: {
      cinepro: parseUrlIntoEndpoint(
        'cinepro',
        'CinePro Primary Scraper',
        'Primary high-speed stream & subtitle extractor (/v1/movies & /v1/tv)',
        DEFAULT_SCRAPER_CINEPRO_URL,
        DEFAULT_SCRAPER_CINEPRO_URL
      ),
      tmdb_embed: parseUrlIntoEndpoint(
        'tmdb_embed',
        'TMDB Embed Scraper',
        'Secondary multi-provider stream extractor (/api/streams/movie & /series)',
        DEFAULT_SCRAPER_TMDB_EMBED_URL,
        DEFAULT_SCRAPER_TMDB_EMBED_URL
      ),
      gateway_fallback: parseUrlIntoEndpoint(
        'gateway_fallback',
        'Coolify Gateway Fallback',
        'Failover Coolify gateway mirror when primary scrapers return 0 streams',
        DEFAULT_SCRAPER_GATEWAY_URL,
        DEFAULT_SCRAPER_GATEWAY_URL
      ),
    },
    updatedAt: 0,
    isCustom: false,
  };
}

function readScraperConfigFromDisk(): ScraperConfigStore {
  const defaults = getDefaultScraperConfigStore();
  const candidatePaths = [
    SCRAPERS_CONFIG_FILE,
    SCRAPERS_BACKUP_MIRROR_FILE,
    '/data/scrapers.json',
    '/app/data/scrapers.json',
    path.join(process.cwd(), 'data', 'scrapers.json'),
    path.join(__dirname, 'data', 'scrapers.json'),
  ];

  let newestStore: ScraperConfigStore | null = null;

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.scrapers && typeof parsed.scrapers === 'object') {
          const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();
          if (!newestStore || updatedAt >= newestStore.updatedAt) {
            const cinepro = parseUrlIntoEndpoint(
              'cinepro',
              defaults.scrapers.cinepro.name,
              defaults.scrapers.cinepro.role,
              parsed.scrapers.cinepro || DEFAULT_SCRAPER_CINEPRO_URL,
              DEFAULT_SCRAPER_CINEPRO_URL
            );
            const tmdb_embed = parseUrlIntoEndpoint(
              'tmdb_embed',
              defaults.scrapers.tmdb_embed.name,
              defaults.scrapers.tmdb_embed.role,
              parsed.scrapers.tmdb_embed || DEFAULT_SCRAPER_TMDB_EMBED_URL,
              DEFAULT_SCRAPER_TMDB_EMBED_URL
            );
            const gateway_fallback = parseUrlIntoEndpoint(
              'gateway_fallback',
              defaults.scrapers.gateway_fallback.name,
              defaults.scrapers.gateway_fallback.role,
              parsed.scrapers.gateway_fallback || DEFAULT_SCRAPER_GATEWAY_URL,
              DEFAULT_SCRAPER_GATEWAY_URL
            );

            const isCustom =
              cinepro.url !== DEFAULT_SCRAPER_CINEPRO_URL ||
              tmdb_embed.url !== DEFAULT_SCRAPER_TMDB_EMBED_URL ||
              gateway_fallback.url !== DEFAULT_SCRAPER_GATEWAY_URL ||
              Boolean(parsed.isCustom);

            newestStore = {
              scrapers: { cinepro, tmdb_embed, gateway_fallback },
              updatedAt,
              isCustom,
            };
          }
        }
      }
    } catch (e) {
      console.warn(`Could not read scraper config candidate ${candidate}:`, e);
    }
  }

  return newestStore || defaults;
}

let scraperConfigStore: ScraperConfigStore = readScraperConfigFromDisk();

function saveScraperConfigToDiskSync(store: ScraperConfigStore) {
  try {
    const serialized = JSON.stringify(store, null, 2);
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SCRAPERS_CONFIG_FILE, serialized, 'utf-8');
    try {
      fs.writeFileSync(SCRAPERS_BACKUP_MIRROR_FILE, serialized, 'utf-8');
    } catch {}
  } catch (err) {
    console.error('Error saving scraper configuration to disk:', err);
  }
}

if (scraperConfigStore.isCustom) {
  saveScraperConfigToDiskSync(scraperConfigStore);
}

function getCineproUrl(): string {
  return scraperConfigStore.scrapers.cinepro.url;
}

function getTmdbEmbedUrl(): string {
  return scraperConfigStore.scrapers.tmdb_embed.url;
}

function getGatewayFallbackUrl(): string {
  return scraperConfigStore.scrapers.gateway_fallback.url;
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
app.all(['/api/health', '/health', '/healthz'], (req: Request, res: Response) => {
  res.status(200).json({
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

// In-memory cache for aggregated subtitles per title/episode
const subtitleCache = new Map<string, any[]>();

const LANGUAGE_NAME_MAP: Record<string, string> = {
  en: 'English',
  eng: 'English',
  english: 'English',
  ar: 'Arabic',
  ara: 'Arabic',
  arabic: 'Arabic',
  'اَلْعَرَبِيَّةُ': 'Arabic',
  'العربية': 'Arabic',
  es: 'Spanish',
  spa: 'Spanish',
  spl: 'Spanish',
  spn: 'Spanish',
  spanish: 'Spanish',
  espanol: 'Spanish',
  'español': 'Spanish',
  castilian: 'Spanish',
  castellano: 'Spanish',
  fr: 'French',
  fre: 'French',
  fra: 'French',
  french: 'French',
  francais: 'French',
  'français': 'French',
  de: 'German',
  ger: 'German',
  deu: 'German',
  german: 'German',
  deutsch: 'German',
  it: 'Italian',
  ita: 'Italian',
  italian: 'Italian',
  italiano: 'Italian',
  pt: 'Portuguese',
  por: 'Portuguese',
  portuguese: 'Portuguese',
  'português': 'Portuguese',
  portugues: 'Portuguese',
  pb: 'Portuguese (Brazil)',
  pob: 'Portuguese (Brazil)',
  'pt-br': 'Portuguese (Brazil)',
  'portuguese (br)': 'Portuguese (Brazil)',
  'portuguese-br': 'Portuguese (Brazil)',
  'brazilian portuguese': 'Portuguese (Brazil)',
  ru: 'Russian',
  rus: 'Russian',
  russian: 'Russian',
  'русский': 'Russian',
  tr: 'Turkish',
  tur: 'Turkish',
  turkish: 'Turkish',
  'türkçe': 'Turkish',
  turkce: 'Turkish',
  hi: 'Hindi',
  hin: 'Hindi',
  hindi: 'Hindi',
  'हिन्दी': 'Hindi',
  id: 'Indonesian',
  ind: 'Indonesian',
  indonesian: 'Indonesian',
  'bahasa indonesia': 'Indonesian',
  ms: 'Malay',
  may: 'Malay',
  msa: 'Malay',
  malay: 'Malay',
  melayu: 'Malay',
  vi: 'Vietnamese',
  vie: 'Vietnamese',
  vietnamese: 'Vietnamese',
  'tiếng việt': 'Vietnamese',
  th: 'Thai',
  tha: 'Thai',
  thai: 'Thai',
  'ภาษาไทย': 'Thai',
  zh: 'Chinese',
  zho: 'Chinese',
  chi: 'Chinese',
  zhc: 'Chinese',
  chinese: 'Chinese',
  '中文': 'Chinese',
  '简体中文': 'Chinese',
  zht: 'Chinese (Traditional)',
  'zh-tw': 'Chinese (Traditional)',
  '繁體中文': 'Chinese (Traditional)',
  ja: 'Japanese',
  jpn: 'Japanese',
  japanese: 'Japanese',
  '日本語': 'Japanese',
  ko: 'Korean',
  kor: 'Korean',
  korean: 'Korean',
  '한국어': 'Korean',
  nl: 'Dutch',
  nld: 'Dutch',
  dut: 'Dutch',
  dutch: 'Dutch',
  nederlands: 'Dutch',
  pl: 'Polish',
  pol: 'Polish',
  polish: 'Polish',
  polski: 'Polish',
  sv: 'Swedish',
  swe: 'Swedish',
  swedish: 'Swedish',
  svenska: 'Swedish',
  da: 'Danish',
  dan: 'Danish',
  danish: 'Danish',
  dansk: 'Danish',
  fi: 'Finnish',
  fin: 'Finnish',
  finnish: 'Finnish',
  suomi: 'Finnish',
  no: 'Norwegian',
  nor: 'Norwegian',
  nb: 'Norwegian',
  nob: 'Norwegian',
  nn: 'Norwegian',
  norwegian: 'Norwegian',
  norsk: 'Norwegian',
  he: 'Hebrew',
  heb: 'Hebrew',
  hebrew: 'Hebrew',
  'עברית': 'Hebrew',
  el: 'Greek',
  ell: 'Greek',
  gre: 'Greek',
  greek: 'Greek',
  'ελληνικά': 'Greek',
  hu: 'Hungarian',
  hun: 'Hungarian',
  hungarian: 'Hungarian',
  magyar: 'Hungarian',
  cs: 'Czech',
  cze: 'Czech',
  ces: 'Czech',
  czech: 'Czech',
  'čeština': 'Czech',
  ro: 'Romanian',
  ron: 'Romanian',
  rum: 'Romanian',
  romanian: 'Romanian',
  'română': 'Romanian',
  bg: 'Bulgarian',
  bul: 'Bulgarian',
  bulgarian: 'Bulgarian',
  uk: 'Ukrainian',
  ukr: 'Ukrainian',
  ukrainian: 'Ukrainian',
  hr: 'Croatian',
  hrv: 'Croatian',
  croatian: 'Croatian',
  hrvatski: 'Croatian',
  sr: 'Serbian',
  srp: 'Serbian',
  scc: 'Serbian',
  serbian: 'Serbian',
  sl: 'Slovenian',
  slv: 'Slovenian',
  slovenian: 'Slovenian',
  sk: 'Slovak',
  slo: 'Slovak',
  slk: 'Slovak',
  slovak: 'Slovak',
  fa: 'Persian',
  per: 'Persian',
  fas: 'Persian',
  persian: 'Persian',
  farsi: 'Persian',
  'فارسی': 'Persian',
  bn: 'Bengali',
  ben: 'Bengali',
  bengali: 'Bengali',
  'বাংলা': 'Bengali',
  ur: 'Urdu',
  urd: 'Urdu',
  urdu: 'Urdu',
  ta: 'Tamil',
  tam: 'Tamil',
  tamil: 'Tamil',
  te: 'Telugu',
  tel: 'Telugu',
  telugu: 'Telugu',
  ml: 'Malayalam',
  mal: 'Malayalam',
  malayalam: 'Malayalam',
  pa: 'Punjabi',
  pan: 'Punjabi',
  panjabi: 'Punjabi',
  punjabi: 'Punjabi',
  tl: 'Filipino',
  tgl: 'Filipino',
  fil: 'Filipino',
  fl: 'Filipino',
  tagalog: 'Filipino',
  filipino: 'Filipino',
  et: 'Estonian',
  est: 'Estonian',
  estonian: 'Estonian',
  lv: 'Latvian',
  lav: 'Latvian',
  latvian: 'Latvian',
  lt: 'Lithuanian',
  lit: 'Lithuanian',
  lithuanian: 'Lithuanian',
  mk: 'Macedonian',
  mac: 'Macedonian',
  mkd: 'Macedonian',
  macedonian: 'Macedonian',
  sq: 'Albanian',
  alb: 'Albanian',
  sqi: 'Albanian',
  albanian: 'Albanian',
  bs: 'Bosnian',
  bos: 'Bosnian',
  bosnian: 'Bosnian',
  is: 'Icelandic',
  ice: 'Icelandic',
  isl: 'Icelandic',
  icelandic: 'Icelandic',
  sw: 'Swahili',
  swa: 'Swahili',
  swahili: 'Swahili',
  ha: 'Hausa',
  hau: 'Hausa',
  hausa: 'Hausa',
};

function normalizeSubtitleLanguage(raw: any): string {
  const candidates = [
    raw?.LanguageName,
    raw?.label,
    raw?.lang,
    raw?.language,
    raw?.SubLanguageID,
    raw?.ISO639,
    raw?.srclang,
  ];

  for (const cand of candidates) {
    if (!cand || typeof cand !== 'string') continue;
    const cleaned = cand.trim();
    if (!cleaned || cleaned.toLowerCase() === 'unknown') continue;
    const lower = cleaned.toLowerCase();
    if (LANGUAGE_NAME_MAP[lower]) {
      return LANGUAGE_NAME_MAP[lower];
    }
    // Strip region suffixes or parenthetical tags like "en-US" or "English [CC]"
    const baseCode = lower.split(/[-_(\[]/)[0].trim();
    if (baseCode && LANGUAGE_NAME_MAP[baseCode]) {
      return LANGUAGE_NAME_MAP[baseCode];
    }
    if (cleaned.length > 2) {
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
  }

  // Fallback: inspect URL filename (e.g. .../English.vtt or .en.srt)
  const urlStr = String(raw?.url || raw?.SubDownloadLink || '');
  const fileMatch = urlStr.match(/\/([A-Za-z]+)\.(?:vtt|srt)(?:\?|$)/i);
  if (fileMatch && fileMatch[1]) {
    const lower = fileMatch[1].toLowerCase();
    if (LANGUAGE_NAME_MAP[lower]) return LANGUAGE_NAME_MAP[lower];
  }

  return 'English';
}

function harvestScraperSubtitles(cacheKey: string, data: any, sourceName: string) {
  if (!data) return;
  const collected: Array<{ id: string; lang: string; url: string; source: string }> = [];

  const pushSubItem = (sub: any, providerLabel: string) => {
    if (!sub) return;
    const subUrl = sub.url || sub.file || sub.src || sub.SubDownloadLink;
    if (!subUrl || typeof subUrl !== 'string' || !subUrl.startsWith('http')) return;
    const lang = normalizeSubtitleLanguage(sub);
    collected.push({
      id: sub.id || `${providerLabel}-${lang}-${subUrl.slice(-24)}`,
      lang,
      url: subUrl,
      source: providerLabel,
    });
  };

  if (Array.isArray(data.subtitles)) {
    for (const sub of data.subtitles) {
      pushSubItem(sub, sourceName);
    }
  }
  if (Array.isArray(data.captions)) {
    for (const sub of data.captions) {
      pushSubItem(sub, sourceName);
    }
  }

  const streamLists = [data.streams, data.sources, data.results, data.data];
  for (const list of streamLists) {
    if (!Array.isArray(list)) continue;
    for (const sItem of list) {
      if (!sItem) continue;
      const prov =
        (sItem.provider && typeof sItem.provider === 'object' ? sItem.provider.name : sItem.provider) ||
        sItem.server ||
        sourceName;
      if (Array.isArray(sItem.subtitles)) {
        for (const sub of sItem.subtitles) {
          pushSubItem(sub, String(prov));
        }
      }
      if (Array.isArray(sItem.captions)) {
        for (const sub of sItem.captions) {
          pushSubItem(sub, String(prov));
        }
      }
    }
  }

  if (collected.length === 0) return;

  const existing = subtitleCache.get(cacheKey) || [];
  const mergedMap = new Map<string, any>();
  for (const item of [...existing, ...collected]) {
    if (item && item.url && !mergedMap.has(item.url)) {
      mergedMap.set(item.url, item);
    }
  }
  subtitleCache.set(cacheKey, Array.from(mergedMap.values()));
}

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

      const activeCineproUrl = getCineproUrl();
      const activeTmdbEmbedUrl = getTmdbEmbedUrl();
      let streamUrl = s?.url || s?.stream_url || s?.link || s?.playlist || '';
      streamUrl = streamUrl.replace(/http:\/\/localhost:(3000|10000)/g, activeCineproUrl);
      streamUrl = streamUrl.replace(/http:\/\/localhost:3005/g, activeTmdbEmbedUrl);
      streamUrl = streamUrl.replace(/&amp;/g, '&');

      // Relay CinePro proxy through our local HTTPS server to prevent Mixed Content blocking (HTTP or HTTPS)
      streamUrl = streamUrl.replace(/^https?:\/\/62\.171\.179\.144(?::\d+)?\/v1\/proxy/i, '/v1/proxy');
      const cineproOrigin = activeCineproUrl.replace(/\/+$/, '');
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

// Track distinct movie/TV IDs scraped per IP in 5-minute windows to catch automated catalog dumpers without ever affecting real viewers
const distinctCatalogScrapeTracker = new Map<string, { windowStart: number; ids: Set<string> }>();

// GET /api/security/stream-token - Issues short-lived HMAC token for playback
app.get('/api/security/stream-token', (req: Request, res: Response) => {
  const type = (req.query.type as string) || 'movie';
  const id = (req.query.id as string) || '0';

  const ts = Date.now();
  const signature = crypto
    .createHmac('sha256', STREAM_SECURITY_SECRET)
    .update(`${ts}:${type}:${id}`)
    .digest('hex');

  const token = `${ts}.${signature}`;
  return res.json({
    token,
    expiresAt: ts + 300000,
  });
});

// GET /api/trap/probe & /api/trap/* - Honeypot Trap ONLY for confirmed non-browser bots & CLI scrapers
app.all(['/api/trap/probe', '/api/trap/*', '/trap/*'], (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || '';

  // Never ban a standard human browser (e.g. Firefox link prefetcher or browser security extension)
  if (isStandardHumanBrowser(userAgent) && !isKnownScraperBot(userAgent) && !isKnownInterceptionTool(userAgent)) {
    return res.status(204).end();
  }

  const record = banIpPermanently(
    ip,
    'Automated Bot Honeypot Trap Triggered',
    'honeypot',
    userAgent,
    req.path
  );
  if (record) {
    return sendPermanentBlockResponse(req, res, record);
  }
  return res.status(403).json({
    error: 'PERMANENT IP BLOCK: Automated crawler or data interception activity detected.',
    code: 'IP_PERMANENTLY_BLOCKED',
  });
});

// POST /api/security/intercept-report - Client-side sentinel report ONLY for confirmed headless frameworks (PhantomJS/Selenium/Nightmare)
app.post('/api/security/intercept-report', (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || '';
  const body = req.body || {};
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 120)
      : 'Confirmed Headless Scraper Framework';

  // Only permanently ban if it's a confirmed headless scraper framework or known bot tool
  const isConfirmedFramework =
    /PhantomJS|Selenium|Nightmare|Headless|WebDriver/i.test(reason) ||
    isKnownScraperBot(userAgent) ||
    isKnownInterceptionTool(userAgent);

  if (!isConfirmedFramework) {
    return res.json({ success: true, ignored: true });
  }

  const category: BanCategory = body.category === 'scraper' ? 'scraper' : 'interception';
  const reqPath = typeof body.path === 'string' ? body.path.slice(0, 80) : '/api/security/intercept-report';

  const record = banIpPermanently(ip, reason, category, userAgent, reqPath);
  return res.status(403).json({
    error: 'PERMANENT IP BLOCK: Your IP address has been permanently blacklisted.',
    code: 'IP_PERMANENTLY_BLOCKED',
    ip,
    reason,
    bannedAt: record?.bannedAt || Date.now(),
    permanent: true,
  });
});

app.get('/api/streams/:type/:id', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const ip = getClientIp(req);
    const userAgent = (req.headers['user-agent'] as string) || '';

    // 1. Detect Automated Bulk Catalog Scraping (> 85 distinct movie/TV IDs scraped within 5 minutes by the same IP)
    // Normal human viewers switching servers or episodes of a show request only 1–15 distinct title IDs in 5 minutes.
    const now = Date.now();
    const tracker = distinctCatalogScrapeTracker.get(ip);
    if (!tracker || now - tracker.windowStart > 5 * 60 * 1000) {
      distinctCatalogScrapeTracker.set(ip, { windowStart: now, ids: new Set([`${type}:${id}`]) });
    } else {
      tracker.ids.add(`${type}:${id}`);
      if (tracker.ids.size > 85) {
        const record = banIpPermanently(
          ip,
          `Automated Bulk Catalog Stream Harvester (${tracker.ids.size} distinct titles in 5m)`,
          'scraper',
          userAgent,
          req.path
        );
        if (record) return sendPermanentBlockResponse(req, res, record);
      }
    }

    // 2. Block External Website Hotlinking (when an external third-party website embeds /api/streams/ directly)
    const referer = (req.headers['referer'] as string) || '';
    const host = (req.headers['host'] as string) || '';
    if (referer) {
      const isAllowedOrigin =
        referer.includes(host) ||
        referer.includes('notflixtv.com') ||
        referer.includes('localhost') ||
        referer.includes('127.0.0.1') ||
        referer.includes('run.app') ||
        referer.includes('sslip.io');

      if (!isAllowedOrigin) {
        securityMetrics.totalInterceptionsBlocked++;
        recordSecurityEvent(
          ip,
          `Blocked External Hotlink Referer (${referer.slice(0, 60)})`,
          userAgent,
          req.path,
          'hotlink',
          false
        );
        return res.status(403).json({
          error: 'External stream hotlinking is prohibited.',
          code: 'HOTLINK_BLOCKED',
        });
      }
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

    const activeCineproBase = getCineproUrl();
    const activeTmdbEmbedBase = getTmdbEmbedUrl();
    const activeGatewayBase = getGatewayFallbackUrl();

    const cineproUrl = isTV
      ? `${activeCineproBase}/v1/tv/${id}/seasons/${s}/episodes/${e}`
      : `${activeCineproBase}/v1/movies/${id}`;

    const tmdbEmbedUrl = isTV
      ? `${activeTmdbEmbedBase}/api/streams/series/${id}?s=${s}&e=${e}`
      : `${activeTmdbEmbedBase}/api/streams/movie/${id}`;

    // Parallel Dual-Engine Scraping: CinePro + TMDB Embed
    const cineproTask = fetchWithTimeout(cineproUrl, 7500);
    const tmdbTask =
      activeTmdbEmbedBase && activeTmdbEmbedBase !== activeCineproBase
        ? fetchWithTimeout(tmdbEmbedUrl, 10000)
        : Promise.resolve(null);

    let combined: any[] = [];

    // Wait for CinePro first (typically returns in 0.3s - 3.5s with 30-50 streams)
    const subKey = `${type}-${id}-${s}-${e}`;
    const cineproData = await cineproTask.catch(() => null);
    if (cineproData) {
      combined = combined.concat(normalizeStreams(cineproData, 'CinePro'));
      harvestScraperSubtitles(subKey, cineproData, 'CinePro');
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
        harvestScraperSubtitles(subKey, quickTmdb, 'TMDB Embed');
      } else {
        // Background merge: when TMDB Embed finishes in background, merge streams AND subtitles into cache
        tmdbTask
          .then((bgTmdb) => {
            if (bgTmdb) {
              harvestScraperSubtitles(subKey, bgTmdb, 'TMDB Embed');
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
        harvestScraperSubtitles(subKey, tmdbData, 'TMDB Embed');
      }
    }

    // Step 3: Coolify gateway mirror fallback if still 0
    if (combined.length === 0 && activeGatewayBase) {
      const query = isTV ? `?s=${s}&e=${e}` : '';
      try {
        const gatewayData = await fetchWithTimeout(
          `${activeGatewayBase}/api/streams/${type}/${id}${query}`,
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
// 4. MULTI-SOURCE SUBTITLES AGGREGATOR & PROXY CONVERTER
// ==========================================
async function fetchJsonWithHeaders(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 6000
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...headers,
      },
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

app.get('/api/subtitles/search', async (req: Request, res: Response) => {
  try {
    let imdbId = String(req.query.imdbId || '').trim();
    const tmdbId = String(req.query.tmdbId || '').trim();
    const rawTitle = String(req.query.title || '').trim();
    const type = (req.query.type as string) === 'tv' ? 'tv' : 'movie';
    const s = String(req.query.s || '1');
    const e = String(req.query.e || '1');
    const subKey = `${type}-${tmdbId}-${s}-${e}`;

    const browserHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };

    // 1. If imdbId is missing or not a valid tt* IMDb ID, resolve external_ids & title from TMDB automatically
    let resolvedTitle = rawTitle;
    if (tmdbId && (!imdbId || !imdbId.startsWith('tt') || !resolvedTitle)) {
      try {
        const [extData, detailsData] = await Promise.all([
          !imdbId || !imdbId.startsWith('tt')
            ? fetchJsonWithHeaders(
                `${TMDB_BASE}/${type}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`,
                browserHeaders,
                3500
              )
            : Promise.resolve(null),
          !resolvedTitle
            ? fetchJsonWithHeaders(
                `${TMDB_BASE}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`,
                browserHeaders,
                3500
              )
            : Promise.resolve(null),
        ]);
        if (extData?.imdb_id && String(extData.imdb_id).startsWith('tt')) {
          imdbId = String(extData.imdb_id).trim();
        }
        if (detailsData) {
          resolvedTitle = String(detailsData.title || detailsData.name || detailsData.original_title || detailsData.original_name || '').trim();
        }
      } catch {}
    }

    const cleanImdbId = imdbId.startsWith('tt') ? imdbId : '';
    const cleanImdbDigits = cleanImdbId.replace(/^tt/i, '');

    // 2. Query OpenSubtitles v3 (Stremio) + OpenSubtitles Official REST API in parallel
    const stremioUrl = cleanImdbId
      ? type === 'tv'
        ? `https://opensubtitles-v3.strem.io/subtitles/series/${cleanImdbId}:${s}:${e}.json`
        : `https://opensubtitles-v3.strem.io/subtitles/movie/${cleanImdbId}.json`
      : '';

    const osRestImdbUrl = cleanImdbDigits
      ? type === 'tv'
        ? `https://rest.opensubtitles.org/search/episode-${e}/imdbid-${cleanImdbDigits}/season-${s}`
        : `https://rest.opensubtitles.org/search/imdbid-${cleanImdbDigits}`
      : '';

    // Also probe CinePro if subtitleCache doesn't have entries for this title yet
    const cineproSubProbePromise =
      tmdbId && !subtitleCache.has(subKey)
        ? fetchJsonWithHeaders(
            type === 'tv'
              ? `${getCineproUrl()}/v1/tv/${tmdbId}/seasons/${s}/episodes/${e}`
              : `${getCineproUrl()}/v1/movies/${tmdbId}`,
            browserHeaders,
            4500
          ).then((cpData) => {
            if (cpData) harvestScraperSubtitles(subKey, cpData, 'CinePro');
            return null;
          })
        : Promise.resolve(null);

    const [stremioData, osRestData] = await Promise.all([
      stremioUrl ? fetchJsonWithHeaders(stremioUrl, browserHeaders, 5500) : Promise.resolve(null),
      osRestImdbUrl
        ? fetchJsonWithHeaders(osRestImdbUrl, { 'User-Agent': 'TemporaryUserAgent' }, 5500)
        : Promise.resolve(null),
      cineproSubProbePromise,
    ]);

    // 3. Fallback to Title Query search on OpenSubtitles REST API if IMDb ID search returned 0 results
    let osRestTitleData: any = null;
    const hasStremioSubs = Array.isArray(stremioData?.subtitles) && stremioData.subtitles.length > 0;
    const hasOsRestSubs = Array.isArray(osRestData) && osRestData.length > 0;

    if (!hasStremioSubs && !hasOsRestSubs && resolvedTitle) {
      const encodedQuery = encodeURIComponent(resolvedTitle.toLowerCase());
      const osQueryUrl =
        type === 'tv'
          ? `https://rest.opensubtitles.org/search/episode-${e}/query-${encodedQuery}/season-${s}`
          : `https://rest.opensubtitles.org/search/query-${encodedQuery}`;
      osRestTitleData = await fetchJsonWithHeaders(
        osQueryUrl,
        { 'User-Agent': 'TemporaryUserAgent' },
        5000
      );
    }

    // 4. Aggregate & Normalize Subtitles from ALL Sources (Scraper Cache + OpenSubtitles v3 + OpenSubtitles REST)
    const aggregated: Array<{
      id: string;
      lang: string;
      url: string;
      source?: string;
    }> = [];
    const seenUrls = new Set<string>();

    const addSub = (id: string, rawLangObj: any, url: string, source: string) => {
      if (!url || typeof url !== 'string' || !url.startsWith('http')) return;
      // Deprioritize or skip known rate-limited NetMirror links if other sources exist
      const normUrl = url.trim();
      if (seenUrls.has(normUrl)) return;
      seenUrls.add(normUrl);

      const lang = normalizeSubtitleLanguage(rawLangObj);
      aggregated.push({
        id: id || `${source}-${lang}-${aggregated.length}`,
        lang,
        url: normUrl,
        source,
      });
    };

    // Source A: Cached Scraper Subtitles (CinePro / Wyzie / OneTouchTV / CastleTV) - non-NetMirror first
    const cachedScraperSubs = (tmdbId && subtitleCache.get(subKey)) || [];
    for (const c of cachedScraperSubs) {
      if (c?.url && !String(c.url).includes('net27.cc')) {
        addSub(c.id || c.label || c.url, c, c.url, c.source || 'Scraper');
      }
    }

    // Source B: OpenSubtitles Stremio v3 (UTF-8 direct SRTs)
    if (Array.isArray(stremioData?.subtitles)) {
      for (const sub of stremioData.subtitles) {
        if (sub?.url) {
          addSub(String(sub.id || sub.url), sub, sub.url, 'OpenSubtitles v3');
        }
      }
    }

    // Source C: OpenSubtitles Official REST API (IMDb match + Title match)
    const restCombined = [
      ...(Array.isArray(osRestData) ? osRestData : []),
      ...(Array.isArray(osRestTitleData) ? osRestTitleData : []),
    ];
    for (const item of restCombined) {
      if (!item) continue;
      // Prefer Stremio UTF-8 direct mirror via IDSubtitleFile if available, plus SubDownloadLink (.gz)
      if (item.IDSubtitleFile) {
        const directUtf8Url = `https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/${item.IDSubtitleFile}`;
        addSub(`os-file-${item.IDSubtitleFile}`, item, directUtf8Url, 'OpenSubtitles');
      }
      if (item.SubDownloadLink) {
        addSub(`os-gz-${item.IDSubtitleFile || ''}`, item, item.SubDownloadLink, 'OpenSubtitles GZ');
      }
    }

    // Source D: Remaining cached scraper subtitles (e.g. NetMirror fallback)
    for (const c of cachedScraperSubs) {
      if (c?.url && String(c.url).includes('net27.cc')) {
        addSub(c.id || c.label || c.url, c, c.url, c.source || 'NetMirror');
      }
    }

    return res.json({
      subtitles: aggregated,
      imdbId: cleanImdbId || undefined,
      count: aggregated.length,
    });
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

    const isOpenSubDl = subUrl.includes('opensubtitles.org');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    let response: globalThis.Response;
    try {
      response = await fetch(subUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': isOpenSubDl
            ? 'TemporaryUserAgent'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: '*/*',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return res.status(response.status).send('Failed to fetch subtitle from upstream');
    }

    const arrayBuffer = await response.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);

    // Automatically gunzip if upstream returned a .gz compressed subtitle file (e.g. dl.opensubtitles.org)
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try {
        buffer = zlib.gunzipSync(buffer);
      } catch (gzErr) {
        console.warn('Subtitle gunzip error:', gzErr);
      }
    }

    // Decode text handling UTF-8 BOM, UTF-16 LE/BE, or custom senc encoding query parameter
    let text = '';
    const sencMatch = subUrl.match(/[?&]senc=([^&]+)/i);
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      text = new TextDecoder('utf-16le').decode(buffer.subarray(2));
    } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      text = new TextDecoder('utf-16be').decode(buffer.subarray(2));
    } else if (sencMatch && sencMatch[1]) {
      try {
        text = new TextDecoder(sencMatch[1].toLowerCase()).decode(buffer);
      } catch {
        text = buffer.toString('utf8');
      }
    } else {
      text = buffer.toString('utf8');
    }

    // Strip UTF-8 BOM if present and normalize CRLF line endings
    text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Convert SRT to WebVTT and normalize short MM:SS.mmm timestamps to HH:MM:SS.mmm
    if (!text.trim().startsWith('WEBVTT')) {
      text =
        'WEBVTT\n\n' +
        text
          .replace(/\{\\([ibu])\}/g, '<$1>')
          .replace(/\{\\\/([ibu])\}/g, '</$1>')
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    } else {
      text = text
        .replace(/\{\\([ibu])\}/g, '<$1>')
        .replace(/\{\\\/([ibu])\}/g, '</$1>')
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    // Normalize short MM:SS.mmm cue timestamps (e.g. CastleTV 00:13.791 --> 00:16.041) to 00:MM:SS.mmm
    text = text.replace(/(^|\s)(\d{2}:\d{2}\.\d{3})(?=\s*-->|\s*$)/gm, '$100:$2');

    // Remove injected ad/watermark lines (e.g. sportdb.pro, osdb.link)
    text = text.replace(/^.*(?:sportdb\.pro|osdb\.link|opensubtitles\.org).*$/gim, '');

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
      targetUrl = `${getCineproUrl()}/v1/proxy${queryString}`;
    } else if (
      targetUrl.startsWith('/') ||
      /^https?:\/\/(localhost|127\.|0\.0\.0\.0|169\.254\.|\[::1\])/i.test(targetUrl) ||
      targetUrl.includes('/api/admin') ||
      targetUrl.includes('analytics.json') ||
      targetUrl.includes('scrapers.json')
    ) {
      const ip = getClientIp(req);
      const userAgent = (req.headers['user-agent'] as string) || '';
      const record = banIpPermanently(
        ip,
        'Stream Proxy SSRF / Internal Data Interception Attempt',
        'interception',
        userAgent,
        req.path
      );
      if (record) return sendPermanentBlockResponse(req, res, record);
      return res.status(403).send('Forbidden: Internal network interception blocked');
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
    const targetUrl = `${getCineproUrl()}/v1/proxy${queryString}`;

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
const ADMIN_TOKEN_SECRET = crypto
  .createHash('sha256')
  .update(`notflix-admin-secret:${ADMIN_USERNAME}:${ADMIN_PASSWORD}`)
  .digest('hex');

// Admin active sessions & revoked tokens (supports stateless HMAC tokens that survive container restarts)
const activeAdminTokens = new Map<string, { createdAt: number; expiresAt: number; username: string }>();
const revokedAdminTokens = new Set<string>();

function createStatelessAdminToken(username: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token: string): { username: string; expiresAt: number } | null {
  if (!token || revokedAdminTokens.has(token)) return null;

  // 1. Check stateless HMAC token (survives container updates/restarts)
  if (token.includes('.')) {
    const [payload, sig] = token.split('.');
    if (payload && sig) {
      const expectedSig = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payload).digest('base64url');
      if (sig === expectedSig) {
        try {
          const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
          if (decoded && decoded.u === ADMIN_USERNAME && typeof decoded.exp === 'number' && Date.now() <= decoded.exp) {
            return { username: decoded.u, expiresAt: decoded.exp };
          }
        } catch {
          return null;
        }
      }
    }
  }

  // 2. Fallback to legacy in-memory token map
  const session = activeAdminTokens.get(token);
  if (session && Date.now() <= session.expiresAt) {
    return { username: session.username, expiresAt: session.expiresAt };
  }
  if (session) activeAdminTokens.delete(token);
  return null;
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.slice(7).trim();
  const verified = verifyAdminToken(token);
  if (!verified) {
    return res.status(401).json({ error: 'Unauthorized: Session expired or invalid' });
  }
  const adminIp = getClientIp(req);
  if (adminIp && !isInternalOrLoopbackIp(adminIp)) {
    whitelistedAdminIps.add(adminIp);
    if (permanentlyBannedIps.has(adminIp)) {
      unblockIpPermanently(adminIp);
    }
  }
  next();
}

// Persistent Analytics storage (multi-path merge + redundant mirror)
const ANALYTICS_DATA_FILE = path.join(DATA_DIR, 'analytics.json');
const ANALYTICS_BACKUP_MIRROR_FILE = '/var/tmp/notflix_analytics_backup.json';

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
    ANALYTICS_BACKUP_MIRROR_FILE,
    '/data/analytics.json',
    '/app/data/analytics.json',
    path.join(process.cwd(), 'data', 'analytics.json'),
    path.join(__dirname, 'data', 'analytics.json'),
    '/app/data_seed/analytics.json',
    path.join(process.cwd(), 'data_seed', 'analytics.json'),
  ];

  const mergedMap = new Map<string, AnalyticsEvent>();

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed.events) && parsed.events.length > 0) {
          const sanitized = sanitizeAnalyticsEvents(parsed.events);
          let addedFromCandidate = 0;
          for (const ev of sanitized) {
            if (ev && ev.id && !mergedMap.has(ev.id)) {
              mergedMap.set(ev.id, ev);
              addedFromCandidate++;
            }
          }
          if (addedFromCandidate > 0) {
            console.log(`📊 Merged ${addedFromCandidate} analytics events from ${candidate} (total: ${mergedMap.size})`);
          }
        }
      }
    } catch (e) {
      console.warn(`Could not read analytics candidate ${candidate}:`, e);
    }
  }

  const mergedEvents = Array.from(mergedMap.values()).sort((a, b) => a.ts - b.ts).slice(-20000);
  return { events: mergedEvents, lastUpdated: Date.now() };
}

function flushAnalyticsToDiskSync() {
  try {
    analyticsStore.lastUpdated = Date.now();
    if (analyticsStore.events.length > 20000) {
      analyticsStore.events = analyticsStore.events.slice(-20000);
    }
    const serialized = JSON.stringify(analyticsStore);
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(ANALYTICS_DATA_FILE, serialized, 'utf-8');
    try {
      fs.writeFileSync(ANALYTICS_BACKUP_MIRROR_FILE, serialized, 'utf-8');
    } catch {
      // Ignore if /var/tmp is read-only
    }
  } catch (err) {
    console.error('Error saving analytics data:', err);
  }
}

analyticsStore = readAnalyticsData();
if (analyticsStore.events.length > 0) {
  flushAnalyticsToDiskSync();
}

let saveAnalyticsTimeout: NodeJS.Timeout | null = null;
function scheduleSaveAnalytics() {
  if (saveAnalyticsTimeout) return;
  saveAnalyticsTimeout = setTimeout(() => {
    saveAnalyticsTimeout = null;
    flushAnalyticsToDiskSync();
  }, 1500);
}

// Flush pending analytics and immediately release HTTP Keep-Alive sockets + exit on container stop/redeploy
function handleGracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`🛑 Received ${signal} — flushing analytics and draining browser connections for zero-downtime update...`);

  if (saveAnalyticsTimeout) {
    clearTimeout(saveAnalyticsTimeout);
    saveAnalyticsTimeout = null;
  }
  if (saveBansTimeout) {
    clearTimeout(saveBansTimeout);
    saveBansTimeout = null;
  }
  flushAnalyticsToDiskSync();
  savePermanentBansToDiskSync();
  if (scraperConfigStore.isCustom) {
    saveScraperConfigToDiskSync(scraperConfigStore);
  }

  if (activeHttpServer) {
    try {
      if (typeof activeHttpServer.closeIdleConnections === 'function') {
        activeHttpServer.closeIdleConnections();
      }
      if (typeof activeHttpServer.closeAllConnections === 'function') {
        activeHttpServer.closeAllConnections();
      }
      activeHttpServer.close(() => {
        process.exit(0);
      });
    } catch {
      process.exit(0);
    }
    // Force exit within 200ms so Docker/Traefik never sees overlapping container routers
    setTimeout(() => process.exit(0), 200).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

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

  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days session
  const token = createStatelessAdminToken(ADMIN_USERNAME, expiresAt);
  activeAdminTokens.set(token, { createdAt: Date.now(), expiresAt, username: ADMIN_USERNAME });

  const adminIp = getClientIp(req);
  if (adminIp && !isInternalOrLoopbackIp(adminIp)) {
    whitelistedAdminIps.add(adminIp);
    if (permanentlyBannedIps.has(adminIp)) {
      unblockIpPermanently(adminIp);
    }
  }

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
  const verified = verifyAdminToken(token);
  if (!verified) {
    return res.status(401).json({ valid: false });
  }
  const adminIp = getClientIp(req);
  if (adminIp && !isInternalOrLoopbackIp(adminIp)) {
    whitelistedAdminIps.add(adminIp);
    if (permanentlyBannedIps.has(adminIp)) {
      unblockIpPermanently(adminIp);
    }
  }
  return res.json({ valid: true, username: verified.username });
});

// POST /api/admin/logout
app.post('/api/admin/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    activeAdminTokens.delete(token);
    revokedAdminTokens.add(token);
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
      totalStoredEvents: analyticsStore.events.length,
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
        totalInterceptionsBlocked: securityMetrics.totalInterceptionsBlocked,
        totalRateLimited: securityMetrics.totalRateLimited,
        totalHoneypotTrapped: securityMetrics.totalHoneypotTrapped,
        activeBannedIps: permanentlyBannedIps.size,
        permanentBans: Array.from(permanentlyBannedIps.values())
          .sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)
          .slice(0, 100),
        recentEvents: securityMetrics.recentSecurityEvents.slice(0, 30),
      },
    });
  } catch (err) {
    console.error('Error generating analytics:', err);
    return res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// GET /api/admin/security/bans (Fetch all permanently blocked IPs)
app.get('/api/admin/security/bans', requireAdminAuth, (_req: Request, res: Response) => {
  return res.json({
    success: true,
    count: permanentlyBannedIps.size,
    bans: Array.from(permanentlyBannedIps.values()).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt),
  });
});

// POST /api/admin/security/ban (Manually block an IP permanently from Admin Dashboard)
app.post('/api/admin/security/ban', requireAdminAuth, (req: Request, res: Response) => {
  const { ip, reason } = req.body || {};
  if (!ip || typeof ip !== 'string' || !ip.trim()) {
    return res.status(400).json({ error: 'Valid IP address is required' });
  }
  const cleanIp = ip.trim().replace(/^::ffff:/i, '');
  if (isInternalOrLoopbackIp(cleanIp)) {
    return res.status(400).json({ error: 'Cannot block loopback or internal container network IPs' });
  }
  const record = banIpPermanently(
    cleanIp,
    typeof reason === 'string' && reason.trim() ? reason.trim() : 'Manually Blocked by Admin',
    'manual',
    'Admin Manual Block',
    '/admin'
  );
  return res.json({
    success: true,
    record,
    bans: Array.from(permanentlyBannedIps.values()).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt),
  });
});

// POST /api/admin/security/unblock (Unblock a permanently banned IP or clear all bans)
app.post('/api/admin/security/unblock', requireAdminAuth, (req: Request, res: Response) => {
  const { ip, all } = req.body || {};
  if (all === true) {
    const cleared = permanentlyBannedIps.size;
    permanentlyBannedIps.clear();
    rateLimitStrikes.clear();
    savePermanentBansToDiskSync();
    return res.json({
      success: true,
      cleared,
      bans: [],
    });
  }
  if (!ip || typeof ip !== 'string' || !ip.trim()) {
    return res.status(400).json({ error: 'IP address is required to unblock' });
  }
  const removed = unblockIpPermanently(ip);
  return res.json({
    success: true,
    removed,
    bans: Array.from(permanentlyBannedIps.values()).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt),
  });
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
    flushAnalyticsToDiskSync();

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

// ============================================================================
// ADMIN SCRAPER API SERVER CONFIGURATION & LIVE PING ENDPOINTS
// ============================================================================

// GET /api/admin/scrapers (Fetch active scraper server URLs, hosts, and ports)
app.get('/api/admin/scrapers', requireAdminAuth, (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res.json({
    success: true,
    config: scraperConfigStore,
  });
});

// POST /api/admin/scrapers (Update or reset scraper server URLs/ports & flush stream cache)
app.post('/api/admin/scrapers', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const defaults = getDefaultScraperConfigStore();

    if (body.reset === true) {
      scraperConfigStore = {
        ...defaults,
        updatedAt: Date.now(),
        isCustom: false,
      };
      saveScraperConfigToDiskSync(scraperConfigStore);
      apiCache.clear();
      return res.json({
        success: true,
        config: scraperConfigStore,
        message: 'Scraper servers restored to default Coolify endpoints and stream cache cleared.',
      });
    }

    const incoming = body.scrapers || {};
    const cinepro = parseUrlIntoEndpoint(
      'cinepro',
      defaults.scrapers.cinepro.name,
      defaults.scrapers.cinepro.role,
      incoming.cinepro || scraperConfigStore.scrapers.cinepro,
      DEFAULT_SCRAPER_CINEPRO_URL
    );
    const tmdb_embed = parseUrlIntoEndpoint(
      'tmdb_embed',
      defaults.scrapers.tmdb_embed.name,
      defaults.scrapers.tmdb_embed.role,
      incoming.tmdb_embed || scraperConfigStore.scrapers.tmdb_embed,
      DEFAULT_SCRAPER_TMDB_EMBED_URL
    );
    const gateway_fallback = parseUrlIntoEndpoint(
      'gateway_fallback',
      defaults.scrapers.gateway_fallback.name,
      defaults.scrapers.gateway_fallback.role,
      incoming.gateway_fallback || scraperConfigStore.scrapers.gateway_fallback,
      DEFAULT_SCRAPER_GATEWAY_URL
    );

    const isCustom =
      cinepro.url !== DEFAULT_SCRAPER_CINEPRO_URL ||
      tmdb_embed.url !== DEFAULT_SCRAPER_TMDB_EMBED_URL ||
      gateway_fallback.url !== DEFAULT_SCRAPER_GATEWAY_URL;

    scraperConfigStore = {
      scrapers: {
        cinepro,
        tmdb_embed,
        gateway_fallback,
      },
      updatedAt: typeof body.updatedAt === 'number' && body.updatedAt > 0 ? body.updatedAt : Date.now(),
      isCustom,
    };

    saveScraperConfigToDiskSync(scraperConfigStore);
    // Clear cached stream responses so new playback requests immediately use the updated scraper servers
    apiCache.clear();

    return res.json({
      success: true,
      config: scraperConfigStore,
      message: 'Scraper API servers updated and active stream cache cleared immediately.',
    });
  } catch (err: any) {
    console.error('Error updating scraper servers:', err);
    return res.status(500).json({ error: 'Failed to update scraper servers: ' + (err?.message || err) });
  }
});

// POST /api/admin/scrapers/test (Live connection & stream probe from backend to target scraper server)
app.post('/api/admin/scrapers/test', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const id = (body.id as ScraperServerId) || 'cinepro';
    const defaults = getDefaultScraperConfigStore();
    const defaultForId = defaults.scrapers[id]?.defaultUrl || DEFAULT_SCRAPER_CINEPRO_URL;

    const parsedEndpoint = parseUrlIntoEndpoint(
      id,
      defaults.scrapers[id]?.name || 'Scraper Server',
      defaults.scrapers[id]?.role || '',
      body,
      defaultForId
    );

    const baseUrl = parsedEndpoint.url;
    // Use TMDB ID 550 (Fight Club) as a fast, deterministic probe target
    let probeUrl = `${baseUrl}/v1/movies/550`;
    if (id === 'tmdb_embed') {
      probeUrl = `${baseUrl}/api/streams/movie/550`;
    } else if (id === 'gateway_fallback') {
      probeUrl = `${baseUrl}/api/health`;
    }

    const startTs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);

    try {
      const response = await fetch(probeUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'Notflix-Admin-Diagnostic/2.5',
        },
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - startTs;

      let streamCount: number | null = null;
      let statusNote = `HTTP ${response.status}`;

      try {
        const text = await response.text();
        if (text && text.trim().startsWith('{')) {
          const json = JSON.parse(text);
          const list =
            json.streams || json.sources || json.results || json.data || (Array.isArray(json) ? json : null);
          if (Array.isArray(list)) {
            streamCount = list.length;
          } else if (json.status === 'ok') {
            statusNote = 'Health OK';
          }
        }
      } catch {}

      const reachable = response.status >= 200 && response.status < 500;
      return res.json({
        success: true,
        reachable,
        status: response.status,
        latencyMs,
        streamCount,
        testedUrl: probeUrl,
        normalizedUrl: baseUrl,
        message: reachable
          ? streamCount !== null
            ? `Online (${latencyMs} ms) · ${streamCount} streams verified`
            : `Online (${latencyMs} ms) · ${statusNote}`
          : `Server returned HTTP ${response.status} (${latencyMs} ms)`,
      });
    } catch (fetchErr: any) {
      clearTimeout(timer);
      const latencyMs = Date.now() - startTs;
      const errCode = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.name || 'UNREACHABLE';
      return res.json({
        success: true,
        reachable: false,
        status: 0,
        latencyMs,
        streamCount: null,
        testedUrl: probeUrl,
        normalizedUrl: baseUrl,
        message: `Unreachable (${errCode}) after ${latencyMs} ms`,
      });
    }
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      reachable: false,
      error: err?.message || 'Diagnostic test failed',
    });
  }
});

// Deployment version & instant cache invalidation endpoint
app.get('/api/version', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate, max-age=0');
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

// Self-unregistering Service Worker killer so no browser ever gets stuck on a cached SW
const SW_KILLER_SCRIPT = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((client) => client.navigate(client.url)))
  );
});
`;

app.get(['/sw.js', '/service-worker.js', '/workbox-*.js'], (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.send(SW_KILLER_SCRIPT);
});

function setNoStoreHtmlHeaders(res: Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
}

// ==========================================
// 6. DEV & PROD VITE STATIC INTEGRATION
// ==========================================
async function startServer() {
  const distPath = path.join(__dirname, 'dist');
  let hasDist = fs.existsSync(path.join(distPath, 'index.html'));

  // Self-healing fallback: if a cached container build ever skipped dist/index.html, build it automatically
  if (!hasDist && process.env.NODE_ENV === 'production') {
    console.warn('⚠️ dist/index.html missing in production container — running self-healing vite build...');
    try {
      execSync('npx vite build', { stdio: 'inherit', cwd: __dirname });
      hasDist = fs.existsSync(path.join(distPath, 'index.html'));
    } catch (buildErr) {
      console.error('⚠️ Self-healing vite build failed, falling back to Vite runtime middleware:', buildErr);
    }
  }

  const isProd = hasDist && process.env.NODE_ENV !== 'development';

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
  app.use(
    express.static(path.join(__dirname, 'public'), {
      etag: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.webmanifest') || filePath.endsWith('.json')) {
          setNoStoreHtmlHeaders(res);
        }
      },
    })
  );

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
        setNoStoreHtmlHeaders(res);
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
    app.use(
      express.static(distPath, {
        index: false, // Handle index.html explicitly with strict no-store headers
        etag: false,
        lastModified: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            setNoStoreHtmlHeaders(res);
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );

    // If an open browser tab requests an old hashed JS/CSS chunk from before a deployment,
    // return an uncached 404 (not index.html) so the client chunk-recovery script triggers an instant reload
    app.get('/assets/*', (_req: Request, res: Response) => {
      setNoStoreHtmlHeaders(res);
      res.status(404).type('text/plain').send('Asset chunk superseded by new deployment');
    });

    // Single-Page Application (SPA) catch-all route for /, /admin, /movies, /series, /anime, etc.
    app.get('*', (_req: Request, res: Response) => {
      setNoStoreHtmlHeaders(res);
      const prodIndex = path.join(distPath, 'index.html');
      const rootIndex = path.join(__dirname, 'index.html');
      const targetIndex = fs.existsSync(prodIndex) ? prodIndex : rootIndex;
      res.sendFile(targetIndex, { etag: false, lastModified: false });
    });

    console.log(`📦 Serving production build from ${distPath} (version: ${DEPLOYMENT_VERSION})`);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Notflix Full-Stack Server running on http://0.0.0.0:${PORT}`);
  });

  activeHttpServer = server;
  // Keep keepAliveTimeout short enough for clean proxy handoffs
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  server.on('error', (err) => {
    console.error('❌ Server listen error:', err);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
