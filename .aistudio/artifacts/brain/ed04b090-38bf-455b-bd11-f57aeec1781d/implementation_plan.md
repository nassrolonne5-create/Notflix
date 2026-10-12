# Notflix Anti-Bot & Anti-Scraping Defense Suite

Multi-layered automated defense architecture designed to prevent stream leeching, automated API scraping, and headless scraper abuse while guaranteeing instantaneous playback for human viewers and protecting search engine indexing.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural parameters have been established based on your selections:

- **Confirmed Decision 1 (Viewer Protection)**: Seamless background rate limiting and passive bot fingerprinting. No intrusive CAPTCHAs or Cloudflare challenge pages that degrade user experience for human viewers.
- **Confirmed Decision 2 (Crawler Policy)**: Whitelist legitimate search engine crawlers (Googlebot, Bingbot, DuckDuckGo) to maintain search index visibility and protect the Google Search logo integration.
- **Confirmed Decision 3 (Stream Security)**: Ephemeral HMAC-signed stream tokens with origin verification on `/api/streams` to block direct scraper hotlinking and automated batch extractors.

---

## 1. Overview & Core Concept

### What It Does
Protects Notflix's streaming infrastructure and scraper proxies from aggressive external scrapers, automated headless scripts (Puppeteer, Playwright, Scrapy, Python Requests), and hotlinking leechers. All protections run invisibly in the background:
- Legitimate users browse and play media with zero interruptions.
- Search engine spiders (Googlebot) crawl metadata and sitemaps freely.
- Malicious scrapers attempting bulk catalog harvesting or direct stream extraction are identified, throttled, and blocked.

### Key Value
- **Infrastructure Protection**: Eliminates bandwidth spikes and upstream scraper IP bans caused by third-party scraper bots.
- **Stream Exclusivity**: Ensures stream URLs can only be resolved from active viewer sessions inside Notflix.
- **SEO Preservation**: Maintains full compliance with Google Search Central guidelines.

---

## 2. Technical Architecture & Defense Layers

```
                      INCOMING HTTP REQUEST
                                │
                                ▼
        ┌────────────────────────────────────────────────┐
        │  Layer 1: Search Engine Whitelist & Robots Check│
        │  (Googlebot, Bingbot, Yandex -> Pass SEO files) │
        └───────────────────────┬────────────────────────┘
                                │ (Non-whitelisted)
                                ▼
        ┌────────────────────────────────────────────────┐
        │  Layer 2: Bot Fingerprint & Scraper Signature  │
        │  (User-Agent blacklists, headless headers,     │
        │   honeypot traps, missing browser signals)     │
        └───────────────────────┬────────────────────────┘
                                │ (Passed)
                                ▼
        ┌────────────────────────────────────────────────┐
        │  Layer 3: IP Sliding-Window Rate Limiter       │
        │  (General API: 120 req/min | Streams: 25/5min) │
        └───────────────────────┬────────────────────────┘
                                │ (Passed)
                                ▼
        ┌────────────────────────────────────────────────┐
        │  Layer 4: HMAC Signed Token & Origin Check     │
        │  (/api/streams requires valid signature +      │
        │   timestamp window < 60s + valid Referer)      │
        └───────────────────────┬────────────────────────┘
                                │
                                ▼
                    FORWARD TO APPLICATION LOGIC
```

### Layer Details

#### Layer 1: Search Engine Crawler Whitelisting
- **Legitimate Spiders**: Whitelists verified bots matching official Googlebot, Bingbot, DuckDuckBot, and Yandex user agents for public routes (`/`, `/movies`, `/series`, `/search`, `/sitemap.xml`, `/robots.txt`, and favicon assets).
- **SEO Route Integrity**: Never applies rate limit blocks to search spiders indexing the site.

#### Layer 2: Passive Bot Fingerprinting & Scraper Traps
- **Known Scraper Signatures**: Instantly rejects automated user agents (`python-requests`, `aiohttp`, `scrapy`, `curl`, `wget`, `httpclient`, `headlesschrome`, `phantomjs`, `go-http-client`).
- **Browser Header Consistency**: Validates presence of standard browser headers (`Accept-Language`, `Sec-Ch-Ua`, `Sec-Fetch-Site`) on interactive endpoints.
- **DOM Honeypot Trap**: Invisible links embedded in the HTML with `rel="nofollow"` pointing to `/api/trap/probe`. Legitimate humans never see or click them; automated crawlers following DOM links fall into the trap and get their IP blacklisted for 24 hours.

#### Layer 3: Sliding-Window Rate Limiting
- **Memory-Efficient Sliding Window**: Tracks request timestamps per client IP.
- **Granular Thresholds**:
  - `Global API`: 120 requests per minute per IP.
  - `Stream Extraction (/api/streams)`: 25 requests per 5 minutes per IP (plenty for human browsing; stops bulk download bots).
  - `Search API`: 45 queries per minute per IP.
- **Standard HTTP 429 Responses**: Returns structured JSON with `Retry-After` headers and clean error payloads.

#### Layer 4: Ephemeral HMAC-Signed Stream Tokens
- **Mechanism**:
  - Before requesting `/api/streams`, the frontend client obtains or derives a short-lived token generated with a timestamp and HMAC signature.
  - The server verifies:
    1. Signature validity against internal secret.
    2. Token age $\le 60\text{ seconds}$.
    3. Request `Referer` and `Origin` headers match the active host.
  - Third-party scrapers attempting to call `/api/streams` without executing the frontend client or with an expired token receive `403 Forbidden: Invalid Stream Signature`.

#### Layer 5: Admin Studio Security Telemetry
- **Admin Dashboard Integration**: Adds a dedicated Security & Anti-Bot panel to `AdminPage.tsx`:
  - Total blocked scraper requests.
  - Top throttled IP addresses and detected bot user-agents.
  - Honeypot trigger log.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Passive In-Memory Defense vs. Cloudflare / 3rd-Party WAF**
  - *Chosen Approach*: Native Node.js / Express security middleware built directly into the server stack.
  - *Why*: Self-contained, works seamlessly in container deployments (Docker/Coolify) with zero third-party subscription dependencies and zero cost.
- **Decision 2: Seamless Protection vs. Interactive CAPTCHA**
  - *Chosen Approach*: Transparent sliding window + token signature.
  - *Why*: Preserves frictionless 1-click video playback for viewers without annoying visual puzzles or Turnstile checkboxes.
- **Decision 3: Stream Protection Token Lifecycle**
  - *Chosen Approach*: 60-second validity window tied to specific media items.
  - *Why*: Prevents replay attacks and link hoarding while allowing normal buffering and server switches within the player.

---

## 4. Verification & Testing Plan

1. **Bot Signature Verification**: Test curl, python, and headless user-agents against protected endpoints and verify `403 Forbidden` / `429 Too Many Requests`.
2. **Human Viewer Playback**: Verify that standard movie playback, series browsing, episode navigation, and search queries function with zero delay.
3. **SEO Crawler Access**: Verify that `/`, `/sitemap.xml`, and `/robots.txt` remain open and responsive when queried with Googlebot user-agents.
4. **Admin Dashboard Security View**: Verify that blocked bot attempts register in the Admin Studio security telemetry cards.
