import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import zlib from 'zlib';
import { Readable } from 'stream';
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

// Persistent Data Directory Setup (Multi-volume +Downloads persistence mirror)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DOWNLOADS_PERSIST_DIR = path.join(__dirname, 'downloads', '.persistence');
const TMP_PERSIST_DIR = '/var/tmp/notflix_persistence';
const ROOT_DATA_DIR = '/data';

const PERSISTENT_WRITE_DIRS = Array.from(
  new Set([
    DATA_DIR,
    path.join(process.cwd(), 'data'),
    DOWNLOADS_PERSIST_DIR,
    TMP_PERSIST_DIR,
    ROOT_DATA_DIR,
  ])
);

const PERSISTENT_READ_DIRS = Array.from(
  new Set([
    ...PERSISTENT_WRITE_DIRS,
    path.join(__dirname, 'data_seed'),
    path.join(process.cwd(), 'data_seed'),
    '/app/data',
    '/app/data_seed',
    '/app/downloads/.persistence',
  ])
);

for (const dir of PERSISTENT_WRITE_DIRS) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Ignore read-only paths on restricted hosts
  }
}

function writeFileAtomicallyToMirrors(filename: string, serialized: string, extraFilePath?: string) {
  for (const dir of PERSISTENT_WRITE_DIRS) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const target = path.join(dir, filename);
      const tmpTarget = `${target}.tmp.${process.pid}`;
      fs.writeFileSync(tmpTarget, serialized, 'utf-8');
      fs.renameSync(tmpTarget, target);
    } catch {
      // Fallback direct write if rename across mount points or non-writable dir
      try {
        fs.writeFileSync(path.join(dir, filename), serialized, 'utf-8');
      } catch {}
    }
  }
  if (extraFilePath) {
    try {
      fs.writeFileSync(extraFilePath, serialized, 'utf-8');
    } catch {}
  }
}

const USER_PROFILES_FILE = path.join(DATA_DIR, 'user_profiles.json');
const LEGACY_GLOBAL_USER_DATA_FILE = path.join(DATA_DIR, 'userdata.json');
const BLOCKED_IPS_FILE = path.join(DATA_DIR, 'blocked_ips.json');
const BLOCKED_IPS_BACKUP_MIRROR_FILE = '/var/tmp/notflix_blocked_ips_backup.json';

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
  /^\/downloads\/\.persistence/i,
  /analytics\.json/i,
  /scrapers\.json/i,
  /user_profiles\.json/i,
  /blocked_ips\.json/i,
  /adblock_policy\.json/i,
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
  scheduleSavePermanentBans();
}

// Persistent Permanent IP Blacklist Map (IP -> PermanentBanRecord)
const permanentlyBannedIps = new Map<string, PermanentBanRecord>();
// Tombstones for explicitly unblocked IPs (IP -> timestamp when unblocked) so merges never resurrect unblocked IPs
const unblockedIpTombstones = new Map<string, number>();
let lastClearedAllBansAt = 0;

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

function mergePermanentBansAndSecurityPayload(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  let changed = false;

  if (typeof parsed.lastClearedAllBansAt === 'number' && parsed.lastClearedAllBansAt > lastClearedAllBansAt) {
    lastClearedAllBansAt = parsed.lastClearedAllBansAt;
    for (const [existingIp, rec] of permanentlyBannedIps.entries()) {
      if ((rec.lastAttemptAt || rec.bannedAt || 0) <= lastClearedAllBansAt) {
        permanentlyBannedIps.delete(existingIp);
        changed = true;
      }
    }
  }

  if (parsed.unblockedTombstones && typeof parsed.unblockedTombstones === 'object') {
    for (const [rawIp, tsVal] of Object.entries(parsed.unblockedTombstones)) {
      const cleanIp = String(rawIp || '').replace(/^::ffff:/i, '').trim();
      const ts = Number(tsVal) || 0;
      if (cleanIp && ts > (unblockedIpTombstones.get(cleanIp) || 0)) {
        unblockedIpTombstones.set(cleanIp, ts);
        const existing = permanentlyBannedIps.get(cleanIp);
        if (existing && (existing.lastAttemptAt || existing.bannedAt || 0) <= ts) {
          permanentlyBannedIps.delete(cleanIp);
          changed = true;
        }
      }
    }
  }

  const list: PermanentBanRecord[] = Array.isArray(parsed?.bans) ? parsed.bans : [];
  for (const item of list) {
    if (item && item.ip && !isInternalOrLoopbackIp(item.ip)) {
      const cleanIp = item.ip.replace(/^::ffff:/i, '').trim();
      const itemLastAttempt = Number(item.lastAttemptAt || item.bannedAt) || Date.now();
      const tombstoneTs = unblockedIpTombstones.get(cleanIp) || 0;

      if (itemLastAttempt <= lastClearedAllBansAt || itemLastAttempt <= tombstoneTs) {
        continue;
      }

      const existing = permanentlyBannedIps.get(cleanIp);
      if (!existing) {
        permanentlyBannedIps.set(cleanIp, {
          ip: cleanIp,
          reason: item.reason || 'Permanent Security Ban',
          category: item.category || 'scraper',
          userAgent: item.userAgent || 'unknown',
          path: item.path || '/',
          bannedAt: Number(item.bannedAt) || itemLastAttempt,
          permanent: true,
          blockedAttempts: Math.max(1, Number(item.blockedAttempts) || 1),
          lastAttemptAt: itemLastAttempt,
        });
        changed = true;
      } else {
        const mergedAttempts = Math.max(existing.blockedAttempts || 1, Number(item.blockedAttempts) || 1);
        const mergedLastAttempt = Math.max(existing.lastAttemptAt || 0, itemLastAttempt);
        const mergedBannedAt = Math.min(existing.bannedAt || itemLastAttempt, Number(item.bannedAt) || itemLastAttempt);
        if (
          mergedAttempts !== existing.blockedAttempts ||
          mergedLastAttempt !== existing.lastAttemptAt ||
          mergedBannedAt !== existing.bannedAt
        ) {
          existing.blockedAttempts = mergedAttempts;
          existing.lastAttemptAt = mergedLastAttempt;
          existing.bannedAt = mergedBannedAt;
          changed = true;
        }
      }
    }
  }

  const incomingMetrics = parsed.securityMetrics || parsed.metrics;
  if (incomingMetrics && typeof incomingMetrics === 'object') {
    const nextScrapers = Math.max(
      securityMetrics.totalBlockedScrapers,
      Number(incomingMetrics.totalBlockedScrapers) || 0,
      permanentlyBannedIps.size
    );
    const nextInterceptions = Math.max(
      securityMetrics.totalInterceptionsBlocked,
      Number(incomingMetrics.totalInterceptionsBlocked) || 0
    );
    const nextRateLimited = Math.max(
      securityMetrics.totalRateLimited,
      Number(incomingMetrics.totalRateLimited) || 0
    );
    const nextHoneypot = Math.max(
      securityMetrics.totalHoneypotTrapped,
      Number(incomingMetrics.totalHoneypotTrapped) || 0
    );

    if (
      nextScrapers !== securityMetrics.totalBlockedScrapers ||
      nextInterceptions !== securityMetrics.totalInterceptionsBlocked ||
      nextRateLimited !== securityMetrics.totalRateLimited ||
      nextHoneypot !== securityMetrics.totalHoneypotTrapped
    ) {
      securityMetrics.totalBlockedScrapers = nextScrapers;
      securityMetrics.totalInterceptionsBlocked = nextInterceptions;
      securityMetrics.totalRateLimited = nextRateLimited;
      securityMetrics.totalHoneypotTrapped = nextHoneypot;
      changed = true;
    }

    const incomingEvents = Array.isArray(incomingMetrics.recentSecurityEvents)
      ? incomingMetrics.recentSecurityEvents
      : Array.isArray(incomingMetrics.recentEvents)
      ? incomingMetrics.recentEvents
      : [];
    if (incomingEvents.length > 0) {
      const evMap = new Map<string, any>();
      for (const ev of [...securityMetrics.recentSecurityEvents, ...incomingEvents]) {
        if (ev && ev.ip && ev.ts) {
          const key = `${ev.ip}_${ev.ts}_${ev.path || ''}`;
          if (!evMap.has(key)) evMap.set(key, ev);
        }
      }
      const mergedEvents = Array.from(evMap.values())
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 60);
      if (mergedEvents.length !== securityMetrics.recentSecurityEvents.length) {
        changed = true;
      }
      securityMetrics.recentSecurityEvents = mergedEvents;
    }
  } else if (permanentlyBannedIps.size > securityMetrics.totalBlockedScrapers) {
    securityMetrics.totalBlockedScrapers = permanentlyBannedIps.size;
  }

  return changed;
}

function loadPermanentBansFromDisk() {
  const candidatePaths = Array.from(
    new Set([
      ...PERSISTENT_READ_DIRS.map((d) => path.join(d, 'blocked_ips.json')),
      BLOCKED_IPS_FILE,
      BLOCKED_IPS_BACKUP_MIRROR_FILE,
    ])
  );

  let purgedLegacyV1Bans = false;
  let loadedAny = false;

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8').trim();
        if (!raw) continue;
        const parsed = JSON.parse(raw);

        // Automatically purge v1 ban files that could contain false-positive browser bans
        if (!parsed || parsed.schemaVersion !== BAN_STORAGE_SCHEMA_VERSION) {
          purgedLegacyV1Bans = true;
          continue;
        }

        if (mergePermanentBansAndSecurityPayload(parsed)) {
          loadedAny = true;
        }
      }
    } catch (e) {
      console.warn(`Could not read blocked_ips candidate ${candidate}:`, e);
    }
  }

  if (purgedLegacyV1Bans || loadedAny) {
    savePermanentBansToDiskSync();
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
        lastClearedAllBansAt,
        unblockedTombstones: Object.fromEntries(unblockedIpTombstones.entries()),
        bans: Array.from(permanentlyBannedIps.values()),
        securityMetrics,
      },
      null,
      2
    );
    writeFileAtomicallyToMirrors('blocked_ips.json', serialized, BLOCKED_IPS_BACKUP_MIRROR_FILE);
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
  unblockedIpTombstones.delete(cleanIp);
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
  securityMetrics.totalBlockedScrapers++;
  if (category === 'interception' || category === 'hotlink') {
    securityMetrics.totalInterceptionsBlocked++;
  } else if (category === 'honeypot') {
    securityMetrics.totalHoneypotTrapped++;
  }

  recordSecurityEvent(cleanIp, `PERMANENT BAN: ${reason}`, userAgent, reqPath, category, true);
  savePermanentBansToDiskSync();
  console.warn(`🚨 [PERMANENT IP BLOCK] Blocked ${cleanIp} permanently | Reason: ${reason} | Path: ${reqPath}`);
  return record;
}

function unblockIpPermanently(rawIp: string): boolean {
  const cleanIp = (rawIp || '').replace(/^::ffff:/i, '').trim();
  unblockedIpTombstones.set(cleanIp, Date.now());
  const deleted = permanentlyBannedIps.delete(cleanIp);
  rateLimitStrikes.delete(cleanIp);
  savePermanentBansToDiskSync();
  return deleted;
}

// In-Memory Sliding-Window Rate Limiters (IP -> timestamp[])
const globalApiRateLimiter = new Map<string, number[]>();
const streamRateLimiter = new Map<string, number[]>();
const adminLoginRateLimiter = new Map<string, number[]>();

function escapeHtmlText(unsafe: unknown): string {
  return String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeCompareStrings(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB) && a.length === b.length;
}

/**
 * Validates that an external URL is safe for server-side proxy fetching (prevents SSRF to loopback,
 * RFC1918 private networks, link-local cloud metadata 169.254.169.254, IPv6 private ranges, or non-HTTP schemes).
 */
function isSafeExternalProxyUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
    if (!host) return false;

    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host === '0.0.0.0' ||
      host === '::' ||
      host === '::1' ||
      host === '0:0:0:0:0:0:0:1' ||
      host === 'metadata.google.internal' ||
      host === 'metadata'
    ) {
      return false;
    }

    // Block IPv6 private / loopback / link-local / IPv4-mapped private addresses
    if (host.includes(':')) {
      if (
        host.startsWith('fe80:') ||
        host.startsWith('fc') ||
        host.startsWith('fd') ||
        host.startsWith('::ffff:127.') ||
        host.startsWith('::ffff:10.') ||
        host.startsWith('::ffff:192.168.') ||
        host.startsWith('::ffff:169.254.') ||
        /^::ffff:172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
      ) {
        return false;
      }
    }

    // Block integer/hex/octal single-token IP encodings (e.g. 2130706433 or 0x7f000001)
    if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
      return false;
    }

    // Block IPv4 loopback, private RFC1918, carrier-grade NAT, and cloud metadata ranges
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const o1 = Number(ipv4Match[1]);
      const o2 = Number(ipv4Match[2]);
      if (o1 > 255 || o2 > 255 || Number(ipv4Match[3]) > 255 || Number(ipv4Match[4]) > 255) {
        return false;
      }
      if (
        o1 === 0 ||
        o1 === 10 ||
        o1 === 127 ||
        (o1 === 169 && o2 === 254) ||
        (o1 === 172 && o2 >= 16 && o2 <= 31) ||
        (o1 === 192 && o2 === 168) ||
        (o1 === 100 && o2 >= 64 && o2 <= 127)
      ) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

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

// Periodic cleanup of expired rate-limit buckets & bounded caches (Permanent IP bans NEVER expire)
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
  for (const [ip, timestamps] of adminLoginRateLimiter.entries()) {
    const valid = timestamps.filter((t) => now - t < 15 * 60 * 1000);
    if (valid.length === 0) adminLoginRateLimiter.delete(ip);
    else adminLoginRateLimiter.set(ip, valid);
  }
  for (const [ip, tracker] of distinctCatalogScrapeTracker.entries()) {
    if (now - tracker.windowStart > 5 * 60 * 1000) {
      distinctCatalogScrapeTracker.delete(ip);
    }
  }
  if (apiCache.size > 1500) {
    for (const [k, entry] of apiCache.entries()) {
      if (now - entry.timestamp > 15 * 60 * 1000) apiCache.delete(k);
    }
  }
  if (subtitleCache.size > 1000) {
    const keys = Array.from(subtitleCache.keys());
    for (let i = 0; i < keys.length - 800; i++) {
      subtitleCache.delete(keys[i]);
    }
  }
}, 5 * 60 * 1000);

