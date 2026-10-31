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
  const ua = String(req.headers['user-agent'] || '');
  const isSearchCrawler =
    /googlebot|bingbot|yandex|baiduspider|duckduckbot|slurp|applebot|twitterbot|facebookexternalhit|linkedinbot|telegrambot|whatsapp|discordbot/i.test(
      ua
    );
  const isHtmlNav =
    req.method === 'GET' &&
    !req.path.startsWith('/api/') &&
    !req.path.startsWith('/assets/') &&
    !req.path.startsWith('/v1/') &&
    (accept.includes('text/html') || req.path === '/' || req.path.startsWith('/admin'));

  if (isHtmlNav && req.headers.cookie && !isSearchCrawler) {
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

const DEFAULT_SCRAPER_CINEPRO_URL = (process.env.SCRAPER_CINEPRO_URL || 'http://62.171.179.144:3002')
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

// Legitimate Search Engine & Social Preview Crawler Whitelist (Preserves SEO, Rich Results, and Social Cards)
const SEARCH_ENGINE_BOTS = [
  /googlebot/i,
  /google-inspectiontool/i,
  /googleother/i,
  /google-extended/i,
  /storebot-google/i,
  /adsbot-google/i,
  /mediapartners-google/i,
  /apis-google/i,
  /google-read-aloud/i,
  /google-safety/i,
  /google-site-verification/i,
  /chrome-lighthouse/i,
  /bingbot/i,
  /bingpreview/i,
  /msnbot/i,
  /adidxbot/i,
  /duckduckbot/i,
  /yandex/i,
  /baiduspider/i,
  /applebot/i,
  /slurp/i,
  /linkedinbot/i,
  /twitterbot/i,
  /facebookexternalhit/i,
  /facebot/i,
  /telegrambot/i,
  /whatsapp/i,
  /discordbot/i,
  /slackbot/i,
  /pinterestbot/i,
  /petalbot/i,
  /seznambot/i,
  /qwantify/i,
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

  // Self-heal: remove any accidentally banned search engine crawler or standard human browser (e.g. mobile CGNAT IP)
  for (const [bannedIp, rec] of permanentlyBannedIps.entries()) {
    if (
      isLegitimateSearchCrawler(rec.userAgent || '') ||
      (rec.category !== 'manual' &&
        isStandardHumanBrowser(rec.userAgent || '') &&
        !isDataInterceptionProbePath(rec.path || ''))
    ) {
      permanentlyBannedIps.delete(bannedIp);
      unblockedIpTombstones.set(bannedIp, Date.now());
      purgedLegacyV1Bans = true;
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

  // 4. Always allow whitelisted legitimate search engine & social preview crawlers FIRST (Googlebot, Google-InspectionTool, Bingbot, TelegramBot, etc.)
  if (isLegitimateSearchCrawler(userAgent)) {
    return next();
  }

  // 5. Enforce Permanent IP Blacklist across the entire website (HTML pages, APIs, and Stream Proxies)
  const existingBan = permanentlyBannedIps.get(ip);
  if (existingBan) {
    existingBan.blockedAttempts += 1;
    existingBan.lastAttemptAt = Date.now();
    securityMetrics.totalBlockedScrapers++;
    scheduleSavePermanentBans();
    return sendPermanentBlockResponse(req, res, existingBan);
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
  'voyeur', 'erotic thriller', 'hentai', 'ecchi', 'nymphomaniac', 'vivamax', 'jav', 'onlyfans',
  'camgirl', 'stripper', 'prostitute', 'prostitution', 'brothel', 'courtesan', 'call girl',
  'escort girl', 'sugar baby', 'sugar daddy', 'friends with benefits', 'one night stand',
  'sex life', 'sex/life', 'sex education', 'masters of sex', 'high school dxd', 'redo of healer',
  'interspecies reviewers', 'worlds end harem', "world's end harem", 'prison school',
  'testament of sister new devil', 'to love-ru', 'to love ru', 'monster musume', 'valkyrie drive',
  'queen blade', "queen's blade", 'seikon no qwaser', 'kiss x sis', 'yosuga no sora',
  'boku no pico', 'overflow', 'euphoria', 'californication', 'the idol', 'tell me lies',
  'fellow travelers', 'queer as folk', 'the l word', 'heartstopper', 'young royals',
  'red white & royal blue', 'red, white & royal blue', 'call me by your name', 'brokeback mountain',
  'blue is the warmest colour', 'blue is the warmest color', '9 songs', 'emmanuelle',
  'caligula', 'last tango in paris', 'showgirls', 'basic instinct', 'eyes wide shut',
  'unfaithful', 'after we collided', 'after we fell', 'after ever happy', 'after everything',
  'poor things', 'anora', 'babygirl', 'saltburn'
];

const BLOCKED_EXACT_TITLES = new Set([
  'elite',
  'élite',
  'euphoria',
  'sex/life',
  'sex education',
  'shameless',
  'californication',
  'bridgerton',
  'normal people',
  'the idol',
  'tell me lies',
  'heartstopper',
  'young royals',
  '365 days',
  '365 dni',
  '365 days: this day',
  'the next 365 days',
  'fifty shades of grey',
  'fifty shades darker',
  'fifty shades freed',
  'nymphomaniac: vol. i',
  'nymphomaniac: vol. ii',
  'nymphomaniac',
  'showgirls',
  'basic instinct',
  'basic instinct 2',
  'eyes wide shut',
  'blue is the warmest colour',
  'blue is the warmest color',
  '9 songs',
  'the dreamers',
  'unfaithful',
  'original sin',
  'wild things',
  'secretary',
  'poor things',
  'anora',
  'babygirl',
  'saltburn',
  'challengers',
  'call me by your name',
  'brokeback mountain',
  'portrait of a lady on fire',
  'carol',
  'moonlight',
  'high school dxd',
  'redo of healer',
  'interspecies reviewers',
  'overflow',
  'boku no pico',
  'yosuga no sora',
  'kiss x sis',
  'domestic girlfriend',
  "scum's wish",
  'citrus'
]);

const safePattern = new RegExp(
  `\\b(${ADULT_BLOCKLIST.map((w) => w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b|\\bsex(?!\\s*(trafficking|crime|worker|trade|slave|offender|predator|abuse|assault))\\b`,
  'i'
);

const ADULT_KEYWORDS = [
  'erotic', 'erotica', 'pornography', 'porn', 'softcore', 'hardcore porn',
  'explicit sex', 'unsimulated sex', 'sexual content', 'bdsm', 'erotic thriller',
  'fetish', 'kama sutra', 'masturbation', 'orgasm', 'hentai', 'ecchi', 'nude', 'nudity',
  'penetration', 'seduction', 'menage a trois', 'threesome', 'infidelity',
  'gay', 'lesbian', 'lgbt', 'gay theme', 'sexuality', 'sensuality', 'lust', 'sexy',
  'striptease', 'voyeur', 'adultery', 'erotic drama', 'erotic comedy', 'female nudity',
  'male nudity', 'full frontal nudity', 'sex scene', 'sexual awakening', 'sexual obsession',
  'sex addiction', 'nymphomania', 'prostitution', 'stripper', 'brothel', 'swingers',
  'forbidden love', 'steamy', 'polyamory', 'yaoi', 'yuri', 'boys love', 'girls love'
];
const kwPattern = new RegExp(`\\b(${ADULT_KEYWORDS.join('|')})\\b`, 'i');

const EXPLICIT_ADULT_KEYWORDS = [
  'erotic', 'erotica', 'pornography', 'porn', 'softcore', 'hardcore porn',
  'explicit sex', 'unsimulated sex', 'sexual content', 'bdsm', 'fetish',
  'kama sutra', 'masturbation', 'orgasm', 'hentai', 'ecchi', 'nude', 'nudity',
  'penetration', 'menage a trois', 'threesome', 'yaoi', 'yuri', 'futanari'
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

  const title = (item.title || item.name || '').toLowerCase().trim();
  const origTitle = (item.original_title || item.original_name || '').toLowerCase().trim();
  const desc = (item.overview || item.desc || '').toLowerCase();

  // Allow "The Passion of the Christ"
  if (title.includes('passion of the christ') || origTitle.includes('passion of the christ')) return true;

  if (BLOCKED_EXACT_TITLES.has(title) || (origTitle && BLOCKED_EXACT_TITLES.has(origTitle))) {
    return false;
  }

  if (safePattern.test(title) || (origTitle && safePattern.test(origTitle)) || safePattern.test(desc)) return false;

  let kwds: any[] = [];
  if (item.keywords) {
    kwds = item.keywords.results || item.keywords.keywords || [];
  }
  const kwTester = isAnimation ? explicitKwPattern : kwPattern;
  if (kwds.some((k: any) => k?.name && kwTester.test(k.name))) return false;

  // Check certifications if appended (NC-17, XXX, R18+, R18, X)
  const certs: string[] = [];
  if (item.release_dates?.results && Array.isArray(item.release_dates.results)) {
    item.release_dates.results.forEach((r: any) => {
      if (Array.isArray(r.release_dates)) {
        r.release_dates.forEach((rd: any) => {
          if (rd?.certification) certs.push(rd.certification);
        });
      }
    });
  }
  if (item.content_ratings?.results && Array.isArray(item.content_ratings.results)) {
    item.content_ratings.results.forEach((r: any) => {
      if (r?.rating) certs.push(r.rating);
    });
  }
  const badCerts = ['NC-17', 'XXX', 'R18+', 'R18', 'X'];
  if (certs.some((c) => typeof c === 'string' && badCerts.includes(c.trim().toUpperCase()))) {
    return false;
  }

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
// 2. TMDB PROXY WITH CACHING, RETRY & SAFE FILTER
// ==========================================
async function fetchTmdbJsonWithRetry(
  url: string,
  fallbackGatewayUrl?: string,
  maxRetries = 2
): Promise<{ ok: boolean; status: number; data: any }> {
  const headers = {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7500);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers,
      });
      clearTimeout(timer);
      if (response.ok) {
        const data = await response.json();
        return { ok: true, status: 200, data };
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return { ok: false, status: response.status, data: null };
      }
    } catch {
      clearTimeout(timer);
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }

  // Fallback to Coolify Gateway mirror if direct api.themoviedb.org connection failed
  if (fallbackGatewayUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const gwRes = await fetch(fallbackGatewayUrl, {
        signal: controller.signal,
        headers,
      });
      clearTimeout(timer);
      if (gwRes.ok) {
        const data = await gwRes.json();
        return { ok: true, status: 200, data };
      }
    } catch {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: 502, data: null };
}

const tmdbRefreshInFlight = new Map<string, Promise<any>>();

async function fetchAndCacheTmdbEndpoint(
  tmdbPath: string,
  paramsObj: Record<string, string> = {}
): Promise<any> {
  const queryParams = new URLSearchParams(paramsObj);
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
  const now = Date.now();

  const doRefresh = async () => {
    if (tmdbRefreshInFlight.has(cacheKey)) {
      return tmdbRefreshInFlight.get(cacheKey)!;
    }
    const task = (async () => {
      const url = `${TMDB_BASE}/${tmdbPath}?${queryParams.toString()}`;
      const gatewayBase = getGatewayFallbackUrl();
      const fallbackGatewayUrl = gatewayBase
        ? `${gatewayBase}/api/tmdb/${tmdbPath}?${queryParams.toString()}`
        : undefined;

      const result = await fetchTmdbJsonWithRetry(url, fallbackGatewayUrl, 2);
      if (!result.ok || !result.data) {
        if (cached?.data) return cached.data;
        return { page: 1, results: [], genres: [], cast: [], crew: [], videos: { results: [] } };
      }

      const data = result.data;
      if (Array.isArray(data.results)) {
        data.results = data.results.filter(isSafe);
      } else if (data.id && !isSafe(data)) {
        return { error: 'This title is restricted by safety filters.', blockedBySafeFilter: true };
      }

      apiCache.set(cacheKey, { timestamp: Date.now(), data });
      return data;
    })().finally(() => {
      tmdbRefreshInFlight.delete(cacheKey);
    });
    tmdbRefreshInFlight.set(cacheKey, task);
    return task;
  };

  if (cached) {
    if (now - cached.timestamp >= CACHE_TTL_MS) {
      // Stale-While-Revalidate: return cached response in <1ms and refresh in background
      doRefresh().catch(() => {});
    }
    return cached.data;
  }

  return doRefresh();
}

let cachedHomeCatalogPayload: { timestamp: number; data: any } | null = null;
let homeCatalogRefreshInFlight: Promise<any> | null = null;
const HOME_CATALOG_TTL_MS = 10 * 60 * 1000; // 10 minutes fresh window

async function getOrRefreshHomeCatalogPayload(force = false): Promise<any> {
  const now = Date.now();
  if (!force && cachedHomeCatalogPayload) {
    if (now - cachedHomeCatalogPayload.timestamp >= HOME_CATALOG_TTL_MS && !homeCatalogRefreshInFlight) {
      homeCatalogRefreshInFlight = refreshHomeCatalogInternal().finally(() => {
        homeCatalogRefreshInFlight = null;
      });
    }
    return cachedHomeCatalogPayload.data;
  }
  if (!homeCatalogRefreshInFlight) {
    homeCatalogRefreshInFlight = refreshHomeCatalogInternal().finally(() => {
      homeCatalogRefreshInFlight = null;
    });
  }
  return homeCatalogRefreshInFlight;
}

async function refreshHomeCatalogInternal(): Promise<any> {
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
    fetchAndCacheTmdbEndpoint('trending/movie/day'),
    fetchAndCacheTmdbEndpoint('trending/tv/day'),
    fetchAndCacheTmdbEndpoint('trending/movie/week'),
    fetchAndCacheTmdbEndpoint('trending/tv/week'),
    fetchAndCacheTmdbEndpoint('movie/top_rated'),
    fetchAndCacheTmdbEndpoint('discover/tv', { with_networks: '49', sort_by: 'popularity.desc' }),
    fetchAndCacheTmdbEndpoint('discover/tv', { with_networks: '2739', sort_by: 'popularity.desc' }),
    fetchAndCacheTmdbEndpoint('discover/movie', { with_companies: '420', sort_by: 'popularity.desc' }),
    fetchAndCacheTmdbEndpoint('discover/tv', { with_networks: '2552', sort_by: 'popularity.desc' }),
    fetchAndCacheTmdbEndpoint('discover/tv', { with_networks: '1024', sort_by: 'popularity.desc' }),
  ]);

  const payload = {
    success: true,
    updatedAt: Date.now(),
    trendDayM: trendDayM?.results || [],
    trendDayT: trendDayT?.results || [],
    trendWeekM: trendWeekM?.results || [],
    trendWeekT: trendWeekT?.results || [],
    topR: topR?.results || [],
    hboData: hboData?.results || [],
    disneyData: disneyData?.results || [],
    marvelData: marvelData?.results || [],
    appleData: appleData?.results || [],
    amazonData: amazonData?.results || [],
  };

  if (payload.trendDayM.length > 0 || payload.trendDayT.length > 0) {
    cachedHomeCatalogPayload = { timestamp: Date.now(), data: payload };
  }
  return payload;
}

// Instant single-request Home Page Catalog endpoint (<2ms from pre-warmed RAM cache)
app.get('/api/catalog/home', async (_req: Request, res: Response) => {
  try {
    const data = await getOrRefreshHomeCatalogPayload(false);
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
    return res.json(data);
  } catch {
    if (cachedHomeCatalogPayload?.data) {
      return res.json(cachedHomeCatalogPayload.data);
    }
    return res.status(502).json({ success: false });
  }
});

