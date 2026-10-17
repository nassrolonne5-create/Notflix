# Admin Backend Scraper API & Server Configuration Manager

Empower the authenticated administrator to inspect, replace, and edit the host IP, port, or full URL of the backend scraper API servers directly from the Admin Dashboard (`/admin`), complete with live connection testing and persistent multi-layer storage that survives deployments.

### User Review & Critical Decisions

> [!IMPORTANT]
> The following product and architectural choices have been confirmed from your preferences and will govern the implementation:

- **Confirmed Decision 1 — Focused Server Scope**: Manage and edit the existing backend scraper engines (**CinePro Primary Scraper**, **TMDB Embed Scraper**, and **Coolify Gateway Fallback**) directly without adding complex multi-node list clutter.
- **Confirmed Decision 2 — Dual Input Mode & Live Diagnostics**: Provide both **structured Host/IP + Port fields** and a **Full URL editing mode** for each server, paired with a **Live Connection Test & Ping** button that verifies upstream reachability, HTTP status, and response latency (`ms`) in real time.
- **Confirmed Decision 3 — Resilient Multi-Layer Persistence**: Save updated scraper configurations on **server disk** (primary data volume + `/var/tmp` mirror) and automatically synchronize a backup copy in the **Admin Browser Vault** (`localStorage`), auto-restoring your custom scraper URLs/ports if a container redeploy ever starts with a fresh disk.

---

### 1. Overview & Core Concept

- **What It Does**: Adds an authenticated **Scraper API & Backend Servers** management panel inside the Admin Dashboard (`/admin`). Changes applied in this panel take effect immediately in the backend stream resolver and proxy relay without restarting the server or editing code.
- **Target Audience / Persona**: Platform administrator managing upstream scraper server migrations, IP rotations, or port changes from any desktop or mobile browser.
- **Key Value**: Eliminates the need to redeploy code or edit environment variables when a scraper server changes its IP address, domain, or port.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Authenticate & Inspect**: Log into `/admin`. The **Backend Scraper API Servers** panel loads the currently active scraper endpoints, displaying each server's active URL, parsed Host/IP, Port, and live reachability status.
  2. **Switch Between Host/Port & Full URL Editing**:
     - In **Host + Port Mode**, edit the protocol (`http://` or `https://`), Host/IP (e.g., `62.171.179.144`), and Port (e.g., `3001` or `3005`) in separate clean inputs; the full URL updates automatically.
     - In **Full URL Mode**, paste or edit a complete endpoint URL (including custom subdomains or paths like `http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io`), and the Host/Port fields synchronize automatically.
  3. **Test Connection & Ping**: Click **Test Server** on any scraper card (or **Ping All**) to run a server-side probe from the backend container to the scraper API, displaying live latency in milliseconds (`tabular-nums`) and HTTP health status.
  4. **Save & Apply Instantly**: Click **Save Scraper Config** to apply the new endpoints immediately to all live stream resolutions and `/v1/proxy` relays, flush the stream cache so new requests use the updated servers right away, and back up the config to both server disk and the Admin Browser Vault.
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: High-density developer and operations console seamlessly integrated into the existing dark slate Admin Studio dashboard.
  - *Color Palette & Mood*: Deep slate canvas (`#080c16` / `#0e1424`) with subtle `1px solid rgba(255,255,255,0.08)` hairline borders, crisp white primary typography, muted slate secondary labels, electric blue (`#3B82F6`) primary actions, emerald (`#10B981`) verified connection states, amber (`#F59E0B`) high-latency warnings, and crimson (`#EF4444`) unreachable states.
  - *Typography & Hierarchy*: Clean sans-serif structural headings paired with strict monospace tabular numerals (`font-mono tabular-nums`) for IP addresses, port numbers, URLs, and ping latencies.
  - *Component Styling & Layout*: Single-elevation server configuration cards arranged in a responsive 3-column desktop grid (`1440px` container baseline), avoiding nested card clutter or decorative badges.
- **Interactive Feedback & Motion**:
  - Instant input synchronization between Host/IP + Port fields and the Full URL field.
  - Live spinner and latency readout (`e.g., 142 ms · HTTP 200 OK`) during server ping tests.
  - Confirmation feedback banner when configuration changes are applied and stream caches are cleared.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Dynamic Runtime Scraper Resolution vs. Static Constants**
  - *Chosen Approach*: Replace static boot-time scraper URL constants in the backend with a dynamic runtime configuration store (`getScraperConfig()`) read on every stream resolution and `/v1/proxy` relay request.
  - *Why*: Allows port or IP changes made in the Admin Dashboard to take effect in `0ms` for all users without restarting the Node.js process or dropping active connections.
  - *Alternatives Considered*: Writing to `.env` and restarting the process was rejected because container restarts interrupt active streams and reset in-memory state.
- **Decision 2: Server-Side Ping Probe vs. Browser Fetch**
  - *Chosen Approach*: Execute connection tests from the backend (`POST /api/admin/scrapers/test`) rather than directly from the admin's browser.
  - *Why*: Upstream scraper servers often run on raw HTTP ports (`3001`, `3005`) without CORS headers, which would be blocked by browser Mixed-Content or CORS rules if tested client-side. Testing from the backend measures the exact connection path used in production.