function renderPermanentBlockHtml(record: PermanentBanRecord): string {
  const safeIp = escapeHtmlText(record.ip);
  const safeReason = escapeHtmlText(record.reason);
  const safeTime = escapeHtmlText(new Date(record.bannedAt).toISOString());
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
      <div class="row"><span class="lbl">BLOCKED IP:</span><span class="val" style="color:#e2e8f0">${safeIp}</span></div>
      <div class="row"><span class="lbl">VIOLATION:</span><span class="val" style="color:#fcd34d">${safeReason}</span></div>
      <div class="row"><span class="lbl">TIMESTAMP:</span><span class="val" style="color:#94a3b8">${safeTime}</span></div>
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

  // 2. Always allow health checks, internal handover sync, Admin UI, Admin API, and static JS/CSS/font assets so Admin Dashboard is always reachable
  if (
    req.path === '/health' ||
    req.path === '/api/health' ||
    req.path === '/healthz' ||
    req.path === '/api/internal/handover-snapshot' ||
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
    !req.path.startsWith('/api/live/') &&
    !req.path.startsWith('/v1/live/') &&
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
  const candidatePaths = Array.from(
    new Set([
      ...PERSISTENT_READ_DIRS.map((d) => path.join(d, 'scrapers.json')),
      SCRAPERS_CONFIG_FILE,
      SCRAPERS_BACKUP_MIRROR_FILE,
    ])
  );

  let newestStore: ScraperConfigStore | null = null;

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8').trim();
        if (!raw) continue;
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
    writeFileAtomicallyToMirrors('scrapers.json', serialized, SCRAPERS_BACKUP_MIRROR_FILE);
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

let userProfilesCache: Record<string, UserData & { updatedAt?: number }> | null = null;

function persistUserProfilesAtomically(profiles: Record<string, UserData & { updatedAt?: number }>) {
  const serialized = JSON.stringify(profiles);
  writeFileAtomicallyToMirrors('user_profiles.json', serialized, USER_PROFILES_FILE);
}

function readAllUserProfiles(): Record<string, UserData & { updatedAt?: number }> {
  if (userProfilesCache) {
    return userProfilesCache;
  }

  const candidatePaths = Array.from(
    new Set([
      USER_PROFILES_FILE,
      ...PERSISTENT_READ_DIRS.map((d) => path.join(d, 'user_profiles.json')),
    ])
  );

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8').trim();
        if (!content) {
          continue;
        }
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          userProfilesCache = parsed;
          return userProfilesCache;
        }
      }
    } catch {
      // Self-heal corrupted or truncated file below
    }
  }

  userProfilesCache = {};
  try {
    persistUserProfilesAtomically(userProfilesCache);
  } catch {}
  return userProfilesCache;
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
    userProfilesCache = profiles;
    persistUserProfilesAtomically(profiles);
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
    const tmdbPath = String(req.params[0] || '').replace(/^\/+/, '');
    if (!tmdbPath || tmdbPath.includes('..') || !/^[a-zA-Z0-9/_-]+$/.test(tmdbPath)) {
      return res.status(400).json({ error: 'Invalid TMDB endpoint path' });
    }
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
    const subUrl = String(req.query.url || '').trim();
    if (!subUrl) {
      return res.status(400).send('url query param required');
    }
    if (!isSafeExternalProxyUrl(subUrl)) {
      return res.status(403).send('Forbidden: Invalid or internal subtitle URL blocked');
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

    if (response.url && !isSafeExternalProxyUrl(response.url)) {
      return res.status(403).send('Forbidden: Redirect to internal address blocked');
    }

    if (!response.ok) {
      return res.status(response.status).send('Failed to fetch subtitle from upstream');
    }

    const contentLen = Number(response.headers.get('content-length') || 0);
    if (contentLen > 5 * 1024 * 1024) {
      return res.status(413).send('Subtitle payload too large');
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
      return res.status(413).send('Subtitle payload too large');
    }
    let buffer = Buffer.from(arrayBuffer);

    // Automatically gunzip if upstream returned a .gz compressed subtitle file (with 5MB max output cap against zip bombs)
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try {
        buffer = zlib.gunzipSync(buffer, { maxOutputLength: 5 * 1024 * 1024 });
      } catch (gzErr) {
        console.warn('Subtitle gunzip error:', gzErr);
        return res.status(400).send('Invalid compressed subtitle payload');
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
      !isSafeExternalProxyUrl(targetUrl) ||
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

    if (upstream.url && !targetUrl.includes('/v1/proxy') && !isSafeExternalProxyUrl(upstream.url)) {
      return res.status(403).send('Forbidden: Redirect to internal network blocked');
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

// ============================================================================
// 4B. CINEPRO LIVE IPTV CHANNELS & LIVE SPORTS EVENTS PROXY SUBSYSTEM
// ============================================================================
const LIVE_LANG_ENGLISH_MAP: Record<string, string> = {
  ar: 'Arabic',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  tr: 'Turkish',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  ru: 'Russian',
};

function toCleanEnglishLanguage(langCode?: string, fallbackLabel?: string): string {
  const code = String(langCode || '').trim().toLowerCase();
  if (LIVE_LANG_ENGLISH_MAP[code]) return LIVE_LANG_ENGLISH_MAP[code];
  const raw = String(fallbackLabel || '').trim();
  const parenMatch = raw.match(/\(([A-Za-z]+)\)/);
  if (parenMatch && parenMatch[1]) return parenMatch[1];
  const asciiOnly = raw.replace(/[^\x20-\x7E]/g, '').trim();
  return asciiOnly || 'International';
}

function extractRawUrlFromProxyLink(urlOrProxy: string): string {
  if (!urlOrProxy || typeof urlOrProxy !== 'string') return '';
  try {
    const qIdx = urlOrProxy.indexOf('?');
    if (qIdx !== -1) {
      const qs = new URLSearchParams(urlOrProxy.slice(qIdx + 1));
      const dataParam = qs.get('data');
      if (dataParam) {
        const parsed = JSON.parse(dataParam);
        if (parsed && typeof parsed.url === 'string') return parsed.url;
      }
      const uParam = qs.get('url');
      if (uParam) return uParam;
    }
  } catch {
    // ignore
  }
  return urlOrProxy;
}

function buildLocalLiveProxyUrl(
  targetUrl: string,
  headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  isManifest = true
): string {
  const endpoint = isManifest ? 'manifest.m3u8' : 'segment.ts';
  const payload = JSON.stringify({ url: targetUrl, headers });
  return `/api/live/proxy/${endpoint}?data=${encodeURIComponent(payload)}`;
}

function rewriteCineproLiveProxyUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let cleaned = rawUrl.trim();
  cleaned = cleaned.replace(/^https?:\/\/[^/\s"']+\/v1\/live\/proxy\//i, '/api/live/proxy/');
  cleaned = cleaned.replace(/^\/v1\/live\/proxy\//i, '/api/live/proxy/');
  return cleaned;
}

let cachedLiveEventsPayload: { data: any; timestamp: number } | null = null;
let cachedLiveChannelsPayload: { data: any; timestamp: number } | null = null;

interface ChannelMetaEntry {
  channelId: string;
  name: string;
  language: string;
  languageLabel: string;
  logo?: string;
  category?: string;
  group?: string;
}

const TV_LOGO_REPO = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main';

function makeSvgChannelBadge(
  bgStart: string,
  bgEnd: string,
  accentColor: string,
  topText: string,
  mainText: string,
  subText = ''
): string {
  const mainFontSize = mainText.length > 8 ? 22 : mainText.length > 5 ? 28 : 34;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${bgStart}"/>
        <stop offset="100%" stop-color="${bgEnd}"/>
      </linearGradient>
    </defs>
    <rect width="160" height="160" rx="26" fill="url(#g)"/>
    <rect x="8" y="8" width="144" height="144" rx="20" fill="none" stroke="${accentColor}" stroke-width="3" stroke-opacity="0.45"/>
    <text x="80" y="${subText ? 46 : 54}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="18" fill="${accentColor}" letter-spacing="1.5">${topText}</text>
    <text x="80" y="${subText ? 96 : 108}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="${mainFontSize}" fill="#ffffff" letter-spacing="0.5">${mainText}</text>
    ${
      subText
        ? `<rect x="24" y="114" width="112" height="24" rx="12" fill="${accentColor}" fill-opacity="0.22"/>
           <text x="80" y="131" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="13" fill="${accentColor}" letter-spacing="1">${subText}</text>`
        : ''
    }
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
}

const LIVE_CHANNEL_DIRECTORY: Record<string, ChannelMetaEntry> = {
  // beIN Sports MENA (Arabic)
  'bein-sports-1-ar': { channelId: 'bein-sports-1-ar', name: 'beIN Sports 1 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://i.imgur.com/Vtk2cGI.png' },
  'bein-sports-2-ar': { channelId: 'bein-sports-2-ar', name: 'beIN Sports 2 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://i.imgur.com/vUJZSvs.png' },
  'bein-sports-3-ar': { channelId: 'bein-sports-3-ar', name: 'beIN Sports 3 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://i.imgur.com/UYSMao3.png' },
  'bein-sports-4-ar': { channelId: 'bein-sports-4-ar', name: 'beIN Sports 4 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://i.imgur.com/vwAgJNi.png' },
  'bein-sports-5-ar': { channelId: 'bein-sports-5-ar', name: 'beIN Sports 5 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://i.imgur.com/2Rha5aY.png' },
  'bein-sports-6-ar': { channelId: 'bein-sports-6-ar', name: 'beIN Sports 6 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://i.imgur.com/0wBdLYb.png' },
  'bein-sports-7-ar': { channelId: 'bein-sports-7-ar', name: 'beIN Sports 7 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://i.imgur.com/iODFwZi.png' },
  'bein-sports-8-ar': { channelId: 'bein-sports-8-ar', name: 'beIN Sports 8 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://i.imgur.com/CaFEyVn.png' },
  'bein-sports-9-ar': { channelId: 'bein-sports-9-ar', name: 'beIN Sports 9 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: 'https://assets.bein.com/mena/sites/3/2023/09/logos-_beINSPORTS9.png' },
  'bein-sports-open-ar': { channelId: 'bein-sports-open-ar', name: 'beIN Sports Open HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-mea.png` },
  'bein-sports-afc-ar': { channelId: 'bein-sports-afc-ar', name: 'beIN Sports AFC HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#f59e0b', 'beIN SPORTS', 'AFC HD', 'ASIA ELITE') },
  'bein-sports-premium-1-ar': { channelId: 'bein-sports-premium-1-ar', name: 'beIN Sports Premium 1 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-1-premium-mea.png` },
  'bein-sports-premium-2-ar': { channelId: 'bein-sports-premium-2-ar', name: 'beIN Sports Premium 2 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-2-premium-mea.png` },
  'bein-sports-premium-3-ar': { channelId: 'bein-sports-premium-3-ar', name: 'beIN Sports Premium 3 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-3-premium-mea.png` },

  // beIN Sports English / French / Turkish / Spanish
  'bein-sports-xtra-en': { channelId: 'bein-sports-xtra-en', name: 'beIN SPORTS XTRA HD (English)', language: 'en', languageLabel: 'English', logo: 'https://i.ibb.co/HT49GPmB/XTRA-2.png' },
  'bein-sports-en-1': { channelId: 'bein-sports-en-1', name: 'beIN Sports 1 English HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-1-english-mea.png` },
  'bein-sports-en-2': { channelId: 'bein-sports-en-2', name: 'beIN Sports 2 English HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-2-english-mea.png` },
  'bein-sports-en-3': { channelId: 'bein-sports-en-3', name: 'beIN Sports 3 English HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-3-english-mea.png` },
  'bein-sports-fr-1': { channelId: 'bein-sports-fr-1', name: 'beIN Sports 1 France HD (FR)', language: 'fr', languageLabel: 'French', logo: `${TV_LOGO_REPO}/countries/france/bein-sports-1-french-fr.png` },
  'bein-sports-fr-2': { channelId: 'bein-sports-fr-2', name: 'beIN Sports 2 France HD (FR)', language: 'fr', languageLabel: 'French', logo: `${TV_LOGO_REPO}/countries/france/bein-sports-2-french-fr.png` },
  'bein-sports-fr-3': { channelId: 'bein-sports-fr-3', name: 'beIN Sports 3 France HD (FR)', language: 'fr', languageLabel: 'French', logo: `${TV_LOGO_REPO}/countries/france/bein-sports-3-french-fr.png` },
  'bein-sports-max-4-fr': { channelId: 'bein-sports-max-4-fr', name: 'beIN Sports MAX 4 France HD (FR)', language: 'fr', languageLabel: 'French', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-4-max-mea.png` },
  'bein-sports-max-5-fr': { channelId: 'bein-sports-max-5-fr', name: 'beIN Sports MAX 5 France HD (FR)', language: 'fr', languageLabel: 'French', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-5-max-mea.png` },
  'bein-sports-max-6-fr': { channelId: 'bein-sports-max-6-fr', name: 'beIN Sports MAX 6 France HD (FR)', language: 'fr', languageLabel: 'French', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-6-max-mea.png` },
  'bein-sports-max-7-fr': { channelId: 'bein-sports-max-7-fr', name: 'beIN Sports MAX 7 France HD (FR)', language: 'fr', languageLabel: 'French', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#e9d5ff', 'beIN SPORTS', 'MAX 7', 'FRANCE HD') },
  'bein-sports-max-9-fr': { channelId: 'bein-sports-max-9-fr', name: 'beIN Sports MAX 9 France HD (FR)', language: 'fr', languageLabel: 'French', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#e9d5ff', 'beIN SPORTS', 'MAX 9', 'FRANCE HD') },
  'bein-sports-max-10-fr': { channelId: 'bein-sports-max-10-fr', name: 'beIN Sports MAX 10 France HD (FR)', language: 'fr', languageLabel: 'French', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#e9d5ff', 'beIN SPORTS', 'MAX 10', 'FRANCE HD') },
  'bein-sports-1-tr': { channelId: 'bein-sports-1-tr', name: 'beIN Sports 1 Türkiye HD', language: 'tr', languageLabel: 'Turkish', logo: 'https://i.imgur.com/Vtk2cGI.png' },
  'bein-sports-2-tr': { channelId: 'bein-sports-2-tr', name: 'beIN Sports 2 Türkiye HD', language: 'tr', languageLabel: 'Turkish', logo: 'https://i.imgur.com/vUJZSvs.png' },
  'bein-sports-3-tr': { channelId: 'bein-sports-3-tr', name: 'beIN Sports 3 Türkiye HD', language: 'tr', languageLabel: 'Turkish', logo: 'https://i.imgur.com/UYSMao3.png' },
  'bein-sports-4-tr': { channelId: 'bein-sports-4-tr', name: 'beIN Sports 4 Türkiye HD', language: 'tr', languageLabel: 'Turkish', logo: 'https://i.imgur.com/vwAgJNi.png' },
  'bein-sports-5-tr': { channelId: 'bein-sports-5-tr', name: 'beIN Sports 5 Türkiye HD', language: 'tr', languageLabel: 'Turkish', logo: 'https://i.imgur.com/2Rha5aY.png' },
  'bein-sports-haber-tr': { channelId: 'bein-sports-haber-tr', name: 'beIN Sports Haber HD (TR)', language: 'tr', languageLabel: 'Turkish', logo: `${TV_LOGO_REPO}/countries/turkey/bein-sports-haber-tr.png` },
  'bein-sports-xtra-es': { channelId: 'bein-sports-xtra-es', name: 'beIN SPORTS XTRA en Español', language: 'es', languageLabel: 'Spanish', logo: 'https://i.imgur.com/V562tpO.png' },

  // MENA Sports (SSC, Alkass, Abu Dhabi, Dubai, Kuwait, Arryadia)
  'ssc-sport-1-ar': { channelId: 'ssc-sport-1-ar', name: 'SSC Sport 1 / Extra 1 HD (Saudi Sports)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#064e3b', '#022c22', '#fbbf24', 'SAUDI SPORTS', 'SSC 1', 'HD LIVE') },
  'ssc-sport-2-ar': { channelId: 'ssc-sport-2-ar', name: 'SSC Sport 2 / Extra 2 HD (Saudi Sports)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#064e3b', '#022c22', '#fbbf24', 'SAUDI SPORTS', 'SSC 2', 'HD LIVE') },
  'ssc-sport-3-ar': { channelId: 'ssc-sport-3-ar', name: 'SSC Sport 3 / Extra 3 HD (Saudi Sports)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#064e3b', '#022c22', '#fbbf24', 'SAUDI SPORTS', 'SSC 3', 'HD LIVE') },
  'ssc-extra-1-ar': { channelId: 'ssc-extra-1-ar', name: 'SSC Sport Extra 1 HD (Saudi Sports)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0f172a', '#064e3b', '#34d399', 'SSC EXTRA', 'EXTRA 1', 'SAUDI HD') },
  'ssc-extra-2-ar': { channelId: 'ssc-extra-2-ar', name: 'SSC Sport Extra 2 HD (Saudi Sports)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0f172a', '#064e3b', '#34d399', 'SSC EXTRA', 'EXTRA 2', 'SAUDI HD') },
  'ssc-extra-3-ar': { channelId: 'ssc-extra-3-ar', name: 'SSC Sport Extra 3 HD (Saudi Sports)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0f172a', '#064e3b', '#34d399', 'SSC EXTRA', 'EXTRA 3', 'SAUDI HD') },
  'alkass-1-ar': { channelId: 'alkass-1-ar', name: 'Alkass Sports HD 1 / 2 (Qatar)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#7f1d1d', '#450a0a', '#fcd34d', 'QATAR SPORTS', 'ALKASS 1', 'الكأس HD') },
  'alkass-2-ar': { channelId: 'alkass-2-ar', name: 'Alkass Sports HD 3 (Qatar)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#7f1d1d', '#450a0a', '#fcd34d', 'QATAR SPORTS', 'ALKASS 3', 'الكأس HD') },
  'alkass-3-ar': { channelId: 'alkass-3-ar', name: 'Alkass Sports HD 4 (Qatar)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#7f1d1d', '#450a0a', '#fcd34d', 'QATAR SPORTS', 'ALKASS 4', 'الكأس HD') },
  'starzplay-sports-1-ar': { channelId: 'starzplay-sports-1-ar', name: 'STARZPLAY Sports 1 / AD Sports Premium 1 HD (Serie A Arabic)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0f172a', '#1e1b4b', '#38bdf8', 'STARZPLAY', 'SPORTS 1', 'SERIE A AR') },
  'starzplay-sports-2-ar': { channelId: 'starzplay-sports-2-ar', name: 'STARZPLAY Sports 2 / AD Sports Premium 2 HD (Serie A Arabic)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0f172a', '#1e1b4b', '#38bdf8', 'STARZPLAY', 'SPORTS 2', 'SERIE A AR') },
  'ad-sports-1-ar': { channelId: 'ad-sports-1-ar', name: 'Abu Dhabi Sports 1 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/abu-dhabi-sports-tv-ae.png` },
  'ad-sports-2-ar': { channelId: 'ad-sports-2-ar', name: 'Abu Dhabi Sports 2 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/abu-dhabi-sports-tv-ae.png` },
  'dubai-sports-1-ar': { channelId: 'dubai-sports-1-ar', name: 'Dubai Sports 1 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/dubai-sports-tv-ae.png` },
  'ontime-sports-1-ar': { channelId: 'ontime-sports-1-ar', name: 'OnTime Sports 1 & 2 HD (Egypt Arabic)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#22d3ee', 'EGYPT SPORTS', 'ONTIME', 'أون تايم HD') },
  'ktv-sport-ar': { channelId: 'ktv-sport-ar', name: 'Kuwait TV Sport HD (KTV Sport)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0369a1', '#0c4a6e', '#38bdf8', 'KUWAIT TV', 'KTV SPORT', 'الكويت الرياضية') },
  'arryadia-ar': { channelId: 'arryadia-ar', name: 'Arryadia Morocco Sports HD', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#991b1b', '#14532d', '#4ade80', 'SNRT MOROCCO', 'ARRYADIA', 'الرياضية TNT') },

  // Movies & Cinema
  'bein-movies-premiere-en': { channelId: 'bein-movies-premiere-en', name: 'beIN / Sky Cinema Premiere HD (Movies)', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-movies-1-premiere-mea.png` },
  'bein-movies-action-en': { channelId: 'bein-movies-action-en', name: 'beIN / Sky Cinema Action HD (Movies)', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-movies-2-action-mea.png` },
  'bein-movies-hits-en': { channelId: 'bein-movies-hits-en', name: 'beIN / Sky Cinema Hits HD (Movies)', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/turkey/bein-movies-stars-hd-tr.png` },
  'bein-movies-drama-en': { channelId: 'bein-movies-drama-en', name: 'beIN / Sky Cinema Drama HD (Movies)', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-movies-3-drama-mea.png` },
  'hbo-hd': { channelId: 'hbo-hd', name: 'HBO Movies & Series HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/hbo-us.png` },
  'hbo-2-hd': { channelId: 'hbo-2-hd', name: 'HBO 2 Movies & Series HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/hbo-us.png` },
  'showtime-hd': { channelId: 'showtime-hd', name: 'Showtime Movies & Series HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/showtime-us.png` },
  'starz-hd': { channelId: 'starz-hd', name: 'Starz Movies HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/starz-us.png` },
  'cinemax-hd': { channelId: 'cinemax-hd', name: 'Cinemax Action Movies HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/cinemax-us.png` },
  'bein-movies-action-ar': { channelId: 'bein-movies-action-ar', name: 'Shahid / MENA Movies Action HD (أفلام أكشن)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0f172a', '#1e293b', '#10b981', 'SHAHID VIP', 'ACTION', 'أفلام أكشن') },
  'bein-movies-thriller-ar': { channelId: 'bein-movies-thriller-ar', name: 'Shahid / MENA Movies Thriller HD (أفلام إثارة)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#0f172a', '#31102f', '#f43f5e', 'SHAHID VIP', 'THRILLER', 'أفلام إثارة') },
  'bein-aflam-ar': { channelId: 'bein-aflam-ar', name: 'Shahid Aflam HD (أفلام عربية)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#042f2e', '#0f172a', '#2dd4bf', 'SHAHID VIP', 'AFLAM', 'أفلام عربية') },
  'rotana-cinema-ar': { channelId: 'rotana-cinema-ar', name: 'Rotana Cinema HD (روتانا سينما)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#065f46', '#022c22', '#fbbf24', 'ROTANA', 'CINEMA', 'روتانا سينما') },

  // Entertainment & MBC / Rotana / Spacetoon
  'rotana-drama-ar': { channelId: 'rotana-drama-ar', name: 'Rotana Drama HD (روتانا دراما)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#581c87', '#2e1065', '#f59e0b', 'ROTANA', 'DRAMA', 'روتانا دراما') },
  'rotana-comedy-ar': { channelId: 'rotana-comedy-ar', name: 'Rotana Comedy HD (روتانا كوميدي)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#9a3412', '#431407', '#fde047', 'ROTANA', 'COMEDY', 'روتانا كوميدي') },
  'mbc-1-ar': { channelId: 'mbc-1-ar', name: 'MBC 1 HD (إم بي سي 1)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-1-ae.png` },
  'mbc-4-ar': { channelId: 'mbc-4-ar', name: 'MBC 4 Series & Entertainment HD (إم بي سي 4)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-4-ae.png` },
  'mbc-5-ar': { channelId: 'mbc-5-ar', name: 'MBC 5 Maghreb HD (إم بي سي 5)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-5-ae.png` },
  'mbc-drama-ar': { channelId: 'mbc-drama-ar', name: 'MBC Drama & MBC+ Drama HD (إم بي سي دراما)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-drama-ae.png` },
  'mbc-plus-drama-ar': { channelId: 'mbc-plus-drama-ar', name: 'MBC+ Drama HD (إم بي سي بلس دراما)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-drama-ae.png` },
  'mbc-masr-ar': { channelId: 'mbc-masr-ar', name: 'MBC Masr 1 & 2 HD (إم بي سي مصر)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-maser-ae.png` },
  'mbc-masr-2-ar': { channelId: 'mbc-masr-2-ar', name: 'MBC Masr 2 HD (إم بي سي مصر 2)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-maser-ae.png` },
  'mbc-iraq-ar': { channelId: 'mbc-iraq-ar', name: 'MBC Iraq HD (إم بي سي العراق)', language: 'ar', languageLabel: 'Arabic', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-iraq-ae.png` },
  'bab-al-hara-ar': { channelId: 'bab-al-hara-ar', name: 'Bab Al Hara Series 24/7 HD (باب الحارة)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#78350f', '#451a03', '#fbbf24', 'SHAHID 24/7', 'BAB AL HARA', 'باب الحارة') },
  'spacetoon-ar': { channelId: 'spacetoon-ar', name: 'Spacetoon Arabic HD (سبيستون)', language: 'ar', languageLabel: 'Arabic', logo: makeSvgChannelBadge('#1e3a8a', '#172554', '#facc15', 'ANIME & KIDS', 'SPACETOON', 'سبيستون') },

  // UK & European Sports
  'sky-sports-main-event': { channelId: 'sky-sports-main-event', name: 'Sky Sports Main Event UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-main-event-uk.png` },
  'sky-sports-premier-league': { channelId: 'sky-sports-premier-league', name: 'Sky Sports Premier League UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-premier-league-uk.png` },
  'sky-sports-football': { channelId: 'sky-sports-football', name: 'Sky Sports Football UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-football-uk.png` },
  'sky-sports-plus': { channelId: 'sky-sports-plus', name: 'Sky Sports+ UK HD', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#f43f5e', 'SKY SPORTS', 'SPORTS+', 'EFL & LIVE HD') },
  'sky-sports-action': { channelId: 'sky-sports-action', name: 'Sky Sports Action UK HD', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#172554', '#38bdf8', 'SKY SPORTS', 'ACTION', 'UK HD') },
  'sky-sports-f1': { channelId: 'sky-sports-f1', name: 'Sky Sports F1 UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-f1-uk.png` },
  'sky-sports-cricket': { channelId: 'sky-sports-cricket', name: 'Sky Sports Cricket UK HD', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#ef4444', 'SKY SPORTS', 'CRICKET', 'UK HD') },
  'sky-sports-golf': { channelId: 'sky-sports-golf', name: 'Sky Sports Golf UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-golf-icon-uk.png` },
  'sky-sports-tennis': { channelId: 'sky-sports-tennis', name: 'Sky Sports Tennis UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-tennis-icon-uk.png` },
  'sky-sports-mix': { channelId: 'sky-sports-mix', name: 'Sky Sports Mix UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-mix-icon-uk.png` },
  'sky-sports-news': { channelId: 'sky-sports-news', name: 'Sky Sports News UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-news-icon-uk.png` },
  'sky-sports-racing': { channelId: 'sky-sports-racing', name: 'Sky Sports Racing UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-racing-icon-uk.png` },
  'tnt-sports-1': { channelId: 'tnt-sports-1', name: 'TNT Sports 1 UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/hd/tnt-sports-1-hd-uk.png` },
  'tnt-sports-2': { channelId: 'tnt-sports-2', name: 'TNT Sports 2 UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/hd/tnt-sports-2-hd-uk.png` },
  'tnt-sports-3': { channelId: 'tnt-sports-3', name: 'TNT Sports 3 UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/hd/tnt-sports-3-hd-uk.png` },
  'tnt-sports-4': { channelId: 'tnt-sports-4', name: 'TNT Sports 4 UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/hd/tnt-sports-4-hd-uk.png` },
  'supersport-premier-league': { channelId: 'supersport-premier-league', name: 'SuperSport Premier League HD', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#f59e0b', 'SUPERSPORT', 'EPL', 'PREMIER LEAGUE') },
  'supersport-grandstand': { channelId: 'supersport-grandstand', name: 'SuperSport Grandstand HD', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#fbbf24', 'SUPERSPORT', 'GRANDSTAND', 'LIVE HD') },
  'supersport-football': { channelId: 'supersport-football', name: 'SuperSport Football HD', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#38bdf8', 'SUPERSPORT', 'FOOTBALL', 'LIVE HD') },
  'supersport-laliga': { channelId: 'supersport-laliga', name: 'SuperSport LaLiga HD', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#7f1d1d', '#f43f5e', 'SUPERSPORT', 'LALIGA', 'LIVE HD') },
  'supersport-variety-1': { channelId: 'supersport-variety-1', name: 'SuperSport Variety 1 HD', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#34d399', 'SUPERSPORT', 'VARIETY 1', 'LIVE HD') },
  'usa-network-hd': { channelId: 'usa-network-hd', name: 'USA Network Sports HD', language: 'en', languageLabel: 'English', logo: 'https://schedulesdirect-api20141201-logos.s3.dualstack.us-east-1.amazonaws.com/stationLogos/s11207_dark_360w_270h.png' },

  // US Sports (Fox, ESPN, CBS, NBC, NBA, NFL, NHL, MLB)
  'fox-sports-1': { channelId: 'fox-sports-1', name: 'Fox Sports 1 (FS1 HD)', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0c4a6e', '#082f49', '#38bdf8', 'FOX SPORTS', 'FS1', 'HD LIVE') },
  'fox-sports-2': { channelId: 'fox-sports-2', name: 'Fox Sports 2 (FS2 HD)', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#1e3a8a', '#172554', '#ef4444', 'FOX SPORTS', 'FS2', 'HD LIVE') },
  'fox-sports-news': { channelId: 'fox-sports-news', name: 'Fox Sports News (1080p)', language: 'en', languageLabel: 'English', logo: 'https://i.imgur.com/O9BapV9.png' },
  'espn-hd': { channelId: 'espn-hd', name: 'ESPN HD (United States)', language: 'en', languageLabel: 'English', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/ESPN_wordmark.svg/960px-ESPN_wordmark.svg.png' },
  'espn-2-hd': { channelId: 'espn-2-hd', name: 'ESPN 2 HD (United States)', language: 'en', languageLabel: 'English', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/ESPN2_logo.svg/960px-ESPN2_logo.svg.png' },
  'espnu-hd': { channelId: 'espnu-hd', name: 'ESPNU HD', language: 'en', languageLabel: 'English', logo: 'https://i.imgur.com/HiBrysh.png' },
  'cbs-sports-golazo': { channelId: 'cbs-sports-golazo', name: 'CBS Sports Golazo Network', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/cbs-sports-golazo-network-us.png` },
  'nbc-sports-now': { channelId: 'nbc-sports-now', name: 'NBC Sports NOW HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/nbc-sports-engine-us.png` },
  'nba-tv': { channelId: 'nba-tv', name: 'NBA TV HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/nba-tv-icon-us.png` },
  'nfl-network': { channelId: 'nfl-network', name: 'NFL Network HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/nfl-network-us.png` },
  'nfl-redzone': { channelId: 'nfl-redzone', name: 'NFL RedZone HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/nfl-network-us.png` },
  'nhl-network': { channelId: 'nhl-network', name: 'NHL Network (1080p)', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/nhl-network-us.png` },
  'mlb-network': { channelId: 'mlb-network', name: 'MLB Network HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/mlb-network-us.png` },

  // Europe / International Sports (France, Spain, Italy, Global)
  'eurosport-1': { channelId: 'eurosport-1', name: 'Eurosport 1 HD', language: 'en', languageLabel: 'English', logo: 'https://i.imgur.com/olQJgm7.png' },
  'eurosport-2': { channelId: 'eurosport-2', name: 'Eurosport 2 HD', language: 'en', languageLabel: 'English', logo: 'https://i.imgur.com/f56dHgR.png' },
  'canal-plus-foot-fr': { channelId: 'canal-plus-foot-fr', name: 'Canal+ Foot France HD', language: 'fr', languageLabel: 'French', logo: `${TV_LOGO_REPO}/countries/france/canal-plus-foot-fr.png` },
  'rmc-sport-1-fr': { channelId: 'rmc-sport-1-fr', name: 'RMC Sport 1 France HD', language: 'fr', languageLabel: 'French', logo: `${TV_LOGO_REPO}/countries/france/rmc-sport-1-fr.png` },
  'lequipe-fr': { channelId: 'lequipe-fr', name: "L'Équipe TV France (1080p)", language: 'fr', languageLabel: 'French', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/32/L%27%C3%89quipe_wordmark.svg/512px-L%27%C3%89quipe_wordmark.svg.png' },
  'fifa-plus-fr': { channelId: 'fifa-plus-fr', name: 'FIFA+ France (FR)', language: 'fr', languageLabel: 'French', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#38bdf8', 'OFFICIAL STREAM', 'FIFA+', 'FRANCE HD') },
  'fifa-plus-en': { channelId: 'fifa-plus-en', name: 'FIFA+ Global (English)', language: 'en', languageLabel: 'English', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#38bdf8', 'OFFICIAL STREAM', 'FIFA+', 'GLOBAL HD') },
  'premier-sports-1': { channelId: 'premier-sports-1', name: 'Premier Sports 1 UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/premier-sports-1-uk.png` },
  'premier-sports-2': { channelId: 'premier-sports-2', name: 'Premier Sports 2 UK HD', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-kingdom/premier-sports-2-uk.png` },
  'real-madrid-tv': { channelId: 'real-madrid-tv', name: 'Real Madrid TV HD', language: 'es', languageLabel: 'Spanish', logo: `${TV_LOGO_REPO}/countries/spain/real-madrid-tv-es.png` },
  'dazn-laliga-es': { channelId: 'dazn-laliga-es', name: 'DAZN LaLiga 1 HD (Spain)', language: 'es', languageLabel: 'Spanish', logo: makeSvgChannelBadge('#09090b', '#18181b', '#facc15', 'DAZN SPAIN', 'LALIGA', 'HD LIVE') },
  'dazn-ligue1-fr': { channelId: 'dazn-ligue1-fr', name: 'DAZN Ligue 1 HD (France)', language: 'fr', languageLabel: 'French', logo: makeSvgChannelBadge('#09090b', '#18181b', '#38bdf8', 'DAZN FRANCE', 'LIGUE 1', 'HD LIVE') },
  'dazn-1-it': { channelId: 'dazn-1-it', name: 'Zona DAZN / DAZN 1 Italia HD (Serie A Enilive)', language: 'it', languageLabel: 'Italian', logo: makeSvgChannelBadge('#09090b', '#18181b', '#22c55e', 'DAZN ITALIA', 'DAZN 1', 'SERIE A') },
  'dazn-2-it': { channelId: 'dazn-2-it', name: 'DAZN 2 Italia HD (Serie A Enilive)', language: 'it', languageLabel: 'Italian', logo: makeSvgChannelBadge('#09090b', '#18181b', '#22c55e', 'DAZN ITALIA', 'DAZN 2', 'SERIE A') },
  'sky-sport-calcio-it': { channelId: 'sky-sport-calcio-it', name: 'Sky Sport Calcio HD Italia (Serie A)', language: 'it', languageLabel: 'Italian', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1303.png' },
  'sky-sport-uno-it': { channelId: 'sky-sport-uno-it', name: 'Sky Sport Uno HD Italia (Serie A & UCL)', language: 'it', languageLabel: 'Italian', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1301.png' },
  'sky-sport-arena-it': { channelId: 'sky-sport-arena-it', name: 'Sky Sport Arena HD Italia (Serie A)', language: 'it', languageLabel: 'Italian', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1322.png' },
  'sky-sport-max-it': { channelId: 'sky-sport-max-it', name: 'Sky Sport Max HD Italia (Serie A & Euro)', language: 'it', languageLabel: 'Italian', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1302.png' },
  'sky-sport-252-it': { channelId: 'sky-sport-252-it', name: 'Sky Sport 252 HD Italia (Serie A Matchday)', language: 'it', languageLabel: 'Italian', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1303.png' },
  'sky-sport-24-it': { channelId: 'sky-sport-24-it', name: 'Sky Sport 24 HD Italia (Calcio News)', language: 'it', languageLabel: 'Italian', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1314.png' },
  'dazn-combat': { channelId: 'dazn-combat', name: 'DAZN Combat & Boxing HD', language: 'en', languageLabel: 'English', logo: 'https://i.postimg.cc/VsW3Jsrz/logo-DAZN-Combat.png' },
  'red-bull-tv': { channelId: 'red-bull-tv', name: 'Red Bull TV Motorsports (1080p)', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/international/red-bull-tv-int.png` },
  'tennis-channel': { channelId: 'tennis-channel', name: 'Tennis Channel HD (1080p)', language: 'en', languageLabel: 'English', logo: `${TV_LOGO_REPO}/countries/united-states/tennis-channel-us.png` },
};

let cachedUpstreamEpgMap: Map<string, any> = new Map();

const GENERIC_PLACEHOLDER_LOGOS = new Set([
  'https://i.imgur.com/Vtk2cGI.png',
  'https://i.imgur.com/vUJZSvs.png',
  'https://i.imgur.com/UYSMao3.png',
  'https://i.imgur.com/vwAgJNi.png',
  'https://i.imgur.com/2Rha5aY.png',
  'https://i.imgur.com/0wBdLYb.png',
  'https://i.imgur.com/iODFwZi.png',
  'https://i.imgur.com/O9BapV9.png',
]);

function resolveChannelLogo(channelId: string, upstreamLogo?: string, channelName?: string): string {
  const curated = LIVE_CHANNEL_DIRECTORY[channelId]?.logo;
  if (curated) return curated;

  const cleanUpstream = String(upstreamLogo || '').trim();
  const isBeinChannel = channelId.startsWith('bein-sports-');
  const isFoxChannel = channelId.startsWith('fox-sports-');

  if (cleanUpstream && (!GENERIC_PLACEHOLDER_LOGOS.has(cleanUpstream) || isBeinChannel || isFoxChannel)) {
    return cleanUpstream;
  }

  // Fallback custom badge for any newly added non-beIN channel whose upstream logo is a generic placeholder
  const label = (channelName || channelId.replace(/-/g, ' ')).replace(/\s*\([^)]*\)/g, '').trim().toUpperCase();
  const words = label.split(/\s+/);
  const top = words[0] || 'LIVE TV';
  const main = words.slice(1, 3).join(' ') || top;
  return makeSvgChannelBadge('#0f172a', '#1e293b', '#38bdf8', top.slice(0, 12), main.slice(0, 10), 'LIVE HD');
}

function buildRecommendedChannelItem(channelId: string): {
  channelId: string;
  name: string;
  language: string;
  languageLabel: string;
  logo?: string;
  streamEndpoint: string;
} {
  const cachedList = Array.isArray(cachedLiveChannelsPayload?.data?.channels)
    ? cachedLiveChannelsPayload!.data.channels
    : [];
  const fromCache = cachedList.find((c: any) => c?.id === channelId);
  const meta = LIVE_CHANNEL_DIRECTORY[channelId];
  const lang = fromCache?.language || meta?.language || 'en';
  const name =
    (channelId === 'canal-plus-foot-fr' && meta?.name) ||
    meta?.name ||
    fromCache?.name ||
    channelId.replace(/-/g, ' ').toUpperCase();
  return {
    channelId,
    name,
    language: lang,
    languageLabel: toCleanEnglishLanguage(lang, fromCache?.languageLabel || meta?.languageLabel),
    logo: resolveChannelLogo(channelId, fromCache?.logo || meta?.logo, name),
    streamEndpoint: `/api/live/stream/${encodeURIComponent(channelId)}`,
  };
}

// Official competition broadcast pools so simultaneous matches in the same time slot map strictly to unique satellite channels (never duplicate alias feeds)
const UEFA_ARABIC_POOL = [
  'bein-sports-1-ar',
  'bein-sports-2-ar',
  'bein-sports-3-ar',
  'bein-sports-4-ar',
  'bein-sports-5-ar',
  'bein-sports-6-ar',
];

const MENA_SAUDI_MULTIPLEX_POOL = [
  'ssc-sport-1-ar',
  'ssc-sport-2-ar',
  'ssc-sport-3-ar',
  'ssc-extra-1-ar',
  'ssc-extra-2-ar',
  'ssc-extra-3-ar',
  'alkass-1-ar',
  'alkass-2-ar',
  'alkass-3-ar',
  'ad-sports-1-ar',
  'ad-sports-2-ar',
  'dubai-sports-1-ar',
];

// Classify every channel into a distinct broadcaster family so a single match never hogs two sibling channels from the same network when concurrent matches are airing
function getChannelNetworkFamily(channelId: string): string {
  if (channelId.startsWith('bein-sports-') && channelId.endsWith('-ar')) return 'bein-ar';
  if (channelId.startsWith('ssc-')) return 'ssc-ar';
  if (channelId.startsWith('alkass-')) return 'alkass-ar';
  if (channelId.startsWith('starzplay-')) return 'starzplay-ar';
  if (
    channelId.startsWith('ad-sports-') ||
    channelId.startsWith('dubai-sports-') ||
    channelId === 'arryadia-ar' ||
    channelId === 'ontime-sports-1-ar' ||
    channelId === 'ktv-sport-ar'
  ) {
    return 'mena-ar';
  }
  if (channelId.startsWith('sky-sports-')) return 'sky-uk';
  if (channelId.startsWith('tnt-sports-') || channelId.startsWith('premier-sports-') || channelId.startsWith('eurosport-')) return 'tnt-uk';
  if (channelId.startsWith('supersport-')) return 'supersport';
  if (channelId.startsWith('bein-sports-en-') || channelId === 'bein-sports-xtra-en') return 'bein-en';
  if (channelId.endsWith('-fr') || channelId.includes('-fr-')) return 'fr';
  if (channelId.endsWith('-es') || channelId.includes('-es-') || channelId === 'real-madrid-tv') return 'es';
  if (channelId.endsWith('-it') || channelId.includes('-it-')) return 'it';
  if (channelId.endsWith('-tr') || channelId.includes('-tr-')) return 'tr';
  if (channelId.startsWith('espn')) return 'espn-us';
  if (channelId.startsWith('fox-sports-')) return 'fox-us';
  if (channelId === 'cbs-sports-golazo') return 'cbs-us';
  if (channelId === 'usa-network-hd' || channelId === 'nbc-sports-now') return 'nbc-us';
  return 'us-en';
}

// Order an event's assigned channels so the match card shows a clean, authoritative priority order (Flagship Arabic + Flagship UK/US + European/International)
function sortEventChannelsForCardDisplay(channelIds: string[]): string[] {
  if (channelIds.length <= 1) return channelIds;
  const isFr = (id: string) => id.endsWith('-fr') || id.includes('-fr-');
  const isEs = (id: string) => id.endsWith('-es') || id.includes('-es-') || id === 'real-madrid-tv';
  const isIt = (id: string) => id.endsWith('-it') || id.includes('-it-');
  const isTr = (id: string) => id.endsWith('-tr') || id.includes('-tr-');

  const arList = channelIds.filter((id) => id.endsWith('-ar'));
  const ukUsList = channelIds.filter(
    (id) =>
      !id.endsWith('-ar') &&
      !isFr(id) &&
      !isEs(id) &&
      !isIt(id) &&
      !isTr(id) &&
      !id.startsWith('bein-sports-en-') &&
      !id.startsWith('supersport-')
  );
  const euroDomesticList = channelIds.filter((id) => isEs(id) || isIt(id) || isFr(id) || isTr(id));
  const intlEnList = channelIds.filter((id) => id.startsWith('bein-sports-en-') || id.startsWith('supersport-'));

  const ordered: string[] = [];
  const pushUnique = (id?: string) => {
    if (id && !ordered.includes(id)) ordered.push(id);
  };

  if (arList.length > 0) pushUnique(arList[0]);
  if (ukUsList.length > 0) pushUnique(ukUsList[0]);
  if (euroDomesticList.length > 0) pushUnique(euroDomesticList[0]);
  if (intlEnList.length > 0) pushUnique(intlEnList[0]);

  for (const id of channelIds) {
    pushUnique(id);
  }
  return ordered;
}

// Strict per-channel stream allowlist/blocklist so a channel NEVER includes another numbered channel's feed as "Server 2 / Backup"
const STRICT_CHANNEL_REQUIRED_STREAM_TOKEN: Record<string, string[]> = {
  // beIN Sports Arabic 1–9 & Open & Premium
  'bein-sports-1-ar': ['premium91'],
  'bein-sports-2-ar': ['premium92'],
  'bein-sports-3-ar': ['premium93'],
  'bein-sports-4-ar': ['premium94'],
  'bein-sports-5-ar': ['premium95'],
  'bein-sports-6-ar': ['premium96'],
  'bein-sports-7-ar': ['premium97'],
  'bein-sports-8-ar': ['premium98', 'premium97', 'premium99'], // 8-ar uses failover if 98 is offline
  'bein-sports-9-ar': ['premium99'],
  'bein-sports-open-ar': ['premium578'],
  'bein-sports-premium-1-ar': ['premium91'],
  'bein-sports-premium-2-ar': ['premium92'],
  'bein-sports-premium-3-ar': ['premium93'],
  // beIN Sports English 1–3
  'bein-sports-en-1': ['premium712'],
  'bein-sports-en-2': ['premium713'],
  'bein-sports-en-3': ['premium714'],
  // beIN Sports France 1–3 & MAX
  'bein-sports-fr-1': ['premium116'],
  'bein-sports-fr-2': ['premium117'],
  'bein-sports-fr-3': ['premium118'],
  'bein-sports-max-4-fr': ['premium494'],
  'bein-sports-max-5-fr': ['premium495'],
  'bein-sports-max-6-fr': ['premium496'],
  'bein-sports-max-7-fr': ['premium497'],
  'bein-sports-max-8-fr': ['premium498'],
  'bein-sports-max-9-fr': ['premium499'],
  'bein-sports-max-10-fr': ['premium500'],
  // TNT Sports 1–4 UK
  'tnt-sports-1': ['premium31'],
  'tnt-sports-2': ['premium32'],
  'tnt-sports-3': ['premium33'],
  'tnt-sports-4': ['premium34'],
  // Sky Sports UK
  'sky-sports-main-event': ['premium38'],
  'sky-sports-premier-league': ['premium130', 'AAxBRQEBc2c'],
  'sky-sports-football': ['premium35'],
  'sky-sports-plus': ['premium36'],
  'sky-sports-action': ['premium37', 'AQNASgYGemc'],
  'sky-sports-f1': ['premium60', 'AwZGQwwEZA'],
  // SuperSport
  'supersport-grandstand': ['premium412'],
  'supersport-football': ['premium413'],
  'supersport-premier-league': ['premium414'],
  'supersport-laliga': ['premium415'],
  'supersport-variety-1': ['premium420'],
  // Serie A Arabic & Italian Dedicated Channels
  'starzplay-sports-1-ar': ['premium609'],
  'starzplay-sports-2-ar': ['premium610'],
  'dazn-1-it': ['premium877'],
  'dazn-2-it': ['premium878'],
  'sky-sport-calcio-it': ['premium870'],
  'sky-sport-uno-it': ['premium461'],
  'sky-sport-arena-it': ['premium462'],
  'sky-sport-max-it': ['premium460'],
  'sky-sport-252-it': ['premium872'],
  'sky-sport-24-it': ['premium869'],
};

// Filter out contaminated secondary mirrors where upstream bundles a different TV channel or a free FAST replay stream
function isMismatchedSecondaryMirror(channelId: string, rawUrl: string, label = ''): boolean {
  const u = String(rawUrl || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  if (!u && !l) return false;

  const allowedTokens = STRICT_CHANNEL_REQUIRED_STREAM_TOKEN[channelId];
  if (allowedTokens && allowedTokens.length > 0 && u) {
    const matchesAllowed = allowedTokens.some((token) => u.includes(token.toLowerCase()));
    if (!matchesAllowed) {
      return true;
    }
  }

  // Premier Sports 1 & 2 UK must only use real UK satellite feeds (premium451/premium709), never Amagi/Pluto/Tubi FAST loops
  if (channelId === 'premier-sports-1' || channelId === 'premier-sports-2') {
    if (u.includes('amagi.tv') || u.includes('pluto') || u.includes('tubi') || u.includes('wurl.com')) {
      return true;
    }
  }

  // Canal+ Foot France must only use Canal+ Foot (premium463), never Canal+ Sport France (premium122 / stream-48) which airs Rugby
  if (channelId === 'canal-plus-foot-fr') {
    if (u.includes('premium122') || u.includes('premium121') || u.includes('stream-48') || l.includes('canal+ sport')) {
      return true;
    }
  }

  // RMC Sport 1 must not fall back to RMC Sport 2 (different live event)
  if (channelId === 'rmc-sport-1-fr') {
    if (u.includes('premium120') || l.includes('rmc sport 2')) return true;
  }

  // SSC channels must not cross-contaminate between SSC 1, SSC 2, SSC 3, and SSC Extra 1/2
  if (channelId === 'ssc-sport-1-ar') {
    if (u.includes('premium615') || u.includes('premium616') || u.includes('premium619') || u.includes('premium620') || u.includes('premium600') || l.includes('extra')) {
      return true;
    }
  }
  if (channelId === 'ssc-sport-2-ar') {
    if (u.includes('premium614') || u.includes('premium616') || u.includes('premium619') || u.includes('premium620') || u.includes('premium601') || l.includes('extra')) {
      return true;
    }
  }
  if (channelId === 'ssc-sport-3-ar') {
    if (u.includes('premium614') || u.includes('premium615') || u.includes('premium619') || u.includes('premium620') || u.includes('premium609') || l.includes('extra')) {
      return true;
    }
  }
  if (channelId === 'ssc-extra-1-ar') {
    if (u.includes('premium620') || u.includes('premium616') || u.includes('premium614') || u.includes('premium615') || u.includes('premium783')) {
      return true;
    }
  }
  if (channelId === 'ssc-extra-2-ar') {
    if (u.includes('premium784')) {
      return true;
    }
  }

  // Abu Dhabi Sports 1 must not fall back to Abu Dhabi Sports 1 Premium (different feed)
  if (channelId === 'ad-sports-1-ar' && (u.includes('premium609') || l.includes('premium'))) {
    return true;
  }

  // KTV Sport must not fall back to KTV Sport Plus
  if (channelId === 'ktv-sport-ar' && l.includes('plus')) {
    return true;
  }

  // Dubai Sports 1 must not fall back to Dubai Racing
  if (channelId === 'dubai-sports-1-ar' && (u.includes('premium608') || l.includes('racing'))) {
    return true;
  }

  // NFL Network single-game feed must not switch to NFL RedZone whiparound
  if (channelId === 'nfl-network' && (u.includes('premium667') || l.includes('redzone'))) {
    return true;
  }

  // DAZN Combat must not switch to DAZN LaLiga or DAZN Ligue 1 football feeds
  if (channelId === 'dazn-combat' && (u.includes('premium538') || u.includes('premium960') || l.includes('laliga') || l.includes('ligue 1'))) {
    return true;
  }

  return false;
}

// Compute real-world broadcaster priority score so simultaneous matches sort in exact TV channel order (1..6)
function getMatchBroadcastPrestige(ev: any): number {
  const home = String(ev?.homeTeam?.name || '').toLowerCase();
  const away = String(ev?.awayTeam?.name || '').toLowerCase();
  const teams = `${home} ${away}`;
  const leagueSlug = String(ev?.leagueSlug || ev?.league || '').toLowerCase();

  let score = 0;
  // League tier priority so top-division matches always claim primary flagship channels before second-tier simultaneous matches
  if (leagueSlug.includes('uefa.champions')) score += 85;
  else if (leagueSlug === 'eng.1' || leagueSlug.includes('premier league')) score += 75;
  else if (leagueSlug === 'esp.1' || leagueSlug === 'ita.1' || leagueSlug === 'ger.1' || leagueSlug === 'fra.1') score += 60;
  else if (leagueSlug.includes('ksa.1') || leagueSlug.includes('afc.champions')) score += 58;
  else if (leagueSlug.includes('uefa.europa') && !leagueSlug.includes('conf')) score += 45;
  else if (leagueSlug.includes('ufc') || leagueSlug.includes('f1') || leagueSlug.includes('nba') || leagueSlug.includes('nfl')) score += 50;
  else if (leagueSlug === 'eng.2') score += 10;

  const clubWeights: Array<[RegExp, number]> = [
    [/\b(real madrid|barcelona|ac milan|milan|arsenal|liverpool|manchester city|manchester united|bayern|paris saint-germain|psg|inter milan|juventus|chelsea)\b/i, 120],
    [/\b(crystal palace|besiktas|beşiktaş|tottenham|aston villa|newcastle|atletico madrid|borussia dortmund|napoli|roma|al hilal|al nassr)\b/i, 75],
    [/\b(as monaco|monaco|lyon|olympique lyonnais|bournemouth|afc bournemouth|marseille|lille|bayer leverkusen|al ittihad|al ahli)\b/i, 70],
    [/\b(atalanta|ajax|ajax amsterdam|sc freiburg|freiburg|tsg hoffenheim|hoffenheim|celtic|celta vigo|rangers|fenerbahce|galatasaray)\b/i, 56],
    [/\b(benfica|real sociedad|porto|sporting|villarreal|athletic club|real betis|fiorentina|lazio|bologna|stuttgart|eintracht frankfurt|rb leipzig|brighton|sunderland|nottingham forest|west ham|fulham|brentford|everton|wolves)\b/i, 35],
    [/\b(nice|rennes|stade rennais|lens|brest|strasbourg|az alkmaar|psv|feyenoord|anderlecht|club brugge|kaa gent|genk|salzburg|olympiacos|panathinaikos|paok|trabzonspor|basaksehir)\b/i, 20],
  ];

  for (const [pattern, weight] of clubWeights) {
    const matches = teams.match(new RegExp(pattern.source, 'gi'));
    if (matches) {
      score += weight * matches.length;
    }
  }

  return score;
}

function assignSmartChannelsForEvent(
  ev: any,
  slotIndex: number,
  claimedInSlot: Set<string>,
  slotContext?: {
    britishRank?: number;
    totalBritishInSlot?: number;
    frenchRank?: number;
    totalFrenchInSlot?: number;
    turkishRank?: number;
  }
): Array<{
  channelId: string;
  name: string;
  language: string;
  languageLabel: string;
  logo?: string;
  streamEndpoint: string;
}> {
  const sport = String(ev?.sport || '').toLowerCase();
  const league = String(ev?.league || '').toLowerCase();
  const leagueSlug = String(ev?.leagueSlug || ev?.competitionCode || '').toLowerCase();
  const home = String(ev?.homeTeam?.name || '').toLowerCase();
  const away = String(ev?.awayTeam?.name || '').toLowerCase();
  const teamsText = `${home} ${away}`;
  const broadcastsText = Array.isArray(ev?.broadcasts) ? ev.broadcasts.join(' ').toLowerCase() : '';
  const statusUpper = String(ev?.status || '').toUpperCase();
  const isLive =
    statusUpper === 'LIVE' ||
    statusUpper === 'IN' ||
    statusUpper === 'IN_PROGRESS' ||
    statusUpper === 'HT' ||
    statusUpper === '1H' ||
    statusUpper === '2H';

  const isFightCard = sport.includes('mma') || sport.includes('ufc') || sport.includes('boxing') || league.includes('ufc');
  const isMotorsport = sport.includes('motor') || sport.includes('f1') || sport.includes('racing') || league.includes('formula');

  const assignedIds: string[] = [];
  const claimedFamiliesForThisEvent = new Set<string>();
  const competitionEligibleSet = new Set<string>();
  const orderedFallbackPools: string[][] = [];

  const addFallbackPool = (pool: string[]) => {
    for (const id of pool) {
      if (id && LIVE_CHANNEL_DIRECTORY[id]) competitionEligibleSet.add(id);
    }
    orderedFallbackPools.push(pool);
  };

  // STRICT GLOBAL EXCLUSIVITY: A physical TV channel can NEVER be assigned to two simultaneous events in the same time slot
  const claimChannel = (id?: string, enforceOnePerNetworkFamily = false): boolean => {
    if (!id || !LIVE_CHANNEL_DIRECTORY[id] || assignedIds.includes(id)) return false;
    if (claimedInSlot.has(id)) return false;
    const family = getChannelNetworkFamily(id);
    if (enforceOnePerNetworkFamily && claimedFamiliesForThisEvent.has(family)) {
      return false;
    }
    assignedIds.push(id);
    claimedInSlot.add(id);
    claimedFamiliesForThisEvent.add(family);
    return true;
  };

  // Extract scraper EPG & recommended channel hints
  const epgLiveIds: string[] = Array.isArray(ev?.epgLiveChannelIds) ? ev.epgLiveChannelIds : [];
  const epgUpcomingIds: string[] = Array.isArray(ev?.epgUpcomingChannelIds) ? ev.epgUpcomingChannelIds : [];
  const scraperRecIds: string[] = Array.isArray(ev?.scraperRecommendedChannels)
    ? ev.scraperRecommendedChannels.map((c: any) => String(c?.channelId || c?.id || c || '').trim()).filter(Boolean)
    : [];

  // STEP 1: REGISTER COMPETITION-SPECIFIC BROADCAST RIGHTS POOLS (2024/2025/2026 RIGHTS)
  // 1. NBA / Basketball
  if (sport.includes('basketball') || league.includes('nba') || leagueSlug === 'nba') {
    const usPools = [
      ['nba-tv', 'espn-hd', 'espn-2-hd', 'tnt-sports-1', 'tnt-sports-2'],
      ['espn-hd', 'espn-2-hd', 'nba-tv', 'tnt-sports-1', 'tnt-sports-2'],
      ['tnt-sports-1', 'tnt-sports-2', 'nba-tv', 'espn-hd', 'espn-2-hd'],
    ];
    const preferredUsPool = broadcastsText.includes('tnt')
      ? usPools[2]
      : broadcastsText.includes('espn') || broadcastsText.includes('abc')
        ? usPools[1]
        : usPools[0];
    addFallbackPool(preferredUsPool);
    addFallbackPool(['sky-sports-arena', 'sky-sports-action', 'sky-sports-mix']);
    addFallbackPool(['fox-sports-1', 'fox-sports-2', 'nbc-sports-now']);
  }
  // 2. NFL / American Football
  else if (
    sport === 'football' ||
    sport === 'nfl' ||
    sport === 'american-football' ||
    league.includes('nfl') ||
    leagueSlug === 'nfl'
  ) {
    if (broadcastsText.includes('espn') || broadcastsText.includes('abc')) {
      addFallbackPool(['espn-hd', 'espn-2-hd', 'nfl-network', 'nfl-redzone', 'fox-sports-1', 'fox-sports-2', 'nbc-sports-now']);
    } else if (broadcastsText.includes('fox')) {
      addFallbackPool(['fox-sports-1', 'fox-sports-2', 'nfl-network', 'nfl-redzone', 'espn-hd', 'espn-2-hd', 'nbc-sports-now']);
    } else {
      addFallbackPool(['nfl-network', 'nfl-redzone', 'fox-sports-1', 'espn-hd', 'fox-sports-2', 'espn-2-hd', 'nbc-sports-now']);
    }
    addFallbackPool(['sky-sports-action', 'sky-sports-main-event', 'sky-sports-mix']);
    addFallbackPool(['dazn-1-de', 'dazn-2-de']);
  }
  // 3. UFC / MMA / Boxing
  else if (isFightCard) {
    addFallbackPool(['ad-sports-2-ar', 'ad-sports-1-ar']);
    addFallbackPool(['dazn-combat', 'espn-hd', 'espn-2-hd', 'fox-sports-2']);
    addFallbackPool(['rmc-sport-1-fr']);
    addFallbackPool(['tnt-sports-1', 'tnt-sports-2', 'tnt-sports-3', 'tnt-sports-4']);
  }
  // 4. Formula 1 / Motorsport
  else if (isMotorsport) {
    addFallbackPool(['sky-sports-f1', 'red-bull-tv', 'espn-2-hd']);
    addFallbackPool(['ssc-sport-3-ar', 'bein-sports-8-ar']);
    addFallbackPool(['canal-plus-foot-fr']);
  }
  // 5. Tennis (ATP / WTA)
  else if (sport.includes('tennis') || league.includes('atp') || league.includes('wta')) {
    addFallbackPool(['sky-sports-tennis', 'tennis-channel', 'eurosport-1', 'eurosport-2']);
    addFallbackPool(['bein-sports-7-ar', 'bein-sports-8-ar', 'bein-sports-9-ar']);
    addFallbackPool(['bein-sports-fr-3', 'bein-sports-max-4-fr']);
  }
  // 6. NHL / Ice Hockey
  else if (sport.includes('hockey') || league.includes('nhl') || leagueSlug === 'nhl') {
    addFallbackPool(['nhl-network', 'espn-hd', 'espn-2-hd', 'espnu-hd', 'fox-sports-2']);
    addFallbackPool(['premier-sports-1', 'premier-sports-2', 'tnt-sports-3', 'tnt-sports-4']);
  }
  // 7. MLB / Baseball
  else if (sport.includes('baseball') || league.includes('mlb') || leagueSlug === 'mlb') {
    addFallbackPool(['mlb-network', 'fox-sports-1', 'espn-hd', 'fox-sports-2', 'espn-2-hd']);
    addFallbackPool(['tnt-sports-2', 'tnt-sports-3', 'tnt-sports-4']);
  }
  // 8. Football / Soccer
  else {
    const isUefaCompetition =
      leagueSlug.includes('uefa') ||
      league.includes('uefa') ||
      league.includes('champions league') ||
      league.includes('europa league') ||
      league.includes('conference league');

    // 8A. UEFA Champions League, UEFA Europa League, UEFA Conference League
    if (isUefaCompetition && !leagueSlug.includes('afc') && !league.includes('afc')) {
      const hasBritishClub =
        /\b(arsenal|aston villa|bournemouth|brentford|brighton|chelsea|crystal palace|everton|fulham|ipswich|leicester|liverpool|manchester city|manchester united|newcastle|nottingham forest|southampton|sunderland|tottenham|west ham|wolves|wolverhampton|celtic|rangers|heart of midlothian|hearts|aberdeen|hibernian)\b/i.test(
          teamsText
        );
      const isScottishClub = /\b(celtic|rangers|heart of midlothian|hearts|aberdeen|hibernian)\b/i.test(teamsText);
      const hasTurkishClub =
        /\b(galatasaray|fenerbahce|fenerbahçe|besiktas|beşiktaş|trabzonspor|basaksehir|başakşehir|samsunspor)\b/i.test(
          teamsText
        );
      const hasFrenchClub =
        /\b(paris saint-germain|psg|marseille|lyon|olympique lyonnais|monaco|as monaco|lille|lens|stade rennais|rennes|nice|brest|strasbourg)\b/i.test(
          teamsText
        );

      addFallbackPool([...UEFA_ARABIC_POOL]);

      const totalBritishInSlot = slotContext?.totalBritishInSlot ?? 0;
      if (hasBritishClub) {
        const britRank = slotContext?.britishRank ?? 0;
        const preferredTnt = `tnt-sports-${Math.min(4, britRank + 1)}`;
        addFallbackPool([preferredTnt, 'tnt-sports-1', 'tnt-sports-2', 'tnt-sports-3', 'tnt-sports-4', 'premier-sports-1', 'premier-sports-2']);
      } else {
        const nonBritishUkPool =
          totalBritishInSlot >= 3
            ? ['tnt-sports-4', 'premier-sports-1', 'premier-sports-2']
            : totalBritishInSlot === 2
              ? ['tnt-sports-3', 'tnt-sports-4', 'premier-sports-1', 'premier-sports-2']
              : totalBritishInSlot === 1
                ? ['tnt-sports-2', 'tnt-sports-3', 'tnt-sports-4', 'premier-sports-1', 'premier-sports-2']
                : ['tnt-sports-1', 'tnt-sports-2', 'tnt-sports-3', 'tnt-sports-4', 'premier-sports-1', 'premier-sports-2'];
        addFallbackPool(nonBritishUkPool);
      }

      addFallbackPool(['cbs-sports-golazo', 'supersport-grandstand', 'supersport-football']);

      if (slotIndex === 0) {
        addFallbackPool(['bein-sports-en-1', 'bein-sports-en-2', 'bein-sports-en-3']);
      } else if (isScottishClub) {
        addFallbackPool(['bein-sports-en-2', 'bein-sports-en-3', 'bein-sports-en-1']);
      } else if (hasBritishClub) {
        addFallbackPool(['bein-sports-en-3', 'bein-sports-en-2', 'bein-sports-en-1']);
      } else if (totalBritishInSlot < 3) {
        addFallbackPool(['bein-sports-en-1', 'bein-sports-en-2', 'bein-sports-en-3']);
      }

      const totalFrenchInSlot = slotContext?.totalFrenchInSlot ?? 0;
      if (hasFrenchClub) {
        const frRank = slotContext?.frenchRank ?? 0;
        if (frRank === 0) {
          addFallbackPool(['canal-plus-foot-fr', 'rmc-sport-1-fr']);
        } else {
          addFallbackPool(['rmc-sport-1-fr', 'canal-plus-foot-fr']);
        }
      } else {
        addFallbackPool(['canal-plus-foot-fr', 'rmc-sport-1-fr']);
      }

      if (hasTurkishClub) {
        addFallbackPool(['bein-sports-1-tr', 'bein-sports-2-tr', 'bein-sports-3-tr']);
      }
      addFallbackPool(['sky-sport-uno-it', 'sky-sport-arena-it', 'sky-sport-max-it']);
    }
    // 8B. Saudi Roshn Pro League & AFC Champions League Elite
    else if (
      leagueSlug.includes('ksa') ||
      league.includes('saudi') ||
      leagueSlug.includes('afc') ||
      league.includes('afc') ||
      /\b(al hilal|al nassr|al ahli|al ittihad|al shabab|al fateh|al fayha|al hazem|al khaleej|al ettifaq|al taawoun|al qadsiah|al riyadh|al wehda|al raed|damac|al ain|al sadd|al gharafa|al rayyan|al wasl)\b/i.test(
        teamsText
      )
    ) {
      const isAfc = leagueSlug.includes('afc') || league.includes('afc');
      if (isAfc) {
        addFallbackPool(['bein-sports-afc-ar', 'ssc-sport-1-ar', 'ssc-sport-2-ar', 'alkass-1-ar', 'alkass-2-ar', 'ad-sports-1-ar', 'ad-sports-2-ar']);
      } else {
        addFallbackPool(['ssc-sport-1-ar', 'ssc-sport-2-ar', 'ssc-sport-3-ar', 'ssc-extra-1-ar', 'ssc-extra-2-ar', 'ssc-extra-3-ar']);
      }
      addFallbackPool(['fox-sports-2', 'fox-sports-1']);
      addFallbackPool(['canal-plus-foot-fr']);
    }
    // 8C-1. English Premier League & FA Cup (Top-Flight)
    // MENA: beIN Sports 1/2 HD (AR) & beIN Sports 1/2 English; UK: Sky Sports PL / Main Event / TNT Sports 1; France: Canal+ Foot (NOT beIN FR)
    else if (
      leagueSlug === 'eng.1' ||
      leagueSlug === 'eng.fa' ||
      league.includes('premier league') ||
      league.includes('fa cup')
    ) {
      addFallbackPool(['bein-sports-1-ar', 'bein-sports-2-ar', 'bein-sports-5-ar', 'bein-sports-6-ar']);
      if (broadcastsText.includes('tnt') || leagueSlug === 'eng.fa' || league.includes('fa cup')) {
        addFallbackPool(['tnt-sports-1', 'tnt-sports-2', 'sky-sports-premier-league', 'sky-sports-main-event']);
      } else {
        addFallbackPool(['sky-sports-premier-league', 'sky-sports-main-event', 'tnt-sports-1']);
      }
      addFallbackPool(['supersport-premier-league', 'supersport-grandstand', 'supersport-variety-1']);
      addFallbackPool(['usa-network-hd', 'nbc-sports-now']);
      addFallbackPool(['bein-sports-en-1', 'bein-sports-en-2']);
      addFallbackPool(['canal-plus-foot-fr']);
    }
    // 8C-2. EFL Championship / Carabao Cup / English Football League (eng.2)
    else if (
      leagueSlug === 'eng.2' ||
      leagueSlug.includes('eng.') ||
      league.includes('championship') ||
      league.includes('efl') ||
      league.includes('carabao')
    ) {
      addFallbackPool(['sky-sports-football', 'sky-sports-plus', 'sky-sports-action', 'sky-sports-main-event', 'sky-sports-mix']);
      addFallbackPool(['cbs-sports-golazo', 'bein-sports-en-3']);
      addFallbackPool(['supersport-football', 'supersport-variety-1']);
      addFallbackPool(['bein-sports-5-ar']);
    }
    // 8D. Spanish LaLiga / Copa del Rey
    // MENA: beIN Sports 3 HD (AR) dedicated LaLiga channel; France: beIN Sports 1/2 FR; Spain: DAZN LaLiga / M+ LaLiga
    else if (leagueSlug.includes('esp') || league.includes('laliga') || league.includes('copa del rey')) {
      const hasRealMadrid = /\b(real madrid)\b/i.test(teamsText);
      addFallbackPool(['bein-sports-3-ar', 'bein-sports-5-ar', 'bein-sports-6-ar']);
      addFallbackPool(['premier-sports-1', 'premier-sports-2']);
      addFallbackPool(['bein-sports-fr-1', 'bein-sports-fr-2', 'bein-sports-max-4-fr']);
      addFallbackPool(['dazn-laliga-es', ...(hasRealMadrid ? ['real-madrid-tv'] : [])]);
      addFallbackPool(['supersport-laliga', 'supersport-football']);
      addFallbackPool(['espn-hd', 'espn-2-hd']);
    }
    // 8E. Italian Serie A / Coppa Italia
    // MENA: STARZPLAY Sports 1/2 (AD Sports Premium 1/2) & Abu Dhabi Sports — NEVER beIN Sports!
    // Italy: DAZN 1/2 Italia & Sky Sport Calcio/Uno/252 Italia; UK: TNT Sports; US: CBS Sports Golazo; France: L'Équipe
    else if (leagueSlug.includes('ita') || league.includes('serie a') || league.includes('coppa italia')) {
      addFallbackPool(['starzplay-sports-1-ar', 'starzplay-sports-2-ar', 'ad-sports-1-ar', 'ad-sports-2-ar']);
      addFallbackPool([
        'dazn-1-it',
        'dazn-2-it',
        'sky-sport-calcio-it',
        'sky-sport-252-it',
        'sky-sport-uno-it',
        'sky-sport-arena-it',
        'sky-sport-max-it',
      ]);
      addFallbackPool(['tnt-sports-2', 'tnt-sports-3', 'tnt-sports-1', 'tnt-sports-4']);
      addFallbackPool(['lequipe-fr']);
      addFallbackPool(['cbs-sports-golazo']);
      addFallbackPool(['supersport-football', 'supersport-variety-1']);
    }
    // 8F. German Bundesliga / DFB-Pokal
    // Germany: Sky Sport Bundesliga 1 / Top Event & DAZN 1/2 DE; MENA: Dubai Sports 1/2 HD; UK: Sky Sports Football / Mix / Plus; US: ESPN — NEVER beIN Sports!
    else if (leagueSlug.includes('ger') || league.includes('bundesliga')) {
      addFallbackPool(['sky-sport-bundesliga-1-de', 'sky-sport-top-event-de', 'dazn-1-de', 'dazn-2-de']);
      addFallbackPool(['dubai-sports-1-ar', 'dubai-sports-2-ar']);
      addFallbackPool(['sky-sports-football', 'sky-sports-mix', 'sky-sports-plus']);
      addFallbackPool(['espn-2-hd', 'espn-hd', 'espnu-hd']);
      addFallbackPool(['sky-sport-max-it', 'sky-sport-arena-it']);
    }
    // 8G. French Ligue 1
    // MENA: beIN Sports 4 HD (AR) & beIN Sports 2/3 EN; France: DAZN Ligue 1 & beIN Sports 1 FR
    else if (leagueSlug.includes('fra') || league.includes('ligue 1')) {
      addFallbackPool(['bein-sports-4-ar', 'bein-sports-5-ar', 'bein-sports-6-ar']);
      addFallbackPool(['bein-sports-en-2', 'bein-sports-en-3']);
      addFallbackPool(['dazn-ligue1-fr', 'bein-sports-fr-1']);
    }
    // 8H. Turkish Süper Lig
    else if (leagueSlug.includes('tur') || league.includes('türkiye') || league.includes('super lig')) {
      addFallbackPool(['bein-sports-1-tr', 'bein-sports-2-tr', 'bein-sports-3-tr', 'bein-sports-4-tr', 'bein-sports-5-tr']);
    }
    // 8I. Moroccan Botola / CAF
    else if (
      leagueSlug.includes('mar') ||
      /\b(wydad|raja|far rabat|berkane|morocco|fath union|hassania|maghreb)\b/i.test(teamsText)
    ) {
      addFallbackPool(['arryadia-ar', 'bein-sports-6-ar']);
    }
    // 8J-1. CONMEBOL Libertadores / Sudamericana (South America — broadcast on beIN Sports XTRA ES/EN & ESPN/FOX)
    else if (
      leagueSlug.includes('conmebol') ||
      league.includes('libertadores') ||
      league.includes('sudamericana')
    ) {
      addFallbackPool(['bein-sports-xtra-es', 'bein-sports-xtra-en']);
      addFallbackPool(['espn-hd', 'espn-2-hd', 'fox-sports-2']);
    }
    // 8J-2. Major League Soccer (MLS) & Liga MX (Apple TV / FOX Sports — NEVER beIN Sports!)
    else if (
      leagueSlug.includes('mex') ||
      league.includes('liga mx') ||
      leagueSlug.includes('usa') ||
      league.includes('mls')
    ) {
      addFallbackPool(['fox-sports-1', 'fox-sports-2', 'espn-hd', 'espn-2-hd', 'cbs-sports-golazo', 'nbc-sports-now']);
    }
    // 8K. Default International Football
    else {
      addFallbackPool(['bein-sports-1-ar', 'bein-sports-2-ar', 'bein-sports-3-ar', 'bein-sports-4-ar']);
      addFallbackPool(['bein-sports-en-1', 'bein-sports-en-2', 'tnt-sports-1', 'premier-sports-1']);
      addFallbackPool(['bein-sports-fr-1', 'bein-sports-fr-2']);
    }
  }

  // STEP 2: 1-TO-1 SCRAPER SYNC PRIORITY
  // If the upstream scraper already assigned competition-eligible channels to this event, honor those exact channels first!
  const scraperDirectIds = scraperRecIds
    .map((rawId) =>
      rawId.startsWith('bein-sports-premium-')
        ? rawId.replace('bein-sports-premium-', 'bein-sports-')
        : rawId
    )
    .filter((chId) => competitionEligibleSet.has(chId));

  for (const chId of scraperDirectIds) {
    const fam = getChannelNetworkFamily(chId);
    if (claimedFamiliesForThisEvent.has(fam)) continue;
    assignedIds.push(chId);
    claimedInSlot.add(chId);
    claimedFamiliesForThisEvent.add(fam);
  }

  // Also check any additional EPG channel IDs if scraperDirectIds was empty
  if (assignedIds.length === 0) {
    const epgCandidates = Array.from(new Set([...(isLive ? epgLiveIds : []), ...epgUpcomingIds]));
    for (const rawId of epgCandidates) {
      const chId = rawId.startsWith('bein-sports-premium-')
        ? rawId.replace('bein-sports-premium-', 'bein-sports-')
        : rawId;
      if (!competitionEligibleSet.has(chId)) continue;
      claimChannel(chId, true);
    }
  }

  // STEP 3: Only run fallback pool assignment if the scraper did not provide channels for this event (e.g., FINISHED matches or overflow fixtures)
  if (assignedIds.length === 0) {
    for (const pool of orderedFallbackPools) {
      for (const id of pool) {
        if (claimChannel(id, true)) break;
      }
    }
  }

  // STEP 4: Competition-restricted last-resort fallback if simultaneous fixtures of the SAME competition exhausted all primary family slots
  if (assignedIds.length === 0 && competitionEligibleSet.size > 0) {
    const eligibleList = Array.from(competitionEligibleSet);
    const unclaimedEligible = eligibleList.find((id) => !claimedInSlot.has(id));
    if (unclaimedEligible) {
      assignedIds.push(unclaimedEligible);
      claimedInSlot.add(unclaimedEligible);
    } else {
      const rotated = eligibleList[slotIndex % eligibleList.length];
      if (rotated) {
        assignedIds.push(rotated);
      }
    }
  }

  return sortEventChannelsForCardDisplay(assignedIds).map((id) => buildRecommendedChannelItem(id));
}

function parseEspnEventToLiveSportEvent(
  ev: any,
  sportType: string,
  defaultLeagueName: string,
  leagueSlug: string,
  leagueLogoUrl?: string
): any[] {
  if (!ev || !ev.id) return [];
  const competitions = Array.isArray(ev.competitions) ? ev.competitions : [];
  if (competitions.length === 0) return [];

  // For UFC / MMA events that have multiple bouts, pick only the main event (last competition) and keep the canonical event ID so it matches the scraper
  if (sportType === 'mma' && competitions.length > 1) {
    const mainBouts = competitions.slice(-1);
    return mainBouts
      .map((comp: any) => {
        const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
        const c1 = competitors[0];
        const c2 = competitors[1];
        const name1 = c1?.athlete?.displayName || c1?.athlete?.fullName || c1?.team?.displayName || 'Fighter 1';
        const name2 = c2?.athlete?.displayName || c2?.athlete?.fullName || c2?.team?.displayName || 'Fighter 2';
        if (name1 === 'Fighter 1' && name2 === 'Fighter 2') return null;

        const rawState = String(comp?.status?.type?.state || ev?.status?.type?.state || 'pre').toLowerCase();
        const status = rawState === 'in' ? 'LIVE' : rawState === 'post' ? 'FINISHED' : 'UPCOMING';
        return {
          id: String(ev.id),
          title: `${name1} vs ${name2}`,
          shortTitle: ev.shortName || 'UFC',
          sport: 'mma',
          league: ev.name || defaultLeagueName || 'UFC / MMA',
          leagueSlug: 'ufc',
          leagueLogo: leagueLogoUrl || 'https://a.espncdn.com/i/leaguelogos/mma/500/ufc.png',
          startTime: comp?.date || ev.date,
          status,
          statusDetail: comp?.status?.type?.shortDetail || ev?.status?.type?.shortDetail || 'Main Card',
          homeTeam: {
            name: name1,
            shortName: c1?.athlete?.shortName || name1.slice(0, 3).toUpperCase(),
            logo: c1?.athlete?.headshot?.href || c1?.athlete?.flag?.href,
            score: c1?.score ?? '0',
          },
          awayTeam: {
            name: name2,
            shortName: c2?.athlete?.shortName || name2.slice(0, 3).toUpperCase(),
            logo: c2?.athlete?.headshot?.href || c2?.athlete?.flag?.href,
            score: c2?.score ?? '0',
          },
          broadcasts: ['TNT Sports 1', 'RMC Sport 1', 'DAZN Combat'],
          recommendedChannels: [],
        };
      })
      .filter(Boolean);
  }

  // For Formula 1 / Motorsport events
  if (sportType === 'motorsport') {
    const comp = competitions[0];
    const rawState = String(comp?.status?.type?.state || ev?.status?.type?.state || 'pre').toLowerCase();
    const status = rawState === 'in' ? 'LIVE' : rawState === 'post' ? 'FINISHED' : 'UPCOMING';
    return [
      {
        id: String(ev.id),
        title: ev.name || 'Formula 1 Grand Prix',
        shortTitle: ev.shortName || 'F1 GP',
        sport: 'motorsport',
        league: defaultLeagueName || 'Formula 1',
        leagueSlug: 'f1',
        leagueLogo: leagueLogoUrl || 'https://a.espncdn.com/i/leaguelogos/racing/500/f1.png',
        startTime: comp?.date || ev.date,
        status,
        statusDetail: comp?.status?.type?.shortDetail || ev?.status?.type?.shortDetail || 'Grand Prix',
        homeTeam: {
          name: ev.shortName || ev.name || 'Formula 1',
          shortName: 'F1',
          logo: 'https://a.espncdn.com/i/leaguelogos/racing/500/f1.png',
          score: '',
        },
        awayTeam: {
          name: 'Race Session',
          shortName: 'GP',
          logo: 'https://a.espncdn.com/i/leaguelogos/racing/500/f1.png',
          score: '',
        },
        broadcasts: ['Sky Sports F1', 'ESPN'],
        recommendedChannels: [],
      },
    ];
  }

  const comp = competitions[0];
  const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
  if (competitors.length < 2) return [];

  const homeComp = competitors.find((c: any) => c.homeAway === 'home') || competitors[0];
  const awayComp = competitors.find((c: any) => c.homeAway === 'away') || competitors[1];

  const homeName =
    homeComp?.team?.displayName ||
    homeComp?.team?.name ||
    homeComp?.athlete?.displayName ||
    'Home';
  const awayName =
    awayComp?.team?.displayName ||
    awayComp?.team?.name ||
    awayComp?.athlete?.displayName ||
    'Away';

  if (homeName === 'Home' && awayName === 'Away') return [];

  // Strictly trust ESPN's real-time state ('in' = LIVE, 'post' = FINISHED, 'pre' = UPCOMING) — never fake LIVE status
  const rawState = String(comp?.status?.type?.state || ev?.status?.type?.state || 'pre').toLowerCase();
  const status = rawState === 'in' ? 'LIVE' : rawState === 'post' ? 'FINISHED' : 'UPCOMING';
  const statusDetail = comp?.status?.type?.shortDetail || ev?.status?.type?.shortDetail || 'Scheduled';

  const broadcasts: string[] = [];
  if (Array.isArray(comp?.broadcasts)) {
    comp.broadcasts.forEach((b: any) => {
      if (Array.isArray(b?.names)) {
        b.names.forEach((n: string) => {
          if (n && !broadcasts.includes(n)) broadcasts.push(n);
        });
      }
    });
  }
  if (Array.isArray(comp?.geoBroadcasts)) {
    comp.geoBroadcasts.forEach((g: any) => {
      const sName = g?.media?.shortName;
      if (sName && !broadcasts.includes(sName)) broadcasts.push(sName);
    });
  }

  const homeAbbr = homeComp?.team?.abbreviation || homeName.slice(0, 3).toUpperCase();
  const awayAbbr = awayComp?.team?.abbreviation || awayName.slice(0, 3).toUpperCase();

  return [
    {
      id: String(ev.id),
      title: `${homeName} vs ${awayName}`,
      shortTitle: `${homeAbbr} vs ${awayAbbr}`,
      sport: sportType,
      league: defaultLeagueName,
      leagueSlug,
      leagueLogo: leagueLogoUrl,
      startTime: comp?.date || ev.date,
      status,
      statusDetail,
      homeTeam: {
        name: homeName,
        shortName: homeAbbr,
        logo: homeComp?.team?.logo || homeComp?.athlete?.flag?.href,
        score: homeComp?.score ?? '0',
      },
      awayTeam: {
        name: awayName,
        shortName: awayAbbr,
        logo: awayComp?.team?.logo || awayComp?.athlete?.flag?.href,
        score: awayComp?.score ?? '0',
      },
      broadcasts,
      recommendedChannels: [],
    },
  ];
}

async function getOrRefreshLiveEventsPayload(maxAgeMs = 12000): Promise<{
  status: string;
  updatedAt: string;
  count: number;
  events: any[];
}> {
  if (
    cachedLiveEventsPayload &&
    Array.isArray(cachedLiveEventsPayload.data?.events) &&
    cachedLiveEventsPayload.data.events.length > 0 &&
    Date.now() - cachedLiveEventsPayload.timestamp < maxAgeMs
  ) {
    return cachedLiveEventsPayload.data;
  }

  try {
    const nowMs = Date.now();
    const todayIso = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');

    // Strictly fetch TODAY's active competitions so matches days away (like weekend fixtures on a weekday) never clutter the live arena
    const espnFeeds: Array<{ url: string; sport: string; league: string; slug: string }> = [
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'UEFA Champions League', slug: 'uefa.champions' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'UEFA Europa League', slug: 'uefa.europa' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa.conf/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'UEFA Conference League', slug: 'uefa.europa.conf' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ksa.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'Saudi Pro League', slug: 'ksa.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'English Premier League', slug: 'eng.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'EFL Championship', slug: 'eng.2' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'Spanish LaLiga', slug: 'esp.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'Italian Serie A', slug: 'ita.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'German Bundesliga', slug: 'ger.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'French Ligue 1', slug: 'fra.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/afc.champions/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'AFC Champions League Elite', slug: 'afc.champions' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.libertadores/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'CONMEBOL Libertadores', slug: 'conmebol.libertadores' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${todayIso}`, sport: 'basketball', league: 'NBA Basketball', slug: 'nba' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${todayIso}`, sport: 'football', league: 'NFL Football', slug: 'nfl' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${todayIso}`, sport: 'hockey', league: 'NHL Hockey', slug: 'nhl' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${todayIso}`, sport: 'mma', league: 'UFC / MMA', slug: 'ufc' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard?dates=${todayIso}`, sport: 'motorsport', league: 'Formula 1', slug: 'f1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates=${todayIso}`, sport: 'tennis', league: 'ATP Tour Tennis', slug: 'atp' },
    ];

    const fetchJsonFast = async (url: string, timeoutMs = 4500): Promise<any> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
        });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    const [cineproRaw, cineproEpgRaw, ...espnResults] = await Promise.all([
      fetchJsonFast(`${getCineproUrl()}/v1/live/events`, 5500),
      fetchJsonFast(`${getCineproUrl()}/v1/live/epg`, 5500),
      ...espnFeeds.map((f) => fetchJsonFast(f.url, 4200)),
    ]);

    // Build authoritative reverse index from Scraper's Real-Time EPG Engine (eventId -> broadcasting channelIds)
    const epgLiveByEventId = new Map<string, string[]>();
    const epgUpcomingByEventId = new Map<string, string[]>();
    if (Array.isArray(cineproEpgRaw?.epg)) {
      const nextUpstreamMap = new Map<string, any>();
      for (const chEpg of cineproEpgRaw.epg) {
        const chId = String(chEpg?.channelId || '').trim();
        if (!chId) continue;
        nextUpstreamMap.set(chId, chEpg);

        const nowEvId = chEpg?.nowPlaying?.eventId ? String(chEpg.nowPlaying.eventId).trim() : '';
        if (nowEvId) {
          if (!epgLiveByEventId.has(nowEvId)) epgLiveByEventId.set(nowEvId, []);
          const arr = epgLiveByEventId.get(nowEvId)!;
          if (!arr.includes(chId)) arr.push(chId);
        }

        const upcomingItems = [
          ...(chEpg?.nextUp ? [chEpg.nextUp] : []),
          ...(Array.isArray(chEpg?.upcoming) ? chEpg.upcoming : []),
        ];
        for (const uItem of upcomingItems) {
          const upEvId = uItem?.eventId ? String(uItem.eventId).trim() : '';
          if (upEvId) {
            if (!epgUpcomingByEventId.has(upEvId)) epgUpcomingByEventId.set(upEvId, []);
            const arr = epgUpcomingByEventId.get(upEvId)!;
            if (!arr.includes(chId)) arr.push(chId);
          }
        }
      }
      if (nextUpstreamMap.size > 0) {
        cachedUpstreamEpgMap = nextUpstreamMap;
      }
    }

    const eventsMap = new Map<string, any>();
    const teamMatchupKeyToIdMap = new Map<string, string>();

    const makeTeamPairKey = (ev: any): string => {
      const h = String(ev?.homeTeam?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const a = String(ev?.awayTeam?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!h || !a) return '';
      return [h, a].sort().join('__');
    };

    const isLiveState = (s?: string) => {
      const u = String(s || '').toUpperCase();
      return u === 'LIVE' || u === 'IN' || u === 'IN_PROGRESS' || u === 'HT' || u === '1H' || u === '2H';
    };
    const isFinishedState = (s?: string) => {
      const u = String(s || '').toUpperCase();
      return u === 'FINISHED' || u === 'POST' || u === 'FINAL' || u === 'FT';
    };

    // Keep LIVE events, upcoming matches starting within the next 30 hours, and matches finished within the last 6 hours
    const shouldKeepEventInWindow = (ev: any): boolean => {
      if (!ev) return false;
      if (isLiveState(ev.status)) return true;
      const startMs = Date.parse(ev.startTime || '');
      if (Number.isNaN(startMs)) return false;

      const diffHours = (startMs - nowMs) / (1000 * 60 * 60);
      if (isFinishedState(ev.status)) {
        return diffHours >= -6 && diffHours <= 1;
      }
      return diffHours >= -1 && diffHours <= 30;
    };

    // 1. Ingest authoritative ESPN live & today events
    espnResults.forEach((data, idx) => {
      if (!data || !Array.isArray(data.events)) return;
      const feedMeta = espnFeeds[idx];
      const leagueObj = Array.isArray(data.leagues) ? data.leagues[0] : null;
      const leagueLogo =
        leagueObj?.logos?.[0]?.href ||
        (feedMeta.sport === 'soccer'
          ? 'https://a.espncdn.com/i/leaguelogos/soccer/500/2310.png'
          : undefined);
      const leagueName = feedMeta.league || leagueObj?.name || 'International';

      for (const rawEv of data.events) {
        const parsedList = parseEspnEventToLiveSportEvent(
          rawEv,
          feedMeta.sport,
          leagueName,
          feedMeta.slug,
          leagueLogo
        );
        for (const item of parsedList) {
          if (item && item.id && shouldKeepEventInWindow(item) && !eventsMap.has(String(item.id))) {
            const idStr = String(item.id);
            eventsMap.set(idStr, {
              ...item,
              epgLiveChannelIds: epgLiveByEventId.get(idStr) || [],
              epgUpcomingChannelIds: epgUpcomingByEventId.get(idStr) || [],
            });
            const pairKey = makeTeamPairKey(item);
            if (pairKey) teamMatchupKeyToIdMap.set(pairKey, idStr);
          }
        }
      }
    });

    // 2. Merge EPG events from the updated CinePro scraper (/v1/live/events), enriching existing events with scraper EPG broadcasts/channels and adding any missing today events
    const cineproEvents = Array.isArray(cineproRaw?.events) ? cineproRaw.events : [];

    for (const ev of cineproEvents) {
      if (!ev || !ev.id) continue;
      if (ev.homeTeam?.name === 'Home' && ev.awayTeam?.name === 'Away') continue;
      const idStr = String(ev.id);
      const pairKey = makeTeamPairKey(ev);
      const matchedId = eventsMap.has(idStr) ? idStr : pairKey ? teamMatchupKeyToIdMap.get(pairKey) : undefined;

      if (matchedId && eventsMap.has(matchedId)) {
        const existing = eventsMap.get(matchedId);
        if (Array.isArray(ev.broadcasts) && ev.broadcasts.length > 0 && (!existing.broadcasts || existing.broadcasts.length === 0)) {
          existing.broadcasts = ev.broadcasts;
        }
        if (Array.isArray(ev.recommendedChannels) && ev.recommendedChannels.length > 0) {
          existing.scraperRecommendedChannels = ev.recommendedChannels;
        }
        if (epgLiveByEventId.has(idStr)) {
          existing.epgLiveChannelIds = Array.from(new Set([...(existing.epgLiveChannelIds || []), ...(epgLiveByEventId.get(idStr) || [])]));
        }
        if (epgUpcomingByEventId.has(idStr)) {
          existing.epgUpcomingChannelIds = Array.from(new Set([...(existing.epgUpcomingChannelIds || []), ...(epgUpcomingByEventId.get(idStr) || [])]));
        }
        continue;
      }

      const candidateEv = {
        ...ev,
        leagueSlug: ev.leagueSlug || ev.competitionCode || ev.sport || '',
        title:
          ev.homeTeam?.name && ev.awayTeam?.name
            ? `${ev.homeTeam.name} vs ${ev.awayTeam.name}`
            : ev.title,
        status: ev.status || 'UPCOMING',
        statusDetail: ev.statusDetail || 'Scheduled',
        scraperRecommendedChannels: Array.isArray(ev.recommendedChannels) ? ev.recommendedChannels : [],
        epgLiveChannelIds: epgLiveByEventId.get(idStr) || [],
        epgUpcomingChannelIds: epgUpcomingByEventId.get(idStr) || [],
      };

      if (shouldKeepEventInWindow(candidateEv)) {
        eventsMap.set(idStr, candidateEv);
        if (pairKey) teamMatchupKeyToIdMap.set(pairKey, idStr);
      }
    }

    // 3. Sort events: LIVE first, then UPCOMING by kickoff time ascending, then FINISHED by kickoff time descending,
    //    and within the same kickoff time window sort by broadcast prestige so headline matches get flagship channels (1..6)
    const allEvents = Array.from(eventsMap.values()).sort((a, b) => {
      const aLive = isLiveState(a.status);
      const bLive = isLiveState(b.status);
      if (aLive !== bLive) return aLive ? -1 : 1;

      const aFin = isFinishedState(a.status);
      const bFin = isFinishedState(b.status);
      if (aFin !== bFin) return aFin ? 1 : -1;

      if (aLive && bLive) {
        return getMatchBroadcastPrestige(b) - getMatchBroadcastPrestige(a);
      }

      const tA = Date.parse(a.startTime || '') || 0;
      const tB = Date.parse(b.startTime || '') || 0;
      const timeDiff = aFin ? tB - tA : tA - tB;
      if (Math.abs(timeDiff) > 45 * 60 * 1000) {
        return timeDiff;
      }
      return getMatchBroadcastPrestige(b) - getMatchBroadcastPrestige(a);
    });

    // 4. Assign accurate per-match broadcast channels with a GLOBAL per-time-window claim registry
    //    so two simultaneous events in the same time slot can NEVER share the same TV channel across any league or sport
    const getSimultaneousSlotKey = (ev: any): string => {
      if (isLiveState(ev.status)) return 'LIVE_NOW';
      const startMs = Date.parse(ev.startTime || '');
      if (Number.isNaN(startMs)) return `${ev.status}_UNKNOWN`;
      const sixtyMinBucket = Math.floor(startMs / (60 * 60 * 1000));
      return `${ev.status}_${sixtyMinBucket}`;
    };

    const getBroadcasterPoolGroup = (ev: any): string => {
      const lgSlug = String(ev.leagueSlug || ev.competitionCode || ev.league || ev.sport || 'general').toLowerCase();
      if (lgSlug.includes('uefa')) return 'uefa';
      if (lgSlug.includes('ksa') || lgSlug.includes('afc') || lgSlug.includes('saudi')) return 'mena';
      return lgSlug;
    };

    const BRITISH_CLUB_REGEX =
      /\b(arsenal|aston villa|bournemouth|brentford|brighton|chelsea|crystal palace|everton|fulham|ipswich|leicester|liverpool|manchester city|manchester united|newcastle|nottingham forest|southampton|sunderland|tottenham|west ham|wolves|wolverhampton|celtic|rangers|heart of midlothian|hearts|aberdeen|hibernian)\b/i;
    const FRENCH_CLUB_REGEX =
      /\b(paris saint-germain|psg|marseille|lyon|olympique lyonnais|monaco|as monaco|lille|lens|stade rennais|rennes|nice|brest|strasbourg)\b/i;
    const TURKISH_CLUB_REGEX =
      /\b(galatasaray|fenerbahce|fenerbahçe|besiktas|beşiktaş|trabzonspor|basaksehir|başakşehir|samsunspor)\b/i;

    const slotBritishTotals = new Map<string, number>();
    const slotFrenchTotals = new Map<string, number>();
    for (const ev of allEvents) {
      const groupSlotKey = `${getBroadcasterPoolGroup(ev)}__${getSimultaneousSlotKey(ev)}`;
      const teams = `${ev?.homeTeam?.name || ''} ${ev?.awayTeam?.name || ''}`;
      if (BRITISH_CLUB_REGEX.test(teams)) {
        slotBritishTotals.set(groupSlotKey, (slotBritishTotals.get(groupSlotKey) || 0) + 1);
      }
      if (FRENCH_CLUB_REGEX.test(teams)) {
        slotFrenchTotals.set(groupSlotKey, (slotFrenchTotals.get(groupSlotKey) || 0) + 1);
      }
    }

    const slotCounters = new Map<string, number>();
    const slotBritishCounters = new Map<string, number>();
    const slotFrenchCounters = new Map<string, number>();
    const slotTurkishCounters = new Map<string, number>();
    const globalSlotClaimedChannels = new Map<string, Set<string>>();

    const normalizedEvents = allEvents.map((ev: any) => {
      const globalTimeSlotKey = getSimultaneousSlotKey(ev);
      const groupSlotKey = `${getBroadcasterPoolGroup(ev)}__${globalTimeSlotKey}`;

      const idxInSlot = slotCounters.get(globalTimeSlotKey) || 0;
      slotCounters.set(globalTimeSlotKey, idxInSlot + 1);

      const teams = `${ev?.homeTeam?.name || ''} ${ev?.awayTeam?.name || ''}`;
      let britishRank = 0;
      if (BRITISH_CLUB_REGEX.test(teams)) {
        britishRank = slotBritishCounters.get(groupSlotKey) || 0;
        slotBritishCounters.set(groupSlotKey, britishRank + 1);
      }
      let frenchRank = 0;
      if (FRENCH_CLUB_REGEX.test(teams)) {
        frenchRank = slotFrenchCounters.get(groupSlotKey) || 0;
        slotFrenchCounters.set(groupSlotKey, frenchRank + 1);
      }
      let turkishRank = 0;
      if (TURKISH_CLUB_REGEX.test(teams)) {
        turkishRank = slotTurkishCounters.get(groupSlotKey) || 0;
        slotTurkishCounters.set(groupSlotKey, turkishRank + 1);
      }

      let claimedSet = globalSlotClaimedChannels.get(globalTimeSlotKey);
      if (!claimedSet) {
        claimedSet = new Set<string>();
        globalSlotClaimedChannels.set(globalTimeSlotKey, claimedSet);
      }

      const recChannels = assignSmartChannelsForEvent(ev, idxInSlot, claimedSet, {
        britishRank,
        totalBritishInSlot: slotBritishTotals.get(groupSlotKey) || 0,
        frenchRank,
        totalFrenchInSlot: slotFrenchTotals.get(groupSlotKey) || 0,
        turkishRank,
      });
      const {
        scraperRecommendedChannels: _unusedScraper,
        epgLiveChannelIds: epgLiveIdsForEv,
        epgUpcomingChannelIds: _unusedUpEpg,
        ...cleanEv
      } = ev;
      return {
        ...cleanEv,
        epgLiveChannelIds: Array.isArray(epgLiveIdsForEv) ? epgLiveIdsForEv : [],
        recommendedChannels: recChannels,
      };
    });

    const fullPayload = {
      status: 'ok',
      updatedAt: new Date().toISOString(),
      count: normalizedEvents.length,
      events: normalizedEvents,
    };

    if (normalizedEvents.length > 0) {
      cachedLiveEventsPayload = { data: fullPayload, timestamp: Date.now() };
    }

    return fullPayload;
  } catch (err: any) {
    console.warn('[Live Events Proxy] Error:', err?.message || err);
    if (cachedLiveEventsPayload) return cachedLiveEventsPayload.data;
    return { status: 'error', updatedAt: new Date().toISOString(), count: 0, events: [] };
  }
}

// Curated sport-accurate 24/7 studio program titles for specialty & beIN Sports channels so channels never display misleading fake "European Summit Match" filler or mismatched sport titles
const CHANNEL_CURATED_STUDIO_PROGRAMS: Record<string, { now: string; next: string; subtitle: string }> = {
  'bein-sports-1-ar': {
    now: 'الأستوديو التحليلي المباشر - الدوري الإنجليزي الممتاز ودوري أبطال أوروبا',
    next: 'ملخصات وأهداف البريميرليغ والبطولات الأوروبية - beIN Sports 1 HD',
    subtitle: 'Premier League & UEFA • 24/7 Studio',
  },
  'bein-sports-2-ar': {
    now: 'الأستوديو التحليلي المباشر - تغطية الدوري الإنجليزي الممتاز',
    next: 'حصاد الجولة وأبرز لقطات البريميرليغ - beIN Sports 2 HD',
    subtitle: 'English Premier League • 24/7 Studio',
  },
  'bein-sports-3-ar': {
    now: 'الأستوديو التحليلي المباشر - تغطية الدوري الإسباني (LaLiga)',
    next: 'ملخصات وأهداف الليغا الإسبانية - beIN Sports 3 HD',
    subtitle: 'Spanish LaLiga • 24/7 Studio',
  },
  'bein-sports-4-ar': {
    now: 'الأستوديو التحليلي المباشر - تغطية الدوري الفرنسي (Ligue 1)',
    next: 'ملخصات وأهداف الدوري الفرنسي - beIN Sports 4 HD',
    subtitle: 'French Ligue 1 • 24/7 Studio',
  },
  'bein-sports-5-ar': {
    now: 'الأستوديو التحليلي والتغطية المباشرة - البطولات الأوروبية',
    next: 'البرامج الرياضية وملخصات المباريات - beIN Sports 5 HD',
    subtitle: 'European Football • 24/7 Studio',
  },
  'bein-sports-6-ar': {
    now: 'الأستوديو التحليلي المباشر - البطولات الأفريقية والعربية (CAF)',
    next: 'ملخصات دوري أبطال أفريقيا والبطولات القارية - beIN Sports 6 HD',
    subtitle: 'CAF & International Football • 24/7 Studio',
  },
  'bein-sports-7-ar': {
    now: 'الأستوديو التحليلي والتغطية الرياضية الشاملة - beIN Sports 7 HD',
    next: 'البرامج الوثائقية وملخصات البطولات العالمية - beIN Sports 7 HD',
    subtitle: 'International Sports & Tennis • 24/7 Studio',
  },
  'bein-sports-8-ar': {
    now: 'التغطية الرياضية المباشرة والبطولات العالمية - beIN Sports 8 HD',
    next: 'ملخصات المنافسات الدولية والبرامج الخاصة - beIN Sports 8 HD',
    subtitle: 'Global Sports Coverage • 24/7 Studio',
  },
  'bein-sports-9-ar': {
    now: 'البرامج الرياضية التحليلية وملخصات الجولة - beIN Sports 9 HD',
    next: 'التغطية الشاملة للبطولات القارية والعالمية - beIN Sports 9 HD',
    subtitle: 'Multi-Sport & Football • 24/7 Studio',
  },
  'bein-sports-open-ar': {
    now: 'النشرة الإخبارية الرياضية والبرامج المفتوحة - beIN Sports Open HD',
    next: 'حصاد الرياضة والتقارير الميدانية - beIN Sports Open HD',
    subtitle: 'beIN Sports Open • News & Highlights',
  },
  'bein-sports-premium-1-ar': {
    now: 'الأستوديو التحليلي المباشر - الدوري الإنجليزي الممتاز ودوري أبطال أوروبا',
    next: 'ملخصات وأهداف البريميرليغ والبطولات الأوروبية - beIN Premium 1 HD',
    subtitle: 'Premier League & UEFA • 24/7 Studio',
  },
  'bein-sports-premium-2-ar': {
    now: 'الأستوديو التحليلي المباشر - تغطية الدوري الإنجليزي الممتاز',
    next: 'حصاد الجولة وأبرز لقطات البريميرليغ - beIN Premium 2 HD',
    subtitle: 'English Premier League • 24/7 Studio',
  },
  'bein-sports-premium-3-ar': {
    now: 'الأستوديو التحليلي المباشر - تغطية الدوري الإسباني (LaLiga)',
    next: 'ملخصات وأهداف الليغا الإسبانية - beIN Premium 3 HD',
    subtitle: 'Spanish LaLiga • 24/7 Studio',
  },
  'bein-sports-afc-ar': {
    now: 'الأستوديو التحليلي المباشر - دوري أبطال آسيا للنخبة (AFC Elite)',
    next: 'ملخصات وأهداف البطولات الآسيوية - beIN Sports AFC HD',
    subtitle: 'AFC Champions League Elite • 24/7 Studio',
  },
  'bein-sports-en-1': {
    now: 'beIN Sports 1 English: Premier League & UEFA Matchday Studio',
    next: 'beIN Sports 1 English: Tactical Review & Extended Highlights',
    subtitle: 'Premier League & UEFA • English HD',
  },
  'bein-sports-en-2': {
    now: 'beIN Sports 2 English: European Football Live Studio',
    next: 'beIN Sports 2 English: Ligue 1 & Premier League Highlights',
    subtitle: 'European Football • English HD',
  },
  'bein-sports-en-3': {
    now: 'beIN Sports 3 English: International Football & Highlights',
    next: 'beIN Sports 3 English: Matchday Classics & Analysis',
    subtitle: 'International Football • English HD',
  },
  'bein-sports-xtra-en': {
    now: 'beIN SPORTS XTRA: Live Studio & South American Football',
    next: 'beIN SPORTS XTRA: Copa Libertadores & International Highlights',
    subtitle: 'Football & Multi-Sport • English HD',
  },
  'bein-sports-xtra-es': {
    now: 'beIN SPORTS XTRA en Español: Estudio Fútbol & Copa Libertadores',
    next: 'beIN SPORTS XTRA en Español: Goles y Resumen Sudamericano',
    subtitle: 'Fútbol Internacional • Español HD',
  },
  'bein-sports-fr-1': {
    now: 'beIN Sports 1 France : Club beIN & Direct LaLiga / Ligue 1',
    next: 'beIN Sports 1 France : L’Expresso & Résumés Football',
    subtitle: 'LaLiga & Ligue 1 • France HD',
  },
  'bein-sports-fr-2': {
    now: 'beIN Sports 2 France : Salon VIP & Direct Football Européen',
    next: 'beIN Sports 2 France : Les Grands Matchs & Résumés',
    subtitle: 'Football Européen • France HD',
  },
  'bein-sports-fr-3': {
    now: 'beIN Sports 3 France : Direct Multisports & Tennis / Football',
    next: 'beIN Sports 3 France : Magazine & Résumés Multisports',
    subtitle: 'Multisports & Football • France HD',
  },
  'bein-sports-1-tr': {
    now: 'beIN Sports 1 Türkiye: Trendyol Süper Lig Stüdyosu & Maç Özetleri',
    next: 'beIN Sports 1 Türkiye: Süper Lig Özel & Taktik Analiz',
    subtitle: 'Trendyol Süper Lig • Türkiye HD',
  },
  'bein-sports-2-tr': {
    now: 'beIN Sports 2 Türkiye: Avrupa Futbolu & Süper Lig Özel',
    next: 'beIN Sports 2 Türkiye: Haftanın Golleri & Özetler',
    subtitle: 'Futbol & Süper Lig • Türkiye HD',
  },
  'bein-sports-3-tr': {
    now: 'beIN Sports 3 Türkiye: Uluslararası Futbol & Maç Klasikleri',
    next: 'beIN Sports 3 Türkiye: Spor Stüdyosu & Özetler',
    subtitle: 'Uluslararası Futbol • Türkiye HD',
  },
  'bein-sports-4-tr': {
    now: 'beIN Sports 4 Türkiye: Canlı Spor Yayını & Futbol Özetleri',
    next: 'beIN Sports 4 Türkiye: Avrupa Ligleri Özel',
    subtitle: 'Spor & Futbol • Türkiye HD',
  },
  'bein-sports-5-tr': {
    now: 'beIN Sports 5 Türkiye: Spor Magazin & Karşılaşma Özetleri',
    next: 'beIN Sports 5 Türkiye: Haftanın En İyileri',
    subtitle: 'Spor & Futbol • Türkiye HD',
  },
  'bein-sports-haber-tr': {
    now: 'beIN Sports Haber: Canlı Spor Bülteni & Son Dakika Gelişmeleri',
    next: 'beIN Sports Haber: Süper Lig Özetleri & Basın Toplantıları',
    subtitle: '24/7 Spor Haberleri • Türkiye HD',
  },
  'sky-sports-cricket': {
    now: 'Sky Sports Cricket Live Studio & Test/ODI Classics',
    next: 'The Cricket Debate & International Highlights',
    subtitle: 'Cricket • 24/7 Studio & Highlights',
  },
  'sky-sports-golf': {
    now: 'PGA Tour & DP World Tour Live Golf Studio',
    next: 'Sky Sports Golf: Inside the Ropes & Highlights',
    subtitle: 'Golf • PGA & DP World Tour',
  },
  'sky-sports-tennis': {
    now: 'ATP & WTA Tour Live Studio & Center Court Classics',
    next: 'Sky Sports Tennis: Grand Slam & Tour Highlights',
    subtitle: 'Tennis • ATP & WTA Tour',
  },
  'sky-sports-racing': {
    now: 'Live Thoroughbred Racing & Paddock Analysis',
    next: 'Sky Sports Racing: International Track Coverage',
    subtitle: 'Horse Racing • Live Paddock & Track',
  },
  'sky-sports-action': {
    now: 'Sky Sports Action: NFL, Rugby & Darts Special',
    next: 'Sky Sports Action Live Studio & Highlights',
    subtitle: 'Multi-Sport • Action & Arena',
  },
  'sky-sports-mix': {
    now: 'Sky Sports Mix: Live Multi-Sport Showcase',
    next: 'Sky Sports Mix: Featured European & World Sport',
    subtitle: 'Multi-Sport • Live Showcase',
  },
  'cbs-sports-golazo': {
    now: 'Morning Footy & Golazo Matchday Studio',
    next: 'Box 2 Box & UEFA / Serie A Tactical Highlights',
    subtitle: 'Football • 24/7 Golazo Network',
  },
  'nbc-sports-now': {
    now: 'Premier League Mornings & NBC Sports Live',
    next: 'NBC Sports: Pro Football Talk & Matchday Highlights',
    subtitle: 'US & Premier League Sports • Live Studio',
  },
  'mlb-network': {
    now: 'MLB Tonight & Diamond Classics',
    next: 'Quick Pitch & Inside the Clubhouse',
    subtitle: 'MLB Baseball • 24/7 Network',
  },
  'nhl-network': {
    now: 'NHL Tonight & On the Fly',
    next: 'NHL Network Ice Time & Game Day',
    subtitle: 'NHL Ice Hockey • 24/7 Network',
  },
  'tennis-channel': {
    now: 'Tennis Channel Live: ATP & WTA Center Court',
    next: 'Inside-In Tennis & Grand Slam Classics',
    subtitle: 'Tennis • 24/7 Tour Coverage',
  },
  'red-bull-tv': {
    now: 'Red Bull Motorsports, Rally & Drift Championship',
    next: 'Red Bull Rampage & Extreme Action Showcase',
    subtitle: 'Motorsports & Adventure • 24/7 HD',
  },
  'spacetoon-ar': {
    now: 'مغامرات وأفلام الأنمي المدبلجة - سبيستون (Spacetoon Anime & Kids)',
    next: 'كوكب أكشن ورياضة - سبيستون (Spacetoon Action & Sports)',
    subtitle: 'Anime & Kids • Spacetoon 24/7',
  },
  'bab-al-hara-ar': {
    now: 'مسلسل باب الحارة - عرض متواصل 24/7 (Bab Al Hara Classic Series)',
    next: 'حلقات مختارة من باب الحارة (Bab Al Hara Marathon)',
    subtitle: 'Arabic Classic Series • 24/7',
  },
};

function getFallbackStudioProgram(channelId: string, slot: 'now' | 'next'): any {
  const nowMs = Date.now();
  const hourStart = new Date(Math.floor(nowMs / 3600000) * 3600000 + (slot === 'next' ? 3600000 : 0)).toISOString();
  const hourEnd = new Date(Math.floor(nowMs / 3600000) * 3600000 + (slot === 'next' ? 7200000 : 3600000)).toISOString();
  const curated = CHANNEL_CURATED_STUDIO_PROGRAMS[channelId];
  if (curated) {
    return {
      id: `studio-${channelId}-${slot}`,
      channelId,
      title: slot === 'now' ? curated.now : curated.next,
      subtitle: curated.subtitle,
      category: curated.subtitle.split('•')[0].trim(),
      league: curated.subtitle.split('•')[0].trim(),
      type: 'studio',
      status: slot === 'now' ? 'LIVE' : 'UPCOMING',
      isLive: slot === 'now',
      startTime: hourStart,
      endTime: hourEnd,
    };
  }
  const meta = LIVE_CHANNEL_DIRECTORY[channelId];
  const cleanName = (meta?.name || channelId).replace(/\s*\([^)]*\)/g, '').trim();
  const isAr = meta?.language === 'ar' || channelId.endsWith('-ar');
  return {
    id: `studio-${channelId}-${slot}`,
    channelId,
    title: isAr
      ? slot === 'now'
        ? `الأستوديو التحليلي المباشر - ${cleanName}`
        : `البث المباشر والبرامج الرياضية - ${cleanName}`
      : slot === 'now'
        ? `${cleanName} Live Studio & Matchday Analysis`
        : `${cleanName} Featured Sports & Highlights`,
    subtitle: `${cleanName} • 24/7 Broadcast`,
    category: meta?.category || 'Sports Studio',
    league: cleanName,
    type: 'studio',
    status: slot === 'now' ? 'LIVE' : 'UPCOMING',
    isLive: slot === 'now',
    startTime: hourStart,
    endTime: hourEnd,
  };
}

// Verify whether an upstream EPG entry is a genuine non-match studio/entertainment program (rejects unverified match overlays and misleading generic filler templates)
function isCleanUpstreamStudioProgram(prog: any, channelId = ''): boolean {
  if (!prog || typeof prog !== 'object') return false;
  if (prog.eventId || prog.matchInfo || prog.type === 'live_match' || prog.type === 'upcoming_match') return false;
  const t = String(prog.title || '').toLowerCase();
  if (!t || t.includes('home vs away') || t.startsWith('live:') || t.startsWith('مباشر:') || /\bvs\b/.test(t)) return false;
  // Reject misleading generic upstream filler strings that claim a "European Summit Match" is playing or use generic boilerplate
  if (
    t.includes('مباراة القمة الأوروبية') ||
    t.includes('مجلة دوري أبطال أوروبا') ||
    t.includes('prime time live broadcast') ||
    t.includes('featured event & studio special') ||
    (channelId.includes('bein') && t.includes('ht spor'))
  ) {
    return false;
  }
  if (channelId && CHANNEL_CURATED_STUDIO_PROGRAMS[channelId]) {
    return false;
  }
  return true;
}

// Helper to build per-channel EPG (nowPlaying, nextUp, upcoming, currentProgram, nextProgram) combining de-conflicted live events + scraper 24/7 EPG
function buildChannelEpgDirectory(events: any[]): Record<
  string,
  {
    nowPlaying: any | null;
    nextUp: any | null;
    upcoming: any[];
    currentProgram: any | null;
    nextProgram: any | null;
  }
> {
  const epgMap: Record<
    string,
    {
      nowPlaying: any | null;
      nextUp: any | null;
      upcoming: any[];
      currentProgram: any | null;
      nextProgram: any | null;
    }
  > = {};
  const nowMs = Date.now();

  // 1. Seed all known & upstream channels with clean 24/7 studio/entertainment EPG programs
  const allChannelIds = new Set<string>([
    ...Object.keys(LIVE_CHANNEL_DIRECTORY),
    ...Array.from(cachedUpstreamEpgMap.keys()),
  ]);

  for (const chId of allChannelIds) {
    const upEpg = cachedUpstreamEpgMap.get(chId);
    const rawNow = upEpg?.nowPlaying || null;
    const rawNext = upEpg?.nextUp || null;
    const rawUpcoming = Array.isArray(upEpg?.upcoming) ? upEpg.upcoming : [];

    const nonMatchNow = isCleanUpstreamStudioProgram(rawNow, chId)
      ? rawNow
      : getFallbackStudioProgram(chId, 'now');
    const nonMatchUpcoming = rawUpcoming.filter((u: any) => isCleanUpstreamStudioProgram(u, chId));
    const nonMatchNext = isCleanUpstreamStudioProgram(rawNext, chId)
      ? rawNext
      : nonMatchUpcoming[0] || getFallbackStudioProgram(chId, 'next');

    epgMap[chId] = {
      nowPlaying: nonMatchNow,
      nextUp: nonMatchNext,
      upcoming: nonMatchUpcoming,
      currentProgram: nonMatchNow,
      nextProgram: nonMatchNext,
    };
  }

  // 2. Overlay de-conflicted LIVE & UPCOMING match broadcasts so every channel's EPG matches the event cards 1-to-1
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.recommendedChannels)) continue;
    const statusUpper = String(ev.status || '').toUpperCase();
    const isLive =
      statusUpper === 'LIVE' ||
      statusUpper === 'IN' ||
      statusUpper === 'IN_PROGRESS' ||
      statusUpper === 'HT' ||
      statusUpper === '1H' ||
      statusUpper === '2H';
    const isFinished =
      statusUpper === 'FINISHED' || statusUpper === 'POST' || statusUpper === 'FINAL' || statusUpper === 'FT';
    if (isFinished) continue;

    const startMs = Date.parse(ev.startTime || '');
    const minsUntil = !Number.isNaN(startMs) ? Math.round((startMs - nowMs) / 60000) : 999;
    const matchTitle =
      ev.homeTeam?.name && ev.awayTeam?.name
        ? `${ev.homeTeam.name} vs ${ev.awayTeam.name}`
        : ev.title || 'Live Match';

    for (const rc of ev.recommendedChannels) {
      const chId = rc?.channelId;
      if (!chId) continue;
      if (!epgMap[chId]) {
        epgMap[chId] = {
          nowPlaying: getFallbackStudioProgram(chId, 'now'),
          nextUp: getFallbackStudioProgram(chId, 'next'),
          upcoming: [],
          currentProgram: null,
          nextProgram: null,
        };
      }

      // Strictly place a match into nowPlaying ONLY when it is actively LIVE
      const isNowOnThisChannel = isLive;
      const progEntry = {
        id: `epg-ev-${ev.id}`,
        eventId: String(ev.id),
        type: isNowOnThisChannel ? 'live_match' : 'upcoming_match',
        title:
          isNowOnThisChannel && ev.homeTeam?.score !== undefined && ev.awayTeam?.score !== undefined && isLive
            ? `${ev.homeTeam.name} ${ev.homeTeam.score} - ${ev.awayTeam.score} ${ev.awayTeam.name}`
            : matchTitle,
        subtitle: `${ev.league || 'Live Sports'} • ${ev.statusDetail || (isNowOnThisChannel ? 'LIVE' : 'Scheduled')}`,
        league: ev.league || 'Live Sports',
        sport: ev.sport || 'soccer',
        startTime: ev.startTime,
        endTime: ev.endTime || (!Number.isNaN(startMs) ? new Date(startMs + 2 * 3600 * 1000).toISOString() : undefined),
        isLive: isNowOnThisChannel,
        status: isNowOnThisChannel ? 'LIVE' : 'UPCOMING',
        statusDetail: ev.statusDetail,
        matchInfo: {
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
          statusDetail: ev.statusDetail,
        },
      };

      if (isNowOnThisChannel) {
        if (!epgMap[chId].nowPlaying || !epgMap[chId].nowPlaying.eventId) {
          epgMap[chId].nowPlaying = { ...progEntry, channelId: chId };
          epgMap[chId].currentProgram = epgMap[chId].nowPlaying;
        }
      } else if (minsUntil > -15) {
        const upItem = { ...progEntry, channelId: chId };
        if (!epgMap[chId].upcoming.some((u: any) => u?.eventId === progEntry.eventId)) {
          epgMap[chId].upcoming.push(upItem);
          // Sort upcoming matches chronologically so nextUp is always the earliest upcoming match
          epgMap[chId].upcoming.sort(
            (a: any, b: any) => (Date.parse(a?.startTime || '') || 0) - (Date.parse(b?.startTime || '') || 0)
          );
        }
        const earliestMatch = epgMap[chId].upcoming.find((u: any) => Boolean(u?.eventId));
        if (earliestMatch) {
          epgMap[chId].nextUp = earliestMatch;
          epgMap[chId].nextProgram = earliestMatch;
        }
      }
    }
  }

  // 3. Sync shared-stream alias channels (e.g. bein-sports-premium-1..3-ar share exact streams with bein-sports-1..3-ar)
  const sharedStreamAliasPairs: Array<[string, string]> = [
    ['bein-sports-1-ar', 'bein-sports-premium-1-ar'],
    ['bein-sports-2-ar', 'bein-sports-premium-2-ar'],
    ['bein-sports-3-ar', 'bein-sports-premium-3-ar'],
  ];
  for (const [primaryId, aliasId] of sharedStreamAliasPairs) {
    if (epgMap[primaryId]) {
      epgMap[aliasId] = {
        nowPlaying: epgMap[primaryId].nowPlaying
          ? { ...epgMap[primaryId].nowPlaying, channelId: aliasId }
          : null,
        nextUp: epgMap[primaryId].nextUp
          ? { ...epgMap[primaryId].nextUp, channelId: aliasId }
          : null,
        upcoming: (epgMap[primaryId].upcoming || []).map((u: any) => ({ ...u, channelId: aliasId })),
        currentProgram: epgMap[primaryId].currentProgram
          ? { ...epgMap[primaryId].currentProgram, channelId: aliasId }
          : null,
        nextProgram: epgMap[primaryId].nextProgram
          ? { ...epgMap[primaryId].nextProgram, channelId: aliasId }
          : null,
      };
    }
  }

  return epgMap;
}

// 1. GET ALL LIVE SPORTS EVENTS & MATCH SCHEDULE (REAL-TIME TODAY & LIVE AGGREGATION + COMPETITION-FIRST CHANNEL ROUTING)
app.get(['/api/live/events', '/v1/live/events'], async (req: Request, res: Response) => {
  try {
    const sportFilterParam = req.query.sport ? String(req.query.sport).toLowerCase() : 'all';
    const statusFilterParam = req.query.status ? String(req.query.status).toLowerCase() : 'all';

    const fullPayload = await getOrRefreshLiveEventsPayload(12000);
    let filtered = Array.isArray(fullPayload.events) ? fullPayload.events : [];
    if (sportFilterParam !== 'all') {
      filtered = filtered.filter((e) => String(e.sport || '').toLowerCase().includes(sportFilterParam));
    }
    if (statusFilterParam !== 'all') {
      filtered = filtered.filter((e) => String(e.status || '').toLowerCase() === statusFilterParam);
    }

    return res.json({
      ...fullPayload,
      count: filtered.length,
      events: filtered,
    });
  } catch (err: any) {
    if (cachedLiveEventsPayload) return res.json(cachedLiveEventsPayload.data);
    return res.json({ status: 'error', count: 0, events: [] });
  }
});

// 1.2 GET XMLTV EPG FEED FOR IPTV PLAYERS (/api/live/epg.xml & /v1/live/epg.xml)
app.get(['/api/live/epg.xml', '/v1/live/epg.xml'], async (req: Request, res: Response) => {
  try {
    const targetUrl = `${getCineproUrl()}/v1/live/epg.xml`;
    const upstream = await fetch(targetUrl);
    if (!upstream.ok) {
      return res.status(upstream.status).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
    }
    let xml = await upstream.text();
    const hostOrigin = `${req.protocol}://${req.get('host')}`;
    xml = xml.replace(/https?:\/\/62\.171\.179\.144:3001/gi, hostOrigin);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(xml);
  } catch {
    return res.status(502).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
  }
});

// 1.25 GET LIVE CHANNEL EPG GUIDE (FULL EPG ARRAY + FILTERING BY ?lang=, ?category=, ?channelId=, ?q=)
app.get(['/api/live/epg', '/v1/live/epg'], async (req: Request, res: Response) => {
  try {
    const eventsPayload = await getOrRefreshLiveEventsPayload(15000);
    const channelEpgMap = buildChannelEpgDirectory(eventsPayload.events || []);

    const params = new URLSearchParams();
    if (req.query.lang) params.set('lang', String(req.query.lang));
    if (req.query.category) params.set('category', String(req.query.category));
    if (req.query.channelId) params.set('channelId', String(req.query.channelId));
    if (req.query.q) params.set('q', String(req.query.q));
    const qs = params.toString() ? `?${params.toString()}` : '';

    const upstreamRes = await fetch(`${getCineproUrl()}/v1/live/epg${qs}`, {
      headers: { Accept: 'application/json' },
    }).catch(() => null);

    let epgArray: any[] = [];
    if (upstreamRes && upstreamRes.ok) {
      const rawEpgData: any = await upstreamRes.json();
      if (Array.isArray(rawEpgData?.epg)) {
        epgArray = rawEpgData.epg.map((entry: any) => {
          const chId = String(entry?.channelId || '').trim();
          const synced = channelEpgMap[chId];
          const dirMeta = LIVE_CHANNEL_DIRECTORY[chId];
          const resolvedName = dirMeta?.name || entry?.channelName || chId;
          const fallbackNow = isCleanUpstreamStudioProgram(entry?.nowPlaying) ? entry.nowPlaying : null;
          const fallbackNext = isCleanUpstreamStudioProgram(entry?.nextUp) ? entry.nextUp : null;
          const fallbackUpcoming = Array.isArray(entry?.upcoming)
            ? entry.upcoming.filter((u: any) => isCleanUpstreamStudioProgram(u))
            : [];
          return {
            ...entry,
            channelName: resolvedName,
            logo: resolveChannelLogo(chId, entry?.logo, resolvedName),
            streamEndpoint: `/api/live/stream/${encodeURIComponent(chId)}`,
            nowPlaying: synced?.nowPlaying || fallbackNow,
            nextUp: synced?.nextUp || fallbackNext,
            upcoming: synced?.upcoming?.length ? synced.upcoming : fallbackUpcoming,
          };
        });
      }
    }

    return res.json({
      status: 'ok',
      updatedAt: eventsPayload.updatedAt || new Date().toISOString(),
      count: epgArray.length || Object.keys(channelEpgMap).length,
      epg: epgArray,
      channelsEpg: channelEpgMap,
    });
  } catch {
    return res.json({ status: 'ok', updatedAt: new Date().toISOString(), count: 0, epg: [], channelsEpg: {} });
  }
});

// 1.3 GET DETAILED 24-HOUR EPG FOR A SPECIFIC CHANNEL (/api/live/epg/:channelId & /v1/live/epg/:channelId)
app.get(['/api/live/epg/:channelId', '/v1/live/epg/:channelId'], async (req: Request, res: Response) => {
  const channelId = String(req.params.channelId || '').trim();
  if (!channelId) {
    return res.status(400).json({ status: 'error', message: 'Missing channelId' });
  }
  try {
    const [eventsPayload, upstreamRes] = await Promise.all([
      getOrRefreshLiveEventsPayload(15000),
      fetch(`${getCineproUrl()}/v1/live/epg/${encodeURIComponent(channelId)}`, {
        headers: { Accept: 'application/json' },
      }).catch(() => null),
    ]);
    const channelEpgMap = buildChannelEpgDirectory(eventsPayload.events || []);
    const synced = channelEpgMap[channelId];
    const dirMeta = LIVE_CHANNEL_DIRECTORY[channelId];

    if (upstreamRes && upstreamRes.ok) {
      const raw: any = await upstreamRes.json();
      const resolvedName = dirMeta?.name || raw?.channelName || channelId;
      const fallbackNow = isCleanUpstreamStudioProgram(raw?.nowPlaying) ? raw.nowPlaying : null;
      const fallbackNext = isCleanUpstreamStudioProgram(raw?.nextUp) ? raw.nextUp : null;
      const fallbackUpcoming = Array.isArray(raw?.upcoming)
        ? raw.upcoming.filter((u: any) => isCleanUpstreamStudioProgram(u))
        : [];
      return res.json({
        ...raw,
        status: 'ok',
        channelId,
        channelName: resolvedName,
        logo: resolveChannelLogo(channelId, raw?.logo, resolvedName),
        streamEndpoint: `/api/live/stream/${encodeURIComponent(channelId)}`,
        nowPlaying: synced?.nowPlaying || fallbackNow,
        nextUp: synced?.nextUp || fallbackNext,
        upcoming: synced?.upcoming?.length ? synced.upcoming : fallbackUpcoming,
      });
    }

    return res.json({
      status: 'ok',
      channelId,
      channelName: dirMeta?.name || channelId,
      logo: resolveChannelLogo(channelId, dirMeta?.logo, dirMeta?.name),
      streamEndpoint: `/api/live/stream/${encodeURIComponent(channelId)}`,
      updatedAt: new Date().toISOString(),
      nowPlaying: synced?.nowPlaying || null,
      nextUp: synced?.nextUp || null,
      upcoming: synced?.upcoming || [],
      schedule: [],
    });
  } catch {
    return res.status(502).json({ status: 'error', channelId });
  }
});

// 1.5 GET LIVE ARENA VIEWERS COUNT (Purely the number of active Live Arena viewers, no content tracking)
app.get(['/api/live/viewers', '/v1/live/viewers', '/api/live-arena/viewers'], (req: Request, res: Response) => {
  try {
    const now = Date.now();
    let liveArenaViewers = 0;
    activeLiveViewers.forEach((data) => {
      if (now - data.lastPing <= 75000 && data.mediaType === 'live') {
        liveArenaViewers++;
      }
    });
    return res.json({ success: true, liveArenaViewers, liveViewers: liveArenaViewers });
  } catch {
    return res.json({ success: true, liveArenaViewers: 0, liveViewers: 0 });
  }
});

// 2. GET ALL LIVE IPTV SPORTS CHANNELS (STRICTLY FROM CINEPRO API + LIVE EPG ENRICHMENT)
app.get(['/api/live/channels', '/v1/live/channels'], async (req: Request, res: Response) => {
  try {
    const params = new URLSearchParams();
    if (req.query.lang && String(req.query.lang) !== 'all') {
      params.set('lang', String(req.query.lang));
    }
    if (req.query.category && String(req.query.category) !== 'all') {
      params.set('category', String(req.query.category));
    }
    if (req.query.q && String(req.query.q).trim()) {
      params.set('q', String(req.query.q).trim());
    }
    const qs = params.toString() ? `?${params.toString()}` : '';
    const isUnfiltered = !qs;

    const eventsPayload = await getOrRefreshLiveEventsPayload(20000);
    const channelEpgMap = buildChannelEpgDirectory(eventsPayload?.events || []);

    if (
      isUnfiltered &&
      cachedLiveChannelsPayload &&
      Date.now() - cachedLiveChannelsPayload.timestamp < 30000
    ) {
      const enrichedCached = (cachedLiveChannelsPayload.data.channels || []).map((ch: any) => {
        const synced = channelEpgMap[ch.id];
        return {
          ...ch,
          epg: synced
            ? {
                ...(ch.epg || {}),
                ...synced,
              }
            : ch.epg || { nowPlaying: null, nextUp: null, upcoming: [], currentProgram: null, nextProgram: null },
        };
      });
      return res.json({
        ...cachedLiveChannelsPayload.data,
        channels: enrichedCached,
      });
    }

    const targetUrl = `${getCineproUrl()}/v1/live/channels${qs}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      if (cachedLiveChannelsPayload) return res.json(cachedLiveChannelsPayload.data);
      return res.status(upstream.status).json({ status: 'error', count: 0, channels: [] });
    }

    const rawData: any = await upstream.json();
    const rawChannels = Array.isArray(rawData?.channels) ? rawData.channels : [];

    const normalizedChannels = rawChannels.map((ch: any) => {
      const chId = String(ch?.id || '').trim();
      const dirMeta = LIVE_CHANNEL_DIRECTORY[chId];
      const cleanLang = toCleanEnglishLanguage(ch?.language, ch?.languageLabel);
      const validStreams: any[] = [];

      if (Array.isArray(ch?.streams)) {
        ch.streams.forEach((st: any, idx: number) => {
          const rawStreamUrl = String(st?.url || '').trim();
          const underlyingUrl = extractRawUrlFromProxyLink(rawStreamUrl);
          if (!underlyingUrl) return;
          if (isMismatchedSecondaryMirror(chId, underlyingUrl, st?.label)) return;

          const proxiedUrl = rawStreamUrl.includes('/v1/live/proxy/')
            ? rewriteCineproLiveProxyUrl(rawStreamUrl)
            : buildLocalLiveProxyUrl(underlyingUrl, st?.headers || undefined, true);

          validStreams.push({
            ...st,
            id: `${chId}-s${idx + 1}`,
            languageLabel: cleanLang,
            url: proxiedUrl,
            rawUrl: underlyingUrl,
          });
        });
      }

      // Inject automatic high-availability sibling failover streams for channels whose primary edge stream is offline
      const DEMBED_HEADERS = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Origin: 'https://dembed.st',
        Referer: 'https://dembed.st/',
      };
      const CHANNEL_FAILOVER_RAW_URLS: Record<string, { url: string; label: string; headers?: Record<string, string> }[]> = {
        'bein-sports-8-ar': [
          {
            url: 'https://edge.cowedd4855ws.sbs/premium97/index.m3u8',
            label: 'beIN Sports HD Failover 1 (AR)',
            headers: DEMBED_HEADERS,
          },
          {
            url: 'https://edge.cowedd4855ws.sbs/premium99/index.m3u8',
            label: 'beIN Sports HD Failover 2 (AR)',
            headers: DEMBED_HEADERS,
          },
        ],
      };

      const failovers = CHANNEL_FAILOVER_RAW_URLS[chId];
      if (failovers && failovers.length > 0) {
        const failoverStreams = failovers.map((fo, idx) => ({
          id: `${chId}-fo${idx + 1}`,
          label: fo.label,
          quality: ch?.quality || '1080p',
          language: ch?.language || 'ar',
          languageLabel: cleanLang,
          url: buildLocalLiveProxyUrl(fo.url, fo.headers, true),
          rawUrl: fo.url,
          headers: fo.headers,
        }));
        validStreams.unshift(...failoverStreams);
      }

      const cleanDefaultProxyUrl =
        validStreams[0]?.url ||
        (ch?.defaultProxyUrl ? rewriteCineproLiveProxyUrl(String(ch.defaultProxyUrl)) : '');

      const resolvedName =
        chId === 'canal-plus-foot-fr' && dirMeta?.name
          ? dirMeta.name
          : dirMeta?.name || ch?.name || chId;

      const syncedEpg = channelEpgMap[chId];
      const upstreamChEpg = ch?.epg || {};
      const mergedNowPlaying =
        syncedEpg?.nowPlaying ||
        (isCleanUpstreamStudioProgram(upstreamChEpg?.nowPlaying) ? upstreamChEpg.nowPlaying : null) ||
        null;
      const mergedNextUp =
        syncedEpg?.nextUp ||
        (isCleanUpstreamStudioProgram(upstreamChEpg?.nextUp) ? upstreamChEpg.nextUp : null) ||
        null;
      const mergedUpcoming = syncedEpg?.upcoming?.length
        ? syncedEpg.upcoming
        : (upstreamChEpg?.upcoming || []).filter((u: any) => isCleanUpstreamStudioProgram(u));

      return {
        ...ch,
        name: resolvedName,
        logo: resolveChannelLogo(chId, ch?.logo, resolvedName),
        languageLabel: cleanLang,
        defaultProxyUrl: cleanDefaultProxyUrl,
        streams: validStreams,
        epg: {
          ...upstreamChEpg,
          nowPlaying: mergedNowPlaying,
          nextUp: mergedNextUp,
          upcoming: mergedUpcoming,
          currentProgram: mergedNowPlaying,
          nextProgram: mergedNextUp,
        },
      };
    });

    const payload = {
      status: 'ok',
      count: normalizedChannels.length,
      categories: rawData?.categories || [
        'bein',
        'mena',
        'movies',
        'entertainment',
        'sky',
        'europe',
        'usa',
        'espn',
        'fox',
        'motorsport',
        'combat',
      ],
      languages: rawData?.languages || ['ar', 'en', 'fr', 'es', 'tr', 'de', 'pt'],
      channels: normalizedChannels,
    };

    if (isUnfiltered && normalizedChannels.length > 0) {
      cachedLiveChannelsPayload = { data: payload, timestamp: Date.now() };
    }

    return res.json(payload);
  } catch (err: any) {
    console.warn('[Live Channels Proxy] Error:', err?.message || err);
    if (cachedLiveChannelsPayload) return res.json(cachedLiveChannelsPayload.data);
    return res.json({ status: 'error', count: 0, channels: [] });
  }
});

// 2B. GET STREAM MIRRORS FOR A SPECIFIC LIVE EVENT (RESOLVES EVENT RECOMMENDED CHANNELS IN PRIORITY ORDER)
app.get(['/api/live/stream/event/:eventId', '/v1/live/stream/event/:eventId'], async (req: Request, res: Response) => {
  const eventId = String(req.params.eventId || '').trim();
  const preferredChannelId = req.query.channelId ? String(req.query.channelId).trim() : '';

  const eventsList = Array.isArray(cachedLiveEventsPayload?.data?.events)
    ? cachedLiveEventsPayload!.data.events
    : [];
  const matchedEvent = eventsList.find((e: any) => String(e?.id) === eventId);

  const recChannels: Array<{ channelId: string; name?: string; language?: string; languageLabel?: string; logo?: string }> =
    Array.isArray(matchedEvent?.recommendedChannels) && matchedEvent.recommendedChannels.length > 0
      ? matchedEvent.recommendedChannels
      : [{ channelId: preferredChannelId || 'bein-sports-1-ar' }];

  const orderedChannelIds = [
    ...(preferredChannelId ? [preferredChannelId] : []),
    ...recChannels.map((r) => r.channelId).filter((id) => id && id !== preferredChannelId),
  ];

  const primaryChannelId = orderedChannelIds[0] || 'bein-sports-1-ar';
  const cachedChannelsList = Array.isArray(cachedLiveChannelsPayload?.data?.channels)
    ? cachedLiveChannelsPayload!.data.channels
    : [];

  const aggregatedSources: any[] = [];
  for (const chId of orderedChannelIds) {
    const chObj = cachedChannelsList.find((c: any) => c?.id === chId);
    const meta = LIVE_CHANNEL_DIRECTORY[chId];
    const chName = meta?.name || chObj?.name || chId;
    const chLang = toCleanEnglishLanguage(chObj?.language || meta?.language || 'en', chObj?.languageLabel || meta?.languageLabel);
    if (Array.isArray(chObj?.streams)) {
      chObj.streams.forEach((st: any, idx: number) => {
        if (!st?.url) return;
        const underlying = st?.rawUrl || extractRawUrlFromProxyLink(String(st.url));
        if (isMismatchedSecondaryMirror(chId, underlying, st?.label)) return;
        if (aggregatedSources.some((existing) => existing.url === st.url)) return;
        aggregatedSources.push({
          id: `${chId}-evsrc-${idx + 1}`,
          channelId: chId,
          server: `${chName.replace(/\s*\([^)]*\)/g, '').trim()} (${chLang})`,
          url: st.url,
          rawUrl: st.rawUrl,
          quality: st.quality || chObj?.quality || '1080p',
          type: 'hls',
          language: chLang,
          languageLabel: chLang,
          verified: chId === primaryChannelId && idx === 0,
        });
      });
    }
  }

  // If cache didn't have streams yet, fetch the primary channel's stream directly
  if (aggregatedSources.length === 0) {
    try {
      const targetUrl = `${getCineproUrl()}/v1/live/stream/${encodeURIComponent(primaryChannelId)}`;
      const upstream = await fetch(targetUrl, { headers: { Accept: 'application/json' } });
      if (upstream.ok) {
        const rawData: any = await upstream.json();
        const rawSources = Array.isArray(rawData?.sources) ? rawData.sources : [];
        rawSources.forEach((s: any, idx: number) => {
          const underlying = String(s?.rawUrl || extractRawUrlFromProxyLink(String(s?.url || ''))).trim();
          if (isMismatchedSecondaryMirror(primaryChannelId, underlying, s?.server || s?.label)) return;
          const proxiedUrl = s?.url ? rewriteCineproLiveProxyUrl(String(s.url)) : '';
          if (proxiedUrl) {
            aggregatedSources.push({
              ...s,
              id: `${primaryChannelId}-evsrc-${idx + 1}`,
              channelId: primaryChannelId,
              url: proxiedUrl,
            });
          }
        });
      }
    } catch {}
  }

  const primaryMeta = LIVE_CHANNEL_DIRECTORY[primaryChannelId];
  return res.json({
    status: 'ok',
    eventId,
    event: matchedEvent || null,
    channel: {
      id: primaryChannelId,
      name: primaryMeta?.name || primaryChannelId,
      logo: resolveChannelLogo(primaryChannelId, primaryMeta?.logo, primaryMeta?.name),
      language: primaryMeta?.language || 'en',
      languageLabel: primaryMeta?.languageLabel || 'English',
    },
    count: aggregatedSources.length,
    sources: aggregatedSources,
  });
});

// 3. GET STREAM MIRRORS FOR A SPECIFIC CHANNEL (STRICTLY FROM CINEPRO API + CACHED CHANNEL STREAM FALLBACK + EPG)
app.get(['/api/live/stream/:channelId', '/v1/live/stream/:channelId'], async (req: Request, res: Response) => {
  const channelId = String(req.params.channelId || '').trim();
  if (!channelId) {
    return res.status(400).json({ status: 'error', message: 'Missing channelId' });
  }

  let rawData: any = null;
  try {
    const targetUrl = `${getCineproUrl()}/v1/live/stream/${encodeURIComponent(channelId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const upstream = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });
      if (upstream.ok) {
        rawData = await upstream.json();
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: any) {
    console.warn(`[Live Stream Channel Proxy] Upstream probe warning for ${channelId}:`, err?.message || err);
  }

  const cachedChannelsList = Array.isArray(cachedLiveChannelsPayload?.data?.channels)
    ? cachedLiveChannelsPayload!.data.channels
    : [];
  const cachedChannelObj = cachedChannelsList.find((c: any) => c?.id === channelId);
  const directoryMeta = LIVE_CHANNEL_DIRECTORY[channelId];

  const rawSources = Array.isArray(rawData?.sources) ? rawData.sources : [];
  const inferredLangCode =
    directoryMeta?.language ||
    (channelId.endsWith('-ar')
      ? 'ar'
      : channelId.endsWith('-fr')
        ? 'fr'
        : channelId.endsWith('-es')
          ? 'es'
          : channelId.endsWith('-tr')
            ? 'tr'
            : 'en');
  const cleanChannelLang = toCleanEnglishLanguage(
    rawData?.channel?.languageCode || rawData?.channel?.language || cachedChannelObj?.language || inferredLangCode,
    rawData?.channel?.languageLabel || rawData?.channel?.language || cachedChannelObj?.languageLabel || directoryMeta?.languageLabel
  );
  const channelName =
    (channelId === 'canal-plus-foot-fr' && directoryMeta?.name) ||
    directoryMeta?.name ||
    rawData?.channel?.name ||
    cachedChannelObj?.name ||
    channelId.replace(/-/g, ' ').toUpperCase();

  const cineproSources: any[] = [];

  // Prepend verified high-availability sibling failover streams for channels whose primary upstream node is down
  const DEMBED_STREAM_HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Origin: 'https://dembed.st',
    Referer: 'https://dembed.st/',
  };
  const STREAM_FAILOVER_MAP: Record<string, { url: string; server: string; headers?: Record<string, string> }[]> = {
    'bein-sports-8-ar': [
      {
        url: 'https://edge.cowedd4855ws.sbs/premium97/index.m3u8',
        server: 'beIN Sports 8 HD Primary Failover (AR)',
        headers: DEMBED_STREAM_HEADERS,
      },
      {
        url: 'https://edge.cowedd4855ws.sbs/premium99/index.m3u8',
        server: 'beIN Sports 8 HD Backup Mirror (AR)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
  };

  const failoverList = STREAM_FAILOVER_MAP[channelId];
  if (failoverList && failoverList.length > 0) {
    failoverList.forEach((fo, idx) => {
      cineproSources.push({
        id: `${channelId}-failover-${idx + 1}`,
        server: fo.server,
        url: buildLocalLiveProxyUrl(fo.url, fo.headers, true),
        rawUrl: fo.url,
        quality: '1080p',
        type: 'hls',
        language: cleanChannelLang,
        languageLabel: cleanChannelLang,
        verified: true,
      });
    });
  }

  // Resolve authoritative de-conflicted EPG for this channel so the player bar EPG and server labels always match what is actually airing
  const eventsListForEpg = Array.isArray(cachedLiveEventsPayload?.data?.events)
    ? cachedLiveEventsPayload!.data.events
    : (await getOrRefreshLiveEventsPayload(15000).catch(() => ({ events: [] }))).events || [];
  const syncedChannelEpgMap = buildChannelEpgDirectory(eventsListForEpg);
  const syncedEpgForChannel = syncedChannelEpgMap[channelId];
  const upstreamRawEpg = rawData?.epg || rawData?.channel?.epg || cachedChannelObj?.epg || {};
  const authoritativeNowPlaying =
    syncedEpgForChannel?.nowPlaying ||
    (isCleanUpstreamStudioProgram(upstreamRawEpg?.nowPlaying) ? upstreamRawEpg.nowPlaying : null) ||
    null;
  const authoritativeNextUp =
    syncedEpgForChannel?.nextUp ||
    (isCleanUpstreamStudioProgram(upstreamRawEpg?.nextUp) ? upstreamRawEpg.nextUp : null) ||
    null;
  const authoritativeUpcoming =
    syncedEpgForChannel?.upcoming?.length
      ? syncedEpgForChannel.upcoming
      : (upstreamRawEpg?.upcoming || []).filter((u: any) => isCleanUpstreamStudioProgram(u));

  const channelEpg = {
    ...upstreamRawEpg,
    nowPlaying: authoritativeNowPlaying,
    nextUp: authoritativeNextUp,
    upcoming: authoritativeUpcoming,
    currentProgram: authoritativeNowPlaying,
    nextProgram: authoritativeNextUp,
  };

  rawSources.forEach((s: any, idx: number) => {
    const rawUrl = String(s?.rawUrl || extractRawUrlFromProxyLink(String(s?.url || ''))).trim();
    if (!rawUrl && !s?.url) return;
    if (isMismatchedSecondaryMirror(channelId, rawUrl, s?.server || s?.label)) return;

    const proxiedUrl = s?.url
      ? rewriteCineproLiveProxyUrl(String(s.url))
      : buildLocalLiveProxyUrl(rawUrl, undefined, true);

    // Strip any stale/inverted "• LIVE: ..." suffix attached by the upstream scraper and replace with our synced EPG title
    const baseServerLabel = String(s?.server || s?.label || `${channelName} Mirror ${idx + 1}`)
      .replace(/\s*•\s*LIVE:.*$/i, '')
      .trim();
    const syncedServerLabel =
      authoritativeNowPlaying?.isLive && authoritativeNowPlaying?.title
        ? `${baseServerLabel} • LIVE: ${authoritativeNowPlaying.title}`
        : baseServerLabel;

    cineproSources.push({
      ...s,
      id: s?.id || `${channelId}-src-${idx + 1}`,
      server: syncedServerLabel,
      url: proxiedUrl,
      rawUrl,
      language: cleanChannelLang,
      languageLabel: cleanChannelLang,
      verified: failoverList ? false : Boolean(s?.verified),
    });
  });

  // Also include any streams defined on rawData.channel.streams or cachedChannelObj.streams if not already in sources
  const extraChannelStreams = [
    ...(Array.isArray(rawData?.channel?.streams) ? rawData.channel.streams : []),
    ...(Array.isArray(cachedChannelObj?.streams) ? cachedChannelObj.streams : []),
  ];
  extraChannelStreams.forEach((st: any, idx: number) => {
    const rawStreamUrl = String(st?.url || '').trim();
    const underlyingUrl = st?.rawUrl || extractRawUrlFromProxyLink(rawStreamUrl);
    if (!underlyingUrl) return;
    if (isMismatchedSecondaryMirror(channelId, underlyingUrl, st?.label)) return;
    if (cineproSources.some((cs) => cs.rawUrl === underlyingUrl || cs.url === rawStreamUrl)) return;

    const proxiedUrl =
      rawStreamUrl.startsWith('/api/live/proxy/') || rawStreamUrl.includes('/v1/live/proxy/')
        ? rewriteCineproLiveProxyUrl(rawStreamUrl)
        : buildLocalLiveProxyUrl(underlyingUrl, st?.headers || undefined, true);

    const baseLabel = String(st?.label || `${channelName} Mirror ${idx + 1}`)
      .replace(/\s*•\s*LIVE:.*$/i, '')
      .trim();

    cineproSources.push({
      id: `${channelId}-chstream-${idx + 1}`,
      server: baseLabel,
      url: proxiedUrl,
      rawUrl: underlyingUrl,
      quality: st?.quality || rawData?.channel?.quality || cachedChannelObj?.quality || '1080p',
      type: 'hls',
      language: cleanChannelLang,
      languageLabel: cleanChannelLang,
      verified: cineproSources.length === 0,
    });
  });

  // Keep verified sources first while preserving all mirrors in order
  cineproSources.sort((a, b) => Number(Boolean(b.verified)) - Number(Boolean(a.verified)));

  return res.json({
    status: rawData?.status || 'ok',
    channel: rawData?.channel
      ? {
          ...rawData.channel,
          name: channelName,
          logo: resolveChannelLogo(channelId, rawData.channel.logo, channelName),
          language: cleanChannelLang,
          languageLabel: cleanChannelLang,
          epg: channelEpg,
        }
      : {
          id: channelId,
          name: channelName,
          logo: resolveChannelLogo(channelId, cachedChannelObj?.logo, channelName),
          language: cleanChannelLang,
          languageLabel: cleanChannelLang,
          epg: channelEpg,
        },
    epg: channelEpg,
    count: cineproSources.length,
    sources: cineproSources,
  });
});

// 4. REAL-TIME PROGRESSIVE SSE STREAM FOR A CHANNEL
app.get(['/api/live/stream/:channelId/sse', '/v1/live/stream/:channelId/sse'], async (req: Request, res: Response) => {
  const channelId = String(req.params.channelId || '').trim();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const targetUrl = `${getCineproUrl()}/v1/live/stream/${encodeURIComponent(channelId)}/sse`;
    const upstream = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });

    if (!upstream.ok || !upstream.body) {
      res.write(`event: done\ndata: {"count":0}\n\n`);
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = decoder.decode(value, { stream: true });
      chunk = chunk.replace(/https?:\/\/[^/\s"']+\/v1\/live\/proxy\//gi, '/api/live/proxy/');
      res.write(chunk);
    }
    return res.end();
  } catch {
    if (!res.writableEnded) {
      res.write(`event: done\ndata: {"count":0}\n\n`);
      res.end();
    }
  }
});

// 5. FULL M3U8 IPTV PLAYLIST GENERATOR (WITH AUTOMATIC XMLTV EPG LINKING)
app.get(['/api/live/playlist.m3u8', '/v1/live/playlist.m3u8'], async (req: Request, res: Response) => {
  try {
    const params = new URLSearchParams();
    params.set('proxy', 'true');
    if (req.query.lang) params.set('lang', String(req.query.lang));
    if (req.query.category) params.set('category', String(req.query.category));

    const targetUrl = `${getCineproUrl()}/v1/live/playlist.m3u8?${params.toString()}`;
    const upstream = await fetch(targetUrl);
    if (!upstream.ok) {
      return res.status(upstream.status).send('#EXTM3U\n');
    }
    let text = await upstream.text();
    const hostOrigin = `${req.protocol}://${req.get('host')}`;
    text = text.replace(/https?:\/\/[^/\s"']+\/v1\/live\/epg\.xml/gi, `${hostOrigin}/api/live/epg.xml`);
    text = text.replace(/https?:\/\/[^/\s"']+\/v1\/live\/proxy\//gi, `${hostOrigin}/api/live/proxy/`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="notflix-live-iptv.m3u8"');
    return res.send(text);
  } catch (err) {
    return res.status(502).send('#EXTM3U\n');
  }
});

// 6. BUILT-IN CORS-FREE HLS MANIFEST & SEGMENT PROXY RELAY (CINEPRO-FIRST FOR PNG/TIKTIKPX UNWRAPPING)
app.all(['/api/live/proxy/:endpoint', '/v1/live/proxy/:endpoint'], async (req: Request, res: Response) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  try {
    const endpoint = String(req.params.endpoint || 'manifest.m3u8');
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

    let directUrl = '';
    let customHeaders: Record<string, string> = {};
    const dataParam = typeof req.query.data === 'string' ? req.query.data : '';
    const urlParam = typeof req.query.url === 'string' ? req.query.url : '';

    if (dataParam) {
      try {
        const parsed = JSON.parse(dataParam);
        if (parsed && typeof parsed.url === 'string') {
          directUrl = parsed.url.trim();
        }
        if (parsed && parsed.headers && typeof parsed.headers === 'object') {
          customHeaders = parsed.headers;
        }
      } catch {
        // Fallback if data isn't plain JSON
      }
    } else if (urlParam) {
      directUrl = urlParam.trim();
    }

    const cineproProxyHeaders: Record<string, string> = {
      Accept: '*/*',
    };
    if (req.headers.range) {
      cineproProxyHeaders['Range'] = req.headers.range as string;
    }

    let upstream: globalThis.Response | null = null;
    let fetchedDirectly = false;

    if (directUrl && !isSafeExternalProxyUrl(directUrl)) {
      return res.status(403).send('Forbidden: Internal or invalid proxy target URL');
    }

    // Fast-path direct fetch for public CDNs that block datacenter scraper IPs (Rotana HibridCDN, Amagi, RMTV Akamai)
    const preferDirectFetch =
      Boolean(directUrl) &&
      /(hibridcdn\.net|amagi\.tv|rmtv\.akamaized\.net|turner\.com|cbsi\.live\.ott\.irdeto\.com)/i.test(directUrl);

    if (!preferDirectFetch) {
      // 1. Fetch from CinePro's /v1/live/proxy/:endpoint FIRST so CinePro's
      //    built-in PNG/TIKTIKPX/gzip segment unwrapper and IP-bound session headers are used.
      const cineproProxyUrl = `${getCineproUrl()}/v1/live/proxy/${encodeURIComponent(endpoint)}${queryString}`;
      const cpController = new AbortController();
      const cpTimeout = setTimeout(() => cpController.abort(), 14000);
      try {
        const resp = await fetch(cineproProxyUrl, {
          headers: cineproProxyHeaders,
          signal: cpController.signal,
          redirect: 'follow',
        });
        clearTimeout(cpTimeout);
        if (resp.ok || resp.status === 206) {
          upstream = resp;
        }
      } catch {
        clearTimeout(cpTimeout);
      }
    }

    // 2. Fall back to direct fetch (or run first for preferDirectFetch CDNs)
    if (!upstream && directUrl && isSafeExternalProxyUrl(directUrl)) {
      const requestHeaders: Record<string, string> = {
        'User-Agent':
          customHeaders['User-Agent'] ||
          customHeaders['user-agent'] ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Accept: '*/*',
      };
      if (customHeaders['Referer'] || customHeaders['referer']) {
        requestHeaders['Referer'] = customHeaders['Referer'] || customHeaders['referer'];
      }
      if (customHeaders['Origin'] || customHeaders['origin']) {
        requestHeaders['Origin'] = customHeaders['Origin'] || customHeaders['origin'];
      }
      if (req.headers.range) {
        requestHeaders['Range'] = req.headers.range as string;
      }

      const directController = new AbortController();
      const directTimeout = setTimeout(() => directController.abort(), 10000);
      try {
        const resp = await fetch(directUrl, {
          headers: requestHeaders,
          signal: directController.signal,
          redirect: 'follow',
        });
        clearTimeout(directTimeout);
        if (resp.url && !isSafeExternalProxyUrl(resp.url)) {
          return res.status(403).send('Forbidden: Redirect to internal network blocked');
        }
        if (resp.ok || resp.status === 206) {
          upstream = resp;
          fetchedDirectly = true;
        }
      } catch {
        clearTimeout(directTimeout);
      }
    }

    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      return res.status(upstream?.status || 502).send(`Upstream returned ${upstream?.status || 502}`);
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const effectiveUrl = fetchedDirectly ? upstream.url || directUrl || '' : directUrl || '';
    const looksLikeM3u8 =
      endpoint.endsWith('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegurl');

    // Fast-path: stream binary .ts/.m4s/.aac segments directly ONLY when already unwrapped by CinePro
    if (!looksLikeM3u8 && !fetchedDirectly && !contentType.includes('image/') && upstream.body) {
      res.setHeader('Content-Type', 'video/mp2t');
      if (upstream.headers.get('content-length')) {
        res.setHeader('Content-Length', upstream.headers.get('content-length')!);
      }
      if (upstream.headers.get('content-range')) {
        res.setHeader('Content-Range', upstream.headers.get('content-range')!);
      }
      res.setHeader('Cache-Control', 'public, max-age=10');
      res.status(upstream.status);

      const nodeStream = Readable.fromWeb(upstream.body as any);
      req.on('close', () => {
        nodeStream.destroy();
      });
      return nodeStream.pipe(res);
    }

    const arrayBuffer = await upstream.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);
    const headerPrefix = buffer.subarray(0, 16).toString('utf8').trimStart();
    const isM3u8Content = headerPrefix.startsWith('#EXTM3U') || headerPrefix.startsWith('#EXT');

    if (isM3u8Content && buffer.length > 0) {
      let text = buffer.toString('utf8');

      // First rewrite any CinePro proxy URLs to our local /api/live/proxy/ endpoint
      text = text.replace(/https?:\/\/[^/\s"']+\/v1\/live\/proxy\//gi, '/api/live/proxy/');
      text = text.replace(/\/v1\/live\/proxy\//gi, '/api/live/proxy/');
      text = text.replace(/([^\r\n"'])(\/api\/live\/proxy\/)/g, '$1\n$2');

      // Also rewrite any remaining unproxied relative/absolute URLs inside the manifest
      if (effectiveUrl) {
        const lines = text.split(/\r?\n/);
        let expectVariantStream = false;

        const rewrittenLines = lines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          if (trimmed.startsWith('#')) {
            if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
              expectVariantStream = true;
            }
            if (trimmed.includes('URI="')) {
              const isPlaylistUri =
                trimmed.startsWith('#EXT-X-MEDIA') || trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF');
              return line.replace(/URI="([^"]+)"/g, (_match, rawUri) => {
                if (rawUri.startsWith('/api/live/proxy/')) {
                  return `URI="${rawUri}"`;
                }
                try {
                  const resolved = new URL(rawUri, effectiveUrl).toString();
                  const isChildM3u8 = isPlaylistUri || /\.m3u8(\?|$)/i.test(resolved);
                  return `URI="${buildLocalLiveProxyUrl(resolved, customHeaders, isChildM3u8)}"`;
                } catch {
                  return _match;
                }
              });
            }
            return line;
          }

          const isVariant = expectVariantStream;
          expectVariantStream = false;

          if (trimmed.startsWith('/api/live/proxy/')) {
            return trimmed;
          }

          try {
            const resolved = new URL(trimmed, effectiveUrl).toString();
            const isChildM3u8 =
              isVariant ||
              /\.m3u8(\?|$)/i.test(resolved) ||
              /\/(playlist|chunklist|master|index|manifest|mono)[^/]*\.m3u8/i.test(resolved);
            return buildLocalLiveProxyUrl(resolved, customHeaders, isChildM3u8);
          } catch {
            return line;
          }
        });

        text = rewrittenLines.join('\n');
      }

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.send(text);
    }

    // Strip any prepended PNG/GIF/ID3 wrapper before the first valid 188-byte MPEG-TS 0x47 sync sequence
    if (buffer.length > 376 && buffer[0] !== 0x47) {
      const maxScan = Math.min(buffer.length - 376, 8192);
      for (let i = 1; i < maxScan; i++) {
        if (buffer[i] === 0x47 && buffer[i + 188] === 0x47 && buffer[i + 376] === 0x47) {
          buffer = buffer.subarray(i);
          break;
        }
      }
    }

    if (buffer.length > 0 && buffer[0] === 0x47) {
      res.setHeader('Content-Type', 'video/mp2t');
    } else if (contentType && !contentType.includes('image/')) {
      res.setHeader('Content-Type', contentType);
    } else {
      res.setHeader('Content-Type', 'video/mp2t');
    }

    if (upstream.headers.get('content-range')) {
      res.setHeader('Content-Range', upstream.headers.get('content-range')!);
    }
    res.setHeader('Content-Length', buffer.length.toString());
    res.status(upstream.status);
    return res.end(buffer);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(502).send('Live proxy relay failed');
    }
  }
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
      if (safeCompareStrings(sig, expectedSig)) {
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
  mediaType?: 'movie' | 'tv' | 'live';
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
    if (ev.mediaType === 'live') {
      return {
        ...ev,
        mediaType: 'live',
        season: undefined,
        episode: undefined,
      };
    }

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

function mergeAnalyticsEventsIntoStore(incomingEvents: any[]): number {
  if (!Array.isArray(incomingEvents) || incomingEvents.length === 0) return 0;
  const sanitized = sanitizeAnalyticsEvents(incomingEvents);
  const existingMap = new Map<string, AnalyticsEvent>();
  for (const ev of analyticsStore.events) {
    if (ev && ev.id) existingMap.set(ev.id, ev);
  }

  let added = 0;
  for (const ev of sanitized) {
    if (!ev) continue;
    const id = ev.id || (ev.ts ? `${ev.ts}-${ev.sessionId || 'anon'}-${ev.type || 'ev'}` : crypto.randomUUID());
    if (!existingMap.has(id)) {
      existingMap.set(id, { ...ev, id });
      added++;
    }
  }

  if (added > 0) {
    analyticsStore.events = Array.from(existingMap.values())
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .slice(-20000);
    analyticsStore.lastUpdated = Date.now();
  }
  return added;
}

function readAnalyticsData(): AnalyticsData {
  const candidatePaths = Array.from(
    new Set([
      ...PERSISTENT_READ_DIRS.map((d) => path.join(d, 'analytics.json')),
      ANALYTICS_DATA_FILE,
      ANALYTICS_BACKUP_MIRROR_FILE,
    ])
  );

  const mergedMap = new Map<string, AnalyticsEvent>();

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8').trim();
        if (!content) continue;
        const parsed = JSON.parse(content);
        const eventsArr = Array.isArray(parsed?.events)
          ? parsed.events
          : Array.isArray(parsed)
          ? parsed
          : [];
        if (eventsArr.length > 0) {
          const sanitized = sanitizeAnalyticsEvents(eventsArr);
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
        // Also merge any embedded security bans if present in a unified backup file
        if (parsed?.security || parsed?.bans) {
          mergePermanentBansAndSecurityPayload(parsed.security || parsed);
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
    writeFileAtomicallyToMirrors('analytics.json', serialized, ANALYTICS_BACKUP_MIRROR_FILE);
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
  const clientIp = getClientIp(req);
  if (!isInternalOrLoopbackIp(clientIp) && !checkRateLimit(clientIp, adminLoginRateLimiter, 10, 15 * 60 * 1000)) {
    res.setHeader('Retry-After', '900');
    return res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes before retrying.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const userOk = safeCompareStrings(username, ADMIN_USERNAME);
  const passOk = safeCompareStrings(password, ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  adminLoginRateLimiter.delete(clientIp);

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

    const isLiveMedia = mediaType === 'live';
    const isTv =
      !isLiveMedia &&
      mediaType === 'tv' &&
      !/spider-man|oppenheimer|avatar|batman|avengers|barbie|dune|gladiator|wicked|interstellar|inception|deadpool|joker/i.test(title || '');

    const normalizedMediaType: 'movie' | 'tv' | 'live' | undefined =
      eventType === 'play' || eventType === 'heartbeat'
        ? isLiveMedia
          ? 'live'
          : isTv
          ? 'tv'
          : 'movie'
        : undefined;

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

    let liveArenaViewersCount = 0;
    let vodViewersCount = 0;

    activeLiveViewers.forEach((data, sessId) => {
      const diff = now - data.lastPing;
      if (diff <= liveTimeout) {
        if (data.mediaType === 'live') {
          // Strictly aggregate Live Arena viewers as total count (no individual viewing detail exposed)
          liveArenaViewersCount++;
        } else {
          vodViewersCount++;
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
        }
      } else {
        // Clean up stale sessions
        activeLiveViewers.delete(sessId);
      }
    });

    const liveViewersCount = liveArenaViewersCount + vodViewersCount;

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
          const effectiveMediaType: 'movie' | 'tv' | 'live' =
            e.mediaType === 'live' ? 'live' : e.mediaType === 'tv' ? 'tv' : 'movie';
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
          const effectiveMediaType: 'movie' | 'tv' | 'live' =
            e.mediaType === 'live' ? 'live' : e.mediaType === 'tv' ? 'tv' : 'movie';
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
        const effectiveMediaType: 'movie' | 'tv' | 'live' | undefined =
          ev.type === 'play' || ev.type === 'heartbeat'
            ? ev.mediaType === 'live'
              ? 'live'
              : ev.mediaType === 'tv'
              ? 'tv'
              : 'movie'
            : undefined;
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
        liveArenaViewers: liveArenaViewersCount,
        vodViewers: vodViewersCount,
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

// GET /api/admin/security/bans (Fetch all permanently blocked IPs + tombstones + security metrics)
app.get('/api/admin/security/bans', requireAdminAuth, (_req: Request, res: Response) => {
  return res.json({
    success: true,
    count: permanentlyBannedIps.size,
    lastClearedAllBansAt,
    unblockedTombstones: Object.fromEntries(unblockedIpTombstones.entries()),
    securityMetrics,
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
    lastClearedAllBansAt,
    unblockedTombstones: Object.fromEntries(unblockedIpTombstones.entries()),
    securityMetrics,
    bans: Array.from(permanentlyBannedIps.values()).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt),
  });
});

// POST /api/admin/security/unblock (Unblock a permanently banned IP or clear all bans)
app.post('/api/admin/security/unblock', requireAdminAuth, (req: Request, res: Response) => {
  const { ip, all } = req.body || {};
  if (all === true) {
    const cleared = permanentlyBannedIps.size;
    lastClearedAllBansAt = Date.now();
    permanentlyBannedIps.clear();
    rateLimitStrikes.clear();
    savePermanentBansToDiskSync();
    return res.json({
      success: true,
      cleared,
      lastClearedAllBansAt,
      unblockedTombstones: Object.fromEntries(unblockedIpTombstones.entries()),
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
    lastClearedAllBansAt,
    unblockedTombstones: Object.fromEntries(unblockedIpTombstones.entries()),
    bans: Array.from(permanentlyBannedIps.values()).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt),
  });
});

// GET /api/admin/analytics/export (Export complete analytics + blocked IPs + security metrics backup)
app.get('/api/admin/analytics/export', requireAdminAuth, (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="notflix-analytics-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.send(
    JSON.stringify(
      {
        ...analyticsStore,
        security: {
          schemaVersion: BAN_STORAGE_SCHEMA_VERSION,
          lastClearedAllBansAt,
          unblockedTombstones: Object.fromEntries(unblockedIpTombstones.entries()),
          bans: Array.from(permanentlyBannedIps.values()),
          securityMetrics,
        },
      },
      null,
      2
    )
  );
});

// POST /api/admin/analytics/import (Restore or merge analytics + blocked IPs backup)
app.post('/api/admin/analytics/import', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const payload = req.body;
    let newEvents: AnalyticsEvent[] = [];
    if (Array.isArray(payload)) {
      newEvents = payload;
    } else if (payload && Array.isArray(payload.events)) {
      newEvents = payload.events;
    } else if (!payload?.security && !payload?.bans) {
      return res.status(400).json({ error: 'Invalid format. Expected JSON with { events: [...] } or an array of events.' });
    }

    const addedCount = mergeAnalyticsEventsIntoStore(newEvents);
    if (addedCount > 0) {
      flushAnalyticsToDiskSync();
    }

    let bansChanged = false;
    if (payload?.security || payload?.bans) {
      bansChanged = mergePermanentBansAndSecurityPayload(payload.security || payload);
      if (bansChanged) {
        savePermanentBansToDiskSync();
      }
    }

    return res.json({
      success: true,
      message: `Successfully imported ${addedCount} analytics events (${analyticsStore.events.length} total) and synced ${permanentlyBannedIps.size} permanently blocked IPs.`,
      importedCount: addedCount,
      totalEvents: analyticsStore.events.length,
      totalBannedIps: permanentlyBannedIps.size,
    });
  } catch (err: any) {
    console.error('Error importing analytics:', err);
    return res.status(500).json({ error: 'Failed to import analytics: ' + (err?.message || err) });
  }
});

// POST /api/admin/state/sync (Atomic bidirectional sync for Analytics Events + Blocked IPs + Security Metrics)
app.post('/api/admin/state/sync', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    let addedEvents = 0;
    if (Array.isArray(body.events) && body.events.length > 0) {
      addedEvents = mergeAnalyticsEventsIntoStore(body.events);
      if (addedEvents > 0) {
        flushAnalyticsToDiskSync();
      }
    }

    const bansChanged = mergePermanentBansAndSecurityPayload({
      bans: body.bans,
      unblockedTombstones: body.unblockedTombstones,
      lastClearedAllBansAt: body.lastClearedAllBansAt,
      securityMetrics: body.securityMetrics,
    });
    if (bansChanged) {
      savePermanentBansToDiskSync();
    }

    return res.json({
      success: true,
      restoredEvents: addedEvents,
      restoredBans: bansChanged,
      totalEvents: analyticsStore.events.length,
      events: analyticsStore.events,
      security: {
        lastClearedAllBansAt,
        unblockedTombstones: Object.fromEntries(unblockedIpTombstones.entries()),
        bans: Array.from(permanentlyBannedIps.values()).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt),
        securityMetrics,
      },
    });
  } catch (err: any) {
    console.error('Error in /api/admin/state/sync:', err);
    return res.status(500).json({ error: 'State sync failed: ' + (err?.message || err) });
  }
});

// GET /api/internal/handover-snapshot (Zero-downtime container-to-container state handover during updates)
app.get('/api/internal/handover-snapshot', (req: Request, res: Response) => {
  const tsHeader = String(req.headers['x-notflix-handover-ts'] || '');
  const sigHeader = String(req.headers['x-notflix-handover-sig'] || '');
  const tsNum = Number(tsHeader) || 0;
  if (!tsNum || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'Expired or missing handover timestamp' });
  }
  const expectedSig = crypto
    .createHmac('sha256', ADMIN_TOKEN_SECRET)
    .update(`handover:${tsHeader}`)
    .digest('hex');
  if (!safeCompareStrings(sigHeader, expectedSig)) {
    return res.status(401).json({ error: 'Invalid handover signature' });
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.json({
    success: true,
    bootId: SERVER_BOOT_TIME,
    deploymentVersion: DEPLOYMENT_VERSION,
    analyticsEvents: analyticsStore.events,
    security: {
      schemaVersion: BAN_STORAGE_SCHEMA_VERSION,
      lastClearedAllBansAt,
      unblockedTombstones: Object.fromEntries(unblockedIpTombstones.entries()),
      bans: Array.from(permanentlyBannedIps.values()),
      securityMetrics,
    },
    scraperConfig: scraperConfigStore,
    adBlockPolicy: adBlockPolicyStore,
  });
});

async function pullStateFromLivePeerOnStartup(): Promise<void> {
  const candidateOrigins = Array.from(
    new Set(
      [
        process.env.PUBLIC_URL,
        process.env.APP_URL,
        process.env.COOLIFY_URL,
        process.env.COOLIFY_FQDN ? `https://${process.env.COOLIFY_FQDN.replace(/^https?:\/\//i, '')}` : '',
        'https://notflixtv.com',
        DEFAULT_SCRAPER_GATEWAY_URL,
      ]
        .map((u) => String(u || '').trim().replace(/\/+$/, ''))
        .filter((u) => u.startsWith('http'))
    )
  );

  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(`handover:${ts}`).digest('hex');

  await Promise.allSettled(
    candidateOrigins.map(async (origin) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3800);
      try {
        const res = await fetch(`${origin}/api/internal/handover-snapshot?_cb=${ts}`, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'x-notflix-handover-ts': ts,
            'x-notflix-handover-sig': sig,
            'User-Agent': 'Notflix-Container-Handover/2.0',
          },
        });
        clearTimeout(timer);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.success || data.bootId === SERVER_BOOT_TIME) return;

        let mergedAny = false;
        if (Array.isArray(data.analyticsEvents) && data.analyticsEvents.length > 0) {
          const added = mergeAnalyticsEventsIntoStore(data.analyticsEvents);
          if (added > 0) {
            flushAnalyticsToDiskSync();
            mergedAny = true;
          }
        }
        if (data.security) {
          if (mergePermanentBansAndSecurityPayload(data.security)) {
            savePermanentBansToDiskSync();
            mergedAny = true;
          }
        }
        if (
          data.scraperConfig &&
          data.scraperConfig.updatedAt > scraperConfigStore.updatedAt &&
          data.scraperConfig.scrapers
        ) {
          scraperConfigStore = data.scraperConfig;
          saveScraperConfigToDiskSync(scraperConfigStore);
          mergedAny = true;
        }
        if (
          data.adBlockPolicy &&
          data.adBlockPolicy.updatedAt > adBlockPolicyStore.updatedAt &&
          (data.adBlockPolicy.mode === 'strict' || data.adBlockPolicy.mode === 'dismissible')
        ) {
          adBlockPolicyStore = data.adBlockPolicy;
          saveAdBlockPolicyToDiskSync(adBlockPolicyStore);
          mergedAny = true;
        }
        if (mergedAny) {
          console.log(
            `🔄 [Container Handover] Pulled live state from ${origin}: ${analyticsStore.events.length} analytics events & ${permanentlyBannedIps.size} blocked IPs preserved.`
          );
        }
      } catch {
        clearTimeout(timer);
      }
    })
  );
}

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

// ============================================================================
// AD-BLOCKER NOTIFICATION POPUP POLICY (Admin-Controlled: Dismissible vs Strict Lock)
// ============================================================================
type AdBlockPopupMode = 'dismissible' | 'strict';

interface AdBlockPolicyStore {
  mode: AdBlockPopupMode;
  updatedAt: number;
}

const ADBLOCK_POLICY_FILE = path.join(DATA_DIR, 'adblock_policy.json');
const ADBLOCK_POLICY_BACKUP_FILE = '/var/tmp/notflix_adblock_policy_backup.json';

function loadAdBlockPolicyFromDisk(): AdBlockPolicyStore {
  const candidates = [ADBLOCK_POLICY_FILE, ADBLOCK_POLICY_BACKUP_FILE];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8').trim();
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.mode === 'dismissible' || parsed.mode === 'strict')) {
          return {
            mode: parsed.mode,
            updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
          };
        }
      }
    } catch {}
  }
  const fallback: AdBlockPolicyStore = {
    mode: 'dismissible',
    updatedAt: 0,
  };
  saveAdBlockPolicyToDiskSync(fallback);
  return fallback;
}

function saveAdBlockPolicyToDiskSync(store: AdBlockPolicyStore): void {
  const payload = JSON.stringify(store, null, 2);
  try {
    fs.writeFileSync(ADBLOCK_POLICY_FILE, payload, 'utf-8');
  } catch {}
  try {
    fs.writeFileSync(ADBLOCK_POLICY_BACKUP_FILE, payload, 'utf-8');
  } catch {}
}

let adBlockPolicyStore: AdBlockPolicyStore = loadAdBlockPolicyFromDisk();

// Public endpoint: Watchers fetch active Ad-Blocker popup policy ('dismissible' | 'strict')
app.get('/api/adblock-policy', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.json({
    success: true,
    mode: adBlockPolicyStore.mode,
    updatedAt: adBlockPolicyStore.updatedAt,
  });
});

// Admin endpoint: Update Ad-Blocker popup policy ('dismissible' | 'strict')
app.post('/api/admin/adblock-policy', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const rawMode = req.body?.mode;
    const mode: AdBlockPopupMode = rawMode === 'strict' ? 'strict' : 'dismissible';
    const updatedAt =
      typeof req.body?.updatedAt === 'number' && req.body.updatedAt > 0 ? req.body.updatedAt : Date.now();

    adBlockPolicyStore = { mode, updatedAt };
    saveAdBlockPolicyToDiskSync(adBlockPolicyStore);

    return res.json({
      success: true,
      policy: adBlockPolicyStore,
      message:
        mode === 'strict'
          ? 'Strict Ad-Blocker Lock enabled: Watchers cannot close the popup until they disable their ad blocker.'
          : 'Dismissible Ad-Blocker Notice enabled: Watchers can close the popup normally.',
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Failed to update Ad-Blocker policy',
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
  app.use('/downloads', (req: Request, res: Response, next: NextFunction) => {
    const cleanRel = (req.path || '').toLowerCase();
    if (cleanRel.includes('.persistence') || cleanRel.endsWith('.json') || cleanRel.includes('/.')) {
      return res.status(403).send('Forbidden');
    }
    next();
  }, express.static(downloadsPath, { dotfiles: 'deny', index: false }));

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

  // ============================================================================
  // PROGRAMMATIC SEO ENGINE: Dynamic 200+ Title XML Sitemap & SSR Meta Injection
  // ============================================================================
  interface SeoCatalogEntry {
    id: number;
    type: 'movie' | 'tv';
    title: string;
    year: string;
    slug: string;
    path: string;
    overview: string;
    poster: string;
    backdrop: string;
    rating: number;
  }

  let seoCatalogCache: {
    updatedAt: number;
    entries: SeoCatalogEntry[];
    byKey: Map<string, SeoCatalogEntry>;
  } = {
    updatedAt: 0,
    entries: [],
    byKey: new Map(),
  };

  function toServerSeoSlug(text: string): string {
    return (
      (text || 'watch')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'watch'
    );
  }

  function escapeXml(unsafe: string): string {
    return (unsafe || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function escapeHtmlAttr(unsafe: string): string {
    return (unsafe || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function safeJsonLdStringify(data: unknown): string {
    return JSON.stringify(data)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  async function refreshSeoCatalog(force = false): Promise<SeoCatalogEntry[]> {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    if (!force && seoCatalogCache.entries.length > 0 && Date.now() - seoCatalogCache.updatedAt < SIX_HOURS) {
      return seoCatalogCache.entries;
    }

    const endpoints: Array<{ path: string; type: 'movie' | 'tv' }> = [
      { path: 'trending/movie/day', type: 'movie' },
      { path: 'trending/movie/week', type: 'movie' },
      { path: 'movie/popular?page=1&without_genres=10749', type: 'movie' },
      { path: 'movie/popular?page=2&without_genres=10749', type: 'movie' },
      { path: 'movie/top_rated?page=1&without_genres=10749', type: 'movie' },
      { path: 'movie/now_playing?page=1&without_genres=10749', type: 'movie' },
      { path: 'trending/tv/day', type: 'tv' },
      { path: 'trending/tv/week', type: 'tv' },
      { path: 'tv/popular?page=1&without_genres=10749', type: 'tv' },
      { path: 'tv/popular?page=2&without_genres=10749', type: 'tv' },
      { path: 'tv/top_rated?page=1&without_genres=10749', type: 'tv' },
      { path: 'discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=1', type: 'tv' },
    ];

    const collected = new Map<string, SeoCatalogEntry>();

    await Promise.allSettled(
      endpoints.map(async (ep) => {
        try {
          const sep = ep.path.includes('?') ? '&' : '?';
          const url = `${TMDB_BASE}/${ep.path}${sep}api_key=${TMDB_API_KEY}&include_adult=false&language=en-US`;
          const res = await fetch(url);
          if (!res.ok) return;
          const data = await res.json();
          const results = Array.isArray(data?.results) ? data.results : [];
          for (const raw of results) {
            if (!raw || !raw.id || !isSafe(raw)) continue;
            const title = String(raw.title || raw.name || '').trim();
            if (!title) continue;
            const key = `${ep.type}:${raw.id}`;
            if (collected.has(key)) continue;

            const year = String(raw.release_date || raw.first_air_date || '').slice(0, 4);
            const slug = toServerSeoSlug(title);
            const entry: SeoCatalogEntry = {
              id: Number(raw.id),
              type: ep.type,
              title,
              year,
              slug,
              path: `/watch/${ep.type}/${raw.id}-${slug}`,
              overview: String(raw.overview || '').trim(),
              poster: raw.poster_path ? `https://image.tmdb.org/t/p/w500${raw.poster_path}` : 'https://notflixtv.com/icon-512.png',
              backdrop: raw.backdrop_path
                ? `https://image.tmdb.org/t/p/w1280${raw.backdrop_path}`
                : raw.poster_path
                ? `https://image.tmdb.org/t/p/w780${raw.poster_path}`
                : 'https://image.tmdb.org/t/p/w1280/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg',
              rating: Number(raw.vote_average) || 7.6,
            };
            collected.set(key, entry);
          }
        } catch {}
      })
    );

    if (collected.size > 0) {
      seoCatalogCache = {
        updatedAt: Date.now(),
        entries: Array.from(collected.values()),
        byKey: collected,
      };
    }

    return seoCatalogCache.entries;
  }

  // Warm up the Programmatic SEO catalog + Live Arena events in the background shortly after server start
  setTimeout(() => {
    refreshSeoCatalog().catch(() => {});
    getOrRefreshLiveEventsPayload(60000).catch(() => {});
  }, 2500);

  function buildLiveMatchSeoPath(ev: any): string {
    const idPart = String(ev?.id || 'match').trim();
    const homeName = String(ev?.homeTeam?.name || '').trim();
    const awayName = String(ev?.awayTeam?.name || '').trim();
    const leagueName = String(ev?.league || '').trim();
    const rawTitle = homeName && awayName ? `${homeName} vs ${awayName} ${leagueName}` : `${ev?.title || 'live-match'} ${leagueName}`;
    return `/live/match/${encodeURIComponent(idPart)}-${toServerSeoSlug(rawTitle)}`;
  }

  function buildLiveChannelSeoPath(channelId: string): string {
    return `/live/channel/${encodeURIComponent(String(channelId || '').trim())}`;
  }

  async function resolveSeoTitleDetails(mediaType: 'movie' | 'tv', tmdbId: number): Promise<SeoCatalogEntry | null> {
    const key = `${mediaType}:${tmdbId}`;
    if (seoCatalogCache.byKey.has(key)) {
      return seoCatalogCache.byKey.get(key)!;
    }

    const cacheKey = `seo-item-${key}`;
    const cached = apiCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 6 * 60 * 60 * 1000) {
      return cached.data;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const url = `${TMDB_BASE}/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const raw = await res.json();
      if (!raw || !raw.id || !isSafe(raw)) return null;

      const title = String(raw.title || raw.name || 'Movie').trim();
      const year = String(raw.release_date || raw.first_air_date || '').slice(0, 4);
      const slug = toServerSeoSlug(title);
      const entry: SeoCatalogEntry = {
        id: Number(raw.id),
        type: mediaType,
        title,
        year,
        slug,
        path: `/watch/${mediaType}/${raw.id}-${slug}`,
        overview: String(raw.overview || '').trim(),
        poster: raw.poster_path ? `https://image.tmdb.org/t/p/w500${raw.poster_path}` : 'https://notflixtv.com/icon-512.png',
        backdrop: raw.backdrop_path
          ? `https://image.tmdb.org/t/p/w1280${raw.backdrop_path}`
          : raw.poster_path
          ? `https://image.tmdb.org/t/p/w780${raw.poster_path}`
          : 'https://image.tmdb.org/t/p/w1280/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg',
        rating: Number(raw.vote_average) || 7.6,
      };
      apiCache.set(cacheKey, { timestamp: Date.now(), data: entry });
      seoCatalogCache.byKey.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async function buildDynamicSitemapXml(): Promise<string> {
    const [entries, livePayload] = await Promise.all([
      refreshSeoCatalog(),
      getOrRefreshLiveEventsPayload(180000),
    ]);
    const liveEventsList = Array.isArray(livePayload?.events) ? livePayload.events : [];
    const channelEntries = Object.values(LIVE_CHANNEL_DIRECTORY);
    const today = new Date().toISOString().split('T')[0];

    const staticUrls = [
      { loc: 'https://notflixtv.com/', priority: '1.0', changefreq: 'hourly' },
      { loc: 'https://notflixtv.com/live', priority: '0.95', changefreq: 'always' },
      { loc: 'https://notflixtv.com/movies', priority: '0.9', changefreq: 'daily' },
      { loc: 'https://notflixtv.com/series', priority: '0.9', changefreq: 'daily' },
      { loc: 'https://notflixtv.com/anime', priority: '0.9', changefreq: 'daily' },
      { loc: 'https://notflixtv.com/search', priority: '0.8', changefreq: 'weekly' },
    ];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n`;

    for (const st of staticUrls) {
      xml += `  <url>\n`;
      xml += `    <loc>${st.loc}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>${st.changefreq}</changefreq>\n`;
      xml += `    <priority>${st.priority}</priority>\n`;
      xml += `  </url>\n`;
    }

    // 1. Live & Upcoming Sports Matches in Notflix Live Arena
    for (const ev of liveEventsList) {
      if (!ev || !ev.id) continue;
      const matchPath = buildLiveMatchSeoPath(ev);
      const fullLoc = `https://notflixtv.com${matchPath}`;
      const matchTitle =
        ev.homeTeam?.name && ev.awayTeam?.name
          ? `${ev.homeTeam.name} vs ${ev.awayTeam.name}`
          : String(ev.title || 'Live Sports Match');
      const leagueLabel = ev.league ? ` — ${ev.league}` : '';
      const chNames = Array.isArray(ev.recommendedChannels)
        ? ev.recommendedChannels
            .slice(0, 4)
            .map((c: any) => String(c.name || '').replace(/\s*\([^)]*\)/g, ''))
            .filter(Boolean)
            .join(', ')
        : 'beIN Sports, Sky Sports, ESPN';
      const imgTitle = escapeXml(`Watch ${matchTitle}${leagueLabel} Live Stream Free HD — Notflix Arena`);
      const imgCaption = escapeXml(
        `Stream ${matchTitle}${leagueLabel} live in 1080p HD on ${chNames || 'Notflix Arena'}.`
      );
      const candidateImg = [ev.homeTeam?.logo, ev.awayTeam?.logo, ev.leagueLogo].find(
        (u) => typeof u === 'string' && u.startsWith('http')
      );
      const isLiveNow = String(ev.status || '').toUpperCase() === 'LIVE';

      xml += `  <url>\n`;
      xml += `    <loc>${escapeXml(fullLoc)}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>${isLiveNow ? 'always' : 'hourly'}</changefreq>\n`;
      xml += `    <priority>${isLiveNow ? '0.95' : '0.90'}</priority>\n`;
      if (candidateImg) {
        xml += `    <image:image>\n`;
        xml += `      <image:loc>${escapeXml(candidateImg)}</image:loc>\n`;
        xml += `      <image:title>${imgTitle}</image:title>\n`;
        xml += `      <image:caption>${imgCaption}</image:caption>\n`;
        xml += `    </image:image>\n`;
      }
      xml += `  </url>\n`;
    }

    // 2. 24/7 Live Sports & Entertainment TV Channels in Notflix Arena
    for (const ch of channelEntries) {
      if (!ch || !ch.channelId) continue;
      const fullLoc = `https://notflixtv.com${buildLiveChannelSeoPath(ch.channelId)}`;
      const cleanName = ch.name.replace(/\s*\([^)]*\)/g, '').trim();
      const imgTitle = escapeXml(`Watch ${cleanName} (${ch.languageLabel}) Live Stream 24/7 Free HD — Notflix Arena`);
      const imgCaption = escapeXml(
        `Watch ${ch.name} live stream 24/7 online free in 1080p Full HD on Notflix Live Arena.`
      );

      xml += `  <url>\n`;
      xml += `    <loc>${escapeXml(fullLoc)}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>hourly</changefreq>\n`;
      xml += `    <priority>0.88</priority>\n`;
      if (ch.logo && ch.logo.startsWith('http')) {
        xml += `    <image:image>\n`;
        xml += `      <image:loc>${escapeXml(ch.logo)}</image:loc>\n`;
        xml += `      <image:title>${imgTitle}</image:title>\n`;
        xml += `      <image:caption>${imgCaption}</image:caption>\n`;
        xml += `    </image:image>\n`;
      }
      xml += `  </url>\n`;
    }

    // 3. Movies & TV Series Catalog
    for (const item of entries) {
      const fullLoc = `https://notflixtv.com${item.path}`;
      const yearLabel = item.year ? ` (${item.year})` : '';
      const imgTitle = escapeXml(`Watch ${item.title}${yearLabel} Online Free in HD — Notflix`);
      const imgCaption = escapeXml(
        item.overview
          ? `Stream ${item.title}${yearLabel} in 1080p HD with subtitles: ${item.overview.slice(0, 140)}`
          : `Watch ${item.title}${yearLabel} online in HD on Notflix.`
      );

      xml += `  <url>\n`;
      xml += `    <loc>${escapeXml(fullLoc)}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>daily</changefreq>\n`;
      xml += `    <priority>0.85</priority>\n`;
      if (item.poster && item.poster.startsWith('http')) {
        xml += `    <image:image>\n`;
        xml += `      <image:loc>${escapeXml(item.poster)}</image:loc>\n`;
        xml += `      <image:title>${imgTitle}</image:title>\n`;
        xml += `      <image:caption>${imgCaption}</image:caption>\n`;
        xml += `    </image:image>\n`;
      }
      xml += `  </url>\n`;
    }

    xml += `</urlset>`;
    return xml;
  }

  async function injectDynamicSeoIntoHtml(rawHtml: string, reqPath: string): Promise<string> {
    try {
      const cleanPath = (reqPath || '/').split('?')[0];
      if (cleanPath.startsWith('/admin')) {
        return rawHtml;
      }

      let pageTitle = 'Notflix — Watch Movies, TV Series, Live Sports & 24/7 TV Online Free in HD';
      let pageDesc =
        'Stream trending movies, full TV series seasons, anime, and live football & sports channels (beIN Sports, Sky Sports, ESPN, SSC) free in 1080p & 4K HD on Notflix.';
      let canonicalUrl = `https://notflixtv.com${cleanPath === '/' ? '/' : cleanPath}`;
      let ogImage = 'https://image.tmdb.org/t/p/w1280/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg';
      let extraJsonLd = '';
      let noscriptCatalogHtml = '';

      const watchMatch = cleanPath.match(/^\/watch\/(movie|tv)\/(\d+)/i);
      const liveMatchRoute = cleanPath.match(/^\/live\/match\/([^/?#]+)/i);
      const liveChannelRoute = cleanPath.match(/^\/live\/channel\/([^/?#]+)/i);
      const isLiveHubRoute = /^\/(live|arena)(\/|$)/i.test(cleanPath);

      if (watchMatch) {
        const mediaType = watchMatch[1].toLowerCase() === 'tv' ? 'tv' : 'movie';
        const tmdbId = parseInt(watchMatch[2], 10);
        const item = await resolveSeoTitleDetails(mediaType, tmdbId);
        if (item) {
          const yearStr = item.year ? ` (${item.year})` : '';
          const typeLabel = mediaType === 'tv' ? 'Full TV Series & Episodes' : 'Full Movie';
          pageTitle = `Watch ${item.title}${yearStr} ${typeLabel} Online Free HD — Notflix`;
          pageDesc = `Watch ${item.title}${yearStr} online free in 1080p & 4K HD with English, Arabic, Spanish & multi-language subtitles on Notflix. ${
            item.overview || ''
          }`.slice(0, 158);
          canonicalUrl = `https://notflixtv.com${item.path}`;
          ogImage = item.backdrop || item.poster || ogImage;

          const schemaObj = {
            '@context': 'https://schema.org',
            '@type': mediaType === 'tv' ? 'TVSeries' : 'Movie',
            name: item.title,
            url: canonicalUrl,
            image: [item.poster, item.backdrop].filter(Boolean),
            description: item.overview || pageDesc,
            datePublished: item.year || undefined,
            inLanguage: 'en',
            aggregateRating: {
              '@type': 'AggregateRating',
              ratingValue: item.rating.toFixed(1),
              bestRating: '10',
              worstRating: '1',
              ratingCount: Math.max(150, Math.round(item.rating * 520)),
            },
            potentialAction: {
              '@type': 'WatchAction',
              target: {
                '@type': 'EntryPoint',
                urlTemplate: canonicalUrl,
                actionPlatform: [
                  'http://schema.org/DesktopWebPlatform',
                  'http://schema.org/MobileWebPlatform',
                  'http://schema.org/IOSPlatform',
                  'http://schema.org/AndroidPlatform',
                ],
              },
            },
          };
          extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(schemaObj)}</script>`;

          const related = seoCatalogCache.entries.slice(0, 24);
          noscriptCatalogHtml = `<noscript><article><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
            item.overview || pageDesc
          )}</p><ul>${related
            .map(
              (r) =>
                `<li><a href="https://notflixtv.com${r.path}">Watch ${escapeHtmlAttr(r.title)}${
                  r.year ? ` (${r.year})` : ''
                } Online HD</a></li>`
            )
            .join('')}</ul></article></noscript>`;
        }
      } else if (liveMatchRoute) {
        const rawParam = decodeURIComponent(liveMatchRoute[1]);
        const livePayload = await getOrRefreshLiveEventsPayload(180000);
        const allEvents = Array.isArray(livePayload?.events) ? livePayload.events : [];
        const matchedEv =
          allEvents.find((e) => String(e.id) === rawParam) ||
          allEvents.find((e) => rawParam.startsWith(`${e.id}-`)) ||
          allEvents.find((e) => buildLiveMatchSeoPath(e).endsWith(rawParam));

        const fallbackSlugTitle = rawParam
          .replace(/^[0-9a-z]+-/i, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());

        const homeName = matchedEv?.homeTeam?.name || fallbackSlugTitle.split(/ Vs /i)[0] || 'Home Team';
        const awayName = matchedEv?.awayTeam?.name || fallbackSlugTitle.split(/ Vs /i)[1] || 'Away Team';
        const matchTitle =
          matchedEv?.homeTeam?.name && matchedEv?.awayTeam?.name
            ? `${matchedEv.homeTeam.name} vs ${matchedEv.awayTeam.name}`
            : matchedEv?.title || fallbackSlugTitle || 'Live Sports Match';
        const leagueName = matchedEv?.league || 'Live Sports Broadcast';
        const startIso = matchedEv?.startTime || new Date().toISOString();
        const startMs = Date.parse(startIso) || Date.now();
        const endIso = new Date(startMs + 2 * 60 * 60 * 1000).toISOString();
        const isLiveNow = String(matchedEv?.status || '').toUpperCase() === 'LIVE';
        const recChannels = Array.isArray(matchedEv?.recommendedChannels) ? matchedEv.recommendedChannels : [];
        const channelListText =
          recChannels.length > 0
            ? recChannels
                .slice(0, 4)
                .map((c: any) => String(c.name || '').replace(/\s*\([^)]*\)/g, ''))
                .join(', ')
            : 'beIN Sports HD, Sky Sports HD, ESPN HD';

        pageTitle = `Watch ${matchTitle} Live Stream Free HD — ${leagueName} | Notflix Arena`;
        pageDesc = `Watch ${matchTitle} (${leagueName}) live stream online free in 1080p Full HD on Notflix Arena. Multi-language commentary on ${channelListText}.`.slice(
          0,
          158
        );
        canonicalUrl = matchedEv
          ? `https://notflixtv.com${buildLiveMatchSeoPath(matchedEv)}`
          : `https://notflixtv.com/live/match/${encodeURIComponent(rawParam)}`;

        const candidateLogo = [matchedEv?.homeTeam?.logo, matchedEv?.awayTeam?.logo, matchedEv?.leagueLogo].find(
          (u) => typeof u === 'string' && u.startsWith('http')
        );
        if (candidateLogo) {
          ogImage = candidateLogo;
        }

        const sportsEventSchema = {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'SportsEvent',
              '@id': `${canonicalUrl}#sportsevent`,
              name: `${matchTitle} — ${leagueName}`,
              description: pageDesc,
              url: canonicalUrl,
              startDate: startIso,
              endDate: endIso,
              eventStatus: isLiveNow
                ? 'https://schema.org/EventInProgress'
                : 'https://schema.org/EventScheduled',
              eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
              sport: matchedEv?.sport || 'Soccer',
              image: [candidateLogo, ogImage].filter(Boolean),
              location: {
                '@type': 'VirtualLocation',
                url: canonicalUrl,
                name: `Notflix Live Arena — ${leagueName}`,
              },
              organizer: {
                '@type': 'SportsOrganization',
                name: leagueName,
                url: 'https://notflixtv.com/live',
              },
              homeTeam: {
                '@type': 'SportsTeam',
                name: homeName,
                logo: matchedEv?.homeTeam?.logo?.startsWith('http') ? matchedEv.homeTeam.logo : undefined,
              },
              awayTeam: {
                '@type': 'SportsTeam',
                name: awayName,
                logo: matchedEv?.awayTeam?.logo?.startsWith('http') ? matchedEv.awayTeam.logo : undefined,
              },
              competitor: [
                { '@type': 'SportsTeam', name: homeName },
                { '@type': 'SportsTeam', name: awayName },
              ],
              potentialAction: {
                '@type': 'WatchAction',
                target: {
                  '@type': 'EntryPoint',
                  urlTemplate: canonicalUrl,
                  actionPlatform: [
                    'http://schema.org/DesktopWebPlatform',
                    'http://schema.org/MobileWebPlatform',
                    'http://schema.org/IOSPlatform',
                    'http://schema.org/AndroidPlatform',
                  ],
                },
              },
            },
            {
              '@type': 'BroadcastEvent',
              '@id': `${canonicalUrl}#broadcast`,
              name: `Live Broadcast: ${matchTitle} (${leagueName})`,
              description: pageDesc,
              isLiveBroadcast: true,
              startDate: startIso,
              endDate: endIso,
              videoFormat: 'HD 1080p',
              inLanguage: ['en', 'ar', 'fr', 'es'],
              workPerformed: {
                '@id': `${canonicalUrl}#sportsevent`,
              },
              publishedOn: recChannels.slice(0, 4).map((rc: any) => ({
                '@type': 'BroadcastService',
                name: rc.name,
                inLanguage: rc.language || 'en',
                url: `https://notflixtv.com${buildLiveChannelSeoPath(rc.channelId)}`,
              })),
            },
          ],
        };
        extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(sportsEventSchema)}</script>`;

        const otherMatches = allEvents.slice(0, 20);
        noscriptCatalogHtml = `<noscript><article><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
          pageDesc
        )}</p><h2>Live Broadcast Channels for ${escapeHtmlAttr(matchTitle)}</h2><ul>${recChannels
          .map(
            (rc: any) =>
              `<li><a href="https://notflixtv.com${buildLiveChannelSeoPath(rc.channelId)}">Watch ${escapeHtmlAttr(
                rc.name
              )} (${escapeHtmlAttr(rc.languageLabel || 'HD')}) Live Stream</a></li>`
          )
          .join('')}</ul><h2>More Live &amp; Upcoming Matches on Notflix Arena</h2><ul>${otherMatches
          .map(
            (m: any) =>
              `<li><a href="https://notflixtv.com${buildLiveMatchSeoPath(m)}">Watch ${escapeHtmlAttr(
                m.title || `${m.homeTeam?.name} vs ${m.awayTeam?.name}`
              )} (${escapeHtmlAttr(m.league || 'Live')}) Online Free HD</a></li>`
          )
          .join('')}</ul></article></noscript>`;
      } else if (liveChannelRoute) {
        const rawChannelId = decodeURIComponent(liveChannelRoute[1]).toLowerCase();
        const chEntry =
          LIVE_CHANNEL_DIRECTORY[rawChannelId] ||
          Object.values(LIVE_CHANNEL_DIRECTORY).find((c) => c.channelId.toLowerCase() === rawChannelId);

        const channelId = chEntry?.channelId || rawChannelId;
        const channelName = chEntry?.name || rawChannelId.replace(/-/g, ' ').toUpperCase();
        const cleanName = channelName.replace(/\s*\([^)]*\)/g, '').trim();
        const langLabel = chEntry?.languageLabel || 'English';
        const langCode = chEntry?.language || 'en';

        pageTitle = `Watch ${cleanName} (${langLabel}) Live Stream 24/7 Free in 1080p HD | Notflix Arena`;
        pageDesc = `Watch ${channelName} live stream 24/7 online free in 1080p Full HD on Notflix Arena. Instant multi-mirror sports, football, and entertainment broadcast.`;
        canonicalUrl = `https://notflixtv.com${buildLiveChannelSeoPath(channelId)}`;
        if (chEntry?.logo && chEntry.logo.startsWith('http')) {
          ogImage = chEntry.logo;
        }

        const tvChannelSchema = {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'TelevisionChannel',
              '@id': `${canonicalUrl}#channel`,
              name: channelName,
              url: canonicalUrl,
              image: chEntry?.logo?.startsWith('http') ? chEntry.logo : ogImage,
              description: pageDesc,
              inLanguage: langCode,
              providesBroadcastService: {
                '@type': 'BroadcastService',
                name: `${cleanName} 24/7 HD Live Stream`,
                broadcastDisplayName: cleanName,
                videoFormat: '1080p HD',
                inLanguage: langCode,
                broadcaster: {
                  '@type': 'Organization',
                  name: 'Notflix Live Arena',
                  url: 'https://notflixtv.com/live',
                },
              },
            },
            {
              '@type': 'BroadcastEvent',
              name: `${cleanName} 24/7 Live Broadcast`,
              isLiveBroadcast: true,
              videoFormat: '1080p HD',
              inLanguage: langCode,
              publishedOn: {
                '@id': `${canonicalUrl}#channel`,
              },
              potentialAction: {
                '@type': 'WatchAction',
                target: {
                  '@type': 'EntryPoint',
                  urlTemplate: canonicalUrl,
                  actionPlatform: [
                    'http://schema.org/DesktopWebPlatform',
                    'http://schema.org/MobileWebPlatform',
                    'http://schema.org/IOSPlatform',
                    'http://schema.org/AndroidPlatform',
                  ],
                },
              },
            },
          ],
        };
        extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(tvChannelSchema)}</script>`;

        const allChannelsList = Object.values(LIVE_CHANNEL_DIRECTORY);
        noscriptCatalogHtml = `<noscript><article><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
          pageDesc
        )}</p><h2>All 24/7 Live Sports &amp; TV Channels on Notflix Arena</h2><ul>${allChannelsList
          .map(
            (c) =>
              `<li><a href="https://notflixtv.com${buildLiveChannelSeoPath(c.channelId)}">Watch ${escapeHtmlAttr(
                c.name
              )} Live Stream 24/7 HD</a></li>`
          )
          .join('')}</ul></article></noscript>`;
      } else if (isLiveHubRoute) {
        pageTitle =
          'Notflix Arena — Watch Live Sports, Football Matches & 24/7 TV Channels Free in 1080p HD';
        pageDesc =
          'Watch live football matches (UEFA Champions League, Premier League, La Liga, Serie A, Saudi Pro League), NBA, UFC, F1 & 102+ 24/7 live TV channels (beIN Sports, Sky Sports, ESPN, SSC) free in 1080p HD.';
        canonicalUrl = 'https://notflixtv.com/live';

        const livePayload = await getOrRefreshLiveEventsPayload(180000);
        const liveMatches = Array.isArray(livePayload?.events) ? livePayload.events : [];
        const allChannelsList = Object.values(LIVE_CHANNEL_DIRECTORY);

        const arenaSchema = {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'CollectionPage',
              '@id': 'https://notflixtv.com/live#webpage',
              name: pageTitle,
              description: pageDesc,
              url: 'https://notflixtv.com/live',
              isPartOf: {
                '@type': 'WebSite',
                name: 'Notflix',
                url: 'https://notflixtv.com/',
              },
            },
            {
              '@type': 'ItemList',
              name: 'Live & Upcoming Sports Matches on Notflix Arena',
              itemListElement: liveMatches.slice(0, 30).map((ev: any, idx: number) => ({
                '@type': 'ListItem',
                position: idx + 1,
                item: {
                  '@type': 'SportsEvent',
                  name:
                    ev.homeTeam?.name && ev.awayTeam?.name
                      ? `${ev.homeTeam.name} vs ${ev.awayTeam.name} (${ev.league || 'Live'})`
                      : ev.title,
                  url: `https://notflixtv.com${buildLiveMatchSeoPath(ev)}`,
                  startDate: ev.startTime || new Date().toISOString(),
                  eventStatus:
                    String(ev.status || '').toUpperCase() === 'LIVE'
                      ? 'https://schema.org/EventInProgress'
                      : 'https://schema.org/EventScheduled',
                  homeTeam: { '@type': 'SportsTeam', name: ev.homeTeam?.name || 'Home' },
                  awayTeam: { '@type': 'SportsTeam', name: ev.awayTeam?.name || 'Away' },
                },
              })),
            },
            {
              '@type': 'ItemList',
              name: '24/7 Live Sports & Entertainment TV Channels',
              itemListElement: allChannelsList.slice(0, 40).map((ch, idx) => ({
                '@type': 'ListItem',
                position: idx + 1,
                url: `https://notflixtv.com${buildLiveChannelSeoPath(ch.channelId)}`,
                name: `${ch.name} (${ch.languageLabel})`,
              })),
            },
          ],
        };
        extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(arenaSchema)}</script>`;

        noscriptCatalogHtml = `<noscript><section><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
          pageDesc
        )}</p><nav aria-label="Live Sports Matches Today"><h2>Live &amp; Upcoming Sports Matches</h2><ul>${liveMatches
          .slice(0, 40)
          .map(
            (ev: any) =>
              `<li><a href="https://notflixtv.com${buildLiveMatchSeoPath(ev)}">Watch ${escapeHtmlAttr(
                ev.homeTeam?.name && ev.awayTeam?.name
                  ? `${ev.homeTeam.name} vs ${ev.awayTeam.name}`
                  : ev.title || 'Live Match'
              )} — ${escapeHtmlAttr(ev.league || 'Live Sports')} Free HD</a></li>`
          )
          .join(
            ''
          )}</ul></nav><nav aria-label="24/7 Live Sports TV Channels Directory"><h2>24/7 Live TV Channels (beIN Sports, Sky Sports, ESPN, SSC, MBC)</h2><ul>${allChannelsList
          .map(
            (ch) =>
              `<li><a href="https://notflixtv.com${buildLiveChannelSeoPath(ch.channelId)}">Watch ${escapeHtmlAttr(
                ch.name
              )} Live Stream 24/7 HD</a></li>`
          )
          .join('')}</ul></nav></section></noscript>`;
      } else {
        if (cleanPath.startsWith('/movies')) {
          pageTitle = 'Watch Movies Online Free in HD (1080p & 4K) — New & Trending Films | Notflix';
          pageDesc =
            'Stream the latest Hollywood blockbusters, top-rated movies, and trending films online free in 1080p and 4K HD with multi-language subtitles on Notflix.';
        } else if (cleanPath.startsWith('/series') || cleanPath.startsWith('/tv')) {
          pageTitle = 'Watch TV Series & Full Seasons Online Free in HD | Notflix';
          pageDesc =
            'Binge-watch full seasons and latest episodes of trending TV series online free in 1080p HD with English, Arabic, and multi-language subtitles on Notflix.';
        } else if (cleanPath.startsWith('/anime')) {
          pageTitle = 'Watch Anime Online Free in HD (English Sub & Dub) | Notflix';
          pageDesc =
            'Stream top-rated and trending Japanese anime series and movies online in 1080p HD with English, Arabic, and multi-language subtitles on Notflix.';
        } else if (cleanPath.startsWith('/search')) {
          pageTitle = 'Search Movies, TV Shows, Anime & Live Sports Online in HD | Notflix';
          pageDesc =
            'Search and stream any movie, TV series, anime, or live football match in 1080p HD with instant multi-language subtitles on Notflix.';
        }

        // Inject crawlable ItemList Schema.org + semantic links for Googlebot discovery (Movies/Series + Live Arena)
        const catalogSample = seoCatalogCache.entries.slice(0, 50);
        const liveMatchesSample = Array.isArray(cachedLiveEventsPayload?.data?.events)
          ? cachedLiveEventsPayload!.data.events.slice(0, 15)
          : [];
        const topChannelsSample = Object.values(LIVE_CHANNEL_DIRECTORY).slice(0, 20);

        if (catalogSample.length > 0 || liveMatchesSample.length > 0) {
          const itemListSchema = {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            name: pageTitle,
            itemListElement: [
              {
                '@type': 'ListItem',
                position: 1,
                url: 'https://notflixtv.com/live',
                name: 'Notflix Live Arena — Live Football Matches & 24/7 Sports TV Channels',
              },
              ...catalogSample.slice(0, 29).map((entry, idx) => ({
                '@type': 'ListItem',
                position: idx + 2,
                url: `https://notflixtv.com${entry.path}`,
                name: `${entry.title}${entry.year ? ` (${entry.year})` : ''}`,
              })),
            ],
          };
          extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(itemListSchema)}</script>`;
          noscriptCatalogHtml = `<noscript><section><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
            pageDesc
          )}</p><nav aria-label="Notflix Live Arena Sports and TV Directory"><h2><a href="https://notflixtv.com/live">Notflix Live Arena — Live Matches &amp; 24/7 Sports Channels</a></h2><ul>${liveMatchesSample
            .map(
              (ev: any) =>
                `<li><a href="https://notflixtv.com${buildLiveMatchSeoPath(ev)}">Watch ${escapeHtmlAttr(
                  ev.homeTeam?.name && ev.awayTeam?.name
                    ? `${ev.homeTeam.name} vs ${ev.awayTeam.name}`
                    : ev.title || 'Live Match'
                )} Live Stream HD</a></li>`
            )
            .join('')}${topChannelsSample
            .map(
              (ch) =>
                `<li><a href="https://notflixtv.com${buildLiveChannelSeoPath(ch.channelId)}">Watch ${escapeHtmlAttr(
                  ch.name
                )} Live 24/7 HD</a></li>`
            )
            .join(
              ''
            )}</ul></nav><nav aria-label="Trending Movies and TV Series Directory"><ul>${catalogSample
            .map(
              (entry) =>
                `<li><a href="https://notflixtv.com${entry.path}">Watch ${escapeHtmlAttr(entry.title)}${
                  entry.year ? ` (${entry.year})` : ''
                } ${entry.type === 'tv' ? 'TV Series' : 'Full Movie'} Online Free HD</a></li>`
            )
            .join('')}</ul></nav></section></noscript>`;
        }
      }

      const safeTitle = escapeHtmlAttr(pageTitle);
      const safeDesc = escapeHtmlAttr(pageDesc);
      const safeUrl = escapeHtmlAttr(canonicalUrl);
      const safeImg = escapeHtmlAttr(ogImage);

      let modified = rawHtml
        .replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`)
        .replace(
          /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
          `<meta name="description" content="${safeDesc}" />`
        )
        .replace(
          /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i,
          `<link rel="canonical" href="${safeUrl}" />`
        )
        .replace(
          /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i,
          `<meta property="og:title" content="${safeTitle}" />`
        )
        .replace(
          /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i,
          `<meta property="og:description" content="${safeDesc}" />`
        )
        .replace(
          /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i,
          `<meta property="og:url" content="${safeUrl}" />`
        )
        .replace(
          /<meta\s+property="og:image"\s+content="[^"]*"\s*\/?>/i,
          `<meta property="og:image" content="${safeImg}" />`
        )
        .replace(
          /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/i,
          `<meta name="twitter:title" content="${safeTitle}" />`
        )
        .replace(
          /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/i,
          `<meta name="twitter:description" content="${safeDesc}" />`
        )
        .replace(
          /<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/?>/i,
          `<meta name="twitter:image" content="${safeImg}" />`
        );

      if (extraJsonLd) {
        modified = modified.replace('</head>', `  ${extraJsonLd}\n  </head>`);
      }
      if (noscriptCatalogHtml) {
        modified = modified.replace('<div id="root"></div>', `<div id="root"></div>\n    ${noscriptCatalogHtml}`);
      }

      return modified;
    } catch {
      return rawHtml;
    }
  }

  const ROBOTS_TXT = `User-agent: *
Allow: /
Allow: /live
Allow: /live/match/
Allow: /live/channel/
Allow: /watch/
Allow: /movies
Allow: /series
Allow: /anime
Allow: /search
Disallow: /admin
Disallow: /api/admin/

Sitemap: https://notflixtv.com/sitemap.xml
`;

  app.get('/robots.txt', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.status(200).send(ROBOTS_TXT);
  });

  app.get('/sitemap.xml', async (_req: Request, res: Response) => {
    try {
      const xml = await buildDynamicSitemapXml();
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=1800');
      return res.status(200).send(xml);
    } catch {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(200).send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://notflixtv.com/</loc></url></urlset>`
      );
    }
  });

  // GET /api/admin/seo/status - Returns live Programmatic SEO & Sitemap metrics for Admin Dashboard
  app.get('/api/admin/seo/status', requireAdminAuth, async (req: Request, res: Response) => {
    const force = req.query.refresh === '1';
    const [entries, livePayload] = await Promise.all([
      refreshSeoCatalog(force),
      getOrRefreshLiveEventsPayload(force ? 0 : 120000),
    ]);
    const moviesCount = entries.filter((e) => e.type === 'movie').length;
    const tvCount = entries.filter((e) => e.type === 'tv').length;
    const liveMatchesCount = Array.isArray(livePayload?.events) ? livePayload.events.length : 0;
    const allChannels = Object.values(LIVE_CHANNEL_DIRECTORY);
    const liveChannelsCount = allChannels.length;
    return res.json({
      success: true,
      totalUrls: entries.length + liveMatchesCount + liveChannelsCount + 6,
      moviesCount,
      tvCount,
      liveMatchesCount,
      liveChannelsCount,
      updatedAt: seoCatalogCache.updatedAt || Date.now(),
      sitemapUrl: 'https://notflixtv.com/sitemap.xml',
      sampleUrls: [
        {
          title: 'Notflix Live Arena — Live Football & 24/7 Sports TV Hub',
          url: 'https://notflixtv.com/live',
          type: 'live',
        },
        ...(Array.isArray(livePayload?.events) ? livePayload.events.slice(0, 2) : []).map((ev: any) => ({
          title: `${ev.homeTeam?.name || ''} vs ${ev.awayTeam?.name || ''} (${ev.league || 'Live'})`,
          url: `https://notflixtv.com${buildLiveMatchSeoPath(ev)}`,
          type: 'live-match',
        })),
        ...allChannels.slice(0, 2).map((ch) => ({
          title: `${ch.name} — 24/7 Live Broadcast`,
          url: `https://notflixtv.com${buildLiveChannelSeoPath(ch.channelId)}`,
          type: 'live-channel',
        })),
        ...entries.slice(0, 4).map((e) => ({
          title: `${e.title}${e.year ? ` (${e.year})` : ''}`,
          url: `https://notflixtv.com${e.path}`,
          type: e.type,
        })),
      ],
    });
  });

  // GET /api/admin/live-arena/status - Returns real-time Live Arena matches, channels, categories & SEO metrics for Admin Dashboard
  app.get('/api/admin/live-arena/status', requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const force = req.query.refresh === '1';
      if (force) {
        cachedLiveEventsPayload = null;
        cachedLiveChannelsPayload = null;
      }
      const livePayload = await getOrRefreshLiveEventsPayload(force ? 0 : 90000);
      const eventsList = Array.isArray(livePayload?.events) ? livePayload.events : [];
      const allChannels = Object.values(LIVE_CHANNEL_DIRECTORY);

      const liveNowCount = eventsList.filter(
        (ev: any) => String(ev?.status || '').toUpperCase() === 'LIVE'
      ).length;
      const upcomingCount = eventsList.filter(
        (ev: any) => String(ev?.status || '').toUpperCase() === 'UPCOMING'
      ).length;
      const finishedCount = eventsList.filter(
        (ev: any) => String(ev?.status || '').toUpperCase() === 'FT'
      ).length;

      const activeLeagues = Array.from(
        new Set(
          eventsList
            .map((ev: any) => String(ev?.league || '').trim())
            .filter(Boolean)
        )
      );

      const groupCounts: Record<string, number> = {};
      for (const ch of allChannels) {
        const g = ch.group || 'Sports';
        groupCounts[g] = (groupCounts[g] || 0) + 1;
      }

      const now = Date.now();
      let activeArenaViewers = 0;
      activeLiveViewers.forEach((v) => {
        if (now - v.lastPing <= 75000 && v.mediaType === 'live') {
          activeArenaViewers++;
        }
      });

      const formattedEvents = eventsList.slice(0, 30).map((ev: any) => ({
        id: ev.id,
        title:
          ev.homeTeam?.name && ev.awayTeam?.name
            ? `${ev.homeTeam.name} vs ${ev.awayTeam.name}`
            : ev.title || 'Live Match',
        sport: ev.sport || 'Soccer',
        league: ev.league || 'Football',
        leagueLogo: ev.leagueLogo || '',
        status: ev.status || 'UPCOMING',
        statusDetail: ev.statusDetail || '',
        startTime: ev.startTime || '',
        homeTeam: ev.homeTeam,
        awayTeam: ev.awayTeam,
        seoPath: buildLiveMatchSeoPath(ev),
        seoUrl: `https://notflixtv.com${buildLiveMatchSeoPath(ev)}`,
        recommendedChannels: Array.isArray(ev.recommendedChannels)
          ? ev.recommendedChannels.map((rc: any) => ({
              channelId: rc.channelId,
              name: rc.name,
              language: rc.language,
              languageLabel: rc.languageLabel,
              logo: rc.logo,
            }))
          : [],
      }));

      const formattedChannels = allChannels.map((ch) => ({
        channelId: ch.channelId,
        name: ch.name,
        group: ch.group,
        language: ch.language,
        languageLabel: ch.languageLabel,
        logo: ch.logo,
        seoPath: buildLiveChannelSeoPath(ch.channelId),
        seoUrl: `https://notflixtv.com${buildLiveChannelSeoPath(ch.channelId)}`,
      }));

      return res.json({
        success: true,
        updatedAt: livePayload?.updatedAt || Date.now(),
        totalEvents: eventsList.length,
        liveNowCount,
        upcomingCount,
        finishedCount,
        totalChannels: allChannels.length,
        activeArenaViewers,
        activeLeagues,
        channelGroups: groupCounts,
        events: formattedEvents,
        channels: formattedChannels,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to load Live Arena status',
      });
    }
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
      appType: 'custom',
    });
    app.use(vite.middlewares);

    // Single-Page Application (SPA) catch-all route for development mode with Dynamic SSR SEO Meta injection
    app.use('*', async (req: Request, res: Response, next: NextFunction) => {
      if (req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/downloads')) {
        return next();
      }
      try {
        setNoStoreHtmlHeaders(res);
        const indexPath = path.resolve(__dirname, 'index.html');
        let template = fs.readFileSync(indexPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        template = await injectDynamicSeoIntoHtml(template, req.originalUrl || req.path);
        res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(template);
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

    // Single-Page Application (SPA) catch-all route with Server-Side SEO Pre-Rendering for /, /live*, /watch/:type/:id, /movies, /series, /anime
    app.get('*', async (req: Request, res: Response) => {
      setNoStoreHtmlHeaders(res);
      const prodIndex = path.join(distPath, 'index.html');
      const rootIndex = path.join(__dirname, 'index.html');
      const targetIndex = fs.existsSync(prodIndex) ? prodIndex : rootIndex;
      try {
        const rawHtml = fs.readFileSync(targetIndex, 'utf-8');
        const seoHtml = await injectDynamicSeoIntoHtml(rawHtml, req.originalUrl || req.path);
        return res.status(200).type('text/html; charset=utf-8').send(seoHtml);
      } catch {
        return res.sendFile(targetIndex, { etag: false, lastModified: false });
      }
    });

    console.log(`📦 Serving production build from ${distPath} (version: ${DEPLOYMENT_VERSION})`);
  }

  // Before binding port 3000 and passing healthcheck, pull live Analytics & Blocked IPs from the outgoing container
  await pullStateFromLivePeerOnStartup().catch(() => {});

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
