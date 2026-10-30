# Cloudflare Turnstile Security Gate & Admin Controls

Implement a privacy-preserving Cloudflare Turnstile verification gate on initial visit per browser session to protect Notflix from automated scrapers, bots, and stream harvesters, backed by server-side `siteverify` validation and live runtime management in both environment variables and the Admin Dashboard.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following product and architectural choices reflect your confirmed preferences:

- **Confirmed Decision 1 — Enforcement Scope**: **Full-site entry gate on first visit** (`TurnstileGate`). Visitors see a sleek, fast Cloudflare Turnstile security check before entering Notflix, while `/admin` and legitimate search/social crawlers (`Googlebot`, `Bingbot`, `TelegramBot`, etc.) bypass the gate so SEO and admin access are never interrupted.
- **Confirmed Decision 2 — Verification Duration**: **Every new browser session (until tab/browser closes)**. Passing Turnstile issues a cryptographically signed session token stored in `sessionStorage` + a session-only HTTP cookie (no `Max-Age`/`Expires`), keeping the user verified across all navigation and refreshes until the browser session ends.
- **Confirmed Decision 3 — Configuration Management**: **Both environment variables and Admin Dashboard controls**. Default credentials can be set via `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and `TURNSTILE_ENABLED` in `.env`, and overridden or toggled live at any time from the Admin Dashboard with persistent storage across restarts.

> [!NOTE]
> **Zero-Lockout Fallback & Test Keys**: If Turnstile is enabled before custom keys are entered, the system automatically defaults to Cloudflare's official Turnstile dummy test keys (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`) or allows instant toggle-off from `/admin` so you are never locked out of your own site.

---

## 1. Overview & Core Concept

- **What It Does**: Presents a streamlined, cinema-grade Cloudflare Turnstile verification screen when a user opens Notflix in a new browser session. Once the Cloudflare widget completes its challenge and the backend validates the token against `https://challenges.cloudflare.com/turnstile/v0/siteverify`, the server issues an HMAC-signed session token and immediately unlocks the full application.
- **Target Audience / Persona**:
  - **Viewers**: Experience a frictionless, 1-second automatic verification check once per browser session without intrusive CAPTCHA puzzles.
  - **Site Administrators**: Manage Turnstile status, Site Key, Secret Key, widget theme/mode, and real-time verification metrics directly inside the Admin Command Center.
- **Key Value**: Blocks headless browsers, automated stream scrapers, and DDoS bots before they can load catalog data or media streams, while preserving 100% SEO indexing and admin accessibility.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **First Visit in a Browser Session**:
     - The visitor lands on Notflix. The app checks `/api/security/turnstile/status` (alongside any existing session token in `sessionStorage`).
     - If Turnstile protection is enabled and the current browser session is not yet verified, the **Full-Site Turnstile Entry Gate** renders over a deep obsidian cinema backdrop (`#080c14`).
     - The official Cloudflare Turnstile script (`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`) renders the interactive/managed Turnstile widget.
     - Upon challenge completion, the client posts the Turnstile response token to `/api/security/turnstile/verify`.
     - Once verified, the gate smoothly fades out (`180ms` transition) and mounts the full Notflix experience (including deep-linked movies, series, or Live TV Arena routes).
  2. **Subsequent Navigation Within the Same Tab/Session**:
     - Refreshing the page or navigating between Movies, Series, Anime, and Live Arena reads the active session token from `sessionStorage` + session cookie and bypasses the gate with zero delay.
     - Closing the tab/browser clears `sessionStorage` and the session cookie, requiring a fresh Turnstile check on the next session.
  3. **Admin Dashboard Management (`/admin`)**:
     - The `/admin` route is always exempt from the public entry gate so administrators can log in and update or disable Turnstile keys at any time.
     - Inside the Admin Dashboard, a dedicated **Cloudflare Turnstile Protection** panel lets the admin toggle Turnstile On/Off, switch between **Custom Production Keys** and **Cloudflare Test Mode**, update the Site Key and Secret Key, and view live session verification counters (Total Verified Sessions, Failed/Bot Challenges, Active Configuration Source).