- **Decision 3: Dual Persistence (Server Disk + Admin Browser Vault)**
  - *Chosen Approach*: Persist scraper settings to `scrapers-config.json` on the server volume (plus `/var/tmp` mirror) AND store an encrypted/signed or timestamped copy in the admin browser's `localStorage` vault (`notflix_admin_scraper_vault_v1`).
  - *Why*: Mirrors the battle-tested analytics vault architecture so even if a Coolify deployment recreates the container from scratch, opening the Admin Dashboard automatically restores your custom scraper servers.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

#### Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        ADMIN DASHBOARD (/admin UI)                           │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                 Scraper Server Configuration Panel                     │  │
│  │  ┌──────────────────────┐ ┌──────────────────────┐ ┌────────────────┐  │  │
│  │  │ CinePro Scraper Card │ │ TMDB Embed Card      │ │ Gateway Mirror │  │  │
│  │  │ • Mode: [IP:Port|URL]│ │ • Mode: [IP:Port|URL]│ │ • Mode: [URL]  │  │  │
│  │  │ • Host Input + Port  │ │ • Host Input + Port  │ │ • Host + Port  │  │  │
│  │  │ • [Test Ping] [Reset]│ │ • [Test Ping] [Reset]│ │ • [Test Ping]  │  │  │
│  │  └──────────┬───────────┘ └──────────┬───────────┘ └────────┬───────┘  │  │
│  └─────────────┼────────────────────────┼──────────────────────┼──────────┘  │
│                │                        │                      │             │
│                ▼                        ▼                      ▼             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │         Admin Browser Vault (localStorage Auto-Backup & Sync)          │  │
│  └──────────────────────────────────────┬─────────────────────────────────┘  │
└─────────────────────────────────────────┼────────────────────────────────────┘
                                          │ Bearer Admin Token (HMAC)
                                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          EXPRESS BACKEND SERVER                              │
│                                                                              │
│  ┌─────────────────────────────┐      ┌───────────────────────────────────┐  │
│  │ Admin Scraper API Endpoints │      │ Runtime Scraper Config Store      │  │
│  │ • GET  /api/admin/scrapers  │◄────►│ • cineproUrl (Host, Port, URL)    │  │
│  │ • POST /api/admin/scrapers  │      │ • tmdbEmbedUrl (Host, Port, URL)  │  │
│  │ • POST /api/admin/scrapers/ │      │ • gatewayFallbackUrl              │  │
│  │        test                 │      │ • updatedAt (timestamp)           │  │
│  └─────────────────────────────┘      └─────────┬─────────────────────────┘  │
│                                                 │                            │
│        ┌────────────────────────────────────────┼───────────────────┐        │
│        ▼                                        ▼                   ▼        │
│  ┌───────────────────────────┐  ┌────────────────────────┐  ┌─────────────┐  │
│  │ Persistent Disk Storage   │  │ Stream Resolver Engine │  │ CinePro     │  │
│  │ • data/scrapers.json      │  │ • /api/streams/:t/:id  │  │ Proxy Relay │  │
│  │ • /var/tmp/ backup mirror │  │ • Auto cache flush     │  │ • /v1/proxy │  │
│  └───────────────────────────┘  └────────────────────────┘  └─────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Data Model & State

- **`ScraperEndpointConfig`**:
  - `id`: `'cinepro' | 'tmdb_embed' | 'gateway_fallback'`
  - `name`: Display name of the scraper engine (e.g., `"CinePro Primary Scraper"`, `"TMDB Embed Scraper"`, `"Coolify Gateway Fallback"`)
  - `protocol`: `'http' | 'https'`
  - `host`: Hostname or IPv4 address (e.g., `'62.171.179.144'`)
  - `port`: Port string (e.g., `'3001'`, `'3005'`, or `''` for standard port 80/443)
  - `url`: Normalized base URL (e.g., `'http://62.171.179.144:3001'`)
- **`ScraperConfigStore`**:
  - `scrapers`: Record containing `cinepro`, `tmdb_embed`, and `gateway_fallback` endpoint definitions
  - `updatedAt`: Epoch milliseconds timestamp used to reconcile updates between the server disk and the Admin Browser Vault

#### Interactive Component & State Mapping

1. **Dual-Mode Input Synchronization**:
   - Editing `protocol`, `host`, or `port` in **Host + Port Mode** immediately recomputes `url = ${protocol}://${host}${port ? ':' + port : ''}`.
   - Editing `url` in **Full URL Mode** parses the URL via `new URL()` (with graceful fallback while typing) to extract and update `protocol`, `host`, and `port` in real time.
2. **Live Connection & Ping Handler (`POST /api/admin/scrapers/test`)**:
   - Accepts `{ targetId, url }` with `requireAdminAuth`.
   - Performs a timed probe against the target scraper endpoint (e.g., `/v1/movies/550` or root health check) with a 6-second timeout.
   - Returns `{ reachable: boolean, status: number, latencyMs: number, streamCount?: number, message: string }` so the admin can verify both network reachability and whether the scraper is actively returning streams.
3. **Save & Vault Sync Flow (`POST /api/admin/scrapers`)**:
   - Validates and normalizes the submitted URLs, updates the in-memory runtime config, writes atomically to disk (`scrapers.json` + `/var/tmp/notflix_scrapers_backup.json`), and clears `apiCache` so subsequent user playback requests immediately use the new scraper servers.
   - Saves the updated config payload to `localStorage.setItem('notflix_admin_scraper_vault_v1', ...)` in the admin's browser.
   - On Admin Dashboard login/mount, if the browser vault has a newer `updatedAt` timestamp than a freshly deployed container still on default values, it automatically pushes the saved configuration back to the server.
