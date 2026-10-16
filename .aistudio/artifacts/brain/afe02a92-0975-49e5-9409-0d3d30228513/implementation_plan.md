# Monetization Ad Script Integration Plan

Safe re-integration of custom advertising and monetization scripts (popunder, banners, or direct scripts) into Notflix, enabling monetization in production while isolating the development preview environment from iframe sandbox restrictions.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> You selected **"I will paste the exact script tag"**. Please paste your script snippet or ad network tag in the chat. We will embed it with our sandbox-aware loader so it monetizes 100% of your real visitors without breaking the dev preview.

- **Confirmed Decision**: You will provide the exact script code / ad tag snippet.
- **Preview Isolation Strategy**: The script will be loaded via a smart execution wrapper that activates on standalone domains and production (`window.self === window.top`) to prevent browser iframe sandbox security blocks.

---

### 1. Overview & Core Concept

- **What It Does**: Re-instates your website monetization scripts (popunder, banners, or ad networks) directly into the web application.
- **Target Audience**: Real end-users visiting your website on production, mobile, or desktop browsers.
- **Key Value**: Restores advertising revenue generation while keeping player performance, server scraping, and the local preview environment rock-solid and error-free.

---

### 2. User Experience & Ad Integration Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                        User Loads Notflix Web App                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
       [Standalone / Production]              [Dev Preview IFrame]
      (window.self === window.top)        (window.self !== window.top)
                  │                                   │
                  ▼                                   ▼
        Inject Monetization Tag            Bypass Popup Injection
         (Popunder / Ad Script)            (Zero Sandbox Violations)
                  │                                   │
                  ▼                                   ▼
       High Revenue Conversion              Clean Testing Experience
```

- **Seamless Player Experience**: The ad integration will be decoupled from the core HLS video player to ensure clicks inside the player controls (play/pause, server switching, subtitle selection) function reliably.
- **Zero Console Violations**: By preventing ad popups from attempting unauthorized parent frame navigation within sandboxed iframes, the browser console remains clean and unblocked.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Standalone Environment Detection**
  - *Chosen Approach*: Wrap the ad tag execution in an environment detection guard (`window.self === window.top || !isDevIframe`).
  - *Why*: Allows the ad network to execute naturally for 100% of real visitors in production while preventing `Blocked script execution because the document's frame is sandboxed` errors during development.
  - *Alternatives Considered*: Direct raw `<script>` injection into `index.html`. Rejected because browser sandboxes kill scripts that try to break out of iframes without `allow-popups`.

- **Decision 2: Asynchronous Non-Blocking Injection**
  - *Chosen Approach*: Load the ad script asynchronously (`async` / dynamic script append) after the initial DOM and CSS stylesheets have loaded.
  - *Why*: Prevents third-party ad network latencies from delaying initial page paint, TMDB movie poster rendering, or video stream scraping.

---

### 4. Technical Architecture & Integration Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                              index.html                                │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                Smart Monetization Script Loader                  │  │
│  │  - Checks environment context (Production vs Preview Sandbox)    │  │
│  │  - Dynamically injects user's custom ad tag                      │  │
│  │  - Sets async execution to guarantee fast stream resolution      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     Notflix Core Application                     │  │
│  │  - React 19 Frontend (Vite)                                      │  │
│  │  - Express Scraper Gateway (CinePro :3001 + TMDB Embed :3005)    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

- **Integration Point**: `index.html` (or dedicated client loader in `src/utils/monetization.ts`).
- **Input Needed**: Your exact script tag snippet (e.g. `<script ...>...</script>`).
