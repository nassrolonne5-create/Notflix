# Top-Left Flipping Brand Logo & Official Telegram Channel Integration

Adds a smooth 3D-flipping brand slot in the top-left header bar that alternates every 4 seconds between the **Notflix** logo and the official **Telegram** channel badge (`https://t.me/Notflix_tv`), along with a permanent Telegram community link in the site footer.

## User Review & Critical Decisions

> [!IMPORTANT]
> Confirmed preferences from our interactive design check:
> - **Confirmed Decision 1 (Click Behavior)**: Clicking the top-left slot while **Notflix** is displayed navigates to the **Home** view; clicking while **Telegram** is displayed opens `https://t.me/Notflix_tv` in a new tab.
> - **Confirmed Decision 2 (Visual Flip State)**: The brand slot flips smoothly every 4 seconds between the **Notflix.** wordmark (`#E50914` red icon) and the **Telegram** paper-plane emblem paired with **Join Telegram** (`#2AABEE` Telegram blue).

---

## 1. Overview & Core Concept

- **What It Does**: Transforms the static top-left brand logo into an alternating 3D flip card that cycles between the Notflix brand mark and the official Telegram channel CTA (`https://t.me/Notflix_tv`).
- **Target Audience / Persona**: Mobile and desktop viewers browsing movies, series, and anime who want instant access to the official Notflix Telegram community for announcements, new releases, and domain updates.
- **Key Value**: Drives high-visibility Telegram channel growth directly from the primary navigation bar without adding extra header rows or crowding the mobile search bar.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Notflix State (0s – 4s)**: Displays the signature red `N` emblem and `NOTFLIX.` display wordmark. Clicking returns the viewer to the Home feed.
  2. **3D Vertical Flip Transition**: Every 4 seconds, the container executes a smooth 3D Y/X-axis rotation (`transform` + `opacity` compositor transition settling within 200–350ms).
  3. **Telegram State (4s – 8s)**: Displays the official Telegram circle/paper-plane SVG emblem in `#2AABEE` sky blue alongside a single-line `JOIN TELEGRAM` display label (`whitespace-nowrap shrink-0`). Clicking opens `https://t.me/Notflix_tv` in a new tab (`target="_blank" rel="noopener noreferrer"`).
  4. **Hover Pause**: Hovering or touching the top-left slot pauses the flip timer so the user's intended click target never switches mid-tap.
  5. **Footer Community Link**: Adds a clean, unboxed `Telegram Channel` link (`https://t.me/Notflix_tv`) to the footer navigation bar so users can also reach Telegram at any time regardless of the flip cycle.
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Dark cinema obsidian (`#0b0f19`) with high-contrast brand accents.
  - *Color Palette & Mood*: Deep slate-obsidian header canvas (`#0b0f19/95`), cinema crimson (`#E50914`) for the Notflix face, and official Telegram azure (`#2AABEE`) for the Telegram face.
  - *Typography & Hierarchy*: Condensed `Bebas Neue` (`font-display`) uppercase tracking for both `NOTFLIX.` and `JOIN TELEGRAM` so both states share identical height, baseline alignment, and visual weight without layout shift.
  - *Touch Ergonomics*: Minimum `44px` interactive height (`min-h-[44px] flex items-center`) in the top-left slot to guarantee comfortable one-handed mobile tapping on 375px–430px screens while respecting the 15% mobile sticky cap.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Fixed-Width / Zero-Layout-Shift Flip Container**
  - *Chosen Approach*: Both faces (`Notflix.` and `Join Telegram`) occupy a single fixed-height, `whitespace-nowrap shrink-0` 3D perspective slot in Zone 1 of the header.
  - *Why*: Prevents the adjacent search bar from jumping horizontally every 4 seconds when the label flips.
  - *Alternatives Considered*: Expanding/collapsing width on flip, which causes distracting layout reflow next to the search input.
- **Decision 2: Hover/Touch Lock on Flip Timer**
  - *Chosen Approach*: Pause the 4-second interval while pointer hover or touch is active on the brand slot.
  - *Why*: Ensures a user moving their thumb or cursor to click "Join Telegram" never accidentally clicks right as it flips back to "Notflix".

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Top Navigation Header                        │
│                                                                      │
│  ┌────────────────────────────────────────┐   ┌───────────────────┐  │
│  │   Zone 1: 3D Flip Brand / Social Slot  │   │ Zone 2 & 3:       │  │
│  │   (4s Interval + Hover/Touch Pause)    │   │ Search & Settings │  │
│  └───────────────────┬────────────────────┘   └───────────────────┘  │
│                      │                                               │
│         ┌────────────┴────────────┐                                  │
│         ▼                         ▼                                  │
│  ┌──────────────────┐      ┌──────────────────────────┐              │
│  │ Face A: NOTFLIX. │      │ Face B: JOIN TELEGRAM    │              │
│  │ Action: Go Home  │      │ Link: t.me/Notflix_tv    │              │
│  └──────────────────┘      └──────────────────────────┘              │
└──────────────────────────────────────────────────────────────────────┘
```

- **Data Model & State**:
  - `showTelegram` (`boolean`): Toggles every `4000ms` via `setInterval` when not hovered.
  - `isHovered` (`boolean`): Pauses the flip cycle while the user's pointer or touch is over the brand container.
- **Interactive Component & State Mapping**:
  - When `showTelegram === false`: Renders a semantic `<button>` / `<a>` that triggers `setActiveTab('home')`.
  - When `showTelegram === true`: Renders a semantic `<a href="https://t.me/Notflix_tv" target="_blank" rel="noopener noreferrer">` that opens the official Notflix Telegram channel directly.