- **Visual Identity & Theme**:
  - **Aesthetic Direction**: Atmospheric Cinema Security Vault — authoritative, minimal, and fast, matching Notflix's dark obsidian palette without visual clutter.
  - **Color Palette & Mood**:
    - Canvas Background: Deep Obsidian (`#080c14`) with subtle radial ambient light (`rgba(225, 29, 72, 0.08)` and `rgba(29, 99, 255, 0.06)`).
    - Surface Container: Slate Obsidian (`#0e1424`) with a crisp `1px` border (`rgba(255, 255, 255, 0.08)`).
    - Primary Accent: Notflix Crimson (`#e11d48`) and Security Emerald (`#10b981`) upon verification success.
  - **Typography & Hierarchy**:
    - Brand Display: Bold condensed uppercase wordmark (`NOTFLIX.`) with clear hierarchy.
    - Body Copy: Crisp readable sans (`14px`–`15px`, `#cbd5e1`) explaining that the connection is being verified.
    - Telemetry / Metrics in Admin: Monospace tabular numerals (`font-mono tabular-nums`) for verification counts and timestamps.
  - **Interactive Feedback & Motion**:
    - Skeleton placeholder while the Cloudflare script initializes.
    - Instant auto-continue as soon as the Turnstile callback fires, plus a manual **Retry Verification** button if network connectivity drops or the token expires.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Explicit Widget Rendering (`render=explicit`) with Server-Side `siteverify`**
  - *Chosen Approach*: Load Cloudflare's Turnstile script dynamically with `render=explicit`, mount via `window.turnstile.render()`, and verify the resulting token on the Express backend via `https://challenges.cloudflare.com/turnstile/v0/siteverify` before issuing an HMAC-SHA256 session token.
  - *Why*: Client-only widget checks can be bypassed by spoofing state. Server-side verification with Cloudflare's API and an HMAC-signed token ensures bots cannot forge verification.
  - *Alternatives Considered*: Implicit HTML tag rendering (`class="cf-turnstile"`), which is harder to control in a React SPA lifecycle and lacks clean retry/cleanup handling.

- **Decision 2: Session-Scoped Persistence (`sessionStorage` + Session Cookie)**
  - *Chosen Approach*: Store the signed verification token in both `sessionStorage` (`notflix_turnstile_session_token`) and a session-scoped HTTP cookie (without `Max-Age` or `Expires`).
  - *Why*: Directly fulfills the "Every new browser session (until tab closes)" requirement while ensuring both React client routing and backend API/SSR checks recognize the verified session.

- **Decision 3: Dual Configuration Layer (`.env` Defaults + Persistent Admin Store)**
  - *Chosen Approach*: Read initial defaults from `TURNSTILE_ENABLED`, `TURNSTILE_SITE_KEY`, and `TURNSTILE_SECRET_KEY` in environment variables, overlaid by a persistent `turnstile-config.json` file (plus `/var/tmp` backup mirror and Browser Vault sync) editable in `/admin`.
  - *Why*: Allows zero-downtime key rotation or instant emergency disablement from the Admin UI without redeploying the container, while still supporting standard `.env` configuration.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CLIENT BROWSER (React SPA)                           │
