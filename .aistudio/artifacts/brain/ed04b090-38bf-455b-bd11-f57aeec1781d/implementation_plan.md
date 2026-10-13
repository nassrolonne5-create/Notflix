# SafeFilter Recalibration: Animation, Anime & Mainstream Romance Support

Enable family-friendly animation, anime, and mainstream titles featuring romantic subplots (such as *Hotel Transylvania*, *Your Name*, and Disney/Pixar classics) to stream and appear without false-positive blocks, while strictly maintaining protection against explicit pornography and adult content.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following parameters were confirmed during interactive clarification:
> - **Animation & Anime Rule**: Allow animation (Genre 16) and anime featuring romance or romantic subplots by default, blocking only titles with explicit adult ratings (e.g., NC-17, TV-MA/R with explicit sexual classifications).
> - **Romance Scope Across Catalog**: Decouple general romance/dating terms from the adult blocklist. Block genuine adult/pornographic classifications (NSFW, explicit sex, erotic, softcore, hardcore, fetish, incest, etc.) while allowing innocent romance and love stories across movies, series, and anime.
> - **Settings Model**: Retain automatic, transparent SafeFilter operation with the smarter classification rules without requiring manual configuration toggles.

- **Confirmed Decision 1**: Animation (TMDB genre `16`) and anime titles are recognized as safe media and will not be blocked merely for having romance keywords or genre `10749`.
- **Confirmed Decision 2**: General vocabulary words (`romance`, `romantic`, `love story`, `dating`, `rom-com`, `passion`) are removed from the explicit adult blocklist; genuine adult/pornographic markers remain strictly blocked.
- **Confirmed Decision 3**: Deep safety checks (`checkDeepSafety`) examine age certifications (`NC-17`, `XXX`, explicit adult flags) rather than blocking on the generic `#9840 romance` keyword tag.

---

## 1. Overview & Core Concept

- **What It Does**: Upgrades the SafeFilter engine in both the client (`src/services/api.ts`) and the backend (`server.ts`) to differentiate between innocent romantic themes in family/mainstream titles and genuine explicit adult content. Titles like *Hotel Transylvania*, *Spirited Away*, *Your Name*, and *Wall-E* will now stream seamlessly, display in search, and appear in recommendations.
- **Target Audience / Persona**: Viewers, anime enthusiasts, and families watching mainstream animated movies, TV series, and anime who expect SafeFilter to protect against pornography and nudity without blocking celebrated PG/PG-13 animated films.
- **Key Value**: Eliminates frustrating false-positive player blocks and toast notices ("This content is blocked by SafeFilter.") on beloved animated movies, creating a friction-free viewing experience.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Direct Search & Browse**: User searches for "Hotel Transylvania" or browse the Anime/Movies sections. All franchise entries render clearly on MediaCards without suppression.
  2. **Instant Playback Initiation**: Clicking on *Hotel Transylvania* opens `VideoPlayerModal`. The `checkDeepSafety` check verifies its PG rating and Animation genre, allows immediate stream resolution, and boots the player without triggering the blocked toast.
  3. **Explicit Content Defense**: Searching for explicit 18+ adult, hentai, or pornographic content continues to be filtered out cleanly with the SafeFilter notice card.
- **Visual Identity & Theme**:
  - Consistent with Notflix's cinematic dark canvas (`bg-[#0a0a0c]`, neutral slate structural surfaces, and vivid red accents).
  - Unboxed metadata styling with typographic separators (`PG · 2012 · Animation · 1h 31m`).
- **Interactive Feedback & Motion**:
  - Smooth player entry transitions without abrupt closures or unwarranted warning toasts.
  - SafeFilter badge in Header remains clean and informative.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Hierarchical Genre & Certification Evaluation**:
  - *Chosen Approach*: If an item has genre `16` (Animation) or `10751` (Family) and has a standard family/teen rating (G, PG, PG-13, TV-G, TV-PG, TV-14), it is marked safe unless it has explicit `adult: true` or `NC-17/XXX` certification.
  - *Why*: Eliminates false-positives for entire animation libraries without weakening protection against real NSFW content.
  - *Alternatives Considered*: Hardcoded whitelist for specific titles (brittle and fails for other anime/animation).
- **Decision 2: Precision Adult Blocklist Cleanse**:
  - *Chosen Approach*: Remove broad non-pornographic words (`romance`, `romantic`, `love story`, `rom-com`, `dating`, `passion`) from `ADULT_BLOCKLIST` and `ADULT_KEYWORDS`. Keep hardcore pornography, erotica, nudity, sexual fetish, and explicit adult markers.
  - *Why*: The original keyword list was overly aggressive, causing mainstream action films and family comedies that mention "a passionate detective" or "a dating mishap" to be banned.

---

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────┐
│                   Notflix SafeFilter                   │
└────────────────────────────────────────────────────────┘
                            │
              Incoming Title (TMDB / Search)
                            │
               Is explicit adult: true? ───────────► BLOCKED
                            │ No
             Is Genre 16 (Animation) or 10751 (Family)?
             ┌──────────────┴──────────────┐
             │ YES                         │ NO
             ▼                             ▼
   Is Certification NC-17/XXX?    Contains genuine pornographic /
   ┌─────────┴─────────┐          erotic terms in title/desc/kw?
   │ YES               │ NO       ┌─────────┴─────────┐
   ▼                   ▼          │ YES               │ NO
BLOCKED             ALLOWED       ▼                   ▼
                               BLOCKED             ALLOWED
```

### Key Logic Updates:
1. **`src/services/api.ts`**:
   - Refine `ADULT_BLOCKLIST` to focus strictly on pornography, erotic content, nudity, and sexual acts, removing benign words like `romance`, `romantic`, `dating`, `love story`, `passion`.
   - Update `isSafe()`: If `item.genre_ids?.includes(16)` or `genres?.some(g => g.id === 16)` (Animation), bypass the generic genre `10749` restriction.
   - Update `checkDeepSafety()`: Permit animation titles unless flagged with explicit adult certifications (`NC-17`, `XXX`).
2. **`server.ts`**:
   - Synchronize `isSafe()` and `ADULT_BLOCKLIST` in `server.ts` to mirror the refined client rules, ensuring TMDB proxy and stream resolution endpoints do not reject valid titles.
   - Adjust TMDB discover default query params: remove global `without_genres=10749` on animation/anime discover paths.
3. **`src/pages/SearchPage.tsx`**:
   - Update `isSafetyFilteredQuery` to avoid flagging queries containing "hotel", "transylvania", or mainstream animated titles.