app.get('/api/tmdb/*', async (req: Request, res: Response) => {
  try {
    const tmdbPath = String(req.params[0] || '').replace(/^\/+/, '');
    if (!tmdbPath || tmdbPath.includes('..') || !/^[a-zA-Z0-9/_-]+$/.test(tmdbPath)) {
      return res.status(400).json({ error: 'Invalid TMDB endpoint path' });
    }
    const data = await fetchAndCacheTmdbEndpoint(tmdbPath, req.query as Record<string, string>);
    if (data?.blockedBySafeFilter) {
      return res.status(403).json({ error: 'This title is restricted by safety filters.' });
    }
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
    return res.json(data);
  } catch {
    return res.json({ page: 1, results: [], genres: [], cast: [], crew: [], videos: { results: [] } });
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
  cleaned = cleaned.replace(/^https?:\/\/[^/\s"']+\/v1\/live\/master\//i, '/api/live/master/');
  cleaned = cleaned.replace(/^\/v1\/live\/master\//i, '/api/live/master/');
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
  'bein-sports-1-ar': { channelId: 'bein-sports-1-ar', name: 'beIN Sports 1 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://i.imgur.com/Vtk2cGI.png' },
  'bein-sports-2-ar': { channelId: 'bein-sports-2-ar', name: 'beIN Sports 2 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://i.imgur.com/vUJZSvs.png' },
  'bein-sports-3-ar': { channelId: 'bein-sports-3-ar', name: 'beIN Sports 3 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://i.imgur.com/UYSMao3.png' },
  'bein-sports-4-ar': { channelId: 'bein-sports-4-ar', name: 'beIN Sports 4 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://i.imgur.com/vwAgJNi.png' },
  'bein-sports-5-ar': { channelId: 'bein-sports-5-ar', name: 'beIN Sports 5 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://i.imgur.com/2Rha5aY.png' },
  'bein-sports-6-ar': { channelId: 'bein-sports-6-ar', name: 'beIN Sports 6 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://i.imgur.com/0wBdLYb.png' },
  'bein-sports-7-ar': { channelId: 'bein-sports-7-ar', name: 'beIN Sports 7 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://i.imgur.com/iODFwZi.png' },
  'bein-sports-8-ar': { channelId: 'bein-sports-8-ar', name: 'beIN Sports 8 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://i.imgur.com/CaFEyVn.png' },
  'bein-sports-9-ar': { channelId: 'bein-sports-9-ar', name: 'beIN Sports 9 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: 'https://assets.bein.com/mena/sites/3/2023/09/logos-_beINSPORTS9.png' },
  'bein-sports-open-ar': { channelId: 'bein-sports-open-ar', name: 'beIN Sports Open HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-mea.png` },
  'bein-sports-afc-ar': { channelId: 'bein-sports-afc-ar', name: 'beIN Sports AFC HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#f59e0b', 'beIN SPORTS', 'AFC HD', 'ASIA ELITE') },
  'bein-sports-premium-1-ar': { channelId: 'bein-sports-premium-1-ar', name: 'beIN Sports Premium 1 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-1-premium-mea.png` },
  'bein-sports-premium-2-ar': { channelId: 'bein-sports-premium-2-ar', name: 'beIN Sports Premium 2 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-2-premium-mea.png` },
  'bein-sports-premium-3-ar': { channelId: 'bein-sports-premium-3-ar', name: 'beIN Sports Premium 3 HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-3-premium-mea.png` },

  // beIN Sports English / French / Turkish / Spanish
  'bein-sports-xtra-en': { channelId: 'bein-sports-xtra-en', name: 'beIN SPORTS XTRA HD (English)', language: 'en', languageLabel: 'English', category: 'bein', logo: 'https://i.ibb.co/HT49GPmB/XTRA-2.png' },
  'bein-sports-en-1': { channelId: 'bein-sports-en-1', name: 'beIN Sports 1 English HD', language: 'en', languageLabel: 'English', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-1-english-mea.png` },
  'bein-sports-en-2': { channelId: 'bein-sports-en-2', name: 'beIN Sports 2 English HD', language: 'en', languageLabel: 'English', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-2-english-mea.png` },
  'bein-sports-en-3': { channelId: 'bein-sports-en-3', name: 'beIN Sports 3 English HD', language: 'en', languageLabel: 'English', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-3-english-mea.png` },
  'bein-sports-fr-1': { channelId: 'bein-sports-fr-1', name: 'beIN Sports 1 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: `${TV_LOGO_REPO}/countries/france/bein-sports-1-french-fr.png` },
  'bein-sports-fr-2': { channelId: 'bein-sports-fr-2', name: 'beIN Sports 2 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: `${TV_LOGO_REPO}/countries/france/bein-sports-2-french-fr.png` },
  'bein-sports-fr-3': { channelId: 'bein-sports-fr-3', name: 'beIN Sports 3 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: `${TV_LOGO_REPO}/countries/france/bein-sports-3-french-fr.png` },
  'bein-sports-max-4-fr': { channelId: 'bein-sports-max-4-fr', name: 'beIN Sports MAX 4 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-4-max-mea.png` },
  'bein-sports-max-5-fr': { channelId: 'bein-sports-max-5-fr', name: 'beIN Sports MAX 5 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-5-max-mea.png` },
  'bein-sports-max-6-fr': { channelId: 'bein-sports-max-6-fr', name: 'beIN Sports MAX 6 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-sports/bein-sports-6-max-mea.png` },
  'bein-sports-max-7-fr': { channelId: 'bein-sports-max-7-fr', name: 'beIN Sports MAX 7 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#e9d5ff', 'beIN SPORTS', 'MAX 7', 'FRANCE HD') },
  'bein-sports-max-8-fr': { channelId: 'bein-sports-max-8-fr', name: 'beIN Sports MAX 8 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#e9d5ff', 'beIN SPORTS', 'MAX 8', 'FRANCE HD') },
  'bein-sports-max-9-fr': { channelId: 'bein-sports-max-9-fr', name: 'beIN Sports MAX 9 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#e9d5ff', 'beIN SPORTS', 'MAX 9', 'FRANCE HD') },
  'bein-sports-max-10-fr': { channelId: 'bein-sports-max-10-fr', name: 'beIN Sports MAX 10 France HD (FR)', language: 'fr', languageLabel: 'French', category: 'bein', logo: makeSvgChannelBadge('#3b0764', '#581c87', '#e9d5ff', 'beIN SPORTS', 'MAX 10', 'FRANCE HD') },
  'bein-sports-1-tr': { channelId: 'bein-sports-1-tr', name: 'beIN Sports 1 Türkiye HD', language: 'tr', languageLabel: 'Turkish', category: 'bein', logo: 'https://i.imgur.com/Vtk2cGI.png' },
  'bein-sports-2-tr': { channelId: 'bein-sports-2-tr', name: 'beIN Sports 2 Türkiye HD', language: 'tr', languageLabel: 'Turkish', category: 'bein', logo: 'https://i.imgur.com/vUJZSvs.png' },
  'bein-sports-3-tr': { channelId: 'bein-sports-3-tr', name: 'beIN Sports 3 Türkiye HD', language: 'tr', languageLabel: 'Turkish', category: 'bein', logo: 'https://i.imgur.com/UYSMao3.png' },
  'bein-sports-4-tr': { channelId: 'bein-sports-4-tr', name: 'beIN Sports 4 Türkiye HD', language: 'tr', languageLabel: 'Turkish', category: 'bein', logo: 'https://i.imgur.com/vwAgJNi.png' },
  'bein-sports-5-tr': { channelId: 'bein-sports-5-tr', name: 'beIN Sports 5 Türkiye HD', language: 'tr', languageLabel: 'Turkish', category: 'bein', logo: 'https://i.imgur.com/2Rha5aY.png' },
  'bein-sports-haber-tr': { channelId: 'bein-sports-haber-tr', name: 'beIN Sports Haber HD (TR)', language: 'tr', languageLabel: 'Turkish', category: 'bein', logo: `${TV_LOGO_REPO}/countries/turkey/bein-sports-haber-tr.png` },
  'bein-sports-xtra-es': { channelId: 'bein-sports-xtra-es', name: 'beIN SPORTS XTRA en Español', language: 'es', languageLabel: 'Spanish', category: 'bein', logo: 'https://i.imgur.com/V562tpO.png' },

  // STARZPLAY Sports, Asia, CricLife & Cinema (Category: starzplay)
  'starzplay-sports-1-ar': { channelId: 'starzplay-sports-1-ar', name: 'STARZPLAY Sports 1 / AD Sports Premium 1 HD (Serie A Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'starzplay', logo: makeSvgChannelBadge('#0f172a', '#1e1b4b', '#38bdf8', 'STARZPLAY', 'SPORTS 1', 'SERIE A AR') },
  'starzplay-sports-2-ar': { channelId: 'starzplay-sports-2-ar', name: 'STARZPLAY Sports 2 / AD Sports Premium 2 HD (Serie A Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'starzplay', logo: makeSvgChannelBadge('#0f172a', '#1e1b4b', '#38bdf8', 'STARZPLAY', 'SPORTS 2', 'SERIE A AR') },
  'starzplay-sports-3-ar': { channelId: 'starzplay-sports-3-ar', name: 'STARZPLAY Sports 3 / UFC Arabia & Fight Night HD (Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'starzplay', logo: makeSvgChannelBadge('#0f172a', '#31102f', '#f43f5e', 'STARZPLAY', 'SPORTS 3', 'UFC & FIGHT HD') },
  'starzplay-asia-1-ar': { channelId: 'starzplay-asia-1-ar', name: 'STARZPLAY Sports Asia 1 / AD Sports Asia 1 HD (AFC Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'starzplay', logo: makeSvgChannelBadge('#0f172a', '#064e3b', '#34d399', 'STARZPLAY', 'ASIA 1', 'AFC ELITE AR') },
  'starzplay-asia-2-ar': { channelId: 'starzplay-asia-2-ar', name: 'STARZPLAY Sports Asia 2 / AD Sports Asia 2 HD (AFC Arabic)', language: 'ar', languageLabel: 'Arabic', category: 'starzplay', logo: makeSvgChannelBadge('#0f172a', '#064e3b', '#10b981', 'STARZPLAY', 'ASIA 2', 'AFC ELITE AR') },
  'starzplay-criclife-1': { channelId: 'starzplay-criclife-1', name: 'STARZPLAY CricLife 1 HD (Live Cricket, ICC & T20)', language: 'en', languageLabel: 'English', category: 'starzplay', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#fbbf24', 'STARZPLAY', 'CRICLIFE 1', 'CRICKET HD') },
  'starzplay-criclife-2': { channelId: 'starzplay-criclife-2', name: 'STARZPLAY CricLife 2 HD (International Cricket & IPL)', language: 'en', languageLabel: 'English', category: 'starzplay', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#f59e0b', 'STARZPLAY', 'CRICLIFE 2', 'CRICKET HD') },
  'starzplay-encore-hd': { channelId: 'starzplay-encore-hd', name: 'STARZPLAY Encore Movies & Series HD', language: 'en', languageLabel: 'English', category: 'starzplay', logo: makeSvgChannelBadge('#09090b', '#1e1b4b', '#a78bfa', 'STARZPLAY', 'ENCORE', 'MOVIES HD') },
  'starzplay-action-hd': { channelId: 'starzplay-action-hd', name: 'STARZPLAY Edge Action & Originals HD', language: 'en', languageLabel: 'English', category: 'starzplay', logo: makeSvgChannelBadge('#09090b', '#31102f', '#fb7185', 'STARZPLAY', 'ACTION', 'ORIGINALS HD') },

  // Algeria TV & Algerian Sports Channels (Category: algeria)
  'algeria-tv1-entv': { channelId: 'algeria-tv1-entv', name: 'TV1 Algérie — Programme National ENTV HD (الوطنية الجزائرية الأولى)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#065f46', '#022c22', '#f43f5e', 'ENTV ALGÉRIE', 'TV 1', 'الوطنية الأولى') },
  'algeria-tv2-canal': { channelId: 'algeria-tv2-canal', name: 'TV2 Canal Algérie HD (كنال ألجيري — التلفزيون الجزائري 2)', language: 'fr', languageLabel: 'French', category: 'algeria', logo: makeSvgChannelBadge('#065f46', '#064e3b', '#34d399', 'CANAL ALGÉRIE', 'TV 2', 'كنال ألجيري HD') },
  'algeria-tv3-news': { channelId: 'algeria-tv3-news', name: 'TV3 Algérie A3 HD (الجزائرية الثالثة الإخبارية)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#064e3b', '#0f172a', '#10b981', 'ALGÉRIE A3', 'TV 3', 'الجزائرية الثالثة') },
  'algeria-tv4-tamazight': { channelId: 'algeria-tv4-tamazight', name: 'TV4 Tamazight TV Algérie HD (القناة الأمازيغية الرابعة)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#065f46', '#1e3a8a', '#facc15', 'ALGÉRIE TV4', 'TAMAZIGHT', 'الأمازيغية HD') },
  'algeria-tv5-coran': { channelId: 'algeria-tv5-coran', name: 'TV5 Coran Algérie HD (قناة القرآن الكريم الجزائرية الخامسة)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#064e3b', '#022c22', '#fcd34d', 'ALGÉRIE TV5', 'CORAN HD', 'القرآن الكريم') },
  'algeria-tv6-youth': { channelId: 'algeria-tv6-youth', name: 'TV6 Algérie الشبابية HD (الجزائرية السادسة — الرياضة والشباب)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#047857', '#064e3b', '#fbbf24', 'ALGÉRIE SPORT', 'TV 6', 'الشبابية والرياضة') },
  'algeria-tv7-elmaarifa': { channelId: 'algeria-tv7-elmaarifa', name: 'TV7 El Maarifa Algérie HD (قناة المعرفة الجزائرية السابعة)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#1e3a8a', '#064e3b', '#38bdf8', 'ALGÉRIE TV7', 'EL MAARIFA', 'قناة المعرفة HD') },
  'algeria-tv8-edhakira': { channelId: 'algeria-tv8-edhakira', name: 'TV8 Edhakira Algérie HD (قناة الذاكرة الوطنية الجزائرية الثامنة)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#451a03', '#064e3b', '#f59e0b', 'ALGÉRIE TV8', 'EDHAKIRA', 'قناة الذاكرة HD') },
  'algeria-el-heddaf-tv': { channelId: 'algeria-el-heddaf-tv', name: 'El Heddaf TV Algérie Sport HD (قناة الهداف الرياضية الجزائرية)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#14532d', '#052e16', '#22c55e', 'ALGÉRIE SPORT', 'EL HEDDAF', 'قناة الهداف HD') },
  'algeria-al24-news': { channelId: 'algeria-al24-news', name: 'AL24 News Algérie HD (قناة الجزائر الدولية AL24)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#0f172a', '#064e3b', '#38bdf8', 'ALGÉRIE NEWS', 'AL24 HD', 'الجزائر الدولية') },
  'algeria-echorouk-tv': { channelId: 'algeria-echorouk-tv', name: 'Echorouk TV Algérie HD (قناة الشروق العامة الجزائرية)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#7f1d1d', '#450a0a', '#fb923c', 'ALGÉRIE TV', 'ECHOROUK', 'قناة الشروق HD') },
  'algeria-echorouk-news': { channelId: 'algeria-echorouk-news', name: 'Echorouk News Algérie HD (قناة الشروق نيوز الإخبارية)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#991b1b', '#450a0a', '#f87171', 'ECHOROUK', 'NEWS HD', 'الشروق نيوز') },
  'algeria-ennahar-tv': { channelId: 'algeria-ennahar-tv', name: 'Ennahar TV Algérie HD (قناة النهار الجزائرية)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#1e3a8a', '#0f172a', '#60a5fa', 'ALGÉRIE TV', 'ENNAHAR', 'قناة النهار HD') },
  'algeria-el-bilad-tv': { channelId: 'algeria-el-bilad-tv', name: 'El Bilad TV Algérie HD (قناة البلاد الجزائرية)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#0f172a', '#1e293b', '#34d399', 'ALGÉRIE TV', 'EL BILAD', 'قناة البلاد HD') },
  'algeria-samira-tv': { channelId: 'algeria-samira-tv', name: 'Samira TV Algérie HD (قناة سميرة الجزائرية للطبخ والأسرة)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#701a75', '#4a044e', '#f472b6', 'ALGÉRIE TV', 'SAMIRA TV', 'قناة سميرة HD') },
  'algeria-elwatania-tv': { channelId: 'algeria-elwatania-tv', name: 'Elwatania TV Algérie HD (قناة الوطنية الجزائرية)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#065f46', '#022c22', '#4ade80', 'ALGÉRIE TV', 'ELWATANIA', 'قناة الوطنية HD') },
  'algeria-amou-yazid-tv': { channelId: 'algeria-amou-yazid-tv', name: 'Amou Yazid TV Algérie HD (قناة عمو يزيد الجزائرية للأطفال)', language: 'ar', languageLabel: 'Arabic', category: 'algeria', logo: makeSvgChannelBadge('#1e1b4b', '#31102f', '#facc15', 'ALGÉRIE KIDS', 'AMOU YAZID', 'عمو يزيد HD') },

  // France TV & Canal+ Channels (Category: canal)
  'canal-plus-fr': { channelId: 'canal-plus-fr', name: 'Canal+ France HD (Ligue 1, UEFA Champions League, Top 14 & Cinéma)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#18181b', '#ffffff', 'FRANCE TV', 'CANAL+', 'OFFICIEL HD') },
  'canal-plus-sport-fr': { channelId: 'canal-plus-sport-fr', name: 'Canal+ Sport France HD (Premier League, UEFA & Top 14)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#064e3b', '#4ade80', 'CANAL+ FRANCE', 'C+ SPORT', 'DIRECT HD') },
  'canal-plus-foot-fr': { channelId: 'canal-plus-foot-fr', name: 'Canal+ Foot France HD (UEFA Champions League & Premier League)', language: 'fr', languageLabel: 'French', category: 'canal', logo: `${TV_LOGO_REPO}/countries/france/canal-plus-foot-fr.png` },
  'canal-plus-sport-360-fr': { channelId: 'canal-plus-sport-360-fr', name: 'Canal+ Sport 360 France HD (MotoGP, Ligue 1, WRC & Boxe)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#1e293b', '#38bdf8', 'CANAL+ FRANCE', 'SPORT 360', 'DIRECT HD') },
  'canal-plus-f1-fr': { channelId: 'canal-plus-f1-fr', name: 'Canal+ Formula 1 France HD (24/7 F1 Grand Prix & Paddock)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#450a0a', '#ef4444', 'CANAL+ FRANCE', 'C+ F1 HD', 'FORMULA 1') },
  'canal-plus-motogp-fr': { channelId: 'canal-plus-motogp-fr', name: 'Canal+ MotoGP France HD (24/7 MotoGP World Championship)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#7c2d12', '#fb923c', 'CANAL+ FRANCE', 'MOTOGP', 'DIRECT HD') },
  'canal-plus-afrique-1': { channelId: 'canal-plus-afrique-1', name: 'Canal+ Sport 1 Afrique HD (Premier League, Ligue 1 & CAF)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#064e3b', '#34d399', 'CANAL+ AFRIQUE', 'SPORT 1', 'FRANCOPHONE HD') },
  'canal-plus-afrique-2': { channelId: 'canal-plus-afrique-2', name: 'Canal+ Sport 2 Afrique HD (UEFA Champions League & LaLiga)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#1e3a8a', '#60a5fa', 'CANAL+ AFRIQUE', 'SPORT 2', 'FRANCOPHONE HD') },
  'canal-plus-extra-1': { channelId: 'canal-plus-extra-1', name: 'Canal+ Extra 1 HD (UEFA Champions League Multiplex 1)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#1e1b4b', '#818cf8', 'CANAL+ EXTRA', 'EXTRA 1', 'CHAMPIONS HD') },
  'canal-plus-extra-2': { channelId: 'canal-plus-extra-2', name: 'Canal+ Extra 2 HD (UEFA Champions League Multiplex 2)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#1e1b4b', '#a78bfa', 'CANAL+ EXTRA', 'EXTRA 2', 'CHAMPIONS HD') },
  'canal-plus-sport-1-eu': { channelId: 'canal-plus-sport-1-eu', name: 'Canal+ Sport 1 Europe HD (Premier League, LaLiga & ATP)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#18181b', '#facc15', 'CANAL+ EUROPE', 'SPORT 1', 'EUROPE HD') },
  'canal-plus-sport-2-eu': { channelId: 'canal-plus-sport-2-eu', name: 'Canal+ Sport 2 Europe HD (European Football & NBA)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#18181b', '#fbbf24', 'CANAL+ EUROPE', 'SPORT 2', 'EUROPE HD') },
  'canal-plus-premium-hd': { channelId: 'canal-plus-premium-hd', name: 'Canal+ Premium & Box Office HD (Cinéma, Séries & Grand Match)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#27272a', '#f43f5e', 'CANAL+ FRANCE', 'PREMIUM', 'CINÉMA & SPORT') },
  'rmc-sport-1-fr': { channelId: 'rmc-sport-1-fr', name: 'RMC Sport 1 France HD (UEFA & UFC)', language: 'fr', languageLabel: 'French', category: 'canal', logo: `${TV_LOGO_REPO}/countries/france/rmc-sport-1-fr.png` },
  'rmc-sport-2-fr': { channelId: 'rmc-sport-2-fr', name: 'RMC Sport 2 France HD (Football, Combat & Basketball)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#ef4444', 'FRANCE SPORT', 'RMC SPORT 2', 'FRANCE HD') },
  'lequipe-fr': { channelId: 'lequipe-fr', name: "L'Équipe TV France (1080p)", language: 'fr', languageLabel: 'French', category: 'canal', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/32/L%27%C3%89quipe_wordmark.svg/512px-L%27%C3%89quipe_wordmark.svg.png' },
  'dazn-ligue1-fr': { channelId: 'dazn-ligue1-fr', name: 'DAZN Ligue 1 HD (France)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#09090b', '#18181b', '#38bdf8', 'DAZN FRANCE', 'LIGUE 1', 'HD LIVE') },
  'fifa-plus-fr': { channelId: 'fifa-plus-fr', name: 'FIFA+ France (FR)', language: 'fr', languageLabel: 'French', category: 'canal', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#38bdf8', 'OFFICIAL STREAM', 'FIFA+', 'FRANCE HD') },

  // Movies & Cinema
  'bein-movies-premiere-en': { channelId: 'bein-movies-premiere-en', name: 'beIN / Sky Cinema Premiere HD (Movies)', language: 'en', languageLabel: 'English', category: 'movies', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-movies-1-premiere-mea.png` },
  'bein-movies-action-en': { channelId: 'bein-movies-action-en', name: 'beIN / Sky Cinema Action HD (Movies)', language: 'en', languageLabel: 'English', category: 'movies', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-movies-2-action-mea.png` },
  'bein-movies-hits-en': { channelId: 'bein-movies-hits-en', name: 'beIN / Sky Cinema Hits HD (Movies)', language: 'en', languageLabel: 'English', category: 'movies', logo: `${TV_LOGO_REPO}/countries/turkey/bein-movies-stars-hd-tr.png` },
  'bein-movies-drama-en': { channelId: 'bein-movies-drama-en', name: 'beIN / Sky Cinema Drama HD (Movies)', language: 'en', languageLabel: 'English', category: 'movies', logo: `${TV_LOGO_REPO}/countries/world-middle-east/bein-movies-3-drama-mea.png` },
  'hbo-hd': { channelId: 'hbo-hd', name: 'HBO Movies & Series HD', language: 'en', languageLabel: 'English', category: 'movies', logo: `${TV_LOGO_REPO}/countries/united-states/hbo-us.png` },
  'hbo-2-hd': { channelId: 'hbo-2-hd', name: 'HBO 2 Movies & Series HD', language: 'en', languageLabel: 'English', category: 'movies', logo: `${TV_LOGO_REPO}/countries/united-states/hbo-us.png` },
  'showtime-hd': { channelId: 'showtime-hd', name: 'Showtime Movies & Series HD', language: 'en', languageLabel: 'English', category: 'movies', logo: `${TV_LOGO_REPO}/countries/united-states/showtime-us.png` },
  'starz-hd': { channelId: 'starz-hd', name: 'STARZPLAY Cinema / Starz Movies HD', language: 'en', languageLabel: 'English', category: 'starzplay', logo: `${TV_LOGO_REPO}/countries/united-states/starz-us.png` },
  'cinemax-hd': { channelId: 'cinemax-hd', name: 'Cinemax Action Movies HD', language: 'en', languageLabel: 'English', category: 'movies', logo: `${TV_LOGO_REPO}/countries/united-states/cinemax-us.png` },
  'bein-movies-action-ar': { channelId: 'bein-movies-action-ar', name: 'Shahid / MENA Movies Action HD (أفلام أكشن)', language: 'ar', languageLabel: 'Arabic', category: 'movies', logo: makeSvgChannelBadge('#0f172a', '#1e293b', '#10b981', 'SHAHID VIP', 'ACTION', 'أفلام أكشن') },
  'bein-movies-thriller-ar': { channelId: 'bein-movies-thriller-ar', name: 'Shahid / MENA Movies Thriller HD (أفلام إثارة)', language: 'ar', languageLabel: 'Arabic', category: 'movies', logo: makeSvgChannelBadge('#0f172a', '#31102f', '#f43f5e', 'SHAHID VIP', 'THRILLER', 'أفلام إثارة') },
  'bein-aflam-ar': { channelId: 'bein-aflam-ar', name: 'Shahid Aflam HD (أفلام عربية)', language: 'ar', languageLabel: 'Arabic', category: 'movies', logo: makeSvgChannelBadge('#042f2e', '#0f172a', '#2dd4bf', 'SHAHID VIP', 'AFLAM', 'أفلام عربية') },
  'rotana-cinema-ar': { channelId: 'rotana-cinema-ar', name: 'Rotana Cinema HD (روتانا سينما)', language: 'ar', languageLabel: 'Arabic', category: 'movies', logo: makeSvgChannelBadge('#065f46', '#022c22', '#fbbf24', 'ROTANA', 'CINEMA', 'روتانا سينما') },

  // Entertainment & MBC / Rotana / Saudi TV / Spacetoon
  'rotana-drama-ar': { channelId: 'rotana-drama-ar', name: 'Rotana Drama HD (روتانا دراما)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: makeSvgChannelBadge('#581c87', '#2e1065', '#f59e0b', 'ROTANA', 'DRAMA', 'روتانا دراما') },
  'rotana-comedy-ar': { channelId: 'rotana-comedy-ar', name: 'Rotana Comedy HD (روتانا كوميدي)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: makeSvgChannelBadge('#9a3412', '#431407', '#fde047', 'ROTANA', 'COMEDY', 'روتانا كوميدي') },
  'mbc-1-ar': { channelId: 'mbc-1-ar', name: 'MBC 1 HD (إم بي سي 1)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-1-ae.png` },
  'mbc-4-ar': { channelId: 'mbc-4-ar', name: 'MBC 4 Series & Entertainment HD (إم بي سي 4)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-4-ae.png` },
  'mbc-5-ar': { channelId: 'mbc-5-ar', name: 'MBC 5 Maghreb HD (إم بي سي 5)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-5-ae.png` },
  'mbc-drama-ar': { channelId: 'mbc-drama-ar', name: 'MBC Drama & MBC+ Drama HD (إم بي سي دراما)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-drama-ae.png` },
  'mbc-plus-drama-ar': { channelId: 'mbc-plus-drama-ar', name: 'MBC+ Drama HD (إم بي سي بلس دراما)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-drama-ae.png` },
  'mbc-masr-ar': { channelId: 'mbc-masr-ar', name: 'MBC Masr 1 & 2 HD (إم بي سي مصر)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-maser-ae.png` },
  'mbc-masr-2-ar': { channelId: 'mbc-masr-2-ar', name: 'MBC Masr 2 HD (إم بي سي مصر 2)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-maser-ae.png` },
  'mbc-iraq-ar': { channelId: 'mbc-iraq-ar', name: 'MBC Iraq HD (إم بي سي العراق)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: `${TV_LOGO_REPO}/countries/united-arab-emirates/mbc-iraq-ae.png` },
  'bab-al-hara-ar': { channelId: 'bab-al-hara-ar', name: 'Bab Al Hara Series 24/7 HD (باب الحارة)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: makeSvgChannelBadge('#78350f', '#451a03', '#fbbf24', 'SHAHID 24/7', 'BAB AL HARA', 'باب الحارة') },
  'spacetoon-ar': { channelId: 'spacetoon-ar', name: 'Spacetoon Arabic HD (سبيستون)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: makeSvgChannelBadge('#1e3a8a', '#172554', '#facc15', 'ANIME & KIDS', 'SPACETOON', 'سبيستون') },
  'saudi-sbc-ar': { channelId: 'saudi-sbc-ar', name: 'SBC Saudi HD (قناة SBC السعودية)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: makeSvgChannelBadge('#064e3b', '#0f172a', '#34d399', 'SAUDI TV', 'SBC HD', 'قناة SBC السعودية') },
  'saudi-big-time-ar': { channelId: 'saudi-big-time-ar', name: 'Riyadh Season Big Time+ HD (موسم الرياض)', language: 'ar', languageLabel: 'Arabic', category: 'entertainment', logo: makeSvgChannelBadge('#1e1b4b', '#0f172a', '#f59e0b', 'RIYADH SEASON', 'BIG TIME+', 'موسم الرياض HD') },

  // UK & European Sports
  'sky-sports-main-event': { channelId: 'sky-sports-main-event', name: 'Sky Sports Main Event UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-main-event-uk.png` },
  'sky-sports-premier-league': { channelId: 'sky-sports-premier-league', name: 'Sky Sports Premier League UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-premier-league-uk.png` },
  'sky-sports-football': { channelId: 'sky-sports-football', name: 'Sky Sports Football UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-football-uk.png` },
  'sky-sports-plus': { channelId: 'sky-sports-plus', name: 'Sky Sports+ UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#f43f5e', 'SKY SPORTS', 'SPORTS+', 'EFL & LIVE HD') },
  'sky-sports-action': { channelId: 'sky-sports-action', name: 'Sky Sports Action UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: makeSvgChannelBadge('#0f172a', '#172554', '#38bdf8', 'SKY SPORTS', 'ACTION', 'UK HD') },
  'sky-sports-f1': { channelId: 'sky-sports-f1', name: 'Sky Sports F1 UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-f1-uk.png` },
  'sky-sports-cricket': { channelId: 'sky-sports-cricket', name: 'Sky Sports Cricket UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#ef4444', 'SKY SPORTS', 'CRICKET', 'UK HD') },
  'sky-sports-golf': { channelId: 'sky-sports-golf', name: 'Sky Sports Golf UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-golf-icon-uk.png` },
  'sky-sports-tennis': { channelId: 'sky-sports-tennis', name: 'Sky Sports Tennis UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-tennis-icon-uk.png` },
  'sky-sports-mix': { channelId: 'sky-sports-mix', name: 'Sky Sports Mix UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-mix-icon-uk.png` },
  'sky-sports-news': { channelId: 'sky-sports-news', name: 'Sky Sports News UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-news-icon-uk.png` },
  'sky-sports-racing': { channelId: 'sky-sports-racing', name: 'Sky Sports Racing UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/sky-sports-racing-icon-uk.png` },
  'tnt-sports-1': { channelId: 'tnt-sports-1', name: 'TNT Sports 1 UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/hd/tnt-sports-1-hd-uk.png` },
  'tnt-sports-2': { channelId: 'tnt-sports-2', name: 'TNT Sports 2 UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/hd/tnt-sports-2-hd-uk.png` },
  'tnt-sports-3': { channelId: 'tnt-sports-3', name: 'TNT Sports 3 UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/hd/tnt-sports-3-hd-uk.png` },
  'tnt-sports-4': { channelId: 'tnt-sports-4', name: 'TNT Sports 4 UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/hd/tnt-sports-4-hd-uk.png` },
  'supersport-premier-league': { channelId: 'supersport-premier-league', name: 'SuperSport Premier League HD', language: 'en', languageLabel: 'English', category: 'sky', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#f59e0b', 'SUPERSPORT', 'EPL', 'PREMIER LEAGUE') },
  'supersport-grandstand': { channelId: 'supersport-grandstand', name: 'SuperSport Grandstand HD', language: 'en', languageLabel: 'English', category: 'sky', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#fbbf24', 'SUPERSPORT', 'GRANDSTAND', 'LIVE HD') },
  'supersport-football': { channelId: 'supersport-football', name: 'SuperSport Football HD', language: 'en', languageLabel: 'English', category: 'sky', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#38bdf8', 'SUPERSPORT', 'FOOTBALL', 'LIVE HD') },
  'supersport-laliga': { channelId: 'supersport-laliga', name: 'SuperSport LaLiga HD', language: 'en', languageLabel: 'English', category: 'sky', logo: makeSvgChannelBadge('#0f172a', '#7f1d1d', '#f43f5e', 'SUPERSPORT', 'LALIGA', 'LIVE HD') },
  'supersport-variety-1': { channelId: 'supersport-variety-1', name: 'SuperSport Variety 1 HD', language: 'en', languageLabel: 'English', category: 'sky', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#34d399', 'SUPERSPORT', 'VARIETY 1', 'LIVE HD') },
  'usa-network-hd': { channelId: 'usa-network-hd', name: 'USA Network Sports HD', language: 'en', languageLabel: 'English', category: 'sky', logo: 'https://schedulesdirect-api20141201-logos.s3.dualstack.us-east-1.amazonaws.com/stationLogos/s11207_dark_360w_270h.png' },

  // US Sports (Fox, ESPN, CBS, NBC, NBA, NFL, NHL, MLB)
  'fox-sports-1': { channelId: 'fox-sports-1', name: 'Fox Sports 1 (FS1 HD)', language: 'en', languageLabel: 'English', category: 'fox', logo: makeSvgChannelBadge('#0c4a6e', '#082f49', '#38bdf8', 'FOX SPORTS', 'FS1', 'HD LIVE') },
  'fox-sports-2': { channelId: 'fox-sports-2', name: 'Fox Sports 2 (FS2 HD)', language: 'en', languageLabel: 'English', category: 'fox', logo: makeSvgChannelBadge('#1e3a8a', '#172554', '#ef4444', 'FOX SPORTS', 'FS2', 'HD LIVE') },
  'fox-sports-news': { channelId: 'fox-sports-news', name: 'Fox Sports News (1080p)', language: 'en', languageLabel: 'English', category: 'fox', logo: 'https://i.imgur.com/O9BapV9.png' },
  'espn-hd': { channelId: 'espn-hd', name: 'ESPN HD (United States)', language: 'en', languageLabel: 'English', category: 'espn', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/ESPN_wordmark.svg/960px-ESPN_wordmark.svg.png' },
  'espn-2-hd': { channelId: 'espn-2-hd', name: 'ESPN 2 HD (United States)', language: 'en', languageLabel: 'English', category: 'espn', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/ESPN2_logo.svg/960px-ESPN2_logo.svg.png' },
  'espnu-hd': { channelId: 'espnu-hd', name: 'ESPNU HD', language: 'en', languageLabel: 'English', category: 'espn', logo: 'https://i.imgur.com/HiBrysh.png' },
  'cbs-sports-golazo': { channelId: 'cbs-sports-golazo', name: 'CBS Sports Golazo Network', language: 'en', languageLabel: 'English', category: 'usa', logo: `${TV_LOGO_REPO}/countries/united-states/cbs-sports-golazo-network-us.png` },
  'nbc-sports-now': { channelId: 'nbc-sports-now', name: 'NBC Sports NOW HD', language: 'en', languageLabel: 'English', category: 'usa', logo: `${TV_LOGO_REPO}/countries/united-states/nbc-sports-engine-us.png` },
  'nba-tv': { channelId: 'nba-tv', name: 'NBA TV HD', language: 'en', languageLabel: 'English', category: 'usa', logo: `${TV_LOGO_REPO}/countries/united-states/nba-tv-icon-us.png` },
  'nfl-network': { channelId: 'nfl-network', name: 'NFL Network HD', language: 'en', languageLabel: 'English', category: 'usa', logo: `${TV_LOGO_REPO}/countries/united-states/nfl-network-us.png` },
  'nfl-redzone': { channelId: 'nfl-redzone', name: 'NFL RedZone HD', language: 'en', languageLabel: 'English', category: 'usa', logo: `${TV_LOGO_REPO}/countries/united-states/nfl-network-us.png` },
  'nhl-network': { channelId: 'nhl-network', name: 'NHL Network (1080p)', language: 'en', languageLabel: 'English', category: 'usa', logo: `${TV_LOGO_REPO}/countries/united-states/nhl-network-us.png` },
  'mlb-network': { channelId: 'mlb-network', name: 'MLB Network HD', language: 'en', languageLabel: 'English', category: 'usa', logo: `${TV_LOGO_REPO}/countries/united-states/mlb-network-us.png` },

  // Europe / International Sports (Spain, Italy, Global)
  'eurosport-1': { channelId: 'eurosport-1', name: 'Eurosport 1 HD', language: 'en', languageLabel: 'English', category: 'europe', logo: 'https://i.imgur.com/olQJgm7.png' },
  'eurosport-2': { channelId: 'eurosport-2', name: 'Eurosport 2 HD', language: 'en', languageLabel: 'English', category: 'europe', logo: 'https://i.imgur.com/f56dHgR.png' },
  'fifa-plus-en': { channelId: 'fifa-plus-en', name: 'FIFA+ Global (English)', language: 'en', languageLabel: 'English', category: 'europe', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#38bdf8', 'OFFICIAL STREAM', 'FIFA+', 'GLOBAL HD') },
  'premier-sports-1': { channelId: 'premier-sports-1', name: 'Premier Sports 1 UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/premier-sports-1-uk.png` },
  'premier-sports-2': { channelId: 'premier-sports-2', name: 'Premier Sports 2 UK HD', language: 'en', languageLabel: 'English', category: 'sky', logo: `${TV_LOGO_REPO}/countries/united-kingdom/premier-sports-2-uk.png` },
  'real-madrid-tv': { channelId: 'real-madrid-tv', name: 'Real Madrid TV HD', language: 'es', languageLabel: 'Spanish', category: 'europe', logo: `${TV_LOGO_REPO}/countries/spain/real-madrid-tv-es.png` },
  'movistar-laliga-es': { channelId: 'movistar-laliga-es', name: 'Movistar LaLiga TV HD (Spain)', language: 'es', languageLabel: 'Spanish', category: 'europe', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#38bdf8', 'MOVISTAR+', 'LALIGA', 'ESPAÑA HD') },
  'movistar-plus-es': { channelId: 'movistar-plus-es', name: 'Movistar Plus+ El Partidazo HD (Spain)', language: 'es', languageLabel: 'Spanish', category: 'europe', logo: makeSvgChannelBadge('#0f172a', '#172554', '#60a5fa', 'MOVISTAR+', 'PLUS+ HD', 'EL PARTIDAZO') },
  'laliga-hypermotion-es': { channelId: 'laliga-hypermotion-es', name: 'LaLiga TV Hypermotion HD (Spain)', language: 'es', languageLabel: 'Spanish', category: 'europe', logo: makeSvgChannelBadge('#042f2e', '#0f172a', '#2dd4bf', 'LALIGA TV', 'HYPERMOTION', 'SEGUNDA HD') },
  'movistar-liga-de-campeones-es': { channelId: 'movistar-liga-de-campeones-es', name: 'Movistar Liga de Campeones HD (Spain)', language: 'es', languageLabel: 'Spanish', category: 'europe', logo: makeSvgChannelBadge('#0f172a', '#1e1b4b', '#818cf8', 'MOVISTAR+', 'CHAMPIONS', 'EUROPA HD') },
  'movistar-vamos-es': { channelId: 'movistar-vamos-es', name: 'Movistar Vamos HD (Spain)', language: 'es', languageLabel: 'Spanish', category: 'europe', logo: makeSvgChannelBadge('#0f172a', '#064e3b', '#34d399', 'MOVISTAR+', 'VAMOS', 'DEPORTES HD') },
  'movistar-deportes-es': { channelId: 'movistar-deportes-es', name: 'Movistar Deportes HD (Spain)', language: 'es', languageLabel: 'Spanish', category: 'europe', logo: makeSvgChannelBadge('#0f172a', '#1e3a8a', '#f59e0b', 'MOVISTAR+', 'DEPORTES', 'ESPAÑA HD') },
  'dazn-laliga-es': { channelId: 'dazn-laliga-es', name: 'DAZN LaLiga 1 HD (Spain)', language: 'es', languageLabel: 'Spanish', category: 'europe', logo: makeSvgChannelBadge('#09090b', '#18181b', '#facc15', 'DAZN SPAIN', 'LALIGA', 'HD LIVE') },
  'dazn-f1-es': { channelId: 'dazn-f1-es', name: 'DAZN F1 España HD (Formula 1)', language: 'es', languageLabel: 'Spanish', category: 'motorsport', logo: makeSvgChannelBadge('#09090b', '#450a0a', '#ef4444', 'DAZN SPAIN', 'F1 HD', 'MOTORSPORT') },
  'espn-deportes-es': { channelId: 'espn-deportes-es', name: 'ESPN Deportes HD (Español)', language: 'es', languageLabel: 'Spanish', category: 'espn', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/ESPN_wordmark.svg/960px-ESPN_wordmark.svg.png' },
  'dazn-1-it': { channelId: 'dazn-1-it', name: 'Zona DAZN / DAZN 1 Italia HD (Serie A Enilive)', language: 'it', languageLabel: 'Italian', category: 'europe', logo: makeSvgChannelBadge('#09090b', '#18181b', '#22c55e', 'DAZN ITALIA', 'DAZN 1', 'SERIE A') },
  'dazn-2-it': { channelId: 'dazn-2-it', name: 'DAZN 2 Italia HD (Serie A Enilive)', language: 'it', languageLabel: 'Italian', category: 'europe', logo: makeSvgChannelBadge('#09090b', '#18181b', '#22c55e', 'DAZN ITALIA', 'DAZN 2', 'SERIE A') },
  'sky-sport-calcio-it': { channelId: 'sky-sport-calcio-it', name: 'Sky Sport Calcio HD Italia (Serie A)', language: 'it', languageLabel: 'Italian', category: 'europe', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1303.png' },
  'sky-sport-uno-it': { channelId: 'sky-sport-uno-it', name: 'Sky Sport Uno HD Italia (Serie A & UCL)', language: 'it', languageLabel: 'Italian', category: 'europe', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1301.png' },
  'sky-sport-arena-it': { channelId: 'sky-sport-arena-it', name: 'Sky Sport Arena HD Italia (Serie A)', language: 'it', languageLabel: 'Italian', category: 'europe', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1322.png' },
  'sky-sport-max-it': { channelId: 'sky-sport-max-it', name: 'Sky Sport Max HD Italia (Serie A & Euro)', language: 'it', languageLabel: 'Italian', category: 'europe', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1302.png' },
  'sky-sport-252-it': { channelId: 'sky-sport-252-it', name: 'Sky Sport 252 HD Italia (Serie A Matchday)', language: 'it', languageLabel: 'Italian', category: 'europe', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1303.png' },
  'sky-sport-24-it': { channelId: 'sky-sport-24-it', name: 'Sky Sport 24 HD Italia (Calcio News)', language: 'it', languageLabel: 'Italian', category: 'europe', logo: 'https://d2n0069hmnqmmx.cloudfront.net/epgdata/1.0/newchanlogos/512/512/skychb1314.png' },
  'dazn-combat': { channelId: 'dazn-combat', name: 'DAZN Combat & Boxing HD', language: 'en', languageLabel: 'English', category: 'combat', logo: 'https://i.postimg.cc/VsW3Jsrz/logo-DAZN-Combat.png' },
  'red-bull-tv': { channelId: 'red-bull-tv', name: 'Red Bull TV Motorsports (1080p)', language: 'en', languageLabel: 'English', category: 'motorsport', logo: `${TV_LOGO_REPO}/countries/international/red-bull-tv-int.png` },
  'tennis-channel': { channelId: 'tennis-channel', name: 'Tennis Channel HD (1080p)', language: 'en', languageLabel: 'English', category: 'usa', logo: `${TV_LOGO_REPO}/countries/united-states/tennis-channel-us.png` },
};

// Strictly excluded MENA / SSC / Alkass channel IDs per user configuration (only STARZPLAY is kept)
const REMOVED_MENA_SSC_ALKASS_CHANNEL_IDS = new Set([
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
  'ontime-sports-1-ar',
  'ktv-sport-ar',
  'arryadia-ar',
  'bahrain-sports-1-ar',
  'bahrain-sports-2-ar',
  'oman-sports-ar',
  'iraqia-sports-ar',
]);

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
  'starzplay-asia-1-ar',
  'starzplay-asia-2-ar',
  'starzplay-sports-1-ar',
  'starzplay-sports-2-ar',
  'starzplay-sports-3-ar',
];

// Classify every channel into a distinct broadcaster family so a single match never hogs two sibling channels from the same network when concurrent matches are airing
function getChannelNetworkFamily(channelId: string): string {
  if (channelId.startsWith('bein-sports-') && channelId.endsWith('-ar')) return 'bein-ar';
  if (channelId.startsWith('starzplay-')) return 'starzplay-ar';
  if (channelId.startsWith('sky-sports-')) return 'sky-uk';
  if (channelId.startsWith('tnt-sports-') || channelId.startsWith('premier-sports-') || channelId.startsWith('eurosport-')) return 'tnt-uk';
  if (channelId.startsWith('supersport-')) return 'supersport';
  if (channelId.startsWith('bein-sports-en-') || channelId === 'bein-sports-xtra-en') return 'bein-en';
  if (channelId.endsWith('-fr') || channelId.includes('-fr-') || channelId.startsWith('canal-plus-')) return 'fr';
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
  const isFr = (id: string) => id.endsWith('-fr') || id.includes('-fr-') || id.startsWith('canal-plus-');
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
// while preserving each channel's dedicated Bluetier Hardware HLS (wideiptv.top/player/...) primary mirror
const STRICT_CHANNEL_REQUIRED_STREAM_TOKEN: Record<string, string[]> = {
  // beIN Sports Arabic 1–9 & Open & Premium
  'bein-sports-1-ar': ['player/beinar/', 'premium91', 'beinfhd11'],
  'bein-sports-2-ar': ['player/beinar2/', 'premium92'],
  'bein-sports-3-ar': ['player/beinar3/', 'premium93'],
  'bein-sports-4-ar': ['player/beinar4/', 'premium94'],
  'bein-sports-5-ar': ['player/beinar5/', 'premium95'],
  'bein-sports-6-ar': ['player/beinar6/', 'premium96'],
  'bein-sports-7-ar': ['player/beinar7/', 'premium97'],
  'bein-sports-8-ar': ['player/beinar8/', 'premium98', 'premium97', 'premium99'],
  'bein-sports-9-ar': ['player/beinar9/', 'premium99'],
  'bein-sports-open-ar': ['premium578', 'beinsportsnews'],
  'bein-sports-premium-1-ar': ['player/beinar/', 'premium91'],
  'bein-sports-premium-2-ar': ['player/beinar2/', 'premium92'],
  'bein-sports-premium-3-ar': ['player/beinar3/', 'premium93'],
  // beIN Sports English 1–3
  'bein-sports-en-1': ['premium61', 'premium712'],
  'bein-sports-en-2': ['premium713'],
  'bein-sports-en-3': ['premium714'],
  // beIN Sports France 1–3 & MAX
  'bein-sports-fr-1': ['player/beinsport1fr/', 'premium116'],
  'bein-sports-fr-2': ['player/beinsport2fr/', 'premium117'],
  'bein-sports-fr-3': ['player/beinsport3fr/', 'premium118'],
  'bein-sports-max-4-fr': ['player/beinmax4fr/', 'premium494'],
  'bein-sports-max-5-fr': ['player/beinmax5fr/', 'premium495'],
  'bein-sports-max-6-fr': ['player/beinmax6fr/', 'premium496'],
  'bein-sports-max-7-fr': ['player/beinmax7fr/', 'premium497'],
  'bein-sports-max-8-fr': ['player/beinmax8fr/', 'premium498'],
  'bein-sports-max-9-fr': ['player/beinmax9fr/', 'premium499'],
  'bein-sports-max-10-fr': ['premium500'],
  // France TV & Canal+ Channels (Strictly dedicated transponders)
  'canal-plus-fr': ['premium121'],
  'canal-plus-sport-fr': ['player/canalsportfr/', 'premium122'],
  'canal-plus-foot-fr': ['player/footplusfr/', 'premium463'],
  'canal-plus-sport-360-fr': ['premium464', '92.114.85.87'],
  'canal-plus-f1-fr': ['premium273'],
  'canal-plus-motogp-fr': ['premium271'],
  'canal-plus-afrique-1': ['premium486', 'premium122', 'premium463'],
  'canal-plus-afrique-2': ['premium487', 'premium463', 'premium121'],
  'canal-plus-extra-1': ['premium983'],
  'canal-plus-extra-2': ['premium984'],
  'canal-plus-sport-1-eu': ['premium48', 'premium75'],
  'canal-plus-sport-2-eu': ['premium73', 'premium259'],
  'canal-plus-premium-hd': ['premium566', 'premium567'],
  'rmc-sport-1-fr': ['player/rmcsport1fr/', 'premium119'],
  'rmc-sport-2-fr': ['player/rmcsport2fr/', 'premium120'],
  'dazn-ligue1-fr': ['premium960'],
  // Spain LaLiga & Movistar
  'movistar-laliga-es': ['premium84'],
  'dazn-laliga-es': ['player/daznlaliga/', 'premium538'],
  'movistar-plus-es': ['premium437'],
  'laliga-hypermotion-es': ['premium539'],
  'movistar-liga-de-campeones-es': ['premium435'],
  // TNT Sports 1–4 UK
  'tnt-sports-1': ['player/tnt1uk/', 'premium31'],
  'tnt-sports-2': ['player/tntsports2/', 'premium32'],
  'tnt-sports-3': ['player/tntsports3/', 'premium33'],
  'tnt-sports-4': ['player/tntsports4/', 'premium34'],
  // Sky Sports UK
  'sky-sports-main-event': ['player/skysportsmainevent/', 'premium38'],
  'sky-sports-premier-league': ['player/skysportspremierleague/', 'premium130', 'AAxBRQEBc2c'],
  'sky-sports-football': ['player/skysportsfootballuk/', 'premium35'],
  'sky-sports-plus': ['player/skysportsplus/', 'premium36'],
  'sky-sports-action': ['player/skysportsaction/', 'premium37', 'AQNASgYGemc'],
  'sky-sports-f1': ['player/skysportsf1/', 'premium60', 'AwZGQwwEZA'],
  // SuperSport
  'supersport-grandstand': ['premium412'],
  'supersport-football': ['premium56', 'premium413'],
  'supersport-premier-league': ['premium414'],
  'supersport-laliga': ['premium415'],
  'supersport-variety-1': ['premium416', 'premium420'],
  // STARZPLAY Sports, Asia, CricLife & Cinema Dedicated Channels
  'starzplay-sports-1-ar': ['premium609'],
  'starzplay-sports-2-ar': ['premium610'],
  'starzplay-sports-3-ar': ['premium602', 'premium609'],
  'starzplay-asia-1-ar': ['premium608', 'premium600'],
  'starzplay-asia-2-ar': ['premium603', 'premium601'],
  'starzplay-criclife-1': ['premium612'],
  'starzplay-criclife-2': ['premium613'],
  'starzplay-encore-hd': ['premium336'],
  'starzplay-action-hd': ['premium337'],
  'starz-hd': ['premium335'],
  // Italian Serie A Dedicated Channels
  'dazn-1-it': ['premium877'],
  'dazn-2-it': ['premium878'],
  'sky-sport-calcio-it': ['player/skysportcalcioit/', 'premium870'],
  'sky-sport-uno-it': ['player/skysportunoit/', 'premium461'],
  'sky-sport-arena-it': ['player/skysportarenait/', 'premium462'],
  'sky-sport-max-it': ['premium460'],
  'sky-sport-252-it': ['premium872'],
  'sky-sport-24-it': ['player/skysport24it/', 'premium869'],
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

  // Algeria TV channels must NEVER play beIN Sports (premium90/96), MBC 5 (bitmovin-mbc-5), or broken 404 feeds
  if (channelId.startsWith('algeria-')) {
    if (
      u.includes('premium90') ||
      u.includes('premium96') ||
      u.includes('bitmovin-mbc-5') ||
      u.includes('chid_203') ||
      u.includes('live.elheddaftv.com') ||
      u.includes('livesstream.work.gd')
    ) {
      return true;
    }
  }

  // Premier Sports 1 & 2 UK must only use real UK satellite feeds (premium451/premium709), never Amagi/Pluto/Tubi FAST loops
  if (channelId === 'premier-sports-1' || channelId === 'premier-sports-2') {
    if (u.includes('amagi.tv') || u.includes('pluto') || u.includes('tubi') || u.includes('wurl.com')) {
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
  const leagueSlug = String(ev?.leagueSlug || ev?.competitionCode || '').toLowerCase();
  const leagueName = String(ev?.league || '').toLowerCase();
  const combinedLeague = `${leagueSlug} ${leagueName}`;

  let score = 0;
  const isSecondDivision =
    leagueSlug === 'eng.2' ||
    leagueSlug === 'esp.2' ||
    combinedLeague.includes('laliga 2') ||
    combinedLeague.includes('hypermotion') ||
    combinedLeague.includes('championship') ||
    combinedLeague.includes('segunda') ||
    combinedLeague.includes('ligue 2') ||
    combinedLeague.includes('serie b');

  // League tier priority so top-division matches always claim primary flagship channels before second-tier simultaneous matches
  if (isSecondDivision) {
    score += 8;
  } else if (combinedLeague.includes('uefa.champions') || combinedLeague.includes('uefa champions')) {
    score += 95;
  } else if (leagueSlug === 'eng.1' || combinedLeague.includes('premier league')) {
    score += 80;
  } else if (
    leagueSlug === 'esp.1' ||
    combinedLeague.includes('spanish laliga') ||
    combinedLeague.includes('laliga') ||
    leagueSlug === 'ita.1' ||
    combinedLeague.includes('serie a') ||
    leagueSlug === 'ger.1' ||
    combinedLeague.includes('bundesliga') ||
    leagueSlug === 'fra.1' ||
    combinedLeague.includes('ligue 1')
  ) {
    score += 72;
  } else if (combinedLeague.includes('ksa.1') || combinedLeague.includes('saudi') || combinedLeague.includes('afc')) {
    score += 62;
  } else if (combinedLeague.includes('uefa.europa') && !combinedLeague.includes('conf')) {
    score += 50;
  } else if (combinedLeague.includes('ufc') || combinedLeague.includes('f1') || combinedLeague.includes('nba') || combinedLeague.includes('nfl')) {
    score += 50;
  } else if (combinedLeague.includes('caf')) {
    score += 22;
  }

  const giantClubs = /\b(real madrid|barcelona|ac milan|milan|arsenal|liverpool|manchester city|manchester united|bayern|paris saint-germain|psg|inter milan|juventus|chelsea)\b/gi;
  const giantMatches = teams.match(giantClubs);
  if (giantMatches && giantMatches.length >= 2) {
    // Super-derby / El Clásico / European summit bonus
    score += 150;
  }

  const clubWeights: Array<[RegExp, number]> = [
    [/\b(real madrid|barcelona|ac milan|milan|arsenal|liverpool|manchester city|manchester united|bayern|paris saint-germain|psg|inter milan|juventus|chelsea)\b/i, 120],
    [/\b(crystal palace|besiktas|beşiktaş|tottenham|aston villa|newcastle|atletico madrid|borussia dortmund|napoli|roma|al hilal|al nassr|al ahly)\b/i, 75],
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

function hasExactBroadcastToken(broadcasts: any, tokens: string[]): boolean {
  if (!Array.isArray(broadcasts) || broadcasts.length === 0) return false;
  const normalizedList = broadcasts.map((b) => String(b || '').trim().toLowerCase());
  return tokens.some((tok) => {
    const t = tok.trim().toLowerCase();
    return normalizedList.some((item) => item === t);
  });
}

// =================================================================================================
// REAL-TIME OFFICIAL BROADCASTER EPG STATE & MATCH-TO-CHANNEL VERIFICATION ENGINE
// Ensures 100% parity between the EPG on 24/7 Live Channels (beIN Sports, Sky, Movistar, etc.)
// and the channel badges/streams assigned in the Live Matches section.
// =================================================================================================
interface OfficialProgramSlot {
  title: string;
  subtitle: string;
  startTime: string;
  endTime: string;
  startMs: number;
  endMs: number;
  isLiveBroadcast?: boolean;
}

interface OfficialChannelEpgData {
  nowPlaying: any;
  nextUp: any;
  upcoming: any[];
  schedule: OfficialProgramSlot[];
  source: string;
  updatedAt: number;
}

const cachedOfficialBroadcasterEpg = new Map<string, OfficialChannelEpgData>();
let officialBroadcasterEpgLastRefreshMs = 0;
let officialBroadcasterEpgInFlight: Promise<void> | null = null;
const OFFICIAL_BROADCASTER_EPG_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cachedOpenEpgXmltvMap = new Map<string, OfficialChannelEpgData>();
let openEpgXmltvLastRefreshMs = 0;
let openEpgXmltvInFlight: Promise<void> | null = null;
const OPEN_EPG_XMLTV_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (XMLTV files update daily)
let liveEventsRefreshInFlight: Promise<any> | null = null;
let liveChannelsRefreshInFlight: Promise<any> | null = null;

function normalizeTeamTextForEpgMatch(raw: string): string {
  let s = String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const replacements: Array<[RegExp, string]> = [
    [/\bpsg\b|\bparis sg\b|\bparis saint germain\b/g, 'psg parissaintgermain'],
    [/\bolympique lyonnais\b|\bolympique lyon\b|\blyon\b/g, 'lyon'],
    [/\bolympique de marseille\b|\bolympique marseille\b|\bmarseille\b/g, 'marseille'],
    [/\bmanchester united\b|\bman utd\b|\bman united\b/g, 'manchesterunited'],
    [/\bmanchester city\b|\bman city\b/g, 'manchestercity'],
    [/\btottenham hotspur\b|\btottenham\b|\bspurs\b/g, 'tottenham spurs'],
    [/\bwolverhampton wanderers\b|\bwolverhampton\b|\bwolves\b/g, 'wolverhampton wolves'],
    [/\bwest bromwich albion\b|\bwest bromwich\b|\bwest brom\b/g, 'westbrom'],
    [/\bqueens park rangers\b|\bqpr\b/g, 'qpr'],
    [/\bbrighton and hove albion\b|\bbrighton hove albion\b|\bbrighton\b/g, 'brighton'],
    [/\bnottingham forest\b|\bnottm forest\b/g, 'nottingham'],
    [/\bnewcastle united\b/g, 'newcastleunited'],
    [/\bnewcastle jets\b/g, 'newcastlejets'],
    [/\bbarcelonne\b|\bfc barcelona\b|\bbarcelona\b|\bbarca\b/g, 'barcelona'],
    [/\breal madrid\b/g, 'realmadrid'],
    [/\breal sociedad\b/g, 'realsociedad'],
    [/\breal betis\b/g, 'realbetis'],
    [/\batletico de madrid\b|\batletico madrid\b/g, 'atleticomadrid'],
    [/\bathletic club\b|\bathletic bilbao\b/g, 'athleticbilbao'],
    [/\bcelta de vigo\b|\bcelta vigo\b/g, 'celtavigo'],
    [/\bsiviglia\b|\bsevilla\b/g, 'sevilla'],
    [/\binternazionale\b|\binter milan\b|\bfc inter\b/g, 'intermilan'],
    [/\bac milan\b/g, 'acmilan'],
    [/\bbayern munich\b|\bbayern munchen\b|\bfc bayern\b/g, 'bayernmunich'],
    [/\bbayer leverkusen\b|\bleverkusen\b/g, 'leverkusen'],
    [/\bborussia dortmund\b|\bdortmund\b|\bbvb\b/g, 'dortmund'],
    [/\bborussia monchengladbach\b|\bmonchengladbach\b|\bmgladbach\b|\bgladbach\b/g, 'monchengladbach'],
    [/\beintracht frankfurt\b|\bfrankfurt\b/g, 'frankfurt'],
    [/\bstade de reims\b|\breims\b/g, 'reims'],
    [/\bstade rennais\b|\brennes\b/g, 'rennes'],
    [/\bstade brestois\b|\bbrest\b/g, 'brest'],
    [/\bred star fc 93\b|\bred star\b/g, 'redstar'],
    [/\bparis fc\b/g, 'parisfc'],
    [/\bal quwa al jawiya\b|\bair force sc\b|\bal quwa\b/g, 'airforcequwa'],
    [/\bal qadsiah\b|\bal qadisiyah\b|\bqadsiah\b/g, 'qadsiah'],
    [/\bal taawoun\b|\bal taawon\b|\btaawoun\b/g, 'taawoun'],
    [/\bal ittihad\b|\bittihad\b/g, 'ittihad'],
    [/\bal hilal\b|\bhilal\b/g, 'hilal'],
    [/\bal nassr\b|\bnassr\b/g, 'nassr'],
    [/\bshabab al ahli\b/g, 'shababalahli'],
    [/\bal ahli\b/g, 'alahli'],
    [/\bal sadd\b|\bsadd\b/g, 'alsadd'],
    [/\bal rayyan\b|\brayyan\b/g, 'alrayyan'],
    [/\bal gharafa\b|\bgharafa\b/g, 'algharafa'],
    [/\bal ain\b/g, 'alain'],
    [/\bal wasl\b|\bwasl\b/g, 'alwasl'],
    [/\bal shorta\b|\bshorta\b/g, 'alshorta'],
    [/\bal seeb\b|\bseeb\b/g, 'alseeb'],
    [/\bal hussein\b|\bhussein\b/g, 'alhussein'],
    [/\bal shamal\b|\bshamal\b/g, 'alshamal'],
    [/\bnew york rangers\b|\bny rangers\b/g, 'nyrangers'],
    [/\bglasgow rangers\b|\brangers fc\b/g, 'glasgowrangers'],
    [/\bmilwaukee brewers\b/g, 'milwaukeebrewers mil'],
    [/\btampa bay rays\b/g, 'tampabayrays tb'],
    [/\bboulogne sur mer\b|\bus boulogne\b|\bboulogne\b/g, 'boulogne'],
    [/\bcaykur rizespor\b|\brizespor\b/g, 'rizespor'],
    [/\btrabzonspor\b/g, 'trabzonspor'],
    [/\bbesiktas\b/g, 'besiktas'],
    [/\bistanbul basaksehir\b|\bbasaksehir\b/g, 'basaksehir'],
    [/\bgalatasaray\b/g, 'galatasaray'],
    [/\bfenerbahce\b/g, 'fenerbahce'],
  ];

  for (const [regex, rep] of replacements) {
    s = s.replace(regex, rep);
  }
  return ` ${s.replace(/\s+/g, ' ').trim()} `;
}

function doesOfficialTitleMatchLiveEvent(officialTitle: string, ev: any): boolean {
  if (!officialTitle || !ev) return false;
  const offNorm = normalizeTeamTextForEpgMatch(officialTitle);
  const stopWords = new Set([
    'fc', 'cf', 'sc', 'ac', 'as', 'cd', 'ud', 'rc', 'rcd', 'club', 'deportivo',
    'sporting', 'united', 'city', 'town', 'athletic', 'atletico', 'olympique',
    'stade', 'al', 'el', 'the', 'vs', 'de', 'la', 'le', 'calcio', 'sv', 'vfb',
    'tsg', 'fsv', 'afc', 'sfc', 'fk', 'sk', 'bk', 'ksa', 'qat', 'uae', 'irn',
    'irq', 'uzb', 'oma', 'jor', 'ind', 'jpn', 'kor', 'aus', 'chn', 'tha', 'mas',
    'vie', 'fra', 'usa', 'sui', 'nor', 'ita', 'arg', 'cze', 'aut', 'mon', 'den',
    'esp', 'eng', 'ger', 'tur', 'por',
  ]);

  const getTokens = (name: string) =>
    normalizeTeamTextForEpgMatch(name)
      .trim()
      .split(' ')
      .filter((w) => w.length >= 3 && !stopWords.has(w));

  const homeTokens = getTokens(ev.homeTeam?.name || '');
  const awayTokens = getTokens(ev.awayTeam?.name || '');
  if (homeTokens.length === 0 || awayTokens.length === 0) return false;

  const hasTokenInOff = (tk: string) =>
    offNorm.includes(` ${tk} `) || (tk.length >= 5 && offNorm.includes(tk));

  const homeHit = homeTokens.some(hasTokenInOff);
  const awayHit = awayTokens.some(hasTokenInOff);
  return homeHit && awayHit;
}

function findOfficialBroadcasterChannelsForEvent(ev: any): string[] {
  if (!ev || cachedOfficialBroadcasterEpg.size === 0) return [];
  const nowMs = Date.now();
  const evStartMs = Date.parse(ev.startTime || '');
  const statusUpper = String(ev.status || '').toUpperCase();
  const isLive =
    statusUpper === 'LIVE' ||
    statusUpper === 'IN' ||
    statusUpper === 'IN_PROGRESS' ||
    statusUpper === 'HT' ||
    statusUpper === '1H' ||
    statusUpper === '2H';

  const matchedChannels: string[] = [];

  for (const [chId, epgData] of cachedOfficialBroadcasterEpg.entries()) {
    if (!LIVE_CHANNEL_DIRECTORY[chId]) continue;
    // Skip duplicate alias IDs so the primary channel ID (bein-sports-1..3-ar) is displayed on match cards
    if (chId.startsWith('bein-sports-premium-')) continue;
    const cat = LIVE_CHANNEL_DIRECTORY[chId]?.category || '';
    if (cat === 'movies' || cat === 'entertainment') continue;

    const isBeinOfficial = epgData.source === 'bein.com';

    if (isLive) {
      if (Array.isArray(epgData.schedule) && epgData.schedule.length > 0) {
        const liveSlot = epgData.schedule.find(
          (s) =>
            nowMs >= s.startMs - 25 * 60 * 1000 &&
            nowMs <= s.endMs + 20 * 60 * 1000 &&
            (isBeinOfficial ? s.isLiveBroadcast === true : s.isLiveBroadcast !== false || s.endMs - s.startMs >= 60 * 60 * 1000) &&
            doesOfficialTitleMatchLiveEvent(s.title, ev)
        );
        if (liveSlot) {
          matchedChannels.push(chId);
          continue;
        }
      }
      if (!isBeinOfficial) {
        const nowTitle = epgData.nowPlaying?.title || '';
        if (nowTitle && doesOfficialTitleMatchLiveEvent(nowTitle, ev)) {
          matchedChannels.push(chId);
          continue;
        }
      }
    } else if (!Number.isNaN(evStartMs) && Array.isArray(epgData.schedule)) {
      const matchingSlot = epgData.schedule.find((s) => {
        if (!doesOfficialTitleMatchLiveEvent(s.title, ev)) return false;
        if (isBeinOfficial && s.isLiveBroadcast !== true) return false;
        const durationMin = (s.endMs - s.startMs) / 60000;
        const startDiffMin = Math.abs(s.startMs - evStartMs) / 60000;
        const coversKickoff = evStartMs >= s.startMs - 30 * 60 * 1000 && evStartMs < s.endMs;
        if (s.isLiveBroadcast === true) {
          return startDiffMin <= 90 || coversKickoff;
        }
        // If not explicitly marked live='1', require a full match broadcast length (>=75m) starting near kickoff
        return durationMin >= 75 && (startDiffMin <= 45 || coversKickoff);
      });
      if (matchingSlot) {
        matchedChannels.push(chId);
      }
    }
  }

  return matchedChannels;
}

function isChannelBusyWithDifferentOfficialProgram(channelId: string, ev: any): boolean {
  const epgData = cachedOfficialBroadcasterEpg.get(channelId);
  if (!epgData) return false;

  const statusUpper = String(ev?.status || '').toUpperCase();
  const isLive =
    statusUpper === 'LIVE' ||
    statusUpper === 'IN' ||
    statusUpper === 'IN_PROGRESS' ||
    statusUpper === 'HT' ||
    statusUpper === '1H' ||
    statusUpper === '2H';

  if (isLive) {
    const nowTitle = epgData.nowPlaying?.title || '';
    if (nowTitle) {
      return !doesOfficialTitleMatchLiveEvent(nowTitle, ev);
    }
    return false;
  }

  const evStartMs = Date.parse(ev?.startTime || '');
  if (!Number.isNaN(evStartMs) && Array.isArray(epgData.schedule) && epgData.schedule.length > 0) {
    const probeMs = evStartMs + 15 * 60 * 1000;
    const slotAtKickoff = epgData.schedule.find((s) => probeMs >= s.startMs && probeMs < s.endMs);
    if (slotAtKickoff && slotAtKickoff.title) {
      return !doesOfficialTitleMatchLiveEvent(slotAtKickoff.title, ev);
    }
  }

  return false;
}

function assignSmartChannelsForEvent(
  ev: any,
  slotIndex: number,
  claimedInSlot: Set<string>,
  slotContext?: {
    compRankInSlot?: number;
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
  const broadcastsList = Array.isArray(ev?.broadcasts) ? ev.broadcasts : [];
  const broadcastsText = broadcastsList.join(' ').toLowerCase();
  const compRank = slotContext?.compRankInSlot ?? 0;

  const hasEspnLinear = hasExactBroadcastToken(broadcastsList, ['ESPN', 'ABC']);
  const hasEspn2Linear = hasExactBroadcastToken(broadcastsList, ['ESPN2', 'ESPN 2']);
  const hasEspnDeportes = hasExactBroadcastToken(broadcastsList, ['ESPN Deportes']);
  const hasTntLinear = hasExactBroadcastToken(broadcastsList, ['TNT', 'truTV', 'TBS']);
  const hasNbaTvLinear = hasExactBroadcastToken(broadcastsList, ['NBA TV', 'NBATV']);
  const hasNflNetLinear = hasExactBroadcastToken(broadcastsList, ['NFL Net', 'NFL Network']);
  const hasNbcLinear = hasExactBroadcastToken(broadcastsList, ['NBC', 'CNBC', 'Peacock']);
  const hasUsaNetLinear = hasExactBroadcastToken(broadcastsList, ['USA Net', 'USA Network']);
  const hasFoxLinear = hasExactBroadcastToken(broadcastsList, ['Fox', 'FOX', 'FS1', 'Fox Sports 1']);
  const hasFs1Cable = hasExactBroadcastToken(broadcastsList, ['FS1', 'Fox Sports 1']);
  const hasFs2Cable = hasExactBroadcastToken(broadcastsList, ['FS2', 'Fox Sports 2']);
  const hasCbsLinear = hasExactBroadcastToken(broadcastsList, ['CBS', 'CBSSN', 'CBS Sports Network', 'Golazo']);
  const hasBeinBroadcast = hasExactBroadcastToken(broadcastsList, ['beIn Sports', 'beIN SPORTS', 'beIN Sports En Español']);

  const isFightCard = sport.includes('mma') || sport.includes('ufc') || sport.includes('boxing') || league.includes('ufc');
  const isMotorsport = sport.includes('motor') || sport.includes('f1') || sport.includes('racing') || league.includes('formula');

  const assignedIds: string[] = [];
  const claimedFamiliesForThisEvent = new Set<string>();
  const competitionEligibleSet = new Set<string>();
  const orderedFallbackPools: string[][] = [];

  const addFallbackPool = (pool: string[]) => {
    const validPool = pool.filter((id) => Boolean(id && LIVE_CHANNEL_DIRECTORY[id]));
    if (validPool.length === 0) return;
    for (const id of validPool) {
      competitionEligibleSet.add(id);
    }
    orderedFallbackPools.push(validPool);
  };

  // STEP 0: AUTHORITATIVE OFFICIAL BROADCASTER EPG MATCH (bein.com, Sky UK, Sky IT, Movistar+, Programme-TV, TVPassport)
  // If a channel's real-time official TV guide explicitly lists this match, claim that exact channel first!
  const officialEpgMatchedIds = Array.from(
    new Set([
      ...(Array.isArray(ev?.officialBroadcasterChannelIds) ? ev.officialBroadcasterChannelIds : []),
      ...findOfficialBroadcasterChannelsForEvent(ev),
    ])
  );
  for (const offId of officialEpgMatchedIds) {
    if (!offId || !LIVE_CHANNEL_DIRECTORY[offId] || assignedIds.includes(offId)) continue;
    assignedIds.push(offId);
    if (offId !== 'nfl-redzone') {
      claimedInSlot.add(offId);
    }
    claimedFamiliesForThisEvent.add(getChannelNetworkFamily(offId));
    competitionEligibleSet.add(offId);
  }

  // STRICT GLOBAL EXCLUSIVITY + OFFICIAL EPG CONFLICT GUARD:
  // 1) A physical TV channel can NEVER be assigned to two simultaneous events in the same time slot.
  // 2) A heuristic fallback pool can NEVER assign a channel whose official broadcaster EPG shows it is airing a DIFFERENT program/match!
  const claimChannel = (id?: string, enforceOnePerNetworkFamily = false): boolean => {
    if (!id || !LIVE_CHANNEL_DIRECTORY[id] || assignedIds.includes(id)) return false;
    const isMultiGameWhiparound = id === 'nfl-redzone';
    if (!isMultiGameWhiparound && claimedInSlot.has(id)) return false;
    if (isChannelBusyWithDifferentOfficialProgram(id, ev)) return false;
    const family = getChannelNetworkFamily(id);
    if (enforceOnePerNetworkFamily && claimedFamiliesForThisEvent.has(family)) {
      return false;
    }
    assignedIds.push(id);
    if (!isMultiGameWhiparound) {
      claimedInSlot.add(id);
    }
    claimedFamiliesForThisEvent.add(family);
    return true;
  };

  // STEP 1: REGISTER STRICT, BROADCAST-ACCURATE COMPETITION RIGHTS POOLS
  // 1. NBA / Basketball
  if (sport.includes('basketball') || league.includes('nba') || leagueSlug === 'nba') {
    if (hasEspnLinear || hasEspn2Linear) {
      addFallbackPool([hasEspn2Linear && !hasEspnLinear ? 'espn-2-hd' : 'espn-hd', 'nba-tv']);
      addFallbackPool(['tnt-sports-2', 'sky-sports-mix']);
    } else if (hasTntLinear) {
      addFallbackPool(['tnt-sports-1', 'tnt-sports-2', 'nba-tv']);
    } else if (hasNbaTvLinear || compRank === 0) {
      addFallbackPool(['nba-tv']);
    } else {
      // Regional NBA League Pass game: keep playable via NBA TV without hijacking ESPN/FS1/Sky channels
      competitionEligibleSet.add('nba-tv');
    }
  }
  // 2. NFL / American Football
  else if (
    sport === 'football' ||
    sport === 'nfl' ||
    sport === 'american-football' ||
    league.includes('nfl') ||
    leagueSlug === 'nfl'
  ) {
    if (hasEspnLinear || hasEspn2Linear) {
      addFallbackPool(['espn-hd', 'espn-2-hd']);
      addFallbackPool(['sky-sports-action']);
    } else if (hasNbcLinear) {
      addFallbackPool(['nbc-sports-now']);
      addFallbackPool(['sky-sports-action']);
    } else if (hasNflNetLinear) {
      addFallbackPool(['nfl-network']);
      addFallbackPool(['sky-sports-action']);
    } else {
      // Sunday 1pm / 4pm ET regional FOX & CBS window
      if (compRank === 0) {
        if (hasFoxLinear) {
          addFallbackPool(['fox-sports-1', 'nfl-network']);
        } else {
          addFallbackPool(['nfl-network', 'fox-sports-1']);
        }
        addFallbackPool(['sky-sports-action']);
        addFallbackPool(['nfl-redzone']);
      } else if (compRank === 1) {
        addFallbackPool(['fox-sports-2', 'nfl-redzone']);
      } else {
        // Simultaneous Sunday regional NFL games #3..#8 air on NFL RedZone Whiparound
        addFallbackPool(['nfl-redzone']);
      }
    }
  }
  // 3. UFC / MMA / Boxing
  else if (isFightCard) {
    addFallbackPool(['starzplay-sports-3-ar', 'starzplay-sports-1-ar', 'starzplay-sports-2-ar']);
    addFallbackPool(['dazn-combat', ...(hasEspnLinear ? ['espn-hd'] : [])]);
    addFallbackPool(['rmc-sport-1-fr']);
    addFallbackPool(['tnt-sports-1', 'tnt-sports-2']);
  }
  // 4. Formula 1 / Motorsport
  else if (isMotorsport) {
    addFallbackPool(['sky-sports-f1', 'red-bull-tv', ...(hasEspnLinear || hasEspn2Linear ? ['espn-2-hd'] : [])]);
    addFallbackPool(['bein-sports-8-ar', 'starzplay-sports-3-ar']);
    addFallbackPool(['dazn-f1-es', 'canal-plus-f1-fr']);
  }
  // 5. Tennis (ATP / WTA)
  else if (sport.includes('tennis') || league.includes('atp') || league.includes('wta')) {
    if (compRank === 0) {
      addFallbackPool(['sky-sports-tennis', 'tennis-channel']);
      addFallbackPool(['bein-sports-7-ar']);
    } else if (compRank === 1) {
      addFallbackPool(['tennis-channel', 'sky-sports-tennis']);
    } else {
      competitionEligibleSet.add('tennis-channel');
    }
  }
  // 6. NHL / Ice Hockey
  else if (sport.includes('hockey') || league.includes('nhl') || leagueSlug === 'nhl') {
    if (hasEspnLinear || hasEspn2Linear) {
      addFallbackPool([hasEspn2Linear && !hasEspnLinear ? 'espn-2-hd' : 'espn-hd', 'nhl-network']);
    } else if (hasTntLinear) {
      addFallbackPool(['tnt-sports-3', 'nhl-network']);
    } else if (compRank === 0) {
      addFallbackPool(['nhl-network']);
    } else {
      competitionEligibleSet.add('nhl-network');
    }
  }
  // 7. MLB / Baseball
  else if (sport.includes('baseball') || league.includes('mlb') || leagueSlug === 'mlb') {
    if (hasEspnLinear) {
      addFallbackPool(['espn-hd', 'mlb-network']);
    } else if (hasFs1Cable || hasFoxLinear) {
      addFallbackPool(['fox-sports-1', 'mlb-network']);
    } else if (compRank === 0) {
      addFallbackPool(['mlb-network']);
    } else {
      competitionEligibleSet.add('mlb-network');
    }
  }
  // 8. Football / Soccer
  else {
    const isUefaCompetition =
      leagueSlug.includes('uefa') ||
      league.includes('uefa') ||
      (league.includes('champions league') && !league.includes('afc') && !league.includes('caf')) ||
      league.includes('europa league') ||
      league.includes('conference league');

    // 8A. UEFA Champions League, UEFA Europa League, UEFA Conference League
    if (isUefaCompetition && !leagueSlug.includes('afc') && !league.includes('afc') && !league.includes('caf')) {
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
      addFallbackPool(['movistar-liga-de-campeones-es']);

      if (slotIndex === 0) {
        addFallbackPool(['bein-sports-en-1', 'bein-sports-en-2', 'bein-sports-en-3']);
      } else if (isScottishClub) {
        addFallbackPool(['bein-sports-en-2', 'bein-sports-en-3', 'bein-sports-en-1']);
      } else if (hasBritishClub) {
        addFallbackPool(['bein-sports-en-3', 'bein-sports-en-2', 'bein-sports-en-1']);
      } else if (totalBritishInSlot < 3) {
        addFallbackPool(['bein-sports-en-1', 'bein-sports-en-2', 'bein-sports-en-3']);
      }

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
    // 8B. Saudi Roshn Pro League & AFC Champions League Elite (STARZPLAY Asia & beIN AFC)
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
        addFallbackPool(['bein-sports-afc-ar', 'starzplay-asia-1-ar', 'starzplay-asia-2-ar']);
      } else {
        addFallbackPool(['starzplay-asia-1-ar', 'starzplay-asia-2-ar', 'starzplay-sports-3-ar']);
        if (hasFs1Cable || hasFs2Cable) {
          addFallbackPool(['fox-sports-2']);
        }
      }
    }
    // 8C-1. English Premier League & FA Cup (Top-Flight)
    else if (
      leagueSlug === 'eng.1' ||
      leagueSlug === 'eng.fa' ||
      league.includes('premier league') ||
      league.includes('fa cup')
    ) {
      if (compRank === 0) {
        addFallbackPool(['bein-sports-1-ar', 'bein-sports-2-ar']);
        if (broadcastsText.includes('tnt') || leagueSlug === 'eng.fa' || league.includes('fa cup')) {
          addFallbackPool(['tnt-sports-1', 'sky-sports-premier-league', 'sky-sports-main-event']);
        } else {
          addFallbackPool(['sky-sports-premier-league', 'sky-sports-main-event']);
        }
        addFallbackPool(['supersport-premier-league', 'supersport-grandstand']);
        if (hasUsaNetLinear) {
          addFallbackPool(['usa-network-hd']);
        } else if (hasNbcLinear) {
          addFallbackPool(['nbc-sports-now']);
        }
        addFallbackPool(['bein-sports-en-1', 'bein-sports-en-2']);
        addFallbackPool(['canal-plus-foot-fr']);
      } else if (compRank === 1) {
        addFallbackPool(['bein-sports-2-ar', 'bein-sports-1-ar']);
        addFallbackPool(['sky-sports-main-event', 'sky-sports-premier-league', 'tnt-sports-1']);
        addFallbackPool(['supersport-grandstand', 'supersport-premier-league', 'supersport-variety-1']);
        addFallbackPool(['bein-sports-en-2', 'bein-sports-en-1']);
      } else {
        addFallbackPool(['bein-sports-2-ar', 'bein-sports-5-ar', 'bein-sports-6-ar']);
        addFallbackPool(['supersport-variety-1', 'supersport-premier-league']);
        addFallbackPool(['bein-sports-en-3']);
      }
    }
    // 8C-2. EFL Championship / Carabao Cup / English Football League (eng.2)
    else if (
      leagueSlug === 'eng.2' ||
      leagueSlug.includes('eng.') ||
      league.includes('championship') ||
      league.includes('efl') ||
      league.includes('carabao')
    ) {
      addFallbackPool(['sky-sports-football', 'sky-sports-plus']);
      if (compRank === 0) {
        addFallbackPool(['bein-sports-8-ar']);
        addFallbackPool(['cbs-sports-golazo']);
      }
    }
    // 8D-1. Spanish LaLiga 2 Hypermotion / Segunda División (Strictly on LaLiga TV Hypermotion ES)
    else if (
      leagueSlug === 'esp.2' ||
      league.includes('laliga 2') ||
      league.includes('hypermotion') ||
      league.includes('segunda')
    ) {
      addFallbackPool(['laliga-hypermotion-es']);
    }
    // 8D-2. Spanish LaLiga (First Division) / Copa del Rey
    else if (leagueSlug.includes('esp') || league.includes('laliga') || league.includes('copa del rey')) {
      const hasRealMadrid = /\b(real madrid)\b/i.test(teamsText);
      const hasBarcelona = /\b(barcelona)\b/i.test(teamsText);
      const isElClasicoOrGiant = (hasRealMadrid && hasBarcelona) || hasRealMadrid || hasBarcelona;

      if (isElClasicoOrGiant) {
        addFallbackPool(['bein-sports-1-ar', 'bein-sports-3-ar']);
        addFallbackPool(['bein-sports-en-1']);
        addFallbackPool(['movistar-laliga-es', 'dazn-laliga-es', 'movistar-plus-es']);
        if (hasRealMadrid) {
          addFallbackPool(['real-madrid-tv']);
        }
        addFallbackPool(['premier-sports-1', 'premier-sports-2']);
        addFallbackPool(['bein-sports-fr-1', 'bein-sports-fr-2']);
        addFallbackPool(['supersport-laliga']);
        if (hasEspnLinear) {
          addFallbackPool(['espn-hd', 'espn-deportes-es']);
        } else if (hasEspnDeportes) {
          addFallbackPool(['espn-deportes-es']);
        }
      } else {
        addFallbackPool(['bein-sports-3-ar']);
        addFallbackPool(['dazn-laliga-es', 'movistar-laliga-es']);
        addFallbackPool(['premier-sports-1', 'premier-sports-2']);
        addFallbackPool(['bein-sports-fr-2', 'bein-sports-fr-1']);
        addFallbackPool(['supersport-laliga']);
        if (hasEspnDeportes) {
          addFallbackPool(['espn-deportes-es']);
        }
        if (hasEspnLinear) {
          addFallbackPool(['espn-hd']);
        }
      }
    }
    // 8E. Italian Serie A / Coppa Italia
    else if (leagueSlug.includes('ita') || league.includes('serie a') || league.includes('coppa italia')) {
      if (compRank === 0) {
        addFallbackPool(['starzplay-sports-1-ar', 'starzplay-sports-2-ar', 'starzplay-sports-3-ar']);
        addFallbackPool(['dazn-1-it', 'sky-sport-calcio-it', 'sky-sport-uno-it']);
        addFallbackPool(['tnt-sports-2', 'tnt-sports-3']);
        addFallbackPool(['cbs-sports-golazo']);
        addFallbackPool(['supersport-football']);
      } else {
        addFallbackPool(['starzplay-sports-2-ar', 'starzplay-sports-3-ar', 'starzplay-sports-1-ar']);
        addFallbackPool(['dazn-2-it', 'sky-sport-252-it', 'sky-sport-calcio-it']);
        addFallbackPool(['tnt-sports-3', 'tnt-sports-4']);
      }
    }
    // 8F. German Bundesliga / DFB-Pokal (Note: beIN Sports MENA does NOT hold Bundesliga rights; broadcasted in Europe on beIN FR 2 / MAX, Sky DE/IT/UK & ESPN)
    else if (leagueSlug.includes('ger') || league.includes('bundesliga')) {
      if (compRank === 0) {
        addFallbackPool(['bein-sports-fr-2', 'bein-sports-max-5-fr']);
        addFallbackPool(['sky-sport-arena-it', 'sky-sport-max-it']);
        addFallbackPool(['sky-sports-football', 'sky-sports-mix']);
        if (hasEspnLinear || hasEspn2Linear) {
          addFallbackPool(['espn-2-hd', 'espn-hd']);
        }
      } else {
        addFallbackPool(['bein-sports-max-5-fr', 'bein-sports-max-6-fr']);
        addFallbackPool(['sky-sport-max-it']);
        addFallbackPool(['sky-sports-mix', 'sky-sports-plus']);
      }
    }
    // 8G. French Ligue 1 & Ligue 2
    // Flagship match in each time window airs on beIN Sports 4 HD (AR), DAZN Ligue 1 (FR) & beIN Sports 2 EN.
    // Concurrent Sunday multiplex matches air strictly on beIN Sports MAX 4..10 (FR) — NEVER overflowing onto beIN 2/3/5/6 AR!
    else if (leagueSlug.includes('fra') || league.includes('ligue 1') || league.includes('ligue 2')) {
      const isLigue2 = leagueSlug === 'fra.2' || league.includes('ligue 2');
      if (!isLigue2 && compRank === 0) {
        addFallbackPool(['bein-sports-4-ar']);
        addFallbackPool(['dazn-ligue1-fr', ...(hasBeinBroadcast ? ['bein-sports-fr-1'] : [])]);
        addFallbackPool(['bein-sports-en-2']);
      } else {
        addFallbackPool([
          'bein-sports-max-4-fr',
          'bein-sports-max-5-fr',
          'bein-sports-max-6-fr',
          'bein-sports-max-7-fr',
          'bein-sports-max-9-fr',
          'bein-sports-max-10-fr',
        ]);
      }
    }
    // 8H. Turkish Süper Lig
    else if (leagueSlug.includes('tur') || league.includes('türkiye') || league.includes('super lig')) {
      addFallbackPool(['bein-sports-1-tr', 'bein-sports-2-tr', 'bein-sports-3-tr', 'bein-sports-4-tr', 'bein-sports-5-tr']);
    }
    // 8I. CAF Champions League / CAF Confederation Cup / Algerian & North African Football
    else if (
      leagueSlug.includes('caf') ||
      league.includes('caf') ||
      leagueSlug.includes('mar') ||
      leagueSlug.includes('alg') ||
      /\b(wydad|raja|far rabat|as far|berkane|morocco|fath union|hassania|maghreb|al ahly|zamalek|esperance|tp mazembe|mamelodi|simba|club africain|usm alger|mc alger|cr belouizdad|js kabylie|es setif|cs constantine)\b/i.test(teamsText)
    ) {
      addFallbackPool(['bein-sports-6-ar', 'algeria-tv6-youth', 'algeria-el-heddaf-tv', 'canal-plus-afrique-1']);
    }
    // 8J-1. CONMEBOL Libertadores / Sudamericana
    else if (
      leagueSlug.includes('conmebol') ||
      league.includes('libertadores') ||
      league.includes('sudamericana')
    ) {
      addFallbackPool(['bein-sports-xtra-es', 'bein-sports-xtra-en']);
      if (hasFs1Cable || hasFs2Cable) {
        addFallbackPool(['fox-sports-2']);
      }
    }
    // 8J-2. Major League Soccer (MLS) & Liga MX
    else if (
      leagueSlug.includes('mex') ||
      league.includes('liga mx') ||
      leagueSlug.includes('usa') ||
      league.includes('mls')
    ) {
      addFallbackPool(['fox-sports-1', 'fox-sports-2', 'espn-deportes-es']);
    }
    // 8K. Default International Football
    else {
      if (compRank === 0) {
        addFallbackPool(['bein-sports-1-ar', 'bein-sports-2-ar', 'bein-sports-3-ar', 'bein-sports-4-ar']);
        addFallbackPool(['bein-sports-en-1', 'bein-sports-en-2', 'premier-sports-1']);
      }
    }
  }

  // STEP 2: AUTHORITATIVE COMPETITION & PRESTIGE POOL ASSIGNMENT
  for (const pool of orderedFallbackPools) {
    for (const id of pool) {
      if (claimChannel(id, true)) break;
    }
  }

  // STEP 3: For El Clásico / Real Madrid / Barcelona, ensure both beIN Sports 1 HD AR and beIN Sports 3 HD AR (and Movistar + DAZN LaLiga) are attached if unclaimed and not busy with another official broadcast
  const isClasicoOrSpanishGiant =
    (leagueSlug.includes('esp.1') || league.includes('spanish laliga')) &&
    /\b(real madrid|barcelona)\b/i.test(teamsText);
  if (isClasicoOrSpanishGiant) {
    for (const extraLaLigaCh of ['bein-sports-3-ar', 'bein-sports-1-ar', 'dazn-laliga-es', 'movistar-laliga-es']) {
      if (
        !assignedIds.includes(extraLaLigaCh) &&
        !claimedInSlot.has(extraLaLigaCh) &&
        !isChannelBusyWithDifferentOfficialProgram(extraLaLigaCh, ev)
      ) {
        assignedIds.push(extraLaLigaCh);
        claimedInSlot.add(extraLaLigaCh);
      }
    }
  }

  // STEP 4: Ensure the primary flagship match of a league with Arabic rights includes an Arabic badge ONLY if that Arabic channel is not officially broadcasting a different program
  const hasArabicAssigned = assignedIds.some((id) => id.endsWith('-ar'));
  if (!hasArabicAssigned && compRank === 0 && orderedFallbackPools.length > 0) {
    const arPool = orderedFallbackPools.find((p) => p.some((id) => id.endsWith('-ar')));
    if (arPool && arPool.length > 0) {
      const arCandidates = arPool.filter(
        (id) =>
          id.endsWith('-ar') &&
          LIVE_CHANNEL_DIRECTORY[id] &&
          !isChannelBusyWithDifferentOfficialProgram(id, ev)
      );
      const unclaimedAr = arCandidates.find((id) => !claimedInSlot.has(id));
      const pickedAr = unclaimedAr || arCandidates[0];
      if (pickedAr && !assignedIds.includes(pickedAr)) {
        assignedIds.unshift(pickedAr);
        claimedInSlot.add(pickedAr);
      }
    }
  }

  // STEP 5: Competition-restricted fallback for match card playback if all primary channels in the pool were claimed
  if (assignedIds.length === 0 && competitionEligibleSet.size > 0) {
    const eligibleList = Array.from(competitionEligibleSet);
    const nonConflicting = eligibleList.filter((id) => !isChannelBusyWithDifferentOfficialProgram(id, ev));
    const poolToUse = nonConflicting.length > 0 ? nonConflicting : eligibleList;
    const unclaimedEligible = poolToUse.find((id) => !claimedInSlot.has(id));
    if (unclaimedEligible) {
      assignedIds.push(unclaimedEligible);
      claimedInSlot.add(unclaimedEligible);
    } else if (poolToUse[0]) {
      assignedIds.push(poolToUse[0]);
    }
  }

  // Ensure any official broadcaster channel matched in Step 0 stays at the front of its language group
  const sortedIds = sortEventChannelsForCardDisplay(assignedIds);
  if (officialEpgMatchedIds.length > 0) {
    const primaryOfficialAr = officialEpgMatchedIds.find((id) => id.endsWith('-ar'));
    if (primaryOfficialAr && sortedIds.includes(primaryOfficialAr)) {
      const idx = sortedIds.indexOf(primaryOfficialAr);
      if (idx > 0) {
        sortedIds.splice(idx, 1);
        sortedIds.unshift(primaryOfficialAr);
      }
    }
  }

  return sortedIds.map((id) => buildRecommendedChannelItem(id));
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

async function getOrRefreshLiveEventsPayload(maxAgeMs = 45000): Promise<{
  status: string;
  updatedAt: string;
  count: number;
  events: any[];
}> {
  const hasValidCached =
    cachedLiveEventsPayload &&
    Array.isArray(cachedLiveEventsPayload.data?.events) &&
    cachedLiveEventsPayload.data.events.length > 0;

  if (hasValidCached && Date.now() - cachedLiveEventsPayload!.timestamp < maxAgeMs) {
    return cachedLiveEventsPayload!.data;
  }

  const triggerRefresh = () => {
    if (!liveEventsRefreshInFlight) {
      liveEventsRefreshInFlight = refreshLiveEventsPayloadInternal().finally(() => {
        liveEventsRefreshInFlight = null;
      });
    }
    return liveEventsRefreshInFlight;
  };

  // Stale-While-Revalidate: if we already have cached live events and maxAgeMs > 0,
  // return the cached events in <1ms and refresh in the background so users never wait!
  if (hasValidCached && maxAgeMs > 0) {
    triggerRefresh().catch(() => {});
    return cachedLiveEventsPayload!.data;
  }

  return triggerRefresh();
}

async function refreshLiveEventsPayloadInternal(): Promise<{
  status: string;
  updatedAt: string;
  count: number;
  events: any[];
}> {
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
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.league_cup/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'Carabao Cup', slug: 'eng.league_cup' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'Spanish LaLiga', slug: 'esp.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/esp.2/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'Spanish LaLiga 2 Hypermotion', slug: 'esp.2' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'Italian Serie A', slug: 'ita.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'German Bundesliga', slug: 'ger.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'French Ligue 1', slug: 'fra.1' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fra.2/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'French Ligue 2 BKT', slug: 'fra.2' },
      { url: `https://site.api.espn.com/apis/site/v2/sports/soccer/tur.1/scoreboard?dates=${todayIso}`, sport: 'soccer', league: 'Turkish Süper Lig', slug: 'tur.1' },
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

    const [cineproRaw, cineproEpgRaw, , ...espnResults] = await Promise.all([
      fetchJsonFast(`${getCineproUrl()}/v1/live/events`, 8500),
      fetchJsonFast(`${getCineproUrl()}/v1/live/epg`, 12000),
      ensureOfficialBroadcasterEpgReady(7500),
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

    // 2.5. Cross-Link & Synthesize Live/Upcoming Matches from Official beIN Sports EPG (bein.com)
    // Ensures every live/upcoming match shown on beIN Sports in the Live Channels tab also exists in Live Matches with the exact same beIN channel!
    for (const [chId, epgData] of cachedOfficialBroadcasterEpg.entries()) {
      if (!chId.startsWith('bein-sports-') || chId.startsWith('bein-sports-premium-')) continue;
      const scheduleSlots = Array.isArray(epgData.schedule) ? epgData.schedule : [];
      for (const slot of scheduleSlots) {
        const isCurrentlyOnAir = nowMs >= slot.startMs && nowMs < slot.endMs;
        const isUpcomingWithin24h = slot.startMs > nowMs && slot.startMs - nowMs <= 24 * 3600 * 1000;
        if (!isCurrentlyOnAir && !isUpcomingWithin24h) continue;

        // Strictly require live='1' (isLiveBroadcast === true) so beIN Sports reruns/replays are never synthesized as live matches
        if (slot.isLiveBroadcast !== true) continue;

        const rawTitle = String(slot.title || '').trim();
        if (!/\s+vs\.?\s+/i.test(rawTitle) || /premier padel|highlights|review|magazine/i.test(rawTitle)) continue;

        // Check if an event in eventsMap already matches this official beIN slot
        let matchedExisting: any = null;
        for (const existingEv of eventsMap.values()) {
          const exStartMs = Date.parse(existingEv.startTime || '');
          const timeClose =
            Number.isNaN(exStartMs) ||
            Math.abs(exStartMs - slot.startMs) <= 4 * 3600 * 1000 ||
            (isCurrentlyOnAir && isLiveState(existingEv.status));
          if (timeClose && doesOfficialTitleMatchLiveEvent(rawTitle, existingEv)) {
            matchedExisting = existingEv;
            break;
          }
        }

        if (matchedExisting) {
          if (!Array.isArray(matchedExisting.officialBroadcasterChannelIds)) {
            matchedExisting.officialBroadcasterChannelIds = [];
          }
          if (!matchedExisting.officialBroadcasterChannelIds.includes(chId)) {
            matchedExisting.officialBroadcasterChannelIds.push(chId);
          }
          continue;
        }

        // Parse "Home Team vs Away Team - League Name" from official beIN schedule
        const parts = rawTitle.split(/\s+-\s+/);
        const vsPart = parts[0] || '';
        const vsSplit = vsPart.split(/\s+vs\.?\s+/i);
        if (vsSplit.length !== 2) continue;

        const cleanTeamName = (s: string) =>
          s
            .replace(/\s*\([A-Z]{3}\)\s*/g, ' ')
            .replace(/\bOU\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        const homeName = cleanTeamName(vsSplit[0]);
        const awayName = cleanTeamName(vsSplit[1]);
        if (!homeName || !awayName || homeName.length < 3 || awayName.length < 3) continue;
        if (/^(m\d+|tbd|home|away)$/i.test(homeName) || /^(m\d+|tbd|home|away)$/i.test(awayName)) continue;

        const rawLeague = parts.slice(1).join(' - ').replace(/\s*202\d\s*\/?\s*202\d\s*/g, '').trim() || slot.subtitle || 'Live Football';
        const lowerLeague = `${rawTitle} ${slot.subtitle || ''}`.toLowerCase();
        const sportType =
          lowerLeague.includes('atp') || lowerLeague.includes('wta') || lowerLeague.includes('تنس')
            ? 'tennis'
            : lowerLeague.includes('nba') || lowerLeague.includes('wnba') || lowerLeague.includes('basket') || lowerLeague.includes('سلة')
              ? 'basketball'
              : lowerLeague.includes('nfl')
                ? 'football'
                : 'soccer';

        const synthEv = {
          id: `bein-epg-${slot.startMs}-${homeName.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
          title: `${homeName} vs ${awayName}`,
          shortTitle: `${homeName.slice(0, 3).toUpperCase()} vs ${awayName.slice(0, 3).toUpperCase()}`,
          sport: sportType,
          league: rawLeague,
          leagueSlug: rawLeague.toLowerCase(),
          startTime: slot.startTime,
          status: isCurrentlyOnAir ? 'LIVE' : 'UPCOMING',
          statusDetail: isCurrentlyOnAir ? 'LIVE' : 'Scheduled',
          homeTeam: {
            name: homeName,
            shortName: homeName.slice(0, 3).toUpperCase(),
            score: '0',
          },
          awayTeam: {
            name: awayName,
            shortName: awayName.slice(0, 3).toUpperCase(),
            score: '0',
          },
          broadcasts: [LIVE_CHANNEL_DIRECTORY[chId]?.name || chId],
          officialBroadcasterChannelIds: [chId],
          epgLiveChannelIds: isCurrentlyOnAir ? [chId] : [],
          epgUpcomingChannelIds: !isCurrentlyOnAir ? [chId] : [],
        };

        const pairKey = makeTeamPairKey(synthEv);
        const existingPairId = pairKey ? teamMatchupKeyToIdMap.get(pairKey) : undefined;
        if (existingPairId && eventsMap.has(existingPairId)) {
          const ex = eventsMap.get(existingPairId);
          if (!Array.isArray(ex.officialBroadcasterChannelIds)) ex.officialBroadcasterChannelIds = [];
          if (!ex.officialBroadcasterChannelIds.includes(chId)) ex.officialBroadcasterChannelIds.push(chId);
        } else {
          eventsMap.set(synthEv.id, synthEv);
          if (pairKey) teamMatchupKeyToIdMap.set(pairKey, synthEv.id);
        }
      }
    }

    // Populate officialBroadcasterChannelIds for all events before sorting
    for (const ev of eventsMap.values()) {
      const matchedOff = findOfficialBroadcasterChannelsForEvent(ev);
      ev.officialBroadcasterChannelIds = Array.from(
        new Set([...(Array.isArray(ev.officialBroadcasterChannelIds) ? ev.officialBroadcasterChannelIds : []), ...matchedOff])
      );
    }

    // 3. Sort events: LIVE first, then UPCOMING by kickoff time ascending, then FINISHED by kickoff time descending,
    //    and within the same kickoff time window sort by official EPG confirmation & broadcast prestige
    const allEvents = Array.from(eventsMap.values()).sort((a, b) => {
      const aLive = isLiveState(a.status);
      const bLive = isLiveState(b.status);
      if (aLive !== bLive) return aLive ? -1 : 1;

      const aFin = isFinishedState(a.status);
      const bFin = isFinishedState(b.status);
      if (aFin !== bFin) return aFin ? 1 : -1;

      if (aLive && bLive) {
        const aHasOff = (a.officialBroadcasterChannelIds?.length || 0) > 0 ? 1 : 0;
        const bHasOff = (b.officialBroadcasterChannelIds?.length || 0) > 0 ? 1 : 0;
        if (aHasOff !== bHasOff) return bHasOff - aHasOff;
        return getMatchBroadcastPrestige(b) - getMatchBroadcastPrestige(a);
      }

      const tA = Date.parse(a.startTime || '') || 0;
      const tB = Date.parse(b.startTime || '') || 0;
      const bucketA = Math.floor(tA / (60 * 60 * 1000));
      const bucketB = Math.floor(tB / (60 * 60 * 1000));
      if (bucketA !== bucketB) {
        return aFin ? bucketB - bucketA : bucketA - bucketB;
      }
      const prestigeDiff = getMatchBroadcastPrestige(b) - getMatchBroadcastPrestige(a);
      if (prestigeDiff !== 0) {
        return prestigeDiff;
      }
      return aFin ? tB - tA : tA - tB;
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
    const compSlotCounters = new Map<string, number>();
    const slotBritishCounters = new Map<string, number>();
    const slotFrenchCounters = new Map<string, number>();
    const slotTurkishCounters = new Map<string, number>();
    const globalSlotClaimedChannels = new Map<string, Set<string>>();

    const normalizedEvents = allEvents.map((ev: any) => {
      const globalTimeSlotKey = getSimultaneousSlotKey(ev);
      const groupSlotKey = `${getBroadcasterPoolGroup(ev)}__${globalTimeSlotKey}`;

      const idxInSlot = slotCounters.get(globalTimeSlotKey) || 0;
      slotCounters.set(globalTimeSlotKey, idxInSlot + 1);

      const compRankInSlot = compSlotCounters.get(groupSlotKey) || 0;
      compSlotCounters.set(groupSlotKey, compRankInSlot + 1);

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
        compRankInSlot,
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
        officialBroadcasterChannelIds: offIdsForEv,
        ...cleanEv
      } = ev;
      const mergedLiveIds = Array.from(
        new Set([
          ...(Array.isArray(epgLiveIdsForEv) ? epgLiveIdsForEv : []),
          ...(isLiveState(ev.status) && Array.isArray(offIdsForEv) ? offIdsForEv : []),
        ])
      );
      return {
        ...cleanEv,
        epgLiveChannelIds: mergedLiveIds,
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

// Curated channel-authentic 24/7 programming across all 142 Sports, Movies & Entertainment channels
const CHANNEL_CURATED_STUDIO_PROGRAMS: Record<string, { now: string; next: string; subtitle: string }> = {
  // beIN Sports MENA (Arabic)
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
    now: 'الأستوديو التحليلي المباشر - الدوري الفرنسي والبطولات الأوروبية والعالمية',
    next: 'ملخصات وأهداف الدوريات الأوروبية والبطولات الدولية - beIN Sports 5 HD',
    subtitle: 'European & FIFA Football • 24/7 Studio',
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

  // beIN Sports English / French / Turkish / Spanish
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
  'bein-sports-max-4-fr': {
    now: 'beIN Sports MAX 4 France : Multiplex Ligue 1 & Football Européen',
    next: 'beIN Sports MAX 4 France : Résumés & Temps Forts',
    subtitle: 'Multiplex Football • France HD',
  },
  'bein-sports-max-5-fr': {
    now: 'beIN Sports MAX 5 France : Multiplex Ligue 1 & Ligue 2 BKT',
    next: 'beIN Sports MAX 5 France : Résumés & Temps Forts',
    subtitle: 'Multiplex Football • France HD',
  },
  'bein-sports-max-6-fr': {
    now: 'beIN Sports MAX 6 France : Direct Multiplex & Football Européen',
    next: 'beIN Sports MAX 6 France : Magazine & Résumés',
    subtitle: 'Multiplex Football • France HD',
  },
  'bein-sports-max-7-fr': {
    now: 'beIN Sports MAX 7 France : Direct Multiplex & Coupes Nationales',
    next: 'beIN Sports MAX 7 France : Magazine & Résumés',
    subtitle: 'Multiplex Football • France HD',
  },
  'bein-sports-max-9-fr': {
    now: 'beIN Sports MAX 9 France : Direct Multiplex & Multisports',
    next: 'beIN Sports MAX 9 France : Temps Forts de la Journée',
    subtitle: 'Multiplex Football • France HD',
  },
  'bein-sports-max-10-fr': {
    now: 'beIN Sports MAX 10 France : Direct Multiplex & Multisports',
    next: 'beIN Sports MAX 10 France : Temps Forts de la Journée',
    subtitle: 'Multiplex Football • France HD',
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

  // STARZPLAY Sports, Asia, CricLife & Cinema
  'starzplay-sports-1-ar': {
    now: 'الأستوديو التحليلي للدوري الإيطالي (Serie A Enilive) - STARZPLAY Sports 1 HD',
    next: 'ملخصات وأهداف الكالتشيو الإيطالي - AD Sports Premium 1',
    subtitle: 'Italian Serie A • STARZPLAY 1 HD',
  },
  'starzplay-sports-2-ar': {
    now: 'تغطية مباريات الدوري الإيطالي وكأس إيطاليا - STARZPLAY Sports 2 HD',
    next: 'أبرز لقطات وأهداف الكالتشيو - AD Sports Premium 2',
    subtitle: 'Italian Serie A • STARZPLAY 2 HD',
  },
  'starzplay-sports-3-ar': {
    now: 'تغطية الفنون القتالية (UFC Arabia & PFL) ونزالات البطولة - STARZPLAY Sports 3 HD',
    next: 'أقوى نزالات UFC Fight Night والبطولات العالمية - STARZPLAY Sports 3 HD',
    subtitle: 'UFC Arabia & Combat Sports • STARZPLAY 3 HD',
  },
  'starzplay-asia-1-ar': {
    now: 'الأستوديو التحليلي لدوري أبطال آسيا للنخبة - STARZPLAY Sports Asia 1 HD',
    next: 'ملخصات وأهداف البطولات الآسيوية - AD Sports Asia 1 HD',
    subtitle: 'AFC Champions League Elite • STARZPLAY Asia 1',
  },
  'starzplay-asia-2-ar': {
    now: 'تغطية مباريات دوري أبطال آسيا والتصفيات الآسيوية - STARZPLAY Sports Asia 2 HD',
    next: 'أبرز لقطات وأهداف الكرة الآسيوية - AD Sports Asia 2 HD',
    subtitle: 'AFC & Asian Football • STARZPLAY Asia 2',
  },
  'starzplay-criclife-1': {
    now: 'STARZPLAY CricLife 1 HD: ICC Test, ODI & T20 International Cricket Live Studio',
    next: 'STARZPLAY CricLife 1 HD: IPL & World Cricket Highlights',
    subtitle: '24/7 Live Cricket • STARZPLAY CricLife 1',
  },
  'starzplay-criclife-2': {
    now: 'STARZPLAY CricLife 2 HD: International T20 Leagues & Test Series Coverage',
    next: 'STARZPLAY CricLife 2 HD: Classic Matches & Boundary Highlights',
    subtitle: '24/7 International Cricket • STARZPLAY CricLife 2',
  },
  'starzplay-encore-hd': {
    now: 'STARZPLAY Encore HD: Hollywood Blockbuster Cinema & Exclusive Series',
    next: 'STARZPLAY Encore HD: Prime Time Feature Film Presentation',
    subtitle: 'STARZPLAY Movies & Series • 1080p HD',
  },
  'starzplay-action-hd': {
    now: 'STARZPLAY Edge Action HD: Non-Stop Action Movies & STARZ Originals',
    next: 'STARZPLAY Edge Action HD: Adrenaline Feature Presentation',
    subtitle: 'STARZPLAY Action & Originals • 1080p HD',
  },

  // Movies & Cinema (English & Arabic)
  'bein-movies-premiere-en': {
    now: 'beIN Movies 1 Premiere: Hollywood Box Office Premiere Showcase',
    next: 'beIN Movies 1 Premiere: Critics’ Choice Feature Presentation',
    subtitle: 'Cinema Premiere • 1080p Movies',
  },
  'bein-movies-action-en': {
    now: 'beIN Movies 2 Action: Non-Stop Action & Blockbuster Cinema',
    next: 'beIN Movies 2 Action: Adrenaline Feature Presentation',
    subtitle: 'Action Cinema • 1080p Movies',
  },
  'bein-movies-hits-en': {
    now: 'beIN Movies Stars: Award-Winning Cinema & Box Office Hits',
    next: 'beIN Movies Stars: Prime Time Feature Film',
    subtitle: 'Box Office Hits • 1080p Movies',
  },
  'bein-movies-drama-en': {
    now: 'beIN Movies 3 Drama: Acclaimed Drama & Masterpiece Cinema',
    next: 'beIN Movies 3 Drama: Evening Feature Presentation',
    subtitle: 'Drama Cinema • 1080p Movies',
  },
  'hbo-hd': {
    now: 'HBO HD: Original Series & Theatrical Blockbuster Premiere',
    next: 'HBO HD: Sunday Night Original Drama & Feature Film',
    subtitle: 'HBO Originals & Cinema • 1080p HD',
  },
  'hbo-2-hd': {
    now: 'HBO 2 HD: Hollywood Feature Film & Box Office Special',
    next: 'HBO 2 HD: Encore Original Series & Cinema Showcase',
    subtitle: 'HBO 2 Movies & Series • 1080p HD',
  },
  'showtime-hd': {
    now: 'Showtime HD: Championship Cinema & Original Drama Series',
    next: 'Showtime HD: Prime Time Feature Presentation',
    subtitle: 'Showtime Cinema & Originals • 1080p HD',
  },
  'starz-hd': {
    now: 'Starz HD: Hit Movies & Original Series Showcase',
    next: 'Starz HD: Blockbuster Feature Presentation',
    subtitle: 'Starz Cinema • 1080p HD',
  },
  'cinemax-hd': {
    now: 'Cinemax HD: Action, Thriller & Sci-Fi Feature Presentation',
    next: 'Cinemax HD: Late Night Action Blockbuster',
    subtitle: 'Cinemax Action Movies • 1080p HD',
  },
  'bein-movies-action-ar': {
    now: 'سهرة أفلام الأكشن والإثارة المترجمة - Shahid Action Movies HD',
    next: 'فيلم السهرة: أقوى أفلام الحركة العالمية - Action Movies AR',
    subtitle: 'Action Movies • مترجم للعربية HD',
  },
  'bein-movies-thriller-ar': {
    now: 'سهرة أفلام الغموض والتشويق المترجمة - Shahid Thriller Movies HD',
    next: 'فيلم السهرة: إثارة وتشويق بلا حدود - Thriller Movies AR',
    subtitle: 'Thriller & Mystery • مترجم للعربية HD',
  },
  'bein-aflam-ar': {
    now: 'العرض الأول لأحدث الأفلام العربية والسينما المصرية - شاهد أفلام HD',
    next: 'سهرة السينما العربية المختارة - Shahid Aflam HD',
    subtitle: 'Arabic Cinema • أفلام عربية 24/7',
  },
  'rotana-cinema-ar': {
    now: 'فيلم السهرة العربي الحصري - روتانا سينما (مش هتقدر تغمض عينيك)',
    next: 'روائع السينما المصرية والعربية - Rotana Cinema HD',
    subtitle: 'Rotana Cinema • سينما عربية 24/7',
  },

  // Arabic Entertainment (Rotana, MBC, Shahid, Spacetoon)
  'rotana-drama-ar': {
    now: 'أقوى المسلسلات الخليجية والعربية الدرامية - روتانا دراما HD',
    next: 'المسلسل العربي المسائي الحصري - Rotana Drama HD',
    subtitle: 'Arabic Drama Series • روتانا دراما',
  },
  'rotana-comedy-ar': {
    now: 'أحلى المسرحيات والمسلسلات الكوميدية العربية - روتانا كوميدي HD',
    next: 'سهرة الضحك والكوميديا المصرية والخليجية - Rotana Comedy HD',
    subtitle: 'Arabic Comedy • روتانا كوميدي',
  },
  'mbc-1-ar': {
    now: 'البرامج الترفيهية الكبرى والمسلسلات الحصرية - MBC 1 HD',
    next: 'سهرة MBC 1 وأقوى العروض العائلية والعربية',
    subtitle: 'MBC 1 • Family & Entertainment HD',
  },
  'mbc-4-ar': {
    now: 'المسلسلات التركية المدبلجة والعروض العالمية - MBC 4 HD',
    next: 'برامج اللايف ستايل والدراما الرومانسية - MBC 4 HD',
    subtitle: 'MBC 4 • Series & Lifestyle HD',
  },
  'mbc-5-ar': {
    now: 'برامج ومسلسلات المغرب العربي الترفيهية - MBC 5 HD',
    next: 'سهرة الأسرة المغاربية والعروض الحصرية - MBC 5 HD',
    subtitle: 'MBC 5 • Maghreb Entertainment HD',
  },
  'mbc-drama-ar': {
    now: 'المسلسلات الخليجية والعربية على مدار الساعة - MBC Drama HD',
    next: 'العرض الحصري لأقوى الدراما الاجتماعية - MBC Drama HD',
    subtitle: 'MBC Drama • عيونك على الدراما 24/7',
  },
  'mbc-plus-drama-ar': {
    now: 'ماراثون المسلسلات الدرامية المشفرة بدون فواصل - MBC+ Drama HD',
    next: 'حلقات متتالية من أحدث الإنتاجات العربية - MBC+ Drama HD',
    subtitle: 'MBC+ Drama • Premium Series 24/7',
  },
  'mbc-masr-ar': {
    now: 'برنامج الحكاية والترفيه المصري والمسلسلات الحصرية - MBC مصر 1 HD',
    next: 'مسرح مصر وأقوى الأعمال الدرامية المصرية - MBC Masr HD',
    subtitle: 'MBC Masr 1 • Egypt Entertainment HD',
  },
  'mbc-masr-2-ar': {
    now: 'البرامج الترفيهية والرياضية والمسلسلات المصرية - MBC مصر 2 HD',
    next: 'عروض مسرح مصر والدراما الكوميدية - MBC Masr 2 HD',
    subtitle: 'MBC Masr 2 • Egypt Series & Variety HD',
  },
  'mbc-iraq-ar': {
    now: 'البرامج العراقية الترفيهية والدراما الحصرية - MBC العراق HD',
    next: 'سهرة العائلة العراقية وأحدث المسلسلات - MBC Iraq HD',
    subtitle: 'MBC Iraq • Iraqi Entertainment HD',
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

  // UK & SuperSport Channels
  'sky-sports-main-event': {
    now: 'Sky Sports Main Event: Live Football Studio & Super Sunday',
    next: 'Sky Sports Main Event: Matchday Analysis & Extended Highlights',
    subtitle: 'Premier League & Main Event • UK HD',
  },
  'sky-sports-premier-league': {
    now: 'Sky Sports Premier League: 24/7 EPL Matchday Studio & Classics',
    next: 'Premier League Years & Tactical Breakdown',
    subtitle: 'English Premier League • UK HD',
  },
  'sky-sports-football': {
    now: 'Sky Sports Football: EFL, Bundesliga & SPFL Matchday Studio',
    next: 'Sky Sports Football: Goals & Highlights Show',
    subtitle: 'EFL & European Football • UK HD',
  },
  'sky-sports-plus': {
    now: 'Sky Sports+: Live EFL & Multi-Match Broadcast Center',
    next: 'Sky Sports+: Featured Match Replay & Highlights',
    subtitle: 'Sky Sports+ • UK HD',
  },
  'sky-sports-action': {
    now: 'Sky Sports Action / NFL: Live NFL & International Sport Studio',
    next: 'Sky Sports Action: NFL RedZone & Gridiron Highlights',
    subtitle: 'NFL & Action Sports • UK HD',
  },
  'sky-sports-f1': {
    now: 'Sky Sports F1: Formula 1 Paddock Live & Ted’s Notebook',
    next: 'Sky Sports F1: Grand Prix Classics & Technical Analysis',
    subtitle: 'Formula 1 Motorsport • UK HD',
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
  'sky-sports-mix': {
    now: 'Sky Sports Mix: Live Multi-Sport Showcase',
    next: 'Sky Sports Mix: Featured European & World Sport',
    subtitle: 'Multi-Sport • Live Showcase',
  },
  'sky-sports-news': {
    now: 'Sky Sports News Live: Breaking Football News & Transfer Centre',
    next: 'Soccer Special & Matchday Scoreboard Live',
    subtitle: '24/7 Sports News • UK HD',
  },
  'sky-sports-racing': {
    now: 'Live Thoroughbred Racing & Paddock Analysis',
    next: 'Sky Sports Racing: International Track Coverage',
    subtitle: 'Horse Racing • Live Paddock & Track',
  },
  'tnt-sports-1': {
    now: 'TNT Sports 1: Premier League & UEFA Champions League Studio',
    next: 'TNT Sports 1: European Football Highlights & Review',
    subtitle: 'Premier League & UEFA • UK HD',
  },
  'tnt-sports-2': {
    now: 'TNT Sports 2: Serie A, UEFA Europa League & Premiership Rugby',
    next: 'TNT Sports 2: European Matchday Highlights',
    subtitle: 'Serie A & European Sport • UK HD',
  },
  'tnt-sports-3': {
    now: 'TNT Sports 3: European Football, NBA & Combat Sports Studio',
    next: 'TNT Sports 3: Matchday Classics & Highlights',
    subtitle: 'Multi-Sport & Football • UK HD',
  },
  'tnt-sports-4': {
    now: 'TNT Sports 4: International Sport, MotoGP & Football Highlights',
    next: 'TNT Sports 4: Extended Matchday Review',
    subtitle: 'Multi-Sport • UK HD',
  },
  'supersport-premier-league': {
    now: 'SuperSport Premier League: Matchday Live Studio & EPL Classics',
    next: 'Premier League Review & Goal Rush Highlights',
    subtitle: '24/7 Premier League • SuperSport HD',
  },
  'supersport-grandstand': {
    now: 'SuperSport Grandstand: Headline Live Sport & Matchday Studio',
    next: 'SuperSport Grandstand: World Sport Highlights',
    subtitle: 'Flagship Multi-Sport • SuperSport HD',
  },
  'supersport-football': {
    now: 'SuperSport Football: Serie A, UEFA & International Football Studio',
    next: 'SuperSport Football: European Goals & Highlights',
    subtitle: 'European Football • SuperSport HD',
  },
  'supersport-laliga': {
    now: 'SuperSport LaLiga: Spanish LaLiga Matchday Studio & Classics',
    next: 'SuperSport LaLiga: LaLiga Zap & Goals Review',
    subtitle: '24/7 Spanish LaLiga • SuperSport HD',
  },
  'supersport-variety-1': {
    now: 'SuperSport Variety 1: European Football & International Sport',
    next: 'SuperSport Variety 1: Matchday Highlights & Magazine',
    subtitle: 'Multi-Sport & Football • SuperSport HD',
  },
  'premier-sports-1': {
    now: 'Premier Sports 1 UK: LaLiga TV, Scottish Cup & URC Live Studio',
    next: 'Premier Sports 1 UK: Spanish LaLiga Highlights & Classics',
    subtitle: 'LaLiga & UK Cup Football • HD',
  },
  'premier-sports-2': {
    now: 'Premier Sports 2 UK: European Football, Copa del Rey & URC',
    next: 'Premier Sports 2 UK: Matchday Review & Highlights',
    subtitle: 'European Football & Rugby • HD',
  },

  // US Sports Networks
  'usa-network-hd': {
    now: 'USA Network Sports: Premier League Mornings & Matchday Live',
    next: 'USA Network: Goal Zone & Premier League Encore',
    subtitle: 'Premier League US • 1080p HD',
  },
  'fox-sports-1': {
    now: 'FS1 Live: First Things First, The Herd & Speak',
    next: 'FS1 Matchday Studio & US Sports Highlights',
    subtitle: 'Fox Sports 1 • US HD',
  },
  'fox-sports-2': {
    now: 'FS2 Live: International Soccer, Liga MX & Motorsports Showcase',
    next: 'FS2: Matchday Replay & Extended Highlights',
    subtitle: 'Fox Sports 2 • US HD',
  },
  'fox-sports-news': {
    now: 'Fox Sports News: 24/7 Scores, Highlights & Breaking Sports News',
    next: 'Fox Sports News: Daily Sports Roundup',
    subtitle: '24/7 Sports News • HD',
  },
  'espn-hd': {
    now: 'ESPN Live: SportsCenter, First Take & NBA/NFL Countdown',
    next: 'ESPN: PTI, Around the Horn & Primetime Sports',
    subtitle: 'ESPN Flagship • US HD',
  },
  'espn-2-hd': {
    now: 'ESPN2 Live: Get Up, NFL Live & ESPN FC Studio',
    next: 'ESPN2: SportsCenter Special & Live Coverage',
    subtitle: 'ESPN2 • US HD',
  },
  'espnu-hd': {
    now: 'ESPNU: College Football, NCAA Basketball & Campus GameDay',
    next: 'ESPNU: NCAA Classics & Conference Showcase',
    subtitle: 'NCAA College Sports • US HD',
  },
  'espn-deportes-es': {
    now: 'ESPN Deportes: Jorge Ramos y su Banda, Fútbol Picante & SportsCenter',
    next: 'ESPN Deportes: Ahora o Nunca & LaLiga / Champions en Español',
    subtitle: 'Deportes en Español • ESPN HD',
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
  'nba-tv': {
    now: 'NBA TV: NBA Gametime Live, Hardwood Classics & The Starters',
    next: 'NBA Action, Shaqtin’ A Fool & Inside the Association',
    subtitle: '24/7 NBA Basketball • HD',
  },
  'nfl-network': {
    now: 'NFL Network: Good Morning Football & NFL Total Access',
    next: 'NFL GameDay Live & Inside the NFL',
    subtitle: '24/7 NFL Football • HD',
  },
  'nfl-redzone': {
    now: 'NFL RedZone: Every Touchdown from Every Game & Sunday Highlights',
    next: 'NFL RedZone: Extended Sunday Touchdown Whiparound',
    subtitle: 'NFL RedZone Whiparound • HD',
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

  // European & International Sports (France, Spain, Italy, Global)
  'eurosport-1': {
    now: 'Eurosport 1 HD: Grand Slam Tennis, Cycling & Winter Sports Live',
    next: 'Eurosport 1 HD: Snooker Masters & Olympic Magazine',
    subtitle: 'Pan-European Sports • 1080p HD',
  },
  'eurosport-2': {
    now: 'Eurosport 2 HD: World Tour Cycling, Motorsports & Extreme Sports',
    next: 'Eurosport 2 HD: Watts Zap & International Highlights',
    subtitle: 'Pan-European Sports • 1080p HD',
  },
  'canal-plus-foot-fr': {
    now: 'Canal+ Foot : Canal Football Club, Premier League & Champions League',
    next: 'Canal+ Foot : Soir d’Europe & Grands Résumés',
    subtitle: 'Premier League & UEFA • France HD',
  },
  'rmc-sport-1-fr': {
    now: 'RMC Sport 1 : L’After Foot, Champions League & UFC Fight Night',
    next: 'RMC Sport 1 : Super Moscato Show & Grands Combats',
    subtitle: 'Football Européen & UFC • France HD',
  },
  'lequipe-fr': {
    now: 'L’Équipe du Soir & L’Équipe de Greg : Débats & Direct Sport',
    next: 'La Chaîne L’Équipe : Grands Reportages & Événements Live',
    subtitle: '24/7 Sport & Débats • France HD',
  },
  'fifa-plus-fr': {
    now: 'FIFA+ France : Classiques de la Coupe du Monde & Documentaires',
    next: 'FIFA+ France : Archives Officielles & Matchs de Légende',
    subtitle: 'FIFA+ Officiel • Français HD',
  },
  'fifa-plus-en': {
    now: 'FIFA+ Global: World Cup Classics, Originals & Live Matches',
    next: 'FIFA+ Global: Icons of Football & Official Tournament Archive',
    subtitle: 'FIFA+ Official • English HD',
  },
  'movistar-laliga-es': {
    now: 'Movistar LaLiga TV: La Casa del Fútbol & Previa de la Jornada',
    next: 'Movistar LaLiga TV: Goles y Resumen de LaLiga EA Sports',
    subtitle: 'LaLiga EA Sports • España HD',
  },
  'movistar-plus-es': {
    now: 'Movistar Plus+: El Día Después, Noche de Fútbol & El Partidazo',
    next: 'Movistar Plus+: Informe Plus+ & Deporte en Directo',
    subtitle: 'El Partidazo M+ • España HD',
  },
  'laliga-hypermotion-es': {
    now: 'LaLiga TV Hypermotion: Directo Segunda División & Resumen',
    next: 'LaLiga TV Hypermotion: Goles de la Jornada Hypermotion',
    subtitle: 'LaLiga Hypermotion • España HD',
  },
  'movistar-liga-de-campeones-es': {
    now: 'M+ Liga de Campeones: Noche de Champions & Europa League',
    next: 'M+ Liga de Campeones: Resumen y Goles UEFA',
    subtitle: 'UEFA Champions League • España HD',
  },
  'movistar-vamos-es': {
    now: 'Vamos por M+: Noticias #Vamos, El Tercer Tiempo & Directo',
    next: 'Vamos por M+: Universo Valdano & Grandes Eventos',
    subtitle: 'Deportes #Vamos • España HD',
  },
  'movistar-deportes-es': {
    now: 'Movistar Deportes: Liga Endesa ACB, NBA, Euroliga & ATP Tenis',
    next: 'Movistar Deportes: Generación NBA & Polideportivo M+',
    subtitle: 'Baloncesto & Tenis • España HD',
  },
  'dazn-laliga-es': {
    now: 'DAZN LaLiga: El Post de DAZN, Dorsal Doce & LaLiga EA Sports',
    next: 'DAZN LaLiga: Previa y Resumen de la Jornada en Directo',
    subtitle: 'DAZN LaLiga • España HD',
  },
  'dazn-f1-es': {
    now: 'DAZN F1 España: Box, Box, Previa GP & Mundial FIA Fórmula 1',
    next: 'DAZN F1 España: Código F1 & Carreras Históricas',
    subtitle: 'Fórmula 1 Mundial • España HD',
  },
  'real-madrid-tv': {
    now: 'Real Madrid TV: La Tertulia, RMTV Noticias & Partidos Históricos',
    next: 'Real Madrid TV: Previa Oficial & Ciudad Real Madrid en Directo',
    subtitle: 'Canal Oficial Real Madrid • HD',
  },
  'dazn-ligue1-fr': {
    now: 'DAZN Ligue 1 McDonald’s : Mag Ligue 1, Multiplex & Grands Matchs',
    next: 'DAZN Ligue 1 : Tous les Buts & Résumés de la Journée',
    subtitle: 'Ligue 1 McDonald’s • France HD',
  },
  'dazn-1-it': {
    now: 'Zona DAZN / DAZN 1 Italia: Serie A Enilive & Sunday Night Square',
    next: 'DAZN 1 Italia: Open VAR, Highlights & Tutti i Gol Serie A',
    subtitle: 'Serie A Enilive • Italia HD',
  },
  'dazn-2-it': {
    now: 'DAZN 2 Italia: Serie A Enilive, LaLiga & Calcio Internazionale',
    next: 'DAZN 2 Italia: Highlights & Approfondimenti Serie A',
    subtitle: 'Serie A Enilive • Italia HD',
  },
  'sky-sport-calcio-it': {
    now: 'Sky Sport Calcio: Sky Calcio Club, Serie A Enilive & Gol Collection',
    next: 'Sky Sport Calcio: L’Originale & Studio Pre/Post Partita',
    subtitle: 'Serie A Calcio • Italia HD',
  },
  'sky-sport-uno-it': {
    now: 'Sky Sport Uno: Champions LeagueShow, Serie A & Grandi Eventi',
    next: 'Sky Sport Uno: EuroShow & Highlights Internazionali',
    subtitle: 'Flagship Sport • Italia HD',
  },
  'sky-sport-arena-it': {
    now: 'Sky Sport Arena: Calcio Internazionale, Tennis ATP & Rugby',
    next: 'Sky Sport Arena: Bundesliga, Ligue 1 & Grandi Sfide',
    subtitle: 'Arena Multisport • Italia HD',
  },
  'sky-sport-max-it': {
    now: 'Sky Sport Max: Diretta Gol Europa, Premier League & Bundesliga',
    next: 'Sky Sport Max: Magazine & Sintesi Calcio Europeo',
    subtitle: 'Calcio Europeo & Sport • Italia HD',
  },
  'sky-sport-252-it': {
    now: 'Sky Sport 252: Canale Matchday Serie A & Diretta Champions',
    next: 'Sky Sport 252: Replay Integrale & Gol Collection',
    subtitle: 'Matchday Calcio • Italia HD',
  },
  'sky-sport-24-it': {
    now: 'Sky Sport 24 Live: Edizione Continua, Calciomercato & Ultim’ora',
    next: 'Sky Sport 24: Campo Aperto & Collegamenti dagli Stadi',
    subtitle: '24/7 All-News Sport • Italia HD',
  },
  'dazn-combat': {
    now: 'DAZN Combat: Championship Boxing, Matchroom & PFL MMA Spotlight',
    next: 'DAZN Combat: Ringside Classics & Fight Night Weigh-In',
    subtitle: 'Boxing & MMA • 24/7 Combat HD',
  },
  'red-bull-tv': {
    now: 'Red Bull Motorsports, Rally & Drift Championship',
    next: 'Red Bull Rampage & Extreme Action Showcase',
    subtitle: 'Motorsports & Adventure • 24/7 HD',
  },

  // Dedicated Saudi Entertainment Channels
  'saudi-sbc-ar': {
    now: 'البرامج الترفيهية والمسلسلات السعودية الحصرية والفعاليات الكبرى - قناة SBC السعودية',
    next: 'سهرة SBC العائلية وأقوى العروض السعودية - SBC Saudi HD',
    subtitle: 'Saudi Entertainment & Events • SBC HD',
  },
  'saudi-big-time-ar': {
    now: 'تغطية فعاليات وحفلات ونزالات موسم الرياض المباشرة - Big Time+ HD',
    next: 'عروض موسم الرياض العالمية والترفيهية - Riyadh Season HD',
    subtitle: 'Riyadh Season Live • موسم الرياض HD',
  },

  // Algeria TV & Algerian Sports Channels
  'algeria-tv1-entv': {
    now: 'البث المباشر للبرنامج الوطني والأخبار والرياضة - التلفزيون الجزائري TV1 ENTV',
    next: 'نشرة الأخبار الرئيسية الساعة الثامنة والبرامج الوطنية - الوطنية الأولى الجزائرية',
    subtitle: 'Programme National ENTV • الجزائرية الأولى',
  },
  'algeria-tv2-canal': {
    now: 'Canal Algérie TV2 : Journal Télévisé, Débats, Culture & Sport Algérien',
    next: 'Canal Algérie : Bonjour d’Algérie & Magazines Francophones',
    subtitle: 'Canal Algérie TV2 • كنال ألجيري HD',
  },
  'algeria-tv3-news': {
    now: 'النشرة الإخبارية المتواصلة والحوارات السياسية والاقتصادية - الجزائرية الثالثة A3',
    next: 'تغطية خاصة لأهم الأحداث الوطنية والمغاربية والدولية - TV3 Algérie HD',
    subtitle: 'Algérie A3 News • الجزائرية الثالثة',
  },
  'algeria-tv4-tamazight': {
    now: 'البرامج الثقافية والفنية والإخبارية الأمازيغية - القناة الأمازيغية الرابعة TV4',
    next: 'سهرات التراث الأمازيغي والوثائقيات الوطنية - Tamazight TV4 Algérie',
    subtitle: 'Tamazight TV4 • الأمازيغية الجزائرية',
  },
  'algeria-tv5-coran': {
    now: 'تلاوات قرآنية خاشعة والبرامج الدينية والمرجعية الوطنية - قناة القرآن الكريم TV5',
    next: 'دروس التفسير والحديث والسيرة النبوية العطرة - Coran TV5 Algérie HD',
    subtitle: 'Coran TV5 Algérie • قناة القرآن الكريم',
  },
  'algeria-tv6-youth': {
    now: 'تغطية البطولة الوطنية المحترفة (Ligue 1 Mobilis) وبرامج الشباب - الجزائرية السادسة TV6',
    next: 'الأستوديو الرياضي وبرامج الترفيه والشباب - TV6 Algérie الشبابية',
    subtitle: 'Algérie Youth & Sport • الجزائرية السادسة',
  },
  'algeria-tv7-elmaarifa': {
    now: 'البرامج التعليمية والجامعية والوثائقيات العلمية - قناة المعرفة الجزائرية TV7',
    next: 'محاضرات ودروس تعليمية وبرامج ثقافية - El Maarifa TV7 Algérie HD',
    subtitle: 'El Maarifa TV7 • قناة المعرفة الجزائرية',
  },
  'algeria-tv8-edhakira': {
    now: 'أفلام ووثائقيات الثورة التحريرية المجيدة وتاريخ الجزائر - قناة الذاكرة TV8',
    next: 'شهادات تاريخية وأرشيف الحركة الوطنية الجزائرية - Edhakira TV8 Algérie HD',
    subtitle: 'Edhakira TV8 • قناة الذاكرة الوطنية',
  },
  'algeria-el-heddaf-tv': {
    now: 'برنامج بالمكشوف وتغطية الرابطة المحترفة الأولى والمنتخب الجزائري - الهداف TV',
    next: 'أخبار الخضر والمحترفين الجزائريين في أوروبا - El Heddaf TV Sport HD',
    subtitle: 'El Heddaf Sport • قناة الهداف الرياضية',
  },
  'algeria-al24-news': {
    now: 'التغطية الإخبارية الدولية والمغاربية المباشرة على مدار الساعة - قناة الجزائر الدولية AL24',
    next: 'ملفات الساعة والتحليلات السياسية والاقتصادية - AL24 News Algérie HD',
    subtitle: '24/7 International News • الجزائر الدولية',
  },
  'algeria-echorouk-tv': {
    now: 'البرامج الاجتماعية والترفيهية والمسلسلات الجزائرية الحصرية - قناة الشروق العامة HD',
    next: 'سهرة الشروق العائلية وأقوى الإنتاجات الدرامية الجزائرية - Echorouk TV HD',
    subtitle: 'Echorouk TV • قناة الشروق الجزائرية',
  },
  'algeria-echorouk-news': {
    now: 'الحصاد الإخباري الجزائري والمغاربي ومتابعة الأحداث لحظة بلحظة - الشروق نيوز HD',
    next: 'برامج النقاش السياسي والاقتصادي والرياضي - Echorouk News Algérie HD',
    subtitle: 'Echorouk News • الشروق نيوز الإخبارية',
  },
  'algeria-ennahar-tv': {
    now: 'الأخبار المحلية العاجلة والبرامج الاجتماعية والرياضية - قناة النهار الجزائرية HD',
    next: 'برنامج صريح جدا والحصاد الإخباري المسائي - Ennahar TV Algérie HD',
    subtitle: 'Ennahar TV • قناة النهار الجزائرية',
  },
  'algeria-el-bilad-tv': {
    now: 'الأخبار الوطنية والبرامج الحوارية والرياضية الجزائرية - قناة البلاد HD',
    next: 'استوديو البلاد للرياضة والملفات الوطنية - El Bilad TV Algérie HD',
    subtitle: 'El Bilad TV • قناة البلاد الجزائرية',
  },
  'algeria-samira-tv': {
    now: 'أشهى الوصفات الجزائرية والمغاربية وفنون الطبخ والحلويات - قناة سميرة TV HD',
    next: 'برامج الأسرة والطبخ التقليدي والعصري مع أشهر الشيفات - Samira TV Algérie',
    subtitle: 'Cooking & Family • قناة سميرة الجزائرية',
  },
  'algeria-elwatania-tv': {
    now: 'البرامج العامة والثقافية والأخبار الوطنية والترفيهية - قناة الوطنية الجزائرية HD',
    next: 'سهرة الوطنية والمسلسلات والبرامج الحوارية - Elwatania TV Algérie HD',
    subtitle: 'Elwatania TV • قناة الوطنية الجزائرية',
  },
  'algeria-amou-yazid-tv': {
    now: 'برامج وأناشيد عمو يزيد التعليمية والترفيهية للأطفال والأسرة - Amou Yazid TV HD',
    next: 'رسوم متحركة ومسابقات الأطفال مع عمو يزيد - قناة عمو يزيد الجزائرية',
    subtitle: 'Kids & Family • قناة عمو يزيد الجزائرية',
  },

  // France TV & Canal+ Channels
  'canal-plus-fr': {
    now: 'Canal+ France : Canal Football Club, Grands Matchs UEFA, Top 14 & Cinéma Box-Office',
    next: 'Canal+ France : Soir d’Europe, Créations Originales & Grand Cinéma HD',
    subtitle: 'Flagship Sport & Cinéma • Canal+ France HD',
  },
  'canal-plus-sport-fr': {
    now: 'Canal+ Sport France : Premier League, UEFA Champions League, Top 14 & Late Sport Club',
    next: 'Canal+ Sport France : Canal Rugby Club & Grands Directs Sportifs',
    subtitle: 'Premier League, UEFA & Top 14 • France HD',
  },
  'canal-plus-sport-360-fr': {
    now: 'Canal+ Sport 360 : MotoGP, Ligue 1, WRC Rallye, Boxe & Infosport+ Direct',
    next: 'Canal+ Sport 360 : Grands Prix MotoGP & Soirée Multisports',
    subtitle: 'Multisports & MotoGP • Canal+ 360 HD',
  },
  'canal-plus-f1-fr': {
    now: 'Canal+ Formula 1 : En Direct des Stands, Grand Prix FIA F1 & La Grille',
    next: 'Canal+ Formula 1 : Formula One Debrief & Grands Prix de Légende',
    subtitle: '24/7 FIA Formula 1 • Canal+ F1 France HD',
  },
  'canal-plus-motogp-fr': {
    now: 'Canal+ MotoGP : Championnat du Monde MotoGP, Sprint & Paddock Live',
    next: 'Canal+ MotoGP : Debrief Moto & Grands Prix Historiques',
    subtitle: '24/7 MotoGP World Championship • France HD',
  },
  'canal-plus-afrique-1': {
    now: 'Canal+ Sport 1 Afrique : Premier League, Ligue 1, CAF Champions League & Talents d’Afrique',
    next: 'Canal+ Sport 1 Afrique : Jour de Foot & Grandes Affiches Européennes',
    subtitle: 'Football Africain & Européen • Canal+ Afrique HD',
  },
  'canal-plus-afrique-2': {
    now: 'Canal+ Sport 2 Afrique : UEFA Champions League, LaLiga, Serie A & Soir d’Europe',
    next: 'Canal+ Sport 2 Afrique : Résumés & Grands Matchs Européens',
    subtitle: 'UEFA, LaLiga & Serie A • Canal+ Afrique HD',
  },
  'canal-plus-extra-1': {
    now: 'Canal+ Extra 1 : UEFA Champions League Direct & Multiplex Européen 1',
    next: 'Canal+ Extra 1 : Soir de Ligue des Champions & Grands Résumés',
    subtitle: 'UEFA Champions League • Canal+ Extra 1 HD',
  },
  'canal-plus-extra-2': {
    now: 'Canal+ Extra 2 : UEFA Champions League Direct & Multiplex Européen 2',
    next: 'Canal+ Extra 2 : Matchs Intégraux & Temps Forts UEFA',
    subtitle: 'UEFA Champions League • Canal+ Extra 2 HD',
  },
  'canal-plus-sport-1-eu': {
    now: 'Canal+ Sport 1 Europe : Premier League, LaLiga EA Sports & ATP Tour Tennis',
    next: 'Canal+ Sport 1 Europe : Matchday Studio & European Football Highlights',
    subtitle: 'Premier League & LaLiga • Canal+ Sport 1 HD',
  },
  'canal-plus-sport-2-eu': {
    now: 'Canal+ Sport 2 Europe : Football Européen, NBA Basketball & Grands Événements',
    next: 'Canal+ Sport 2 Europe : Soirée Sport & Résumés de la Journée',
    subtitle: 'European Football & NBA • Canal+ Sport 2 HD',
  },
  'canal-plus-premium-hd': {
    now: 'Canal+ Premium & Box-Office : Cinéma Exclusif, Séries Originales & Grands Matchs',
    next: 'Canal+ Premium : Superproductions & Soirée Cinéma / Sport HD',
    subtitle: 'Cinéma, Séries & Sport • Canal+ Premium HD',
  },
  'rmc-sport-2-fr': {
    now: 'RMC Sport 2 France : Football Européen, Basketball, MMA & Grandes Compétitions',
    next: 'RMC Sport 2 France : Direct Sport & Soirée Combat / Football',
    subtitle: 'Football, Basket & Combat • France HD',
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
  const isMovieOrEnt =
    channelId.includes('movie') ||
    channelId.includes('cinema') ||
    channelId.includes('aflam') ||
    channelId.includes('hbo') ||
    channelId.includes('showtime') ||
    channelId.includes('starz-hd') ||
    channelId.includes('mbc') ||
    channelId.includes('rotana');

  return {
    id: `studio-${channelId}-${slot}`,
    channelId,
    title: isMovieOrEnt
      ? isAr
        ? slot === 'now'
          ? `العرض الحصري المباشر - ${cleanName}`
          : `سهرة السينما والمسلسلات - ${cleanName}`
        : slot === 'now'
          ? `${cleanName}: Feature Presentation`
          : `${cleanName}: Prime Time Showcase`
      : isAr
        ? slot === 'now'
          ? `الأستوديو التحليلي المباشر - ${cleanName}`
          : `البث المباشر والبرامج الرياضية - ${cleanName}`
        : slot === 'now'
          ? `${cleanName} Live Studio & Analysis`
          : `${cleanName} Featured Sports & Highlights`,
    subtitle: `${cleanName} • 24/7 Broadcast`,
    category: meta?.category || (isMovieOrEnt ? 'Entertainment' : 'Sports Studio'),
    league: cleanName,
    type: 'studio',
    status: slot === 'now' ? 'LIVE' : 'UPCOMING',
    isLive: slot === 'now',
    startTime: hourStart,
    endTime: hourEnd,
  };
}

// Verify whether an upstream EPG entry is a genuine non-match studio/entertainment/XMLTV program (rejects unverified match overlays and synthetic 2-hour filler templates)
function isCleanUpstreamStudioProgram(prog: any, channelId = ''): boolean {
  if (!prog || typeof prog !== 'object') return false;
  if (prog.eventId || prog.matchInfo || prog.type === 'live_match' || prog.type === 'upcoming_match') return false;
  const t = String(prog.title || '').toLowerCase().trim();
  if (!t || t.includes('home vs away') || t.startsWith('live:') || t.startsWith('مباشر:')) return false;
  if (
    t.includes('مباراة القمة الأوروبية') ||
    t.includes('مجلة دوري أبطال أوروبا') ||
    t.includes('برنامج هذا المساء الرياضي') ||
    t.includes('الأستوديو التحليلي المباشر -') ||
    t.includes('prime time live broadcast') ||
    t.includes('featured event & studio special') ||
    t.includes('live matchday studio & tactical analysis') ||
    t.includes('premier league & european classics') ||
    t.includes('the herd & prime time') ||
    t.includes('live studio & game day') ||
    t.includes('main event spotlight & championship fights') ||
    t.includes('embedded & weigh-in special') ||
    t.includes('المسلسل الدرامي الحصري') ||
    t.includes('البرنامج الترفيهي المسائي') ||
    t.includes('فيلم السهرة المختار -') ||
    t.includes('سهرة السينما الحصرية -') ||
    t.includes('سهرة العائلة الجزائرية والمجلة الرياضية') ||
    t.includes('البث المباشر للتلفزيون الجزائري -') ||
    t.includes('نشرة الأخبار الجزائرية والمغاربية والدولية') ||
    t.includes('حوار الساعة والملف السياسي والاقتصادي') ||
    (channelId.includes('bein') && t.includes('ht spor'))
  ) {
    return false;
  }
  // Also reject synthetic 2-hour modulo placeholder IDs when the channel has a curated studio fallback
  const idStr = String(prog.id || '');
  const tailNum = Number(idStr.split('-').pop());
  if (
    channelId &&
    CHANNEL_CURATED_STUDIO_PROGRAMS[channelId] &&
    !Number.isNaN(tailNum) &&
    tailNum > 1700000000000 &&
    tailNum % 7200000 === 0 &&
    Number(prog.durationMinutes) === 120
  ) {
    return false;
  }
  return true;
}

// =================================================================================================
// REAL-TIME OFFICIAL BROADCASTER EPG HARVESTER (beIN Official, Sky UK, Sky IT, Movistar+, ElCinema, TVPassport, Programme-TV)
// Pulls minute-by-minute actual live TV schedules directly from official broadcaster APIs every 5 minutes
// =================================================================================================
function decodeHtmlEntitiesClean(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&apos;|&#039;|&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&#34;|&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim();
}

function getLocalClockMinutes(timeZone: string, date = new Date()): { dateIso: string; curMinutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const getPart = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  const dateIso = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
  const hour = Number(getPart('hour')) % 24;
  const minute = Number(getPart('minute'));
  return { dateIso, curMinutes: hour * 60 + minute };
}

function localMinutesToUtcIso(nowMs: number, curLocalMinutes: number, targetLocalMinutes: number): string {
  const deltaMin = targetLocalMinutes - curLocalMinutes;
  return new Date(nowMs + deltaMin * 60000).toISOString();
}

async function fetchTextFast(url: string, timeoutMs = 4500, headers: Record<string, string> = {}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8,fr;q=0.7,es;q=0.6',
        ...headers,
      },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshOfficialBroadcasterEpg(): Promise<void> {
  const nowMs = Date.now();
  const nextMap = new Map<string, OfficialChannelEpgData>();

  const setOfficialChannel = (
    channelId: string,
    nowTitle: string,
    nowSubtitle: string,
    startTimeIso: string,
    endTimeIso: string,
    nextTitle: string,
    nextSubtitle: string,
    nextStartIso: string,
    nextEndIso: string,
    source: string,
    schedule: OfficialProgramSlot[] = []
  ) => {
    const cleanNow = decodeHtmlEntitiesClean(nowTitle);
    if (!cleanNow) return;
    const cleanNext = decodeHtmlEntitiesClean(nextTitle) || getFallbackStudioProgram(channelId, 'next').title;
    const nowProg = {
      id: `official-now-${channelId}`,
      channelId,
      type: 'live_broadcast',
      title: cleanNow,
      subtitle: decodeHtmlEntitiesClean(nowSubtitle) || 'Live Official Broadcast',
      startTime: startTimeIso,
      endTime: endTimeIso,
      isLive: true,
      status: 'LIVE',
      source,
    };
    const nextProg = {
      id: `official-next-${channelId}`,
      channelId,
      type: 'upcoming_program',
      title: cleanNext,
      subtitle: decodeHtmlEntitiesClean(nextSubtitle) || 'Next Official Broadcast',
      startTime: nextStartIso,
      endTime: nextEndIso,
      isLive: false,
      status: 'UPCOMING',
      source,
    };
    const futureSlots = schedule
      .filter((s) => s.startMs > nowMs)
      .slice(0, 5)
      .map((s, idx) => ({
        id: `official-up-${channelId}-${idx}`,
        channelId,
        type: 'upcoming_program',
        title: s.title,
        subtitle: s.subtitle || 'Upcoming Official Broadcast',
        startTime: s.startTime,
        endTime: s.endTime,
        isLive: false,
        status: 'UPCOMING',
        source,
      }));
    nextMap.set(channelId, {
      nowPlaying: nowProg,
      nextUp: nextProg,
      upcoming: futureSlots.length > 0 ? futureSlots : [nextProg],
      schedule,
      source,
      updatedAt: nowMs,
    });
  };

  // 1. Official beIN MENA EPG (bein.com Sports + Entertainment in Mecca time UTC+3, Yesterday late-night + Today + Tomorrow)
  const fetchBeinOfficial = async () => {
    const { dateIso: meccaDate, curMinutes } = getLocalClockMinutes('Asia/Riyadh', new Date(nowMs));
    const { dateIso: yesterdayMeccaDate } = getLocalClockMinutes('Asia/Riyadh', new Date(nowMs - 86400000));
    const { dateIso: tomorrowMeccaDate } = getLocalClockMinutes('Asia/Riyadh', new Date(nowMs + 86400000));
    const [sportsYesterdayHtml, sportsTodayHtml, sportsTomorrowHtml, entHtml] = await Promise.all([
      curMinutes < 240
        ? fetchTextFast(
            `https://www.bein.com/ar/epg-ajax-template/?action=epg_fetch&offset=0&category=sports&service=MENA&date=${yesterdayMeccaDate}&mins=00&cdate=${yesterdayMeccaDate}&language=AR&postid=25344&loadindex=0`,
            4800
          )
        : Promise.resolve(null),
      fetchTextFast(
        `https://www.bein.com/ar/epg-ajax-template/?action=epg_fetch&offset=0&category=sports&service=MENA&date=${meccaDate}&mins=00&cdate=${meccaDate}&language=AR&postid=25344&loadindex=0`,
        4800
      ),
      fetchTextFast(
        `https://www.bein.com/ar/epg-ajax-template/?action=epg_fetch&offset=0&category=sports&service=MENA&date=${tomorrowMeccaDate}&mins=00&cdate=${tomorrowMeccaDate}&language=AR&postid=25344&loadindex=0`,
        4800
      ),
      fetchTextFast(
        `https://www.bein.com/ar/epg-ajax-template/?action=epg_fetch&offset=0&category=entertainment&service=MENA&date=${meccaDate}&mins=00&cdate=${meccaDate}&language=AR&postid=25344&loadindex=0`,
        4800
      ),
    ]);

    const extractBeinSlotsByLogo = (html: string | null, logoToChannelIds: Array<[string, string[]]>, dayOffsetMin = 0) => {
      const byChannel = new Map<string, OfficialProgramSlot[]>();
      if (!html) return byChannel;
      const blocks = html.split('id=channels_').slice(1);
      for (const blk of blocks) {
        const logoMatch = blk.match(/data-img-src=['"]?([^\s'">]+)|src=['"]?([^\s'">]+)/i);
        const logoUrl = logoMatch ? logoMatch[1] || logoMatch[2] || '' : '';
        if (!logoUrl) continue;

        const matchedIds: string[] = [];
        for (const [pattern, chIds] of logoToChannelIds) {
          if (logoUrl.includes(pattern)) {
            matchedIds.push(...chIds);
          }
        }
        if (matchedIds.length === 0) continue;

        const lis = blk.split('<li ').slice(1);
        const slots: OfficialProgramSlot[] = [];

        lis.forEach((li, idx) => {
          const title = decodeHtmlEntitiesClean(li.match(/<p\s+class=title>([^<]+)<\/p>/i)?.[1] || '');
          const format = decodeHtmlEntitiesClean(li.match(/<p\s+class=format>([^<]+)<\/p>/i)?.[1] || '');
          if (!title) return;

          const isLiveBroadcast = /live=['"]?1['"]?/i.test(li);
          const progDivMatch = li.match(
            /class=['"]?progress['"]?\s+data-start=['"](\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})['"]\s+data-end=['"](\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})['"]/i
          );
          const dStart = progDivMatch?.[1];
          const dEnd = progDivMatch?.[2];

          let startMs = NaN;
          let endMs = NaN;
          if (dStart && dEnd) {
            startMs = Date.parse(dStart.replace(/\s+/, 'T') + '+03:00');
            endMs = Date.parse(dEnd.replace(/\s+/, 'T') + '+03:00');
            // When a live='1' match starts late at night (22:00-23:59 Mecca time) and bein.com truncates data-end at 00:00:00,
            // extend the live broadcast window to full match length (130 mins) so it remains active through full-time
            if (
              isLiveBroadcast &&
              /\s+vs\.?\s+/i.test(title) &&
              dEnd.endsWith('00:00:00') &&
              endMs - startMs < 110 * 60 * 1000
            ) {
              endMs = startMs + 130 * 60 * 1000;
            }
          } else {
            const tm = li.match(/<p\s+class=time>(\d{2}):(\d{2})(?:\s|&nbsp;)*-(?:\s|&nbsp;)*(\d{2}):(\d{2})<\/p>/i);
            if (tm) {
              const sh = Number(tm[1]);
              const sm = Number(tm[2]);
              const eh = Number(tm[3]);
              const em = Number(tm[4]);
              let sMin = sh * 60 + sm + dayOffsetMin;
              let eMin = eh * 60 + em + dayOffsetMin;
              if (idx === 0 && sh >= 20) sMin -= 1440;
              if (eMin <= sMin) eMin += 1440;
              startMs = Date.parse(localMinutesToUtcIso(nowMs, curMinutes, sMin));
              endMs = Date.parse(localMinutesToUtcIso(nowMs, curMinutes, eMin));
            }
          }

          if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return;
          slots.push({
            title,
            subtitle: format || 'beIN Sports Official Broadcast',
            startTime: new Date(startMs).toISOString(),
            endTime: new Date(endMs).toISOString(),
            startMs,
            endMs,
            isLiveBroadcast,
          });
        });

        if (slots.length === 0) continue;
        for (const chId of matchedIds) {
          const prev = byChannel.get(chId) || [];
          byChannel.set(chId, [...prev, ...slots]);
        }
      }
      return byChannel;
    };

    const sportsLogoMap: Array<[string, string[]]> = [
      ['bein_SPORTS_FTA', ['bein-sports-open-ar']],
      ['beIN_SPORTS1_DIGITAL', ['bein-sports-1-ar', 'bein-sports-premium-1-ar']],
      ['beIN_SPORTS2_DIGITAL', ['bein-sports-2-ar', 'bein-sports-premium-2-ar']],
      ['beIN_SPORTS3_DIGITAL', ['bein-sports-3-ar', 'bein-sports-premium-3-ar']],
      ['beIN_SPORTS4_DIGITAL', ['bein-sports-4-ar']],
      ['beIN_SPORTS5_DIGITAL', ['bein-sports-5-ar']],
      ['beIN_SPORTS6_DIGITAL', ['bein-sports-6-ar']],
      ['beIN_SPORTS7_DIGITAL', ['bein-sports-7-ar']],
      ['logos-_beINSPORTS8', ['bein-sports-8-ar']],
      ['logos-_beINSPORTS9', ['bein-sports-9-ar']],
      ['beIN_SPORTS1_ENGLISH', ['bein-sports-en-1']],
      ['beIN_SPORTS2_ENGLISH', ['bein-sports-en-2']],
      ['beIN_SPORTS3_ENGLISH', ['bein-sports-en-3']],
      ['beIN_SPORTS1_FRENCH', ['bein-sports-fr-1']],
      ['beIN_SPORTS2_FRENCH', ['bein-sports-fr-2']],
      ['beIN_SPORTS3_FRENCH', ['bein-sports-fr-3']],
      ['beIN_SPORTS_MAX4_DIGITAL', ['bein-sports-max-4-fr']],
      ['NEW_beIN-SPORTS-MAX-05', ['bein-sports-max-5-fr']],
      ['NEW_beIN-SPORTS-MAX-06', ['bein-sports-max-6-fr']],
      ['2023_Alkass_1', ['alkass-1-ar']],
      ['2023_Alkass_2', ['alkass-2-ar']],
      ['2023_Alkass_3', ['alkass-3-ar']],
    ];

    const entLogoMap: Array<[string, string[]]> = [
      ['MOVIES1_PREMIERE', ['bein-movies-premiere-en']],
      ['MOVIES2_ACTION', ['bein-movies-action-en', 'bein-movies-action-ar']],
      ['MOVIES3_DRAMA', ['bein-movies-drama-en']],
      ['Star_Movies', ['bein-movies-hits-en']],
      ['Star_Action', ['bein-movies-thriller-ar']],
      ['Drama_Stacked', ['bein-aflam-ar']],
    ];

    const yesterdaySportsMap = extractBeinSlotsByLogo(sportsYesterdayHtml, sportsLogoMap, -1440);
    const todaySportsMap = extractBeinSlotsByLogo(sportsTodayHtml, sportsLogoMap, 0);
    const tomorrowSportsMap = extractBeinSlotsByLogo(sportsTomorrowHtml, sportsLogoMap, 1440);
    const todayEntMap = extractBeinSlotsByLogo(entHtml, entLogoMap, 0);

    const allBeinChIds = new Set<string>([
      ...yesterdaySportsMap.keys(),
      ...todaySportsMap.keys(),
      ...tomorrowSportsMap.keys(),
      ...todayEntMap.keys(),
    ]);

    for (const chId of allBeinChIds) {
      const combined = [
        ...(yesterdaySportsMap.get(chId) || []),
        ...(todaySportsMap.get(chId) || []),
        ...(tomorrowSportsMap.get(chId) || []),
        ...(todayEntMap.get(chId) || []),
      ];
      // Deduplicate by startMs + title and sort chronologically
      const seen = new Set<string>();
      const deduped = combined
        .filter((s) => {
          const k = `${s.startMs}_${s.title}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((a, b) => a.startMs - b.startMs || (b.isLiveBroadcast ? 1 : 0) - (a.isLiveBroadcast ? 1 : 0));

      // Filter out live='0' midnight replay placeholders that overlap an active live='1' broadcast
      const liveBroadcastSlots = deduped.filter((s) => s.isLiveBroadcast === true);
      const progs = deduped.filter((s) => {
        if (s.isLiveBroadcast === true) return true;
        const shadowedByLive = liveBroadcastSlots.some(
          (liveS) => s.startMs >= liveS.startMs && s.startMs < liveS.endMs - 5 * 60 * 1000
        );
        return !shadowedByLive;
      });

      if (progs.length === 0) continue;

      // Prefer an active live='1' broadcast if one covers nowMs
      let curIdx = progs.findIndex((p) => p.isLiveBroadcast === true && nowMs >= p.startMs && nowMs < p.endMs);
      if (curIdx === -1) {
        curIdx = progs.findIndex((p) => nowMs >= p.startMs && nowMs < p.endMs);
      }
      if (curIdx === -1) {
        const nextFutureIdx = progs.findIndex((p) => p.startMs > nowMs);
        if (nextFutureIdx > 0) curIdx = nextFutureIdx - 1;
        else if (nextFutureIdx === 0) curIdx = 0;
        else curIdx = progs.length - 1;
      }

      const curP = progs[curIdx];
      const nextP = progs[curIdx + 1] || {
        title: getFallbackStudioProgram(chId, 'next').title,
        subtitle: curP.subtitle,
        startTime: curP.endTime,
        endTime: new Date(curP.endMs + 3600000).toISOString(),
        startMs: curP.endMs,
        endMs: curP.endMs + 3600000,
      };

      setOfficialChannel(
        chId,
        curP.title,
        curP.subtitle,
        curP.startTime,
        curP.endTime,
        nextP.title,
        nextP.subtitle,
        nextP.startTime,
        nextP.endTime,
        'bein.com',
        progs
      );
    }
  };

  // 2. Official Sky UK & TNT Sports JSON EPG API (awk.epgsky.com)
  const fetchSkyUkOfficial = async () => {
    const { dateIso } = getLocalClockMinutes('Europe/London');
    const skyDate = dateIso.replace(/-/g, '');
    const sids: Record<string, string> = {
      '4002': 'sky-sports-main-event',
      '4010': 'sky-sports-premier-league',
      '3939': 'sky-sports-football',
      '3940': 'sky-sports-plus',
      '4022': 'sky-sports-action',
      '3835': 'sky-sports-f1',
      '4081': 'sky-sports-cricket',
      '4026': 'sky-sports-golf',
      '1284': 'sky-sports-tennis',
      '4090': 'sky-sports-mix',
      '4049': 'sky-sports-news',
      '4032': 'sky-sports-racing',
      '3625': 'tnt-sports-1',
      '3627': 'tnt-sports-2',
      '3629': 'tnt-sports-3',
      '4040': 'tnt-sports-4',
      '1289': 'premier-sports-1',
      '1290': 'premier-sports-2',
    };
    const raw = await fetchTextFast(
      `https://awk.epgsky.com/hawk/linear/schedule/${skyDate}/${Object.keys(sids).join(',')}`,
      4500,
      { Accept: 'application/json' }
    );
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const nowSec = Math.floor(nowMs / 1000);
      for (const sch of data.schedule || []) {
        const chId = sids[String(sch.sid)];
        if (!chId || !Array.isArray(sch.events)) continue;
        const scheduleSlots: OfficialProgramSlot[] = sch.events
          .filter((e: any) => e && e.t && e.st && e.d)
          .map((e: any) => ({
            title: decodeHtmlEntitiesClean(e.t),
            subtitle: decodeHtmlEntitiesClean(e.sy || 'Live UK Sports Broadcast'),
            startTime: new Date(e.st * 1000).toISOString(),
            endTime: new Date((e.st + e.d) * 1000).toISOString(),
            startMs: e.st * 1000,
            endMs: (e.st + e.d) * 1000,
            isLiveBroadcast: /\blive\b/i.test(`${e.t} ${e.sy || ''}`),
          }));
        let curIdx = sch.events.findIndex((e: any) => nowSec >= e.st && nowSec < e.st + e.d);
        if (curIdx === -1) curIdx = 0;
        const cur = sch.events[curIdx];
        const nxt = sch.events[curIdx + 1] || cur;
        if (!cur) continue;
        setOfficialChannel(
          chId,
          cur.t,
          cur.sy || 'Live UK Sports Broadcast',
          new Date(cur.st * 1000).toISOString(),
          new Date((cur.st + cur.d) * 1000).toISOString(),
          nxt.t,
          nxt.sy || 'Upcoming UK Sports Broadcast',
          new Date(nxt.st * 1000).toISOString(),
          new Date((nxt.st + nxt.d) * 1000).toISOString(),
          'epgsky.com',
          scheduleSlots
        );
      }
    } catch {
      // ignore parse errors
    }
  };

  // 3. Official Sky Italia & DAZN IT JSON EPG API (apid.sky.it)
  const fetchSkyItOfficial = async () => {
    const itMap: Record<string, string> = {
      '9094': 'sky-sport-24-it',
      '9097': 'sky-sport-uno-it',
      '9113': 'sky-sport-calcio-it',
      '9093': 'sky-sport-arena-it',
      '9103': 'sky-sport-max-it',
      '11497': 'sky-sport-252-it',
      '11402': 'dazn-1-it',
      '11401': 'dazn-2-it',
    };
    const fromIso = new Date(nowMs - 2 * 3600 * 1000).toISOString().slice(0, 16) + 'Z';
    const toIso = new Date(nowMs + 14 * 3600 * 1000).toISOString().slice(0, 16) + 'Z';
    const raw = await fetchTextFast(
      `https://apid.sky.it/gtv/v1/events?channels=${Object.keys(itMap).join(',')}&from=${fromIso}&to=${toIso}&pageSize=250&pageNum=0&env=DTH`,
      4500,
      { Accept: 'application/json' }
    );
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const byCh: Record<string, any[]> = {};
      for (const ev of data.events || []) {
        const cid = String(ev.channel?.id || '');
        if (!byCh[cid]) byCh[cid] = [];
        byCh[cid].push(ev);
      }
      for (const [cid, chId] of Object.entries(itMap)) {
        const list = (byCh[cid] || []).sort(
          (a, b) => Date.parse(a.starttime || '') - Date.parse(b.starttime || '')
        );
        if (list.length === 0) continue;
        const scheduleSlots: OfficialProgramSlot[] = list
          .map((e: any) => {
            const sMs = Date.parse(e.starttime || '');
            const eMs = Date.parse(e.endtime || '');
            if (Number.isNaN(sMs) || Number.isNaN(eMs)) return null;
            return {
              title: decodeHtmlEntitiesClean(e.eventTitle || e.title || 'Sky Sport Live'),
              subtitle: decodeHtmlEntitiesClean(e.eventSynopsis || e.content?.genre?.name || 'Sky Sport Italia HD'),
              startTime: e.starttime,
              endTime: e.endtime,
              startMs: sMs,
              endMs: eMs,
            };
          })
          .filter(Boolean) as OfficialProgramSlot[];
        let curIdx = list.findIndex(
          (e) => nowMs >= Date.parse(e.starttime || '') && nowMs < Date.parse(e.endtime || '')
        );
        if (curIdx === -1) curIdx = 0;
        const cur = list[curIdx];
        const nxt = list[curIdx + 1] || cur;
        setOfficialChannel(
          chId,
          cur.eventTitle || cur.title || 'Sky Sport Live',
          cur.eventSynopsis || cur.content?.genre?.name || 'Sky Sport Italia HD',
          cur.starttime,
          cur.endtime,
          nxt.eventTitle || nxt.title || 'Sky Sport Next',
          nxt.eventSynopsis || nxt.content?.genre?.name || 'Sky Sport Italia HD',
          nxt.starttime,
          nxt.endtime,
          'sky.it',
          scheduleSlots
        );
      }
    } catch {
      // ignore parse errors
    }
  };

  // 4. Official Arabic Entertainment & Movies TV Guide (elcinema.com/tvguide/)
  const fetchElCinemaArabicOfficial = async () => {
    const html = await fetchTextFast('https://elcinema.com/tvguide/', 4500);
    if (!html) return;
    const arMap: Record<string, string[]> = {
      '1127': ['mbc-1-ar'],
      '1129': ['mbc-4-ar'],
      '1354': ['mbc-5-ar'],
      '1194': ['mbc-drama-ar'],
      '1131': ['mbc-plus-drama-ar'],
      '1239': ['mbc-masr-ar'],
      '1278': ['mbc-masr-2-ar'],
      '1340': ['mbc-iraq-ar'],
      '1289': ['rotana-cinema-ar'],
      '1147': ['rotana-drama-ar'],
      '1358': ['rotana-comedy-ar'],
      '1322': ['bein-movies-premiere-en'],
      '1323': ['bein-movies-action-en', 'bein-movies-action-ar'],
      '1324': ['bein-movies-drama-en'],
      '1212': ['bein-movies-hits-en'],
      '1330': ['bein-movies-thriller-ar'],
      '1309': ['bein-aflam-ar'],
    };
    const lines = html.split('<div class="tv-line">').slice(1);
    for (const ln of lines) {
      const idMatch = ln.match(/\/tvguide\/(\d+)\//);
      if (!idMatch) continue;
      const targetIds = arMap[idMatch[1]];
      if (!targetIds) continue;
      const titles = [
        ...ln.matchAll(/<ul class="unstyled no-margin">\s*<li>(?:<a[^>]*>)?([^<]+)/g),
      ].map((x) => x[1].trim());
      if (titles.length === 0) continue;
      const nowTitle = titles[0];
      const nextTitle = titles[1] || titles[0];
      for (const chId of targetIds) {
        if (nextMap.has(chId)) continue;
        setOfficialChannel(
          chId,
          nowTitle,
          'البث المباشر الآن • جدول القنوات الرسمي',
          new Date(nowMs - 15 * 60000).toISOString(),
          new Date(nowMs + 45 * 60000).toISOString(),
          nextTitle,
          'البرنامج القادم • جدول القنوات الرسمي',
          new Date(nowMs + 45 * 60000).toISOString(),
          new Date(nowMs + 105 * 60000).toISOString(),
          'elcinema.com'
        );
      }
    }
  };

  // 5. Official Movistar Plus+ Spain EPG (movistarplus.es)
  const fetchMovistarSpainOfficial = async () => {
    const { curMinutes } = getLocalClockMinutes('Europe/Madrid');
    const esChannels: Array<[string, string]> = [
      ['mliga', 'movistar-laliga-es'],
      ['daznli', 'dazn-laliga-es'],
      ['mplus', 'movistar-plus-es'],
      ['mligs', 'laliga-hypermotion-es'],
      ['chapio', 'movistar-liga-de-campeones-es'],
      ['vamosd', 'movistar-vamos-es'],
      ['cpdep', 'movistar-deportes-es'],
      ['mvf1', 'dazn-f1-es'],
      ['esp', 'eurosport-1'],
      ['esp2', 'eurosport-2'],
      ['realm', 'real-madrid-tv'],
    ];
    await Promise.all(
      esChannels.map(async ([code, chId]) => {
        const html = await fetchTextFast(`https://www.movistarplus.es/programacion-tv/${code}`, 4200);
        if (!html) return;
        const boxes = html.split(/class="[^"]*container_box[^"]*"/).slice(1);
        const progs: Array<{ title: string; genre: string; sMin: number }> = [];
        for (const b of boxes) {
          const tm = b.match(/<li class="time">\s*(\d{2}):(\d{2})\s*<\/li>/);
          const tt = b.match(/<li class="title">\s*([^<]+)\s*<\/li>/);
          const gn = b.match(/<li class="genre">\s*([^<]+)\s*<\/li>/);
          if (tm && tt) {
            const sh = Number(tm[1]);
            const sm = Number(tm[2]);
            let sMin = sh * 60 + sm;
            if (progs.length > 0 && sMin < progs[progs.length - 1].sMin - 180) {
              sMin += 1440;
            }
            progs.push({
              title: tt[1].trim(),
              genre: gn ? gn[1].trim() : 'Movistar Plus+ HD',
              sMin,
            });
          }
        }
        if (progs.length === 0) return;
        const scheduleSlots: OfficialProgramSlot[] = progs.map((p, i) => {
          const eMin = i + 1 < progs.length ? progs[i + 1].sMin : p.sMin + 90;
          const sIso = localMinutesToUtcIso(nowMs, curMinutes, p.sMin);
          const eIso = localMinutesToUtcIso(nowMs, curMinutes, eMin);
          return {
            title: decodeHtmlEntitiesClean(p.title),
            subtitle: decodeHtmlEntitiesClean(p.genre),
            startTime: sIso,
            endTime: eIso,
            startMs: Date.parse(sIso),
            endMs: Date.parse(eIso),
          };
        });
        let curIdx = -1;
        for (let i = 0; i < progs.length; i++) {
          const nMin = i + 1 < progs.length ? progs[i + 1].sMin : progs[i].sMin + 90;
          if (curMinutes >= progs[i].sMin && curMinutes < nMin) {
            curIdx = i;
            break;
          }
        }
        if (curIdx === -1) curIdx = Math.max(0, progs.length - 1);
        const cur = progs[curIdx];
        const nxt = progs[curIdx + 1] || cur;
        const curEndMin = curIdx + 1 < progs.length ? progs[curIdx + 1].sMin : cur.sMin + 90;
        const nxtEndMin = curIdx + 2 < progs.length ? progs[curIdx + 2].sMin : nxt.sMin + 90;
        setOfficialChannel(
          chId,
          cur.title,
          cur.genre,
          localMinutesToUtcIso(nowMs, curMinutes, cur.sMin),
          localMinutesToUtcIso(nowMs, curMinutes, curEndMin),
          nxt.title,
          nxt.genre,
          localMinutesToUtcIso(nowMs, curMinutes, nxt.sMin),
          localMinutesToUtcIso(nowMs, curMinutes, nxtEndMin),
          'movistarplus.es',
          scheduleSlots
        );
      })
    );
  };

  // 6. Official French Sports & Canal+ EPG (programme-television.org)
  const fetchFranceSportsOfficial = async () => {
    const { curMinutes } = getLocalClockMinutes('Europe/Paris');
    const frChannels: Array<[string, string]> = [
      ['canal', 'canal-plus-fr'],
      ['canal-foot', 'canal-plus-foot-fr'],
      ['canal-sport', 'canal-plus-sport-fr'],
      ['canal-sport-360', 'canal-plus-sport-360-fr'],
      ['rmc-sport-1', 'rmc-sport-1-fr'],
      ['rmc-sport-2', 'rmc-sport-2-fr'],
      ['l-equipe', 'lequipe-fr'],
      ['bein-sports-3', 'bein-sports-fr-3'],
    ];
    await Promise.all(
      frChannels.map(async ([slug, chId]) => {
        if (nextMap.has(chId)) return;
        const html = await fetchTextFast(`https://www.programme-television.org/tv/chaines/${slug}`, 4200);
        if (!html) return;
        const items = html.split('tvgrid-broadcast__item').slice(1);
        const progs: Array<{ title: string; sub: string; sMin: number }> = [];
        for (const it of items) {
          const tm = it.match(/tvgrid-broadcast__details-time">\s*(\d{2})[:h](\d{2})/);
          const tt = it.match(/tvgrid-broadcast__details-title[^"]*">\s*(?:<span>)?([^<]+)/);
          const sub = it.match(/tvgrid-broadcast__details-season">\s*(?:<span>)?([^<]+)/);
          if (tm && tt) {
            const sh = Number(tm[1]);
            const sm = Number(tm[2]);
            let sMin = sh * 60 + sm;
            if (progs.length > 0 && sMin < progs[progs.length - 1].sMin - 180) {
              sMin += 1440;
            }
            progs.push({
              title: tt[1].trim(),
              sub: sub ? sub[1].trim() : 'Direct Sport France',
              sMin,
            });
          }
        }
        if (progs.length === 0) return;
        const scheduleSlots: OfficialProgramSlot[] = progs.map((p, i) => {
          const eMin = i + 1 < progs.length ? progs[i + 1].sMin : p.sMin + 90;
          const sIso = localMinutesToUtcIso(nowMs, curMinutes, p.sMin);
          const eIso = localMinutesToUtcIso(nowMs, curMinutes, eMin);
          const fullT = p.sub && !p.title.includes(p.sub) ? `${p.title} : ${p.sub}` : p.title;
          return {
            title: decodeHtmlEntitiesClean(fullT),
            subtitle: decodeHtmlEntitiesClean(p.sub || 'Direct TV France'),
            startTime: sIso,
            endTime: eIso,
            startMs: Date.parse(sIso),
            endMs: Date.parse(eIso),
          };
        });
        let curIdx = -1;
        for (let i = 0; i < progs.length; i++) {
          const nMin = i + 1 < progs.length ? progs[i + 1].sMin : progs[i].sMin + 90;
          if (curMinutes >= progs[i].sMin && curMinutes < nMin) {
            curIdx = i;
            break;
          }
        }
        if (curIdx === -1) curIdx = Math.max(0, progs.length - 1);
        const cur = progs[curIdx];
        const nxt = progs[curIdx + 1] || cur;
        const curEndMin = curIdx + 1 < progs.length ? progs[curIdx + 1].sMin : cur.sMin + 90;
        const nxtEndMin = curIdx + 2 < progs.length ? progs[curIdx + 2].sMin : nxt.sMin + 90;
        setOfficialChannel(
          chId,
          cur.sub && !cur.title.includes(cur.sub) ? `${cur.title} : ${cur.sub}` : cur.title,
          cur.sub || 'Direct TV France',
          localMinutesToUtcIso(nowMs, curMinutes, cur.sMin),
          localMinutesToUtcIso(nowMs, curMinutes, curEndMin),
          nxt.sub && !nxt.title.includes(nxt.sub) ? `${nxt.title} : ${nxt.sub}` : nxt.title,
          nxt.sub || 'À Suivre',
          localMinutesToUtcIso(nowMs, curMinutes, nxt.sMin),
          localMinutesToUtcIso(nowMs, curMinutes, nxtEndMin),
          'programme-television.org',
          scheduleSlots
        );
      })
    );
  };

  // 7. Official US Sports & Movies EPG (tvpassport.com)
  const fetchUsTvPassportOfficial = async () => {
    const usChannels: Array<[string, string]> = [
      ['hbo--eastern-feed/614', 'hbo-hd'],
      ['hbo-2--eastern-feed/626', 'hbo-2-hd'],
      ['paramount-with-showtime--eastern-feed/665', 'showtime-hd'],
      ['starz--eastern/583', 'starz-hd'],
      ['cinemax--eastern-feed/632', 'cinemax-hd'],
      ['espn/594', 'espn-hd'],
      ['espn2/650', 'espn-2-hd'],
      ['espn-u/3331', 'espnu-hd'],
      ['espn-deportes/2108', 'espn-deportes-es'],
      ['fox-sports-1/668', 'fox-sports-1'],
      ['fox-sports-2/2114', 'fox-sports-2'],
      ['usa-network--east-feed/640', 'usa-network-hd'],
      ['cbs-sports-network-usa/3115', 'cbs-sports-golazo'],
      ['nba-tv-usa/3116', 'nba-tv'],
      ['nfl-network/3349', 'nfl-network'],
      ['nfl-redzone/6921', 'nfl-redzone'],
      ['mlb-network/6178', 'mlb-network'],
      ['nhl-network-usa/14156', 'nhl-network'],
      ['the-tennis-channel/2269', 'tennis-channel'],
      ['bein-sport-usa/10853', 'bein-sports-xtra-en'],
      ['bein-sport-en-espanol/10855', 'bein-sports-xtra-es'],
    ];

    const parseTvPassportStation = async ([slug, chId]: [string, string]) => {
      const html = await fetchTextFast(`https://www.tvpassport.com/tv-listings/stations/${slug}`, 5500);
      if (!html) return;
      const items = html.split(/id="itemheader\d+"/i).slice(1);
      const parsed: Array<{ title: string; sub: string; startMs: number; endMs: number }> = [];
      for (const it of items) {
        const st = it.match(/data-st="([^"]+)"/i)?.[1] || '';
        const durMin = Number(it.match(/data-duration="(\d+)"/i)?.[1] || '60');
        const showName = it.match(/data-showname="([^"]+)"/i)?.[1] || '';
        const epTitle = it.match(/data-episodetitle="([^"]*)"/i)?.[1] || '';
        if (!st || !showName) continue;
        const isoEst = st.replace(' ', 'T') + '-04:00';
        const startMsVal = Date.parse(isoEst);
        if (Number.isNaN(startMsVal)) continue;
        const endMsVal = startMsVal + durMin * 60000;
        const fullTitle =
          epTitle && !showName.toLowerCase().includes(epTitle.toLowerCase())
            ? `${showName}: ${epTitle}`
            : showName;
        parsed.push({
          title: fullTitle,
          sub: epTitle || showName,
          startMs: startMsVal,
          endMs: endMsVal,
        });
      }
      if (parsed.length === 0) return;
      const scheduleSlots: OfficialProgramSlot[] = parsed.map((p) => ({
        title: decodeHtmlEntitiesClean(p.title),
        subtitle: decodeHtmlEntitiesClean(p.sub),
        startTime: new Date(p.startMs).toISOString(),
        endTime: new Date(p.endMs).toISOString(),
        startMs: p.startMs,
        endMs: p.endMs,
      }));
      let curIdx = parsed.findIndex((p) => nowMs >= p.startMs && nowMs < p.endMs);
      if (curIdx === -1) {
        curIdx = parsed.findIndex((p) => p.startMs > nowMs);
        if (curIdx > 0) curIdx -= 1;
        else if (curIdx === -1) curIdx = parsed.length - 1;
      }
      const cur = parsed[curIdx];
      const nxt = parsed[curIdx + 1] || cur;
      setOfficialChannel(
        chId,
        cur.title,
        cur.sub,
        new Date(cur.startMs).toISOString(),
        new Date(cur.endMs).toISOString(),
        nxt.title,
        nxt.sub,
        new Date(nxt.startMs).toISOString(),
        new Date(nxt.endMs).toISOString(),
        'tvpassport.com',
        scheduleSlots
      );
    };

    const batch1 = usChannels.slice(0, 7);
    const batch2 = usChannels.slice(7, 14);
    const batch3 = usChannels.slice(14);
    await Promise.all(batch1.map(parseTvPassportStation));
    await Promise.all(batch2.map(parseTvPassportStation));
    await Promise.all(batch3.map(parseTvPassportStation));
  };

  // 8. Official XMLTV Feeds Harvester (open-epg.com compressed .xml.gz feeds + Upstream Scraper XMLTV)
  const fetchOpenEpgXmltvFeeds = async () => {
    const parseXmltvTimestamp = (rawTs?: string): number => {
      const m = String(rawTs || '')
        .trim()
        .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
      if (!m) return NaN;
      const tz = m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : 'Z';
      return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`);
    };

    const xmltvChannelToInternalIds: Record<string, string[]> = {
      // Qatar (qatar1.xml.gz & qatar2.xml.gz)
      'beIN SPORTS.qa': ['bein-sports-open-ar'],
      'bein SPORTS FTA DIGITAL.qa': ['bein-sports-open-ar'],
      'beIN SPORTS 1.qa': ['bein-sports-1-ar', 'bein-sports-premium-1-ar'],
      'beIN SPORTS1 DIGITAL.qa': ['bein-sports-1-ar', 'bein-sports-premium-1-ar'],
      'beIN SPORTS 2.qa': ['bein-sports-2-ar', 'bein-sports-premium-2-ar'],
      'beIN SPORTS2 DIGITAL.qa': ['bein-sports-2-ar', 'bein-sports-premium-2-ar'],
      'beIN SPORTS 3.qa': ['bein-sports-3-ar', 'bein-sports-premium-3-ar'],
      'beIN SPORTS3 DIGITAL.qa': ['bein-sports-3-ar', 'bein-sports-premium-3-ar'],
      'beIN SPORTS 4.qa': ['bein-sports-4-ar'],
      'beIN SPORTS4 DIGITAL.qa': ['bein-sports-4-ar'],
      'beIN SPORTS 5.qa': ['bein-sports-5-ar'],
      'beIN SPORTS5 DIGITAL.qa': ['bein-sports-5-ar'],
      'beIN SPORTS 6.qa': ['bein-sports-6-ar'],
      'beIN SPORTS6 DIGITAL -d-1.qa': ['bein-sports-6-ar'],
      'beIN SPORTS 7.qa': ['bein-sports-7-ar'],
      'beIN SPORTS7 DIGITAL.qa': ['bein-sports-7-ar'],
      'beIN SPORTS 8.qa': ['bein-sports-8-ar'],
      'beINSPORTS8.qa': ['bein-sports-8-ar'],
      'beIN SPORTS 9.qa': ['bein-sports-9-ar'],
      'beINSPORTS9.qa': ['bein-sports-9-ar'],
      'beIN SPORTS AFC.qa': ['bein-sports-afc-ar'],
      'beIN SPORTS 1 AFC.qa': ['bein-sports-afc-ar'],
      'beIN SPORTS EN 1.qa': ['bein-sports-en-1'],
      'beIN SPORTS1 ENGLISH Digital.qa': ['bein-sports-en-1'],
      'beIN SPORTS EN 2.qa': ['bein-sports-en-2'],
      'beIN SPORTS2 ENGLISH Digital.qa': ['bein-sports-en-2'],
      'beIN SPORTS XTRA 1.qa': ['bein-sports-en-3'],
      'beIN SPORTS XTRA1 Digital.qa': ['bein-sports-en-3'],
      'beIN SPORTS FR 1.qa': ['bein-sports-fr-1'],
      'beIN SPORTS1 FRENCH Digital.qa': ['bein-sports-fr-1'],
      'beIN SPORTS FR 2.qa': ['bein-sports-fr-2'],
      'beIN SPORTS2 FRENCH Digital.qa': ['bein-sports-fr-2'],
      'beIN SPORTS MAX 4.qa': ['bein-sports-max-4-fr'],
      'beIN SPORTS MAX 5.qa': ['bein-sports-max-5-fr'],
      'beIN SPORTS MAX 6.qa': ['bein-sports-max-6-fr'],

      // Turkey (turkey1.xml.gz)
      'beIN SPORTS 1.tr': ['bein-sports-1-tr'],
      'beIN SPORTS 2.tr': ['bein-sports-2-tr'],
      'beIN SPORTS 3.tr': ['bein-sports-3-tr'],
      'beIN SPORTS 4.tr': ['bein-sports-4-tr'],
      'beIN SPORTS 5.tr': ['bein-sports-5-tr'],
      'beIN SPORTS HABER.tr': ['bein-sports-haber-tr'],

      // France (france1.xml.gz)
      'beIN SPORTS 1.fr': ['bein-sports-fr-1'],
      'beIN SPORTS 2.fr': ['bein-sports-fr-2'],
      'beIN SPORTS 3.fr': ['bein-sports-fr-3'],
      'beIN SPORTS MAX 4.fr': ['bein-sports-max-4-fr'],
      'beIN SPORTS MAX 5.fr': ['bein-sports-max-5-fr'],
      'beIN SPORTS MAX 6.fr': ['bein-sports-max-6-fr'],
      'beIN SPORTS MAX 7.fr': ['bein-sports-max-7-fr'],
      'beIN SPORTS MAX 8.fr': ['bein-sports-max-8-fr'],
      'beIN SPORTS MAX 9.fr': ['bein-sports-max-9-fr'],
      'beIN SPORTS MAX 10.fr': ['bein-sports-max-10-fr'],
      'Canal+.fr': ['canal-plus-fr', 'canal-plus-premium-hd'],
      'Canal+ Sport.fr': ['canal-plus-sport-fr', 'canal-plus-afrique-1', 'canal-plus-sport-1-eu'],
      'Canal+ Foot.fr': ['canal-plus-foot-fr', 'canal-plus-afrique-2', 'canal-plus-sport-2-eu'],
      'Canal+ Sport 360.fr': ['canal-plus-sport-360-fr', 'canal-plus-extra-1'],
      'Canal+ Live 1.fr': ['canal-plus-extra-2'],
      'RMC Sport 1.fr': ['rmc-sport-1-fr'],
      'RMC Sport 2.fr': ['rmc-sport-2-fr'],
      "L'Equipe.fr": ['lequipe-fr'],
      'L&apos;Equipe.fr': ['lequipe-fr'],
      'Eurosport 1.fr': ['eurosport-1'],
      'Eurosport 2.fr': ['eurosport-2'],

      // STARZPLAY, Algeria TV & Arabic Entertainment (saudiarabia1.xml.gz & egypt1.xml.gz)
      'AD Sports Premium 1.sa': ['starzplay-sports-1-ar'],
      'AD Sports Premium 2.sa': ['starzplay-sports-2-ar'],
      'STARZPLAY Sports.sa': ['starzplay-sports-3-ar'],
      'AD Sports 1.sa': ['starzplay-asia-1-ar'],
      'AD Sports 2.sa': ['starzplay-asia-2-ar'],
      'MBC 1 HD.sa': ['mbc-1-ar'],
      'MBC 4 HD.sa': ['mbc-4-ar'],
      'MBC Drama HD.sa': ['mbc-drama-ar'],
      'MBC+ Drama HD.sa': ['mbc-plus-drama-ar'],
      'MBC MASR.sa': ['mbc-masr-ar'],
      'MBC MASR 2.sa': ['mbc-masr-2-ar'],
      'Rotana Cinema HD.sa': ['rotana-cinema-ar'],
      'Rotana Drama HD.sa': ['rotana-drama-ar'],
      'Rotana Comedy.sa': ['rotana-comedy-ar'],
      'الشروق الجزائرية.eg': ['algeria-echorouk-tv', 'algeria-echorouk-news'],
      'إس بي سي.eg': ['saudi-sbc-ar'],
      'إم بي سي 5.eg': ['mbc-5-ar'],
      'إم بي سي العراق.eg': ['mbc-iraq-ar'],
      'بي إن موفيز بريمير.eg': ['bein-movies-premiere-en'],
      'بي إن موفيز أكشن.eg': ['bein-movies-action-en', 'bein-movies-action-ar'],
      'بي إن موفيز دراما.eg': ['bein-movies-drama-en'],

      // United Kingdom (unitedkingdom1.xml.gz)
      'Sky Sports Main Event HD.uk': ['sky-sports-main-event'],
      'Sky Sports Premier League HD.uk': ['sky-sports-premier-league'],
      'Sky Sports Football HD.uk': ['sky-sports-football'],
      'Sky Sports + HD.uk': ['sky-sports-plus'],
      'Sky Sports Action HD.uk': ['sky-sports-action'],
      'Sky Sports F1 HD.uk': ['sky-sports-f1'],
      'Sky Sports Cricket HD.uk': ['sky-sports-cricket'],
      'Sky Sports Golf HD.uk': ['sky-sports-golf'],
      'Sky Sports Tennis HD.uk': ['sky-sports-tennis'],
      'Sky Sports Mix HD.uk': ['sky-sports-mix'],
      'Sky Sports News HD.uk': ['sky-sports-news'],
      'Sky Sports Racing.uk': ['sky-sports-racing'],
      'TNT Sports 1 HD.uk': ['tnt-sports-1'],
      'TNT Sports 2 HD.uk': ['tnt-sports-2'],
      'TNT Sports 3 HD.uk': ['tnt-sports-3'],
      'TNT Sports 4 HD.uk': ['tnt-sports-4'],
      'Premier Sports 1 HD.uk': ['premier-sports-1'],
      'Premier Sports 2 HD.uk': ['premier-sports-2'],

      // Spain (spain1.xml.gz & spain2.xml.gz)
      'M+ LALIGA.es': ['movistar-laliga-es'],
      'DAZN LALIGA.es': ['dazn-laliga-es'],
      'Movistar Plus.es': ['movistar-plus-es'],
      'LALIGA TV HYPERMOTION.es': ['laliga-hypermotion-es'],
      'DAZN F1.es': ['dazn-f1-es'],
      '#Vamos.es': ['movistar-vamos-es'],

      // South Africa SuperSport (southafrica2.xml.gz)
      'SS Grandstand.za': ['supersport-grandstand'],
      'SS Premier League.za': ['supersport-premier-league'],
      'SS La Liga.za': ['supersport-laliga'],
      'SS Football.za': ['supersport-football'],
      'SS Football Plus.za': ['supersport-variety-1'],

      // United States (unitedstates1.xml.gz)
      'ESPNHD.us': ['espn-hd'],
      'ESPN2HD.us': ['espn-2-hd'],
      'ESPNUHD.us': ['espnu-hd'],
      'ESPNDHD.us': ['espn-deportes-es'],
      'FS1HD.us': ['fox-sports-1'],
      'FS2HD.us': ['fox-sports-2'],
      'CBSSNHD.us': ['cbs-sports-golazo'],
      'USAHD.us': ['usa-network-hd'],
      'NBCSN.us': ['nbc-sports-now'],
      'NBATVHD.us': ['nba-tv'],
      'NFLNET.us': ['nfl-network'],
      'NFLNRZ.us': ['nfl-redzone'],
      'NHLNET.us': ['nhl-network'],
      'MLBN.us': ['mlb-network'],
      'HBOHD.us': ['hbo-hd'],
      'HBODRMA.us': ['hbo-2-hd'],
      'STARZ.us': ['starz-hd', 'starzplay-encore-hd', 'starzplay-action-hd'],
    };

    const xmltvFiles = [
      'qatar1.xml.gz',
      'turkey1.xml.gz',
      'france1.xml.gz',
      'saudiarabia1.xml.gz',
      'southafrica2.xml.gz',
    ];

    // If open-epg.com XMLTV cache is still fresh (within 4 hours), reuse it immediately without downloading or decompressing!
    if (
      cachedOpenEpgXmltvMap.size > 0 &&
      nowMs - openEpgXmltvLastRefreshMs < OPEN_EPG_XMLTV_TTL_MS
    ) {
      for (const [k, v] of cachedOpenEpgXmltvMap.entries()) {
        if (!nextMap.has(k)) {
          nextMap.set(k, v);
        }
      }
      return;
    }

    if (openEpgXmltvInFlight) {
      for (const [k, v] of cachedOpenEpgXmltvMap.entries()) {
        if (!nextMap.has(k)) {
          nextMap.set(k, v);
        }
      }
      return;
    }

    const gunzipAsync = (buf: Buffer): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        zlib.gunzip(buf, (err, res) => (err ? reject(err) : resolve(res)));
      });

    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const targetXmltvChannelsPattern = Object.keys(xmltvChannelToInternalIds)
      .map(escapeRegex)
      .join('|');
    const targetedProgrammeRegex = new RegExp(
      `<programme\\s+[^>]*channel="(${targetXmltvChannelsPattern})"[^>]*>[\\s\\S]*?<\\/programme>`,
      'g'
    );

    const fetchAndParseXmltvGz = async (fileName: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7500);
      try {
        const r = await fetch(`https://www.open-epg.com/files/${fileName}`, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
          },
        });
        if (!r.ok) return;
        const arrBuf = await r.arrayBuffer();
        // Decompress asynchronously on libuv worker thread so the main Node.js HTTP event loop is never blocked
        const unzippedBuf = await gunzipAsync(Buffer.from(arrBuf));
        const xmlText = unzippedBuf.toString('utf8');
        // Yield to event loop before scanning
        await new Promise((resolve) => setImmediate(resolve));

        const byInternalChannel = new Map<string, OfficialProgramSlot[]>();
        const matches = xmlText.matchAll(targetedProgrammeRegex);

        for (const match of matches) {
          const blk = match[0];
          const chRaw = match[1];
          if (!chRaw) continue;
          const targetIds =
            xmltvChannelToInternalIds[chRaw] ||
            xmltvChannelToInternalIds[decodeHtmlEntitiesClean(chRaw)];
          if (!targetIds || targetIds.length === 0) continue;

          const startRaw = blk.match(/start="([^"]+)"/)?.[1];
          const stopRaw = blk.match(/stop="([^"]+)"/)?.[1];
          const startMs = parseXmltvTimestamp(startRaw);
          const endMs = parseXmltvTimestamp(stopRaw);
          if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) continue;
          // Only retain slots within [-6h, +36h] around nowMs
          if (endMs < nowMs - 6 * 3600 * 1000 || startMs > nowMs + 36 * 3600 * 1000) continue;

          const rawTitle = decodeHtmlEntitiesClean(blk.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '');
          if (!rawTitle || /^none$/i.test(rawTitle)) continue;
          const rawSub = decodeHtmlEntitiesClean(blk.match(/<sub-title[^>]*>([^<]+)<\/sub-title>/i)?.[1] || '');
          const rawDesc = decodeHtmlEntitiesClean(blk.match(/<desc[^>]*>([^<]+)<\/desc>/i)?.[1] || '');

          const combinedText = `${rawTitle} ${rawSub}`;
          const isHighlightOrReplay =
            /\b(hl|highlights|özet|özetleri|résumé|resumen|sintesi|bant|tekrar|rep|replay|rediffusion|magazine|stories|remix)\b/i.test(
              combinedText
            );
          const isExplicitLive = /\b(canli|canlı|live|direct|direto|diretta|directo)\b/i.test(combinedText);
          const isLiveBroadcast = isExplicitLive || (!isHighlightOrReplay && endMs - startMs >= 85 * 60 * 1000);

          const slotObj: OfficialProgramSlot = {
            title: rawTitle,
            subtitle: rawSub || (rawDesc ? rawDesc.slice(0, 90) : 'Official XMLTV Broadcast Schedule'),
            startTime: new Date(startMs).toISOString(),
            endTime: new Date(endMs).toISOString(),
            startMs,
            endMs,
            isLiveBroadcast,
          };

          for (const internalId of targetIds) {
            const list = byInternalChannel.get(internalId) || [];
            list.push(slotObj);
            byInternalChannel.set(internalId, list);
          }
        }

        for (const [internalId, slots] of byInternalChannel.entries()) {
          if (nextMap.has(internalId)) continue;
          const sorted = slots.sort((a, b) => a.startMs - b.startMs);
          let curIdx = sorted.findIndex((p) => nowMs >= p.startMs && nowMs < p.endMs);
          if (curIdx === -1) {
            const nextFuture = sorted.findIndex((p) => p.startMs > nowMs);
            if (nextFuture > 0) curIdx = nextFuture - 1;
            else if (nextFuture === 0) curIdx = 0;
            else curIdx = sorted.length - 1;
          }
          const curP = sorted[curIdx];
          const nextP = sorted[curIdx + 1] || {
            title: getFallbackStudioProgram(internalId, 'next').title,
            subtitle: curP.subtitle,
            startTime: curP.endTime,
            endTime: new Date(curP.endMs + 3600000).toISOString(),
            startMs: curP.endMs,
            endMs: curP.endMs + 3600000,
          };
          setOfficialChannel(
            internalId,
            curP.title,
            curP.subtitle,
            curP.startTime,
            curP.endTime,
            nextP.title,
            nextP.subtitle,
            nextP.startTime,
            nextP.endTime,
            `open-epg.com (${fileName.replace('.xml.gz', '')})`,
            sorted
          );
          const built = nextMap.get(internalId);
          if (built) {
            cachedOpenEpgXmltvMap.set(internalId, built);
          }
        }
      } catch {
        // ignore individual XMLTV feed timeout
      } finally {
        clearTimeout(timer);
      }
    };

    // Process XMLTV files sequentially in the background so CPU/memory stays flat
    openEpgXmltvInFlight = (async () => {
      for (const file of xmltvFiles) {
        await fetchAndParseXmltvGz(file);
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (cachedOpenEpgXmltvMap.size > 0) {
        openEpgXmltvLastRefreshMs = Date.now();
      }
    })().finally(() => {
      openEpgXmltvInFlight = null;
    });

    // Apply any already-cached XMLTV channels immediately without waiting for the background XMLTV download
    for (const [k, v] of cachedOpenEpgXmltvMap.entries()) {
      if (!nextMap.has(k)) {
        nextMap.set(k, v);
      }
    }
  };

  // Run primary official broadcaster harvesters first, then attach cached/background open-epg.com XMLTV feeds
  await Promise.allSettled([
    fetchBeinOfficial(),
    fetchSkyUkOfficial(),
    fetchSkyItOfficial(),
    fetchElCinemaArabicOfficial(),
    fetchMovistarSpainOfficial(),
    fetchFranceSportsOfficial(),
    fetchUsTvPassportOfficial(),
  ]);

  await fetchOpenEpgXmltvFeeds();

  if (nextMap.size > 0) {
    for (const [k, v] of nextMap.entries()) {
      cachedOfficialBroadcasterEpg.set(k, v);
    }
    officialBroadcasterEpgLastRefreshMs = Date.now();
  }
}

async function ensureOfficialBroadcasterEpgReady(maxWaitMs = 2500): Promise<void> {
  const now = Date.now();
  if (
    cachedOfficialBroadcasterEpg.size > 0 &&
    now - officialBroadcasterEpgLastRefreshMs < OFFICIAL_BROADCASTER_EPG_TTL_MS
  ) {
    return;
  }
  if (!officialBroadcasterEpgInFlight) {
    officialBroadcasterEpgInFlight = refreshOfficialBroadcasterEpg().finally(() => {
      officialBroadcasterEpgInFlight = null;
    });
  }
  // If we already have EPG data in memory, never block the caller — let refresh finish in the background!
  if (cachedOfficialBroadcasterEpg.size === 0 && maxWaitMs > 0) {
    await Promise.race([
      officialBroadcasterEpgInFlight,
      new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
    ]);
  }
}

// Kick off initial background harvest of official broadcaster EPG on server startup
setTimeout(() => {
  ensureOfficialBroadcasterEpgReady(0).catch(() => {});
}, 1200);

// Helper to build per-channel EPG (nowPlaying, nextUp, upcoming, currentProgram, nextProgram) combining Official Broadcaster EPG + de-conflicted live events + curated 24/7 EPG
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

  // 1. Seed all known channels with Official Broadcaster EPG first (bein.com, Sky UK, Sky IT, Movistar+, ElCinema, Programme-TV, TVPassport), falling back to clean studio EPG
  const allChannelIds = new Set<string>([
    ...Object.keys(LIVE_CHANNEL_DIRECTORY),
    ...Array.from(cachedUpstreamEpgMap.keys()),
    ...Array.from(cachedOfficialBroadcasterEpg.keys()),
  ]);

  for (const chId of allChannelIds) {
    const officialEpg = cachedOfficialBroadcasterEpg.get(chId);
    if (officialEpg && officialEpg.nowPlaying) {
      epgMap[chId] = {
        nowPlaying: { ...officialEpg.nowPlaying, channelId: chId },
        nextUp: officialEpg.nextUp ? { ...officialEpg.nextUp, channelId: chId } : getFallbackStudioProgram(chId, 'next'),
        upcoming: Array.isArray(officialEpg.upcoming)
          ? officialEpg.upcoming.map((u: any) => ({ ...u, channelId: chId }))
          : [],
        currentProgram: { ...officialEpg.nowPlaying, channelId: chId },
        nextProgram: officialEpg.nextUp ? { ...officialEpg.nextUp, channelId: chId } : getFallbackStudioProgram(chId, 'next'),
      };
      continue;
    }

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

  let liveNflRedzoneCount = 0;

  // 2. Overlay LIVE scores onto Official Broadcaster EPG when teams match, or populate channels that lack an official live broadcaster feed
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
    const prestigeScore = getMatchBroadcastPrestige(ev);
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

      if (chId === 'nfl-redzone' && isLive) {
        liveNflRedzoneCount++;
      }

      const hasOfficialBroadcasterFeed = cachedOfficialBroadcasterEpg.has(chId);
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
        prestigeScore,
        matchInfo: {
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
          statusDetail: ev.statusDetail,
        },
      };

      if (hasOfficialBroadcasterFeed) {
        // Channel has an authoritative official broadcaster guide (e.g. bein.com, Sky UK, Sky IT, Movistar+):
        // Never overwrite its official program with a guessed match; only enrich with live score if the official program is this exact match!
        const curOffTitle = epgMap[chId].nowPlaying?.title || '';
        if (isNowOnThisChannel && doesOfficialTitleMatchLiveEvent(curOffTitle, ev)) {
          epgMap[chId].nowPlaying = {
            ...epgMap[chId].nowPlaying,
            ...progEntry,
            title:
              ev.homeTeam?.score !== undefined && ev.awayTeam?.score !== undefined
                ? `${curOffTitle} (${ev.homeTeam.score} - ${ev.awayTeam.score})`
                : curOffTitle,
            channelId: chId,
          };
          epgMap[chId].currentProgram = epgMap[chId].nowPlaying;
        }
        continue;
      }

      if (isNowOnThisChannel) {
        if (!epgMap[chId].nowPlaying || !epgMap[chId].nowPlaying.eventId) {
          epgMap[chId].nowPlaying = { ...progEntry, channelId: chId };
          epgMap[chId].currentProgram = epgMap[chId].nowPlaying;
        }
      } else if (minsUntil > -15) {
        const upItem = { ...progEntry, channelId: chId };
        if (!epgMap[chId].upcoming.some((u: any) => u?.eventId === progEntry.eventId)) {
          epgMap[chId].upcoming.push(upItem);
          epgMap[chId].upcoming.sort((a: any, b: any) => {
            const tA = Date.parse(a?.startTime || '') || 0;
            const tB = Date.parse(b?.startTime || '') || 0;
            const pA = Number(a?.prestigeScore || 0);
            const pB = Number(b?.prestigeScore || 0);
            const withinFourHoursA = tA - nowMs <= 4 * 3600 * 1000;
            const withinFourHoursB = tB - nowMs <= 4 * 3600 * 1000;
            if (pA >= 250 && withinFourHoursA && pB < 250) return -1;
            if (pB >= 250 && withinFourHoursB && pA < 250) return 1;
            return tA - tB;
          });
        }
        const earliestMatch = epgMap[chId].upcoming.find((u: any) => Boolean(u?.eventId));
        if (earliestMatch) {
          epgMap[chId].nextUp = earliestMatch;
          epgMap[chId].nextProgram = earliestMatch;
        }
      }
    }
  }

  // If 2+ Sunday NFL games are simultaneously live on NFL RedZone, show the true RedZone multi-game whiparound EPG title
  if (liveNflRedzoneCount >= 2 && epgMap['nfl-redzone']?.nowPlaying) {
    epgMap['nfl-redzone'].nowPlaying = {
      ...epgMap['nfl-redzone'].nowPlaying,
      title: `NFL RedZone Live: Sunday Whiparound (${liveNflRedzoneCount} Games In Play)`,
      subtitle: 'NFL RedZone HD • Live Multi-Game Touchdown Coverage',
    };
    epgMap['nfl-redzone'].currentProgram = epgMap['nfl-redzone'].nowPlaying;
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
    await ensureOfficialBroadcasterEpgReady(9000);
    const eventsPayload = await getOrRefreshLiveEventsPayload(10000);
    const channelEpgMap = buildChannelEpgDirectory(eventsPayload.events || []);
    const hostOrigin = `${req.protocol}://${req.get('host')}`;

    const formatXmltvDate = (isoOrMs?: string | number): string => {
      const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs || ''));
      const d = Number.isNaN(ms) ? new Date() : new Date(ms);
      const pad = (n: number) => String(n).padStart(2, '0');
      return (
        `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
      );
    };

    const xmlLines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<tv generator-info-name="Notflix-Official-XMLTV-EPG" generator-info-url="${escapeHtmlText(hostOrigin)}">`,
    ];

    const allChIds = Object.keys(LIVE_CHANNEL_DIRECTORY);
    for (const chId of allChIds) {
      const meta = LIVE_CHANNEL_DIRECTORY[chId];
      const logo = resolveChannelLogo(chId, meta.logo, meta.name);
      xmlLines.push(`  <channel id="${escapeHtmlText(chId)}">`);
      xmlLines.push(`    <display-name lang="${escapeHtmlText(meta.language || 'en')}">${escapeHtmlText(meta.name)}</display-name>`);
      if ((meta as any).shortName) {
        xmlLines.push(`    <display-name>${escapeHtmlText((meta as any).shortName)}</display-name>`);
      }
      if (logo) {
        xmlLines.push(`    <icon src="${escapeHtmlText(logo)}" />`);
      }
      xmlLines.push('  </channel>');
    }

    for (const chId of allChIds) {
      const meta = LIVE_CHANNEL_DIRECTORY[chId];
      const lang = escapeHtmlText(meta?.language || 'en');
      const offData = cachedOfficialBroadcasterEpg.get(chId);
      const synced = channelEpgMap[chId];
      const slots: Array<{ title: string; subtitle?: string; startTime: string; endTime: string }> = [];

      if (offData && Array.isArray(offData.schedule) && offData.schedule.length > 0) {
        for (const s of offData.schedule) {
          slots.push({
            title: s.title,
            subtitle: s.subtitle,
            startTime: s.startTime,
            endTime: s.endTime,
          });
        }
      } else {
        if (synced?.nowPlaying) slots.push(synced.nowPlaying);
        if (Array.isArray(synced?.upcoming) && synced.upcoming.length > 0) {
          slots.push(...synced.upcoming);
        } else if (synced?.nextUp) {
          slots.push(synced.nextUp);
        }
      }

      for (const s of slots) {
        if (!s || !s.title) continue;
        const startStr = formatXmltvDate(s.startTime);
        const stopStr = formatXmltvDate(s.endTime || Date.now() + 3600000);
        xmlLines.push(`  <programme start="${startStr}" stop="${stopStr}" channel="${escapeHtmlText(chId)}">`);
        xmlLines.push(`    <title lang="${lang}">${escapeHtmlText(s.title)}</title>`);
        if (s.subtitle) {
          xmlLines.push(`    <sub-title lang="${lang}">${escapeHtmlText(s.subtitle)}</sub-title>`);
        }
        xmlLines.push('  </programme>');
      }
    }

    xmlLines.push('</tv>');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(xmlLines.join('\n'));
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
        epgArray = rawEpgData.epg
          .filter((entry: any) => !REMOVED_MENA_SSC_ALKASS_CHANNEL_IDS.has(String(entry?.channelId || '').trim()))
          .map((entry: any) => {
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

    const eventsPayload = await getOrRefreshLiveEventsPayload(60000);
    const channelEpgMap = buildChannelEpgDirectory(eventsPayload?.events || []);

    if (
      isUnfiltered &&
      cachedLiveChannelsPayload &&
      Date.now() - cachedLiveChannelsPayload.timestamp < 5 * 60 * 1000
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
    const rawChannels = (Array.isArray(rawData?.channels) ? rawData.channels : []).filter(
      (c: any) => !REMOVED_MENA_SSC_ALKASS_CHANNEL_IDS.has(String(c?.id || '').trim())
    );

    const DEMBED_HEADERS = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      Origin: 'https://dembed.st',
      Referer: 'https://dembed.st/',
    };

    const CHANNEL_FAILOVER_RAW_URLS: Record<string, { url: string; label: string; headers?: Record<string, string> }[]> = {
      'starzplay-sports-1-ar': [
        {
          url: 'https://edge.wedd48c.top/premium609/index.m3u8',
          label: 'STARZPLAY Sports 1 / AD Sports Premium 1 HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'starzplay-sports-2-ar': [
        {
          url: 'https://edge.wedd48c.top/premium610/index.m3u8',
          label: 'STARZPLAY Sports 2 / AD Sports Premium 2 HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'starzplay-sports-3-ar': [
        {
          url: 'https://edge.wedd48c.top/premium602/index.m3u8',
          label: 'STARZPLAY Sports 3 / UFC Arabia HD (1080p)',
          headers: DEMBED_HEADERS,
        },
        {
          url: 'https://edge.wedd48c.top/premium609/index.m3u8',
          label: 'STARZPLAY Sports Backup HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'starzplay-asia-1-ar': [
        {
          url: 'https://edge.wedd48c.top/premium608/index.m3u8',
          label: 'STARZPLAY Sports Asia 1 / AD Sports Asia 1 HD (1080p)',
          headers: DEMBED_HEADERS,
        },
        {
          url: 'https://edge.wedd48c.top/premium600/index.m3u8',
          label: 'STARZPLAY Asia 1 Backup HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'starzplay-asia-2-ar': [
        {
          url: 'https://edge.wedd48c.top/premium603/index.m3u8',
          label: 'STARZPLAY Sports Asia 2 / AD Sports Asia 2 HD (1080p)',
          headers: DEMBED_HEADERS,
        },
        {
          url: 'https://edge.wedd48c.top/premium601/index.m3u8',
          label: 'STARZPLAY Asia 2 Backup HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'starzplay-criclife-1': [
        {
          url: 'https://edge.wedd48c.top/premium612/index.m3u8',
          label: 'STARZPLAY CricLife 1 HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'starzplay-criclife-2': [
        {
          url: 'https://edge.wedd48c.top/premium613/index.m3u8',
          label: 'STARZPLAY CricLife 2 HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'starzplay-encore-hd': [
        {
          url: 'https://edge.wedd48c.top/premium336/index.m3u8',
          label: 'STARZPLAY Encore Movies & Series HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'starzplay-action-hd': [
        {
          url: 'https://edge.wedd48c.top/premium337/index.m3u8',
          label: 'STARZPLAY Edge Action & Originals HD (1080p)',
          headers: DEMBED_HEADERS,
        },
      ],
      'algeria-samira-tv': [
        {
          url: 'http://185.9.2.18/chid_347/index.m3u8',
          label: 'Samira / TDA Algérie HD (1080p)',
        },
        {
          url: 'https://cdn.live.easybroadcast.io/abr_corp/66_al24_u4yga6h/playlist.m3u8',
          label: 'Algérie Backup HD (1080p)',
        },
      ],
      'saudi-sbc-ar': [
        {
          url: 'https://shd-gcp-live.edgenextcdn.net/live/bitmovin-sbc/90e09c0c28db26435799b4a14892a167/index.m3u8',
          label: 'SBC Saudi Official HD (1080p)',
        },
      ],
      'saudi-big-time-ar': [
        {
          url: 'https://shd-gcp-live.edgenextcdn.net/live/bitmovin-big-time-plus/924283f994779a311c1389698ff7e736/index.m3u8',
          label: 'Riyadh Season Big Time+ Official HD (1080p)',
        },
      ],
    };

    // Inject STARZPLAY & Saudi entertainment channels if not already in upstream list
    const DEDICATED_EXTRA_CHANNEL_IDS = [
      'starzplay-sports-1-ar',
      'starzplay-sports-2-ar',
      'starzplay-sports-3-ar',
      'starzplay-asia-1-ar',
      'starzplay-asia-2-ar',
      'starzplay-criclife-1',
      'starzplay-criclife-2',
      'starzplay-encore-hd',
      'starzplay-action-hd',
      'saudi-sbc-ar',
      'saudi-big-time-ar',
    ];
    for (const extraId of DEDICATED_EXTRA_CHANNEL_IDS) {
      if (!rawChannels.some((c: any) => c?.id === extraId)) {
        const meta = LIVE_CHANNEL_DIRECTORY[extraId];
        if (meta) {
          rawChannels.push({
            id: extraId,
            name: meta.name,
            network: meta.category === 'starzplay' ? 'STARZPLAY' : 'Saudi Entertainment',
            category: meta.category || 'starzplay',
            language: meta.language,
            languageLabel: meta.languageLabel,
            country: meta.category === 'starzplay' ? 'AE' : 'SA',
            quality: '1080p',
            logo: meta.logo,
            streams: [],
          });
        }
      }
    }

    const normalizedChannels = rawChannels.map((ch: any) => {
      const chId = String(ch?.id || '').trim();
      const dirMeta = LIVE_CHANNEL_DIRECTORY[chId];
      const cleanLang = toCleanEnglishLanguage(ch?.language || dirMeta?.language, ch?.languageLabel || dirMeta?.languageLabel);
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

      const failovers = CHANNEL_FAILOVER_RAW_URLS[chId];
      if (failovers && failovers.length > 0) {
        const failoverStreams = failovers.map((fo, idx) => ({
          id: `${chId}-fo${idx + 1}`,
          label: fo.label,
          quality: ch?.quality || '1080p',
          language: ch?.language || dirMeta?.language || 'ar',
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

      const resolvedCategory =
        chId.startsWith('algeria-') || ch?.country === 'DZ'
          ? 'algeria'
          : chId.startsWith('starzplay-') || chId === 'starz-hd'
            ? 'starzplay'
            : chId.startsWith('canal-plus-') ||
                chId.startsWith('rmc-sport-') ||
                chId === 'lequipe-fr' ||
                chId === 'dazn-ligue1-fr' ||
                chId === 'fifa-plus-fr'
              ? 'canal'
              : dirMeta?.category || ch?.category || 'europe';

      const syncedEpg = channelEpgMap[chId];
      const upstreamChEpg = ch?.epg || {};
      const mergedNowPlaying =
        syncedEpg?.nowPlaying ||
        (isCleanUpstreamStudioProgram(upstreamChEpg?.nowPlaying, chId) ? upstreamChEpg.nowPlaying : null) ||
        getFallbackStudioProgram(chId, 'now');
      const mergedNextUp =
        syncedEpg?.nextUp ||
        (isCleanUpstreamStudioProgram(upstreamChEpg?.nextUp, chId) ? upstreamChEpg.nextUp : null) ||
        getFallbackStudioProgram(chId, 'next');
      const mergedUpcoming = syncedEpg?.upcoming?.length
        ? syncedEpg.upcoming
        : (upstreamChEpg?.upcoming || []).filter((u: any) => isCleanUpstreamStudioProgram(u, chId));

      return {
        ...ch,
        name: resolvedName,
        category: resolvedCategory,
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
      categories: [
        'bein',
        'starzplay',
        'algeria',
        'canal',
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
      languages: rawData?.languages || ['ar', 'en', 'fr', 'es', 'tr', 'it', 'de', 'pt'],
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
    (channelId.endsWith('-ar') || channelId.startsWith('algeria-')
      ? 'ar'
      : channelId.endsWith('-fr') || channelId.startsWith('canal-plus-')
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

  // Prepend verified high-availability sibling failover streams for channels whose primary upstream node is down or contaminated
  const DEMBED_STREAM_HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Origin: 'https://dembed.st',
    Referer: 'https://dembed.st/',
  };
  const STREAM_FAILOVER_MAP: Record<string, { url: string; server: string; headers?: Record<string, string> }[]> = {
    'starzplay-sports-1-ar': [
      {
        url: 'https://edge.wedd48c.top/premium609/index.m3u8',
        server: 'STARZPLAY Sports 1 / AD Sports Premium 1 HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'starzplay-sports-2-ar': [
      {
        url: 'https://edge.wedd48c.top/premium610/index.m3u8',
        server: 'STARZPLAY Sports 2 / AD Sports Premium 2 HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'starzplay-sports-3-ar': [
      {
        url: 'https://edge.wedd48c.top/premium602/index.m3u8',
        server: 'STARZPLAY Sports 3 / UFC Arabia HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
      {
        url: 'https://edge.wedd48c.top/premium609/index.m3u8',
        server: 'STARZPLAY Sports Backup HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'starzplay-asia-1-ar': [
      {
        url: 'https://edge.wedd48c.top/premium608/index.m3u8',
        server: 'STARZPLAY Sports Asia 1 / AD Sports Asia 1 HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
      {
        url: 'https://edge.wedd48c.top/premium600/index.m3u8',
        server: 'STARZPLAY Asia 1 Backup HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'starzplay-asia-2-ar': [
      {
        url: 'https://edge.wedd48c.top/premium603/index.m3u8',
        server: 'STARZPLAY Sports Asia 2 / AD Sports Asia 2 HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
      {
        url: 'https://edge.wedd48c.top/premium601/index.m3u8',
        server: 'STARZPLAY Asia 2 Backup HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'starzplay-criclife-1': [
      {
        url: 'https://edge.wedd48c.top/premium612/index.m3u8',
        server: 'STARZPLAY CricLife 1 HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'starzplay-criclife-2': [
      {
        url: 'https://edge.wedd48c.top/premium613/index.m3u8',
        server: 'STARZPLAY CricLife 2 HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'starzplay-encore-hd': [
      {
        url: 'https://edge.wedd48c.top/premium336/index.m3u8',
        server: 'STARZPLAY Encore Movies & Series HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'starzplay-action-hd': [
      {
        url: 'https://edge.wedd48c.top/premium337/index.m3u8',
        server: 'STARZPLAY Edge Action & Originals HD (1080p)',
        headers: DEMBED_STREAM_HEADERS,
      },
    ],
    'algeria-samira-tv': [
      {
        url: 'http://185.9.2.18/chid_347/index.m3u8',
        server: 'Samira / TDA Algérie HD (1080p)',
      },
      {
        url: 'https://cdn.live.easybroadcast.io/abr_corp/66_al24_u4yga6h/playlist.m3u8',
        server: 'Algérie Backup HD (1080p)',
      },
    ],
    'saudi-sbc-ar': [
      {
        url: 'https://shd-gcp-live.edgenextcdn.net/live/bitmovin-sbc/90e09c0c28db26435799b4a14892a167/index.m3u8',
        server: 'SBC Saudi Official HD (1080p)',
      },
    ],
    'saudi-big-time-ar': [
      {
        url: 'https://shd-gcp-live.edgenextcdn.net/live/bitmovin-big-time-plus/924283f994779a311c1389698ff7e736/index.m3u8',
        server: 'Riyadh Season Big Time+ Official HD (1080p)',
      },
    ],
  };

  const failoverList = STREAM_FAILOVER_MAP[channelId];
  if (failoverList && failoverList.length > 0 && rawSources.length === 0) {
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
        verified: idx === 0,
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
    (isCleanUpstreamStudioProgram(upstreamRawEpg?.nowPlaying, channelId) ? upstreamRawEpg.nowPlaying : null) ||
    getFallbackStudioProgram(channelId, 'now');
  const authoritativeNextUp =
    syncedEpgForChannel?.nextUp ||
    (isCleanUpstreamStudioProgram(upstreamRawEpg?.nextUp, channelId) ? upstreamRawEpg.nextUp : null) ||
    getFallbackStudioProgram(channelId, 'next');
  const authoritativeUpcoming =
    syncedEpgForChannel?.upcoming?.length
      ? syncedEpgForChannel.upcoming
      : (upstreamRawEpg?.upcoming || []).filter((u: any) => isCleanUpstreamStudioProgram(u, channelId));

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
    const sUrl = String(s?.url || '').trim();
    if (!rawUrl && !sUrl) return;
    // Skip upstream ABR master playlist on channels where we filter out contaminated secondary mirrors
    if (
      sUrl.includes('/live/master/') &&
      (Boolean(failoverList) || Boolean(STRICT_CHANNEL_REQUIRED_STREAM_TOKEN[channelId]) || channelId.startsWith('algeria-'))
    ) {
      return;
    }
    if (isMismatchedSecondaryMirror(channelId, rawUrl, s?.server || s?.label)) return;

    const proxiedUrl = sUrl
      ? rewriteCineproLiveProxyUrl(sUrl)
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

// 3B. MULTI-STREAM ABR MASTER PLAYLIST PROXY
app.get(['/api/live/master/:channelFile', '/v1/live/master/:channelFile'], async (req: Request, res: Response) => {
  try {
    const channelFile = String(req.params.channelFile || '').trim();
    const targetUrl = `${getCineproUrl()}/v1/live/master/${encodeURIComponent(channelFile)}`;
    const upstream = await fetch(targetUrl);
    if (!upstream.ok) {
      return res.status(upstream.status).send('#EXTM3U\n');
    }
    let text = await upstream.text();
    text = text.replace(/https?:\/\/[^/\s"']+\/v1\/live\/proxy\//gi, '/api/live/proxy/');
    text = text.replace(/\/v1\/live\/proxy\//gi, '/api/live/proxy/');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(text);
  } catch {
    return res.status(502).send('#EXTM3U\n');
  }
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
      chunk = chunk.replace(/https?:\/\/[^/\s"']+\/v1\/live\/master\//gi, '/api/live/master/');
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
    text = text.replace(/https?:\/\/[^/\s"']+\/v1\/live\/master\//gi, `${hostOrigin}/api/live/master/`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="notflix-live-iptv.m3u8"');
    return res.send(text);
  } catch (err) {
    return res.status(502).send('#EXTM3U\n');
  }
});

// 6. BUILT-IN CORS-FREE HLS MANIFEST & SEGMENT PROXY RELAY (DIRECT CDN + LOCAL PNG/TIKTIKPX/GZIP UNWRAPPING + RAM CACHE)
const liveProxyManifestCache = new Map<string, { text: string; expiresAt: number }>();
const liveProxySegmentCache = new Map<string, { buffer: Buffer; contentType: string; expiresAt: number }>();
const MAX_LIVE_SEGMENT_CACHE_ENTRIES = 28;

function unwrapTikTikPxPayload(buf: Buffer): Buffer {
  if (buf.length >= 12 && buf.subarray(0, 8).toString('ascii') === 'TIKTIKPX') {
    const payloadLen = buf.readUInt32BE(8);
    const endOffset = Math.min(buf.length, 12 + payloadLen);
    const slice = buf.subarray(12, endOffset);
    if (slice.length >= 2 && slice[0] === 0x1f && slice[1] === 0x8b) {
      try {
        return zlib.gunzipSync(slice);
      } catch {
        return slice;
      }
    }
    return slice;
  }
  return buf;
}

function unwrapLiveMediaSegment(rawBuffer: Buffer): Buffer {
  if (!rawBuffer || rawBuffer.length < 16) return rawBuffer;
  let buffer = rawBuffer;

  // 1. True PNG image container (0x89 'P' 'N' 'G') used by TikTok CDN (~tplv-tiktokx-origin.image)
  //    Contains zlib-compressed IDAT scanlines -> PNG row filters (0..4) -> TIKTIKPX length prefix -> gzip -> MPEG-TS (0x47)
  if (
    buffer.length > 64 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[12] === 0x49 &&
    buffer[13] === 0x48 &&
    buffer[14] === 0x44 &&
    buffer[15] === 0x52
  ) {
    try {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      const colorType = buffer[25];
      const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
      const rowBytes = width * bpp;
      const stride = 1 + rowBytes;

      if (width > 0 && width <= 4096 && height > 0 && height <= 8192) {
        let pos = 8;
        const idatChunks: Buffer[] = [];
        while (pos + 8 <= buffer.length) {
          const chunkLen = buffer.readUInt32BE(pos);
          if (chunkLen < 0 || pos + 12 + chunkLen > buffer.length) break;
          const chunkType = buffer.subarray(pos + 4, pos + 8).toString('ascii');
          if (chunkType === 'IDAT') {
            idatChunks.push(buffer.subarray(pos + 8, pos + 8 + chunkLen));
          } else if (chunkType === 'IEND') {
            break;
          }
          pos += 12 + chunkLen;
        }

        if (idatChunks.length > 0) {
          const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
          if (inflated.length >= stride * height) {
            const pixels = Buffer.allocUnsafe(rowBytes * height);
            for (let y = 0; y < height; y++) {
              const filter = inflated[y * stride];
              const srcOff = y * stride + 1;
              const dstOff = y * rowBytes;
              const prevOff = (y - 1) * rowBytes;
              if (filter === 0) {
                inflated.copy(pixels, dstOff, srcOff, srcOff + rowBytes);
              } else {
                for (let x = 0; x < rowBytes; x++) {
                  const raw = inflated[srcOff + x];
                  const a = x >= bpp ? pixels[dstOff + x - bpp] : 0;
                  const b = y > 0 ? pixels[prevOff + x] : 0;
                  const c = x >= bpp && y > 0 ? pixels[prevOff + x - bpp] : 0;
                  let val = raw;
                  if (filter === 1) {
                    val = (raw + a) & 0xff;
                  } else if (filter === 2) {
                    val = (raw + b) & 0xff;
                  } else if (filter === 3) {
                    val = (raw + ((a + b) >> 1)) & 0xff;
                  } else if (filter === 4) {
                    const p = a + b - c;
                    const pa = Math.abs(p - a);
                    const pb = Math.abs(p - b);
                    const pc = Math.abs(p - c);
                    const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                    val = (raw + pr) & 0xff;
                  }
                  pixels[dstOff + x] = val;
                }
              }
            }
            buffer = unwrapTikTikPxPayload(pixels);
          }
        }
      }
    } catch {
      // Fall through to raw signature scans if PNG inflate fails
    }
  }

  // 2. Direct TIKTIKPX wrapper
  if (buffer.length >= 12 && buffer.subarray(0, 8).toString('ascii') === 'TIKTIKPX') {
    buffer = unwrapTikTikPxPayload(buffer);
  }

  // 3. Raw Gzip wrapper (0x1f 0x8b)
  if (buffer.length >= 18 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      buffer = zlib.gunzipSync(buffer);
    } catch {
      // Keep original buffer if not valid gzip
    }
  }

  // 4. Strip any prepended PNG/GIF/ID3 header before the first valid 188-byte MPEG-TS 0x47 sync sequence
  if (buffer.length > 376 && buffer[0] !== 0x47) {
    const maxScan = Math.min(buffer.length - 376, 8192);
    for (let i = 1; i < maxScan; i++) {
      if (buffer[i] === 0x47 && buffer[i + 188] === 0x47 && buffer[i + 376] === 0x47) {
        buffer = buffer.subarray(i);
        break;
      }
    }
  }

  return buffer;
}

function stabilizeLiveM3u8Manifest(rawManifestText: string, effectiveUrl: string, customHeaders: Record<string, string>): string {
  let text = rawManifestText;

  // First rewrite any CinePro proxy URLs to our local /api/live/proxy/ endpoint
  text = text.replace(/https?:\/\/[^/\s"']+\/v1\/live\/proxy\//gi, '/api/live/proxy/');
  text = text.replace(/\/v1\/live\/proxy\//gi, '/api/live/proxy/');
  text = text.replace(/([^\r\n"'])(\/api\/live\/proxy\/)/g, '$1\n$2');

  const lines = text.split(/\r?\n/);
  let expectVariantStream = false;
  let maxExtinfDuration = 0;

  for (const l of lines) {
    const m = l.match(/^#EXTINF:([\d.]+)/i);
    if (m) {
      const dur = parseFloat(m[1]);
      if (Number.isFinite(dur) && dur > maxExtinfDuration) {
        maxExtinfDuration = dur;
      }
    }
  }

  const rewrittenLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      rewrittenLines.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      // Strip upstream #EXT-X-START:TIME-OFFSET=-15.0 which forces HLS players onto the bleeding edge
      // and causes 15-second freezes/jumps when upstream publishes segments in 2-segment batches
      if (trimmed.startsWith('#EXT-X-START:')) {
        continue;
      }

      // Stabilize fluctuating #EXT-X-TARGETDURATION so hls.js never recalculates target latency mid-stream and seeks 15s forward
      if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
        const declared = parseInt(trimmed.slice('#EXT-X-TARGETDURATION:'.length), 10) || 6;
        const stableTarget = Math.max(declared, Math.ceil(maxExtinfDuration), 8);
        rewrittenLines.push(`#EXT-X-TARGETDURATION:${stableTarget}`);
        continue;
      }

      if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
        expectVariantStream = true;
      }
      if (trimmed.includes('URI="')) {
        const isPlaylistUri =
          trimmed.startsWith('#EXT-X-MEDIA') || trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF');
        rewrittenLines.push(
          line.replace(/URI="([^"]+)"/g, (_match, rawUri) => {
            if (rawUri.startsWith('/api/live/proxy/')) {
              return `URI="${rawUri}"`;
            }
            if (!effectiveUrl) return _match;
            try {
              const resolved = new URL(rawUri, effectiveUrl).toString();
              const isChildM3u8 = isPlaylistUri || /\.m3u8(\?|$)/i.test(resolved);
              return `URI="${buildLocalLiveProxyUrl(resolved, customHeaders, isChildM3u8)}"`;
            } catch {
              return _match;
            }
          })
        );
        continue;
      }
      rewrittenLines.push(line);
      continue;
    }

    const isVariant = expectVariantStream;
    expectVariantStream = false;

    if (trimmed.startsWith('/api/live/proxy/')) {
      rewrittenLines.push(trimmed);
      continue;
    }

    if (effectiveUrl) {
      try {
        const resolved = new URL(trimmed, effectiveUrl).toString();
        const isChildM3u8 =
          isVariant ||
          /\.m3u8(\?|$)/i.test(resolved) ||
          /\/(playlist|chunklist|master|index|manifest|mono)[^/]*\.m3u8/i.test(resolved);
        rewrittenLines.push(buildLocalLiveProxyUrl(resolved, customHeaders, isChildM3u8));
        continue;
      } catch {
        rewrittenLines.push(line);
        continue;
      }
    }

    rewrittenLines.push(line);
  }

  return rewrittenLines.join('\n');
}

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

    if (directUrl && !isSafeExternalProxyUrl(directUrl)) {
      return res.status(403).send('Forbidden: Internal or invalid proxy target URL');
    }

    const isManifestEndpoint =
      endpoint.endsWith('.m3u8') || /\.m3u8(\?|$)/i.test(directUrl);
    const hasRangeHeader = Boolean(req.headers.range);
    const cacheKey = directUrl || `${endpoint}${queryString}`;

    // 1. Check RAM Cache for Manifests (1.2s TTL) or Segments (18s TTL)
    const now = Date.now();
    if (isManifestEndpoint) {
      const cachedManifest = liveProxyManifestCache.get(cacheKey);
      if (cachedManifest && cachedManifest.expiresAt > now) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(cachedManifest.text);
      }
    } else if (!hasRangeHeader) {
      const cachedSeg = liveProxySegmentCache.get(cacheKey);
      if (cachedSeg && cachedSeg.expiresAt > now) {
        res.setHeader('Content-Type', cachedSeg.contentType);
        res.setHeader('Content-Length', cachedSeg.buffer.length.toString());
        res.setHeader('Cache-Control', 'public, max-age=15');
        return res.status(200).end(cachedSeg.buffer);
      }
    }

    // Build headers for direct CDN fetch and CinePro proxy fallback
    const buildDirectRequestHeaders = (): Record<string, string> => {
      const h: Record<string, string> = {
        'User-Agent':
          customHeaders['User-Agent'] ||
          customHeaders['user-agent'] ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Accept: '*/*',
      };
      if (customHeaders['Referer'] || customHeaders['referer']) {
        h['Referer'] = customHeaders['Referer'] || customHeaders['referer'];
      }
      if (customHeaders['Origin'] || customHeaders['origin']) {
        h['Origin'] = customHeaders['Origin'] || customHeaders['origin'];
      }
      if (req.headers.range) {
        h['Range'] = req.headers.range as string;
      }
      return h;
    };

    const cineproProxyHeaders: Record<string, string> = { Accept: '*/*' };
    if (req.headers.range) {
      cineproProxyHeaders['Range'] = req.headers.range as string;
    }

    // Determine whether to fetch directly from the Edge CDN first:
    // - All binary video segments (.ts / .image / .m4s / .aac) on public CDNs (TikTok CDN, cdn.wideiptv.top, Akamai, CloudFront, etc.)
    //   are 10x–50x faster when fetched directly (~120–350ms vs 2,500–16,000ms through the remote CinePro VPS) and unwrapped locally.
    // - Public M3U8 CDNs (HibridCDN, Amagi, Akamai, CloudFront, Kwikmotion, EdgeNext, EasyBroadcast) also fetch directly first.
    const isIpBoundManifestHost =
      isManifestEndpoint &&
      /(wedd48c\.top|cowedd|wideiptv\.top\/player\/)/i.test(directUrl);

    const preferDirectFetch =
      Boolean(directUrl) &&
      (!isManifestEndpoint ||
        !isIpBoundManifestHost ||
        /(hibridcdn\.net|amagi\.tv|akamaized\.net|cloudfront\.net|kwikmotion\.com|edgenextcdn\.net|easybroadcast\.io|turner\.com|irdeto\.com|daioncdn\.net|streamup\.eu)/i.test(
          directUrl
        ));

    const fetchFromDirectCdn = async (timeoutMs: number): Promise<globalThis.Response | null> => {
      if (!directUrl || !isSafeExternalProxyUrl(directUrl)) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(directUrl, {
          headers: buildDirectRequestHeaders(),
          signal: controller.signal,
          redirect: 'follow',
        });
        if (resp.url && !isSafeExternalProxyUrl(resp.url)) {
          clearTimeout(timer);
          return null;
        }
        if (resp.ok || resp.status === 206) {
          clearTimeout(timer);
          return resp;
        }
      } catch {
        // ignore and allow fallback
      }
      clearTimeout(timer);
      return null;
    };

    const fetchFromCineproRelay = async (timeoutMs: number): Promise<globalThis.Response | null> => {
      const cineproProxyUrl = `${getCineproUrl()}/v1/live/proxy/${encodeURIComponent(endpoint)}${queryString}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(cineproProxyUrl, {
          headers: cineproProxyHeaders,
          signal: controller.signal,
          redirect: 'follow',
        });
        if (resp.ok || resp.status === 206) {
          clearTimeout(timer);
          return resp;
        }
      } catch {
        // ignore and allow fallback
      }
      clearTimeout(timer);
      return null;
    };

    let upstream: globalThis.Response | null = null;
    let fetchedDirectly = false;

    if (preferDirectFetch) {
      upstream = await fetchFromDirectCdn(isManifestEndpoint ? 6000 : 7500);
      if (upstream) {
        fetchedDirectly = true;
      } else {
        upstream = await fetchFromCineproRelay(isManifestEndpoint ? 6500 : 9000);
      }
    } else {
      // IP-bound manifest host (edge.wedd48c.top or wideiptv.top/player/): fetch from CinePro with fast 5.5s timeout + 1 retry
      upstream = await fetchFromCineproRelay(5500);
      if (!upstream) {
        upstream = await fetchFromCineproRelay(5500);
      }
      if (!upstream && directUrl) {
        upstream = await fetchFromDirectCdn(5500);
        if (upstream) fetchedDirectly = true;
      }
    }

    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      return res.status(upstream?.status || 502).send(`Upstream returned ${upstream?.status || 502}`);
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const effectiveUrl = fetchedDirectly ? upstream.url || directUrl || '' : directUrl || '';

    const arrayBuffer = await upstream.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);
    const headerPrefix = buffer.subarray(0, 16).toString('utf8').trimStart();
    const isM3u8Content = headerPrefix.startsWith('#EXTM3U') || headerPrefix.startsWith('#EXT');

    if (isM3u8Content && buffer.length > 0) {
      const stabilizedText = stabilizeLiveM3u8Manifest(buffer.toString('utf8'), effectiveUrl, customHeaders);
      liveProxyManifestCache.set(cacheKey, {
        text: stabilizedText,
        expiresAt: Date.now() + 1200,
      });
      if (liveProxyManifestCache.size > 120) {
        const oldestKey = liveProxyManifestCache.keys().next().value;
        if (oldestKey) liveProxyManifestCache.delete(oldestKey);
      }

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.send(stabilizedText);
    }

    // Unwrap PNG/IDAT/TIKTIKPX/Gzip/header-prefixed media segments into clean 0x47 MPEG-TS bytes
    buffer = Buffer.from(unwrapLiveMediaSegment(buffer));

    let resolvedContentType = 'video/mp2t';
    if (buffer.length > 0 && buffer[0] === 0x47) {
      resolvedContentType = 'video/mp2t';
    } else if (contentType && !contentType.includes('image/') && !contentType.includes('text/plain')) {
      resolvedContentType = contentType;
    }

    if (!hasRangeHeader && upstream.status === 200 && buffer.length > 0 && buffer.length <= 6 * 1024 * 1024) {
      liveProxySegmentCache.set(cacheKey, {
        buffer,
        contentType: resolvedContentType,
        expiresAt: Date.now() + 18000,
      });
      if (liveProxySegmentCache.size > MAX_LIVE_SEGMENT_CACHE_ENTRIES) {
        const oldestKey = liveProxySegmentCache.keys().next().value;
        if (oldestKey) liveProxySegmentCache.delete(oldestKey);
      }
    }

    res.setHeader('Content-Type', resolvedContentType);
    if (upstream.headers.get('content-range')) {
      res.setHeader('Content-Range', upstream.headers.get('content-range')!);
    }
    res.setHeader('Cache-Control', 'public, max-age=15');
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

    // Track active live stream state (viewer currently playing or entering Movie/Series player or Live Arena)
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
    } else if (eventType === 'pageview' && typeof title === 'string' && !activeLiveViewers.has(sessionId)) {
      const cleanRoute = title.trim();
      if (/^\/(live|arena)(\/|$)/i.test(cleanRoute)) {
        activeLiveViewers.set(sessionId, {
          lastPing: now,
          title: 'Live Arena Hub',
          device: device || 'desktop',
          mediaType: 'live',
        });
      } else {
        const watchRouteMatch = cleanRoute.match(/^\/watch\/(movie|tv)\/(\d+)(?:-(.+))?/i);
        if (watchRouteMatch) {
          const routeMediaType = watchRouteMatch[1].toLowerCase() === 'tv' ? 'tv' : 'movie';
          const slugTitle = watchRouteMatch[3]
            ? watchRouteMatch[3].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
            : `TMDB #${watchRouteMatch[2]}`;
          activeLiveViewers.set(sessionId, {
            lastPing: now,
            title: slugTitle,
            device: device || 'desktop',
            mediaType: routeMediaType,
          });
        }
      }
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

    // 1. Calculate live viewers (active in last 120 seconds to include mobile background/PiP viewers where browser timers throttle to 60s)
    const liveTimeout = 120 * 1000;
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
    turnstileConfig: turnstileConfigStore,
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
        if (
          data.turnstileConfig &&
          typeof data.turnstileConfig === 'object' &&
          (data.turnstileConfig.updatedAt || 0) > (turnstileConfigStore.updatedAt || 0)
        ) {
          turnstileConfigStore = {
            ...turnstileConfigStore,
            ...data.turnstileConfig,
          };
          saveTurnstileConfigToDiskSync(turnstileConfigStore);
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

// ============================================================================
// CLOUDFLARE TURNSTILE SECURITY GATE (Env Vars + Admin Dashboard Controls)
// ============================================================================
const CF_TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const CF_TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
const DEFAULT_TURNSTILE_SITE_KEY = '0x4AAAAAAFtBNaXqrUAtPyOc';
const DEFAULT_TURNSTILE_SECRET_KEY = '0x4AAAAAAFtBNVrLfiSVyyv03sVdDegQ_rs';

// Track consumed Turnstile challenge tokens to prevent token replay attacks (Cloudflare Turnstile best practice)
const consumedTurnstileTokens = new Map<string, number>();

interface TurnstileConfigStore {
  enabled: boolean;
  mode: 'custom' | 'test';
  siteKey: string;
  secretKey: string;
  theme: 'dark' | 'auto';
  verifiedCount: number;
  failedCount: number;
  updatedAt: number;
}

const TURNSTILE_CONFIG_FILE = path.join(DATA_DIR, 'turnstile_config.json');
const TURNSTILE_BACKUP_FILE = '/var/tmp/notflix_turnstile_backup.json';

function getDefaultTurnstileConfigStore(): TurnstileConfigStore {
  const envEnabledRaw = String(process.env.TURNSTILE_ENABLED || '').trim().toLowerCase();
  const envSiteKey = String(
    process.env.TURNSTILE_SITE_KEY || process.env.VITE_TURNSTILE_SITE_KEY || DEFAULT_TURNSTILE_SITE_KEY
  ).trim();
  const envSecretKey = String(process.env.TURNSTILE_SECRET_KEY || DEFAULT_TURNSTILE_SECRET_KEY).trim();
  const hasCustomKeys = Boolean(envSiteKey && envSecretKey);
  const disabledByEnv = envEnabledRaw === 'false' || envEnabledRaw === '0' || envEnabledRaw === 'no';

  return {
    enabled: !disabledByEnv,
    mode: hasCustomKeys ? 'custom' : 'test',
    siteKey: envSiteKey,
    secretKey: envSecretKey,
    theme: 'dark',
    verifiedCount: 0,
    failedCount: 0,
    updatedAt: Date.now(),
  };
}

function saveTurnstileConfigToDiskSync(store: TurnstileConfigStore): void {
  const payload = JSON.stringify(store, null, 2);
  try {
    writeFileAtomicallyToMirrors('turnstile_config.json', payload, TURNSTILE_BACKUP_FILE);
  } catch {}
}

function loadTurnstileConfigFromDisk(): TurnstileConfigStore {
  const defaults = getDefaultTurnstileConfigStore();
  const candidates = Array.from(
    new Set([
      ...PERSISTENT_READ_DIRS.map((d) => path.join(d, 'turnstile_config.json')),
      TURNSTILE_CONFIG_FILE,
      TURNSTILE_BACKUP_FILE,
    ])
  );

  let newest: TurnstileConfigStore | null = null;
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8').trim();
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0;
          const storedSiteKey = typeof parsed.siteKey === 'string' ? parsed.siteKey.trim() : '';
          const storedSecretKey = typeof parsed.secretKey === 'string' ? parsed.secretKey.trim() : '';
          // Upgrade any legacy unconfigured placeholder config to the production Turnstile keys
          const isUnconfiguredLegacy = !storedSiteKey || storedSiteKey === CF_TURNSTILE_TEST_SITE_KEY;

          if (!newest || updatedAt >= newest.updatedAt) {
            newest = {
              enabled: isUnconfiguredLegacy
                ? defaults.enabled
                : typeof parsed.enabled === 'boolean'
                ? parsed.enabled
                : defaults.enabled,
              mode: isUnconfiguredLegacy
                ? 'custom'
                : parsed.mode === 'test' || parsed.mode === 'custom'
                ? parsed.mode
                : defaults.mode,
              siteKey: !isUnconfiguredLegacy && storedSiteKey ? storedSiteKey : defaults.siteKey,
              secretKey: !isUnconfiguredLegacy && storedSecretKey ? storedSecretKey : defaults.secretKey,
              theme: parsed.theme === 'auto' ? 'auto' : 'dark',
              verifiedCount: Number(parsed.verifiedCount) || 0,
              failedCount: Number(parsed.failedCount) || 0,
              updatedAt: isUnconfiguredLegacy ? Date.now() : updatedAt,
            };
          }
        }
      }
    } catch {}
  }

  const finalConfig = newest || defaults;
  saveTurnstileConfigToDiskSync(finalConfig);
  return finalConfig;
}

let turnstileConfigStore: TurnstileConfigStore = loadTurnstileConfigFromDisk();

function resolveActiveTurnstileKeys(store: TurnstileConfigStore): {
  siteKey: string;
  secretKey: string;
  usingTestKeys: boolean;
} {
  const effectiveSiteKey = String(
    store.siteKey ||
      process.env.TURNSTILE_SITE_KEY ||
      process.env.VITE_TURNSTILE_SITE_KEY ||
      DEFAULT_TURNSTILE_SITE_KEY
  ).trim();
  const effectiveSecretKey = String(
    store.secretKey || process.env.TURNSTILE_SECRET_KEY || DEFAULT_TURNSTILE_SECRET_KEY
  ).trim();

  if (store.mode === 'custom' && effectiveSiteKey && effectiveSecretKey) {
    return {
      siteKey: effectiveSiteKey,
      secretKey: effectiveSecretKey,
      usingTestKeys: false,
    };
  }

  return {
    siteKey: CF_TURNSTILE_TEST_SITE_KEY,
    secretKey: CF_TURNSTILE_TEST_SECRET_KEY,
    usingTestKeys: true,
  };
}

function createTurnstileSessionToken(ip: string): string {
  const ts = Date.now();
  const cleanIp = String(ip || '0.0.0.0').replace(/^::ffff:/i, '').trim();
  const sig = crypto
    .createHmac('sha256', STREAM_SECURITY_SECRET)
    .update(`cf_turnstile:${ts}:${cleanIp}`)
    .digest('hex');
  return `${ts}.${sig}`;
}

function verifyTurnstileSessionToken(rawToken: string, ip: string): boolean {
  if (!rawToken || typeof rawToken !== 'string' || !rawToken.includes('.')) return false;
  const [tsPart, sigPart] = rawToken.trim().split('.');
  const ts = Number(tsPart);
  if (!ts || !sigPart || Math.abs(Date.now() - ts) > 24 * 60 * 60 * 1000) return false;

  const cleanIp = String(ip || '0.0.0.0').replace(/^::ffff:/i, '').trim();
  const expectedIpSig = crypto
    .createHmac('sha256', STREAM_SECURITY_SECRET)
    .update(`cf_turnstile:${tsPart}:${cleanIp}`)
    .digest('hex');

  if (safeCompareStrings(sigPart, expectedIpSig)) return true;

  // Fallback check without IP binding in case mobile carrier rotated IP mid-session
  const fallbackSig = crypto
    .createHmac('sha256', STREAM_SECURITY_SECRET)
    .update(`cf_turnstile:${tsPart}:0.0.0.0`)
    .digest('hex');
  return safeCompareStrings(sigPart, fallbackSig);
}

function extractTurnstileCookie(req: Request): string {
  const cookieHeader = String(req.headers.cookie || '');
  if (!cookieHeader) return '';
  const match = cookieHeader.match(/(?:^|;\s*)notflix_cf_verified=([^;]+)/);
  return match && match[1] ? decodeURIComponent(match[1].trim()) : '';
}

// Public endpoint: Check if Cloudflare Turnstile gate is active and whether current browser session is verified
app.get('/api/security/turnstile/status', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const ip = getClientIp(req);
  const userAgent = String(req.headers['user-agent'] || '');

  // Legitimate search engine & social preview crawlers always bypass Turnstile so SEO indexing is never blocked
  if (isLegitimateSearchCrawler(userAgent)) {
    const active = resolveActiveTurnstileKeys(turnstileConfigStore);
    return res.json({
      success: true,
      enabled: false,
      mode: active.usingTestKeys ? 'test' : turnstileConfigStore.mode,
      siteKey: active.siteKey,
      theme: turnstileConfigStore.theme || 'dark',
      verified: true,
    });
  }

  const headerToken = String(req.headers['x-turnstile-token'] || '').trim();
  const cookieToken = extractTurnstileCookie(req);
  const isVerified =
    !turnstileConfigStore.enabled ||
    verifyTurnstileSessionToken(headerToken, ip) ||
    verifyTurnstileSessionToken(cookieToken, ip);

  const active = resolveActiveTurnstileKeys(turnstileConfigStore);

  return res.json({
    success: true,
    enabled: Boolean(turnstileConfigStore.enabled),
    mode: active.usingTestKeys ? 'test' : turnstileConfigStore.mode,
    siteKey: active.siteKey,
    theme: turnstileConfigStore.theme || 'dark',
    verified: isVerified,
  });
});

// Public endpoint: Verify Cloudflare Turnstile challenge token and issue session-only verification cookie + token
app.post('/api/security/turnstile/verify', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const ip = getClientIp(req);
  const userAgent = String(req.headers['user-agent'] || '');
  const token = String(req.body?.token || req.body?.['cf-turnstile-response'] || '').trim();
  const isPreviewFallback = req.body?.previewFallback === true;

  if (!turnstileConfigStore.enabled) {
    const sessionToken = createTurnstileSessionToken(ip);
    res.setHeader(
      'Set-Cookie',
      `notflix_cf_verified=${encodeURIComponent(sessionToken)}; Path=/; SameSite=Lax`
    );
    return res.json({
      success: true,
      verified: true,
      sessionToken,
    });
  }

  if (!token || token.length > 2048) {
    turnstileConfigStore.failedCount = (turnstileConfigStore.failedCount || 0) + 1;
    return res.status(400).json({
      success: false,
      error: !token ? 'Missing Cloudflare Turnstile challenge token.' : 'Invalid Turnstile token length.',
    });
  }

  // Reject single-use token replay attempts
  const now = Date.now();
  if (consumedTurnstileTokens.size > 2000) {
    for (const [tKey, ts] of consumedTurnstileTokens.entries()) {
      if (now - ts > 10 * 60 * 1000) consumedTurnstileTokens.delete(tKey);
    }
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (consumedTurnstileTokens.has(tokenHash)) {
    turnstileConfigStore.failedCount = (turnstileConfigStore.failedCount || 0) + 1;
    return res.status(403).json({
      success: false,
      error: 'Turnstile challenge token has already been used. Please complete a fresh challenge.',
    });
  }

  const active = resolveActiveTurnstileKeys(turnstileConfigStore);
  const reqHost = String(req.hostname || req.headers.host || '').toLowerCase();
  const isPreviewHost =
    reqHost.includes('.run.app') || reqHost.includes('localhost') || reqHost.startsWith('127.0.0.1');
  const secretToUse =
    isPreviewFallback && isPreviewHost ? CF_TURNSTILE_TEST_SECRET_KEY : active.secretKey;

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretToUse);
    formData.append('response', token);
    if (ip && ip !== '0.0.0.0') {
      formData.append('remoteip', ip);
    }
    if (crypto.randomUUID) {
      formData.append('idempotency_key', crypto.randomUUID());
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
    const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    clearTimeout(timer);

    const cfData: any = await cfRes.json();

    if (cfData && cfData.success === true) {
      consumedTurnstileTokens.set(tokenHash, now);
      turnstileConfigStore.verifiedCount = (turnstileConfigStore.verifiedCount || 0) + 1;
      saveTurnstileConfigToDiskSync(turnstileConfigStore);

      const sessionToken = createTurnstileSessionToken(ip);
      // Session-only cookie (no Max-Age or Expires) so verification lasts until browser tab/session closes
      res.setHeader(
        'Set-Cookie',
        `notflix_cf_verified=${encodeURIComponent(sessionToken)}; Path=/; SameSite=Lax`
      );
      return res.json({
        success: true,
        verified: true,
        sessionToken,
      });
    }

    turnstileConfigStore.failedCount = (turnstileConfigStore.failedCount || 0) + 1;
    saveTurnstileConfigToDiskSync(turnstileConfigStore);
    recordSecurityEvent(
      ip,
      `Cloudflare Turnstile Verification Failed (${Array.isArray(cfData?.['error-codes']) ? cfData['error-codes'].join(', ') : 'invalid-token'})`,
      userAgent,
      '/api/security/turnstile/verify',
      'interception',
      false
    );

    return res.status(403).json({
      success: false,
      error: 'Cloudflare Turnstile verification failed. Please complete the challenge again.',
      codes: cfData?.['error-codes'] || [],
    });
  } catch (err: any) {
    // If running in Test Mode or preview fallback and Cloudflare's API is unreachable, fail-safe for valid non-empty tokens
    if ((active.usingTestKeys || (isPreviewFallback && isPreviewHost)) && token.length >= 8) {
      consumedTurnstileTokens.set(tokenHash, now);
      turnstileConfigStore.verifiedCount = (turnstileConfigStore.verifiedCount || 0) + 1;
      saveTurnstileConfigToDiskSync(turnstileConfigStore);
      const sessionToken = createTurnstileSessionToken(ip);
      res.setHeader(
        'Set-Cookie',
        `notflix_cf_verified=${encodeURIComponent(sessionToken)}; Path=/; SameSite=Lax`
      );
      return res.json({
        success: true,
        verified: true,
        sessionToken,
      });
    }

    return res.status(502).json({
      success: false,
      error: 'Could not reach Cloudflare Turnstile verification service: ' + (err?.message || 'Timeout'),
    });
  }
});

// Admin endpoint: Fetch Cloudflare Turnstile configuration & verification telemetry
app.get('/api/admin/turnstile', requireAdminAuth, (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const active = resolveActiveTurnstileKeys(turnstileConfigStore);
  const hasEnvSiteKey = Boolean(
    String(
      process.env.TURNSTILE_SITE_KEY || process.env.VITE_TURNSTILE_SITE_KEY || DEFAULT_TURNSTILE_SITE_KEY
    ).trim()
  );
  const hasEnvSecretKey = Boolean(
    String(process.env.TURNSTILE_SECRET_KEY || DEFAULT_TURNSTILE_SECRET_KEY).trim()
  );

  return res.json({
    success: true,
    config: {
      ...turnstileConfigStore,
      activeSiteKey: active.siteKey,
      usingTestKeys: active.usingTestKeys,
      hasEnvSiteKey,
      hasEnvSecretKey,
    },
  });
});

// Admin endpoint: Update Cloudflare Turnstile configuration (enable/disable, mode, keys, theme)
app.post('/api/admin/turnstile', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const nextEnabled =
      typeof body.enabled === 'boolean' ? body.enabled : turnstileConfigStore.enabled;
    const nextMode: 'custom' | 'test' =
      body.mode === 'test' || body.mode === 'custom' ? body.mode : turnstileConfigStore.mode;
    const nextSiteKey =
      typeof body.siteKey === 'string' ? body.siteKey.trim() : turnstileConfigStore.siteKey;
    const nextSecretKey =
      typeof body.secretKey === 'string' ? body.secretKey.trim() : turnstileConfigStore.secretKey;
    const nextTheme: 'dark' | 'auto' = body.theme === 'auto' ? 'auto' : 'dark';
    const nextUpdatedAt =
      typeof body.updatedAt === 'number' && body.updatedAt > 0 ? body.updatedAt : Date.now();

    turnstileConfigStore = {
      ...turnstileConfigStore,
      enabled: nextEnabled,
      mode: nextMode,
      siteKey: nextSiteKey,
      secretKey: nextSecretKey,
      theme: nextTheme,
      updatedAt: nextUpdatedAt,
    };

    saveTurnstileConfigToDiskSync(turnstileConfigStore);
    const active = resolveActiveTurnstileKeys(turnstileConfigStore);
    const hasEnvSiteKey = Boolean(
      String(process.env.TURNSTILE_SITE_KEY || process.env.VITE_TURNSTILE_SITE_KEY || '').trim()
    );
    const hasEnvSecretKey = Boolean(String(process.env.TURNSTILE_SECRET_KEY || '').trim());

    return res.json({
      success: true,
      config: {
        ...turnstileConfigStore,
        activeSiteKey: active.siteKey,
        usingTestKeys: active.usingTestKeys,
        hasEnvSiteKey,
        hasEnvSecretKey,
      },
      message: nextEnabled
        ? active.usingTestKeys
          ? 'Cloudflare Turnstile Gate enabled (using Cloudflare Official Demo/Test Keys until custom keys are provided).'
          : 'Cloudflare Turnstile Gate enabled with your custom Site & Secret keys.'
        : 'Cloudflare Turnstile Gate disabled.',
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Failed to update Cloudflare Turnstile configuration',
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

function setHtmlResponseHeaders(req: Request, res: Response) {
  const cleanReqPath = String(req.originalUrl || req.path || '/').split('?')[0].toLowerCase();
  if (cleanReqPath.startsWith('/admin') || cleanReqPath.startsWith('/api/')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    setNoStoreHtmlHeaders(res);
    return;
  }
  res.setHeader('X-Robots-Tag', 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');
  const ua = String(req.headers['user-agent'] || '');
  const isBot =
    /googlebot|inspectiontool|googleother|storebot|bingbot|yandex|baiduspider|duckduckbot|slurp|applebot|twitterbot|facebookexternalhit|linkedinbot|telegrambot|whatsapp|discordbot/i.test(
      ua
    );
  if (isBot && !isShuttingDown) {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
    res.setHeader('Vary', 'User-Agent, Accept-Encoding');
    return;
  }
  setNoStoreHtmlHeaders(res);
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
      { path: 'movie/popular?page=3&without_genres=10749', type: 'movie' },
      { path: 'movie/top_rated?page=1&without_genres=10749', type: 'movie' },
      { path: 'movie/top_rated?page=2&without_genres=10749', type: 'movie' },
      { path: 'movie/now_playing?page=1&without_genres=10749', type: 'movie' },
      { path: 'movie/now_playing?page=2&without_genres=10749', type: 'movie' },
      { path: 'movie/upcoming?page=1&without_genres=10749', type: 'movie' },
      { path: 'trending/tv/day', type: 'tv' },
      { path: 'trending/tv/week', type: 'tv' },
      { path: 'tv/popular?page=1&without_genres=10749', type: 'tv' },
      { path: 'tv/popular?page=2&without_genres=10749', type: 'tv' },
      { path: 'tv/popular?page=3&without_genres=10749', type: 'tv' },
      { path: 'tv/top_rated?page=1&without_genres=10749', type: 'tv' },
      { path: 'tv/top_rated?page=2&without_genres=10749', type: 'tv' },
      { path: 'tv/on_the_air?page=1&without_genres=10749', type: 'tv' },
      { path: 'discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=1', type: 'tv' },
      { path: 'discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=2', type: 'tv' },
    ];

    const collected = new Map<string, SeoCatalogEntry>(seoCatalogCache.byKey);

    await Promise.allSettled(
      endpoints.map(async (ep) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try {
          const sep = ep.path.includes('?') ? '&' : '?';
          const url = `${TMDB_BASE}/${ep.path}${sep}api_key=${TMDB_API_KEY}&include_adult=false&language=en-US`;
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) return;
          const data = await res.json();
          const results = Array.isArray(data?.results) ? data.results : [];
          let addedAny = false;
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
            addedAny = true;
          }
          if (addedAny) {
            seoCatalogCache = {
              updatedAt: Date.now(),
              entries: Array.from(collected.values()),
              byKey: collected,
            };
          }
        } catch {
          clearTimeout(timer);
        }
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

  // Warm up the Home Catalog, Programmatic SEO catalog & Live Arena events immediately on server start
  setTimeout(() => {
    getOrRefreshHomeCatalogPayload(false).catch(() => {});
    refreshSeoCatalog().catch(() => {});
    getOrRefreshLiveEventsPayload(60000).catch(() => {});
  }, 150);

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

  async function resolveSeoTitleDetails(
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    fallbackSlug?: string
  ): Promise<SeoCatalogEntry | null> {
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
      const timer = setTimeout(() => controller.abort(), 3200);
      const url = `${TMDB_BASE}/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const raw = await res.json();
        if (raw && raw.id && raw.adult !== true && raw.adult !== 'true') {
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
            poster: raw.poster_path
              ? `https://image.tmdb.org/t/p/w500${raw.poster_path}`
              : 'https://notflixtv.com/icon-512.png',
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
        }
      }
    } catch {}

    // Resilient fallback from URL slug so Googlebot never receives duplicate homepage metadata on /watch/:type/:id
    if (tmdbId > 0) {
      const humanizedTitle = fallbackSlug
        ? fallbackSlug
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .trim()
        : `${mediaType === 'tv' ? 'Series' : 'Movie'} #${tmdbId}`;
      const cleanSlug = toServerSeoSlug(fallbackSlug || humanizedTitle);
      return {
        id: tmdbId,
        type: mediaType,
        title: humanizedTitle,
        year: '2026',
        slug: cleanSlug,
        path: `/watch/${mediaType}/${tmdbId}-${cleanSlug}`,
        overview: `Watch ${humanizedTitle} online free in 1080p and 4K Full HD with English, Arabic, Spanish, French, and multi-language subtitles on Notflix.`,
        poster: 'https://notflixtv.com/icon-512.png',
        backdrop: 'https://image.tmdb.org/t/p/w1280/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg',
        rating: 7.8,
      };
    }

    return null;
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
      { loc: 'https://notflixtv.com/movies', priority: '0.95', changefreq: 'hourly' },
      { loc: 'https://notflixtv.com/series', priority: '0.95', changefreq: 'hourly' },
      { loc: 'https://notflixtv.com/anime', priority: '0.95', changefreq: 'daily' },
      { loc: 'https://notflixtv.com/live', priority: '0.95', changefreq: 'always' },
      { loc: 'https://notflixtv.com/search', priority: '0.85', changefreq: 'weekly' },
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

    // 1. Movies, TV Series & Anime Catalog FIRST (Primary Core Pages for Google Crawl Priority)
    for (const item of entries) {
      const fullLoc = `https://notflixtv.com${item.path}`;
      const yearLabel = item.year ? ` (${item.year})` : '';
      const typeLabel = item.type === 'tv' ? 'Full TV Series' : 'Full Movie';
      const imgTitle = escapeXml(`Watch ${item.title}${yearLabel} ${typeLabel} Online Free in HD — Notflix`);
      const imgCaption = escapeXml(
        item.overview
          ? `Stream ${item.title}${yearLabel} in 1080p & 4K HD with subtitles: ${item.overview.slice(0, 140)}`
          : `Watch ${item.title}${yearLabel} online free in 1080p HD on Notflix.`
      );

      xml += `  <url>\n`;
      xml += `    <loc>${escapeXml(fullLoc)}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>daily</changefreq>\n`;
      xml += `    <priority>0.92</priority>\n`;
      if (item.poster && item.poster.startsWith('http')) {
        xml += `    <image:image>\n`;
        xml += `      <image:loc>${escapeXml(item.poster)}</image:loc>\n`;
        xml += `      <image:title>${imgTitle}</image:title>\n`;
        xml += `      <image:caption>${imgCaption}</image:caption>\n`;
        xml += `    </image:image>\n`;
      }
      xml += `  </url>\n`;
    }

    // 2. Live & Upcoming Sports Matches in Notflix Live Arena
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
      xml += `    <priority>${isLiveNow ? '0.90' : '0.86'}</priority>\n`;
      if (candidateImg) {
        xml += `    <image:image>\n`;
        xml += `      <image:loc>${escapeXml(candidateImg)}</image:loc>\n`;
        xml += `      <image:title>${imgTitle}</image:title>\n`;
        xml += `      <image:caption>${imgCaption}</image:caption>\n`;
        xml += `    </image:image>\n`;
      }
      xml += `  </url>\n`;
    }

    // 3. 24/7 Live Sports & Entertainment TV Channels in Notflix Arena
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
      xml += `    <priority>0.84</priority>\n`;
      if (ch.logo && ch.logo.startsWith('http')) {
        xml += `    <image:image>\n`;
        xml += `      <image:loc>${escapeXml(ch.logo)}</image:loc>\n`;
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
      const rawCleanPath = (reqPath || '/').split('?')[0].split('#')[0] || '/';
      const cleanPath = rawCleanPath.length > 1 ? rawCleanPath.replace(/\/+$/, '') : '/';
      if (cleanPath.toLowerCase().startsWith('/admin')) {
        return rawHtml
          .replace(/s\.src\s*=\s*['"]https:\/\/fz\.liquidincan\.com\/[^'"]+['"];?/gi, 's.src = "";')
          .replace(
            /<meta\s+name="robots"\s+content="[^"]*"\s*\/?>/i,
            '<meta name="robots" content="noindex, nofollow" />'
          )
          .replace(
            /<meta\s+name="googlebot"\s+content="[^"]*"\s*\/?>/i,
            '<meta name="googlebot" content="noindex, nofollow" />'
          )
          .replace(
            '<head>',
            '<head><script data-cfasync="false">window.__NOTFLIX_IS_ADMIN__=true;</script>'
          );
      }

      let pageTitle = 'Notflix — Watch Movies, TV Series & Anime Online Free in HD (1080p & 4K)';
      let pageDesc =
        'Stream trending movies, full TV series seasons, and anime online free in 1080p & 4K HD on Notflix with English, Arabic, Spanish, French & multi-language subtitles.';
      let pageKeywords =
        'Notflix, watch movies online free, stream tv series hd, watch full movies 1080p, watch anime english sub dub, free streaming site, 4k movies online, new movies 2026, مشاهدة افلام مترجمة, مشاهدة مسلسلات, ايجي بست, فاصل اعلاني';
      let canonicalUrl = `https://notflixtv.com${cleanPath === '/' ? '/' : cleanPath}`;
      let ogImage = 'https://image.tmdb.org/t/p/w1280/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg';
      let extraJsonLd = '';
      let ssrSemanticBodyHtml = '';

      const watchMatch = cleanPath.match(/^\/watch\/(movie|tv)\/(\d+)(?:-(.+))?$/i);
      const liveMatchRoute = cleanPath.match(/^\/live\/match\/([^/?#]+)/i);
      const liveChannelRoute = cleanPath.match(/^\/live\/channel\/([^/?#]+)/i);
      const isLiveHubRoute = /^\/(live|arena)(\/|$)/i.test(cleanPath);

      if (watchMatch) {
        const mediaType = watchMatch[1].toLowerCase() === 'tv' ? 'tv' : 'movie';
        const tmdbId = parseInt(watchMatch[2], 10);
        const urlSlugPart = watchMatch[3] || '';
        const item = await resolveSeoTitleDetails(mediaType, tmdbId, urlSlugPart);
        if (item) {
          const yearStr = item.year ? ` (${item.year})` : '';
          const typeLabel = mediaType === 'tv' ? 'Full TV Series & Episodes' : 'Full Movie';
          pageTitle = `Watch ${item.title}${yearStr} ${typeLabel} Online Free HD — Notflix`;
          pageDesc = `Watch ${item.title}${yearStr} online free in 1080p & 4K HD with English, Arabic, Spanish & multi-language subtitles on Notflix. ${
            item.overview || ''
          }`.slice(0, 158);
          pageKeywords = `watch ${item.title} online free, ${item.title}${yearStr} full ${
            mediaType === 'tv' ? 'series' : 'movie'
          } hd, stream ${item.title} 1080p, ${item.title} english subtitles, ${item.title} مترجم, Notflix`;
          // Always keep canonicalUrl identical to cleanPath if slug is present so Google never flags "Alternate page with proper canonical tag"
          canonicalUrl = urlSlugPart ? `https://notflixtv.com${cleanPath}` : `https://notflixtv.com${item.path}`;
          ogImage = item.backdrop || item.poster || ogImage;

          const schemaObj = {
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': mediaType === 'tv' ? 'TVSeries' : 'Movie',
                '@id': `${canonicalUrl}#media`,
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
              },
              {
                '@type': 'BreadcrumbList',
                itemListElement: [
                  { '@type': 'ListItem', position: 1, name: 'Notflix Home', item: 'https://notflixtv.com/' },
                  {
                    '@type': 'ListItem',
                    position: 2,
                    name: mediaType === 'tv' ? 'TV Series' : 'Movies',
                    item: mediaType === 'tv' ? 'https://notflixtv.com/series' : 'https://notflixtv.com/movies',
                  },
                  { '@type': 'ListItem', position: 3, name: item.title, item: canonicalUrl },
                ],
              },
            ],
          };
          extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(schemaObj)}</script>`;

          const related = seoCatalogCache.entries.slice(0, 24);
          ssrSemanticBodyHtml = `<article><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
            item.overview || pageDesc
          )}</p><p>Stream ${escapeHtmlAttr(item.title)}${escapeHtmlAttr(
            yearStr
          )} in 1080p Full HD and 4K Ultra HD with instant multi-server playback and synchronized English, Arabic, Spanish, and French subtitles on Notflix.</p><h2>Related Movies &amp; TV Series to Watch Free in HD</h2><ul>${related
            .map(
              (r) =>
                `<li><a href="https://notflixtv.com${r.path}">Watch ${escapeHtmlAttr(r.title)}${
                  r.year ? ` (${r.year})` : ''
                } Online Free HD</a></li>`
            )
            .join('')}</ul></article>`;
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
        pageDesc = `Watch ${matchTitle} (${leagueName}) live stream online free in 1080p Full HD on Notflix Arena. Multi-language commentary on ${channelListText}. بث مباشر`.slice(
          0,
          158
        );
        pageKeywords = `${matchTitle} live stream, watch ${matchTitle} free hd, ${homeName} vs ${awayName} live, ${leagueName} live stream, ${channelListText}, بث مباشر ${homeName} و ${awayName}, مشاهدة مباراة ${homeName}, يلا شوت, كورة لايف, beIN Sports AR HD, Notflix Arena`;
        // Always self-canonicalize to the clean requested match path so Google never marks match URLs as Alternate canonical
        canonicalUrl = `https://notflixtv.com${cleanPath}`;

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
            {
              '@type': 'VideoObject',
              '@id': `${canonicalUrl}#video`,
              name: `Watch ${matchTitle} (${leagueName}) Live Stream HD`,
              description: pageDesc,
              thumbnailUrl: [candidateLogo || ogImage],
              uploadDate: startIso,
              contentUrl: canonicalUrl,
              embedUrl: canonicalUrl,
              publication: {
                '@type': 'BroadcastEvent',
                name: `${matchTitle} Live Stream`,
                isLiveBroadcast: true,
                startDate: startIso,
                endDate: endIso,
              },
            },
            {
              '@type': 'BreadcrumbList',
              itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Notflix Home', item: 'https://notflixtv.com/' },
                { '@type': 'ListItem', position: 2, name: 'Live Sports Arena', item: 'https://notflixtv.com/live' },
                { '@type': 'ListItem', position: 3, name: `${matchTitle} (${leagueName})`, item: canonicalUrl },
              ],
            },
          ],
        };
        extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(sportsEventSchema)}</script>`;

        const otherMatches = allEvents.slice(0, 20);
        ssrSemanticBodyHtml = `<article><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
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
          .join('')}</ul></article>`;
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
        pageDesc = `Watch ${channelName} live stream 24/7 online free in 1080p Full HD on Notflix Arena. Instant multi-mirror sports, football, and entertainment broadcast. بث مباشر`;
        pageKeywords = `${cleanName} live stream, watch ${cleanName} online free hd, ${channelName} 24/7 live, بث مباشر ${cleanName}, مشاهدة قناة ${cleanName} بدون تقطيع, Notflix Arena`;
        canonicalUrl = `https://notflixtv.com${buildLiveChannelSeoPath(channelId)}`;
        if (chEntry?.logo && chEntry.logo.startsWith('http')) {
          ogImage = chEntry.logo;
        }

        const nowIso = new Date().toISOString();
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
            {
              '@type': 'VideoObject',
              '@id': `${canonicalUrl}#video`,
              name: `Watch ${cleanName} (${langLabel}) Live Stream 24/7 HD`,
              description: pageDesc,
              thumbnailUrl: [chEntry?.logo?.startsWith('http') ? chEntry.logo : ogImage],
              uploadDate: nowIso,
              contentUrl: canonicalUrl,
              embedUrl: canonicalUrl,
              publication: {
                '@type': 'BroadcastEvent',
                name: `${cleanName} 24/7 Live Broadcast`,
                isLiveBroadcast: true,
                startDate: nowIso,
              },
            },
            {
              '@type': 'BreadcrumbList',
              itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Notflix Home', item: 'https://notflixtv.com/' },
                { '@type': 'ListItem', position: 2, name: 'Live Sports Arena', item: 'https://notflixtv.com/live' },
                { '@type': 'ListItem', position: 3, name: `${cleanName} (${langLabel})`, item: canonicalUrl },
              ],
            },
          ],
        };
        extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(tvChannelSchema)}</script>`;

        const allChannelsList = Object.values(LIVE_CHANNEL_DIRECTORY);
        ssrSemanticBodyHtml = `<article><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
          pageDesc
        )}</p><h2>All 24/7 Live Sports &amp; TV Channels on Notflix Arena</h2><ul>${allChannelsList
          .map(
            (c) =>
              `<li><a href="https://notflixtv.com${buildLiveChannelSeoPath(c.channelId)}">Watch ${escapeHtmlAttr(
                c.name
              )} Live Stream 24/7 HD</a></li>`
          )
          .join('')}</ul></article>`;
      } else if (isLiveHubRoute) {
        pageTitle =
          'Notflix Arena — Watch Live Sports, Football Matches & 24/7 TV Channels Free in 1080p HD';
        pageDesc =
          'Watch live football matches (UEFA Champions League, Premier League, La Liga, El Clásico, Serie A), NBA, UFC, F1 & 102+ 24/7 live TV channels (beIN Sports AR/EN, Sky Sports, ESPN, SSC) free in 1080p HD.';
        pageKeywords =
          'live football stream free hd, watch beIN Sports 1 AR live, بث مباشر مباريات اليوم, مشاهدة قنوات بين سبورت مجانا, El Clasico live stream, Real Madrid vs Barcelona live, Champions League live, Premier League live, La Liga live, Sky Sports live, ESPN live, SSC Sports live, Koora Live, Yalla Shoot HD, Notflix Arena';
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
              '@type': 'BreadcrumbList',
              itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Notflix Home', item: 'https://notflixtv.com/' },
                { '@type': 'ListItem', position: 2, name: 'Live Sports & TV Arena', item: 'https://notflixtv.com/live' },
              ],
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

        ssrSemanticBodyHtml = `<section><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
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
          .join('')}</ul></nav></section>`;
      } else {
        if (cleanPath.startsWith('/movies')) {
          pageTitle = 'Watch Movies Online Free in HD (1080p & 4K) — New & Trending Films | Notflix';
          pageDesc =
            'Stream the latest Hollywood blockbusters, top-rated movies, and trending films online free in 1080p and 4K HD with multi-language subtitles on Notflix.';
          pageKeywords =
            'watch movies online free, full movies hd 1080p, 4k movies streaming, new movies 2026, top rated movies, مشاهدة افلام مترجمة, Notflix movies';
        } else if (cleanPath.startsWith('/series') || cleanPath.startsWith('/tv')) {
          pageTitle = 'Watch TV Series & Full Seasons Online Free in HD | Notflix';
          pageDesc =
            'Binge-watch full seasons and latest episodes of trending TV series online free in 1080p HD with English, Arabic, and multi-language subtitles on Notflix.';
          pageKeywords =
            'watch tv series online free, full seasons hd, stream tv shows 1080p, HBO series, Netflix series free, مشاهدة مسلسلات مترجمة, Notflix series';
        } else if (cleanPath.startsWith('/anime')) {
          pageTitle = 'Watch Anime Online Free in HD (English Sub & Dub) | Notflix';
          pageDesc =
            'Stream top-rated and trending Japanese anime series and movies online in 1080p HD with English, Arabic, and multi-language subtitles on Notflix.';
          pageKeywords =
            'watch anime online free, anime english sub, anime english dub, 1080p anime streaming, مشاهدة انمي مترجم, Notflix anime';
        } else if (cleanPath.startsWith('/search')) {
          pageTitle = 'Search Movies, TV Shows & Anime Online in HD | Notflix';
          pageDesc =
            'Search and stream any movie, TV series, or anime in 1080p & 4K HD with instant multi-language subtitles on Notflix.';
        }

        if (seoCatalogCache.entries.length === 0) {
          // Trigger SEO catalog warmup in background without delaying initial HTML response
          refreshSeoCatalog().catch(() => {});
        }

        // Filter catalog sample to match the active category tab while keeping Movies & Series #1
        const allCatalog = seoCatalogCache.entries;
        const filteredCatalog = cleanPath.startsWith('/movies')
          ? allCatalog.filter((e) => e.type === 'movie')
          : cleanPath.startsWith('/series') || cleanPath.startsWith('/tv') || cleanPath.startsWith('/anime')
            ? allCatalog.filter((e) => e.type === 'tv')
            : allCatalog;
        const catalogSample = (filteredCatalog.length > 0 ? filteredCatalog : allCatalog).slice(0, 60);

        if (catalogSample.length > 0) {
          const itemListSchema = {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            name: pageTitle,
            description: pageDesc,
            itemListElement: catalogSample.slice(0, 35).map((entry, idx) => ({
              '@type': 'ListItem',
              position: idx + 1,
              item: {
                '@type': entry.type === 'tv' ? 'TVSeries' : 'Movie',
                name: entry.title,
                url: `https://notflixtv.com${entry.path}`,
                image: entry.poster,
                datePublished: entry.year || undefined,
                aggregateRating: {
                  '@type': 'AggregateRating',
                  ratingValue: entry.rating.toFixed(1),
                  bestRating: '10',
                  worstRating: '1',
                  ratingCount: Math.max(150, Math.round(entry.rating * 480)),
                },
              },
            })),
          };
          extraJsonLd = `<script type="application/ld+json">${safeJsonLdStringify(itemListSchema)}</script>`;
          ssrSemanticBodyHtml = `<section><h1>${escapeHtmlAttr(pageTitle)}</h1><p>${escapeHtmlAttr(
            pageDesc
          )}</p><nav aria-label="Trending Movies and TV Series Directory"><h2>Watch Trending Movies &amp; Full TV Series Online Free in 1080p &amp; 4K HD</h2><ul>${catalogSample
            .map(
              (entry) =>
                `<li><a href="https://notflixtv.com${entry.path}">Watch ${escapeHtmlAttr(entry.title)}${
                  entry.year ? ` (${entry.year})` : ''
                } ${entry.type === 'tv' ? 'Full TV Series' : 'Full Movie'} Online Free HD</a></li>`
            )
            .join('')}</ul></nav></section>`;
        }
      }

      const safeTitle = escapeHtmlAttr(pageTitle);
      const safeDesc = escapeHtmlAttr(pageDesc);
      const safeKeywords = escapeHtmlAttr(pageKeywords);
      const safeUrl = escapeHtmlAttr(canonicalUrl);
      const safeImg = escapeHtmlAttr(ogImage);

      let modified = rawHtml
        .replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`)
        .replace(
          /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
          `<meta name="description" content="${safeDesc}" />`
        )
        .replace(
          /<meta\s+name="keywords"\s+content="[^"]*"\s*\/?>/i,
          `<meta name="keywords" content="${safeKeywords}" />`
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

      const activeTurnstile = resolveActiveTurnstileKeys(turnstileConfigStore);
      const turnstileBootstrapScript = `<script data-cfasync="false">window.__NOTFLIX_TURNSTILE__=${JSON.stringify({
        enabled: Boolean(turnstileConfigStore.enabled),
        mode: activeTurnstile.usingTestKeys ? 'test' : turnstileConfigStore.mode,
        siteKey: activeTurnstile.siteKey,
        theme: turnstileConfigStore.theme || 'dark',
      })};</script>`;

      modified = modified.replace('<head>', `<head>${turnstileBootstrapScript}`);

      if (extraJsonLd) {
        modified = modified.replace('</head>', `  ${extraJsonLd}\n  </head>`);
      }
      if (ssrSemanticBodyHtml) {
        // Inject both live semantic DOM (for Googlebot WRS with JS enabled) and <noscript> fallback outside #root
        const liveSemanticContainer = `<div id="notflix-ssr-seo-catalog" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;">${ssrSemanticBodyHtml}</div>\n    <noscript>${ssrSemanticBodyHtml}</noscript>`;
        modified = modified.replace('<div id="root"></div>', `<div id="root"></div>\n    ${liveSemanticContainer}`);
      }

      return modified;
    } catch {
      return rawHtml;
    }
  }

  const ROBOTS_TXT = `User-agent: *
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Googlebot-Image
Allow: /

User-agent: Googlebot-Video
Allow: /

User-agent: Bingbot
Allow: /

Sitemap: https://notflixtv.com/sitemap.xml
`;

  app.get('/robots.txt', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
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
        if (now - v.lastPing <= 120000 && v.mediaType === 'live') {
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
        setHtmlResponseHeaders(req, res);
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

    // Cache production index.html template in RAM so disk I/O never slows down HTML responses
    const prodIndex = path.join(distPath, 'index.html');
    const rootIndex = path.join(__dirname, 'index.html');
    const targetIndex = fs.existsSync(prodIndex) ? prodIndex : rootIndex;
    let cachedProdHtmlTemplate = '';
    try {
      cachedProdHtmlTemplate = fs.readFileSync(targetIndex, 'utf-8');
    } catch {}

    // Single-Page Application (SPA) catch-all route with Server-Side SEO Pre-Rendering for /, /live*, /watch/:type/:id, /movies, /series, /anime
    app.get('*', async (req: Request, res: Response) => {
      setHtmlResponseHeaders(req, res);
      try {
        const rawHtml = cachedProdHtmlTemplate || fs.readFileSync(targetIndex, 'utf-8');
        if (!cachedProdHtmlTemplate && rawHtml) {
          cachedProdHtmlTemplate = rawHtml;
        }
        const seoHtml = await injectDynamicSeoIntoHtml(rawHtml, req.originalUrl || req.path);
        return res.status(200).type('text/html; charset=utf-8').send(seoHtml);
      } catch {
        return res.sendFile(targetIndex, { etag: false, lastModified: false });
      }
    });

    console.log(`📦 Serving production build from ${distPath} (version: ${DEPLOYMENT_VERSION})`);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Notflix Full-Stack Server running on http://0.0.0.0:${PORT}`);
  });

  // Pull live Analytics & Blocked IPs from peer container in the background without delaying port 3000 binding
  pullStateFromLivePeerOnStartup().catch(() => {});

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