│                                                                             │
│  ┌──────────────────────────┐        ┌───────────────────────────────────┐  │
│  │   App.tsx Entry Router   │        │     AdminPage.tsx (/admin)        │  │
│  │  (Bypasses /admin route) │        │  ┌─────────────────────────────┐  │  │
│  └────────────┬─────────────┘        │  │ Turnstile Security Controls │  │  │
│               │                      │  │ • Enable / Disable Toggle   │  │  │
│               ▼                      │  │ • Site Key & Secret Key     │  │  │
│  ┌──────────────────────────┐        │  │ • Live Verification Stats   │  │  │
│  │   TurnstileGate.tsx      │        │  └──────────────┬──────────────┘  │  │
│  │ • Checks sessionStorage  │        └─────────────────┼─────────────────┘  │
│  │ • Mounts CF Turnstile JS │                          │                    │
│  │ • Submits token to API   │                          │                    │
│  └────────────┬─────────────┘                          │                    │
└───────────────┼────────────────────────────────────────┼────────────────────┘
                │                                        │
                ▼ POST /api/security/turnstile/verify    ▼ GET/POST /api/admin/turnstile
┌─────────────────────────────────────────────────────────────────────────────┐
│                        EXPRESS SERVER (server.ts)                           │
│                                                                             │
│  ┌────────────────────────────────────┐   ┌──────────────────────────────┐  │
│  │   Turnstile Verification Engine    │   │  Turnstile Config Manager    │  │
│  │ • Calls Cloudflare siteverify API  │   │ • Reads .env defaults        │  │
│  │ • Signs HMAC-SHA256 Session Token  │   │ • Persists data/turnstile    │  │
│  │ • Sets Session Cookie + JSON Token │   │ • Syncs with Admin Vault     │  │
│  └─────────────────┬──────────────────┘   └──────────────────────────────┘  │
└────────────────────┼────────────────────────────────────────────────────────┘
                     │
                     ▼ POST https://challenges.cloudflare.com/turnstile/v0/siteverify
        ┌──────────────────────────┐
        │   Cloudflare Turnstile   │
        │     Verification API     │
        └──────────────────────────┘
```

### Data Model & State

- **Server Turnstile Configuration (`TurnstileConfigStore`)**:
  - `enabled`: `boolean` (whether the full-site entry gate is active)
  - `mode`: `'custom' | 'test'` (uses custom Cloudflare keys or Cloudflare's official test keys)
  - `siteKey`: `string` (public Cloudflare Turnstile Site Key)
  - `secretKey`: `string` (private Cloudflare Turnstile Secret Key — never exposed to public endpoints; masked in Admin UI unless edited)
  - `theme`: `'dark' | 'auto'`
  - `updatedAt`: `number`
- **Turnstile Telemetry Counters**:
  - `verifiedCount`: Total passed challenges
  - `failedCount`: Total rejected/expired challenges
- **Session Verification Token**:
  - Format: `<timestamp>.<clientIpHash>.<hmacSignature>` signed with `STREAM_SECURITY_SECRET`.
  - Stored in `sessionStorage` (`notflix_turnstile_verified_token`) and session cookie (`notflix_cf_verified`).

### Interactive Component & State Mapping

1. **Public Status Check (`GET /api/security/turnstile/status`)**:
   - Returns `{ enabled, siteKey, theme, verified }` (never exposes `secretKey`).
   - Validates any incoming `x-turnstile-token` header or `notflix_cf_verified` session cookie so returning page refreshes within the same tab resolve in a single round-trip.
2. **Challenge Verification (`POST /api/security/turnstile/verify`)**:
   - Accepts `{ token }` from the client Turnstile widget.
   - Sends `secret`, `response`, and `remoteip` to `https://challenges.cloudflare.com/turnstile/v0/siteverify`.
   - On success, increments `verifiedCount`, sets the session-only cookie, and returns `{ success: true, sessionToken }`.
   - On failure, increments `failedCount` and returns a clear error message prompting widget reset (`window.turnstile.reset()`).
3. **Admin Configuration (`GET /api/admin/turnstile` & `POST /api/admin/turnstile`)**:
   - Protected by `requireAdminAuth`.
   - Allows toggling `enabled`, selecting `'custom'` vs `'test'` keys, saving `siteKey` and `secretKey`, and resetting or testing the configuration live.
   - Synchronized across both `/server.ts` and `/Notflix-main/server.ts` as well as `/src` and `/Notflix-main/src`.
