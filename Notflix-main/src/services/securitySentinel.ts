// Client-Side Anti-Interception, Anti-Scraping & Anti-Page-Inspection Sentinel
// Prevents Developer Mode (DevTools), DOM Inspection, Source Viewing, and Stream Data Capture
// Safe across all browser and iframe environments (never mutates read-only/getter-only window properties)

export interface PermanentBlockInfo {
  blocked: boolean;
  ip?: string;
  reason?: string;
  code?: string;
  bannedAt?: number;
  inspectionLocked?: boolean;
  inspectionReason?: string;
  strikeCount?: number;
}

type BlockListener = (info: PermanentBlockInfo) => void;

class SecuritySentinel {
  private initialized = false;
  private blockState: PermanentBlockInfo = {
    blocked: false,
    inspectionLocked: false,
    strikeCount: 0,
  };
  private listeners: Set<BlockListener> = new Set();
  private streamFetchTimestamps: number[] = [];
  private inspectionStrikes = 0;
  private lastStrikeTime = 0;

  public subscribe(listener: BlockListener): () => void {
    this.listeners.add(listener);
    if (this.blockState.blocked || this.blockState.inspectionLocked) {
      listener(this.blockState);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getBlockState(): PermanentBlockInfo {
    return this.blockState;
  }

  private notifyListeners() {
    this.listeners.forEach((cb) => cb({ ...this.blockState }));
  }

  public isAdminContext(): boolean {
    if (typeof window === 'undefined') return false;
    if ((window as any).__NOTFLIX_IS_ADMIN__) return true;
    const path = window.location.pathname.toLowerCase();
    const hash = window.location.hash.toLowerCase();
    if (path.startsWith('/admin') || hash.startsWith('#admin') || hash.startsWith('#/admin')) {
      return true;
    }
    try {
      if (localStorage.getItem('notflix_admin_token')) return true;
    } catch {}
    return false;
  }

  private purgeActiveMediaAndConsole() {
    if (typeof document === 'undefined') return;
    try {
      // Immediately scrub any active video/iframe sources so DevTools Network/Elements cannot capture stream URLs
      const videos = document.querySelectorAll('video');
      videos.forEach((v) => {
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch {}
      });
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((f) => {
        try {
          f.src = 'about:blank';
        } catch {}
      });
      if (typeof console !== 'undefined' && typeof console.clear === 'function') {
        console.clear();
      }
    } catch {}
  }

  public triggerInspectionLock(reason: string) {
    if (this.isAdminContext() || this.blockState.blocked) return;

    const now = Date.now();
    // Debounce rapid duplicate events within 800ms
    if (now - this.lastStrikeTime > 800) {
      this.inspectionStrikes += 1;
      this.lastStrikeTime = now;
    }

    this.purgeActiveMediaAndConsole();

    this.blockState = {
      ...this.blockState,
      inspectionLocked: true,
      inspectionReason: reason,
      strikeCount: this.inspectionStrikes,
    };
    this.notifyListeners();

    // If user repeatedly tries to force Developer Mode / Page Inspection (3+ strikes), permanently ban their IP
    if (this.inspectionStrikes >= 3) {
      this.reportInterceptionAttempt(
        `Persistent Developer Mode / Page Inspection Data Capture (${reason})`,
        'interception'
      );
    }
  }

  public dismissInspectionLock() {
    if (this.blockState.blocked) return;
    this.blockState = {
      ...this.blockState,
      inspectionLocked: false,
      inspectionReason: undefined,
    };
    this.notifyListeners();
  }

  public triggerBlock(info: PermanentBlockInfo) {
    if (this.isAdminContext()) return;
    this.purgeActiveMediaAndConsole();
    this.blockState = {
      ...this.blockState,
      ...info,
      blocked: true,
      inspectionLocked: true,
    };
    this.notifyListeners();
  }

  public recordStreamRequest() {
    if (this.isAdminContext() || this.blockState.blocked) return;
    const now = Date.now();
    this.streamFetchTimestamps = this.streamFetchTimestamps.filter((t) => now - t < 60000);
    this.streamFetchTimestamps.push(now);
    if (this.streamFetchTimestamps.length > 35) {
      this.reportInterceptionAttempt(
        'Automated Bulk Stream API Harvesting Script Detected',
        'scraper'
      );
    }
  }

  public async inspectResponse(response: Response, urlStr = '') {
    if (!response || response.status !== 403 || this.isAdminContext() || urlStr.includes('/api/admin')) {
      return;
    }
    try {
      const clone = response.clone();
      const data = await clone.json();
      if (
        data &&
        (data.code === 'IP_PERMANENTLY_BLOCKED' ||
          data.code === 'TRAP_TRIGGERED' ||
          data.code === 'SCRAPER_BLOCKED' ||
          data.code === 'BOT_DETECTED')
      ) {
        this.triggerBlock({
          blocked: true,
          ip: data.ip,
          reason: data.reason || data.error || 'Permanent IP Block Enforced',
          code: data.code,
          bannedAt: data.bannedAt || Date.now(),
        });
      }
    } catch {}
  }

  public async reportInterceptionAttempt(
    reason: string,
    category: 'scraper' | 'interception' = 'interception'
  ) {
    if (this.isAdminContext() || this.blockState.blocked) return;
    this.purgeActiveMediaAndConsole();
    try {
      const res = await fetch('/api/security/intercept-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason,
          category,
          path: typeof window !== 'undefined' ? window.location.pathname : '/',
          ts: Date.now(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      this.triggerBlock({
        blocked: true,
        ip: data?.ip || 'Detected Network IP',
        reason: data?.reason || reason,
        code: 'IP_PERMANENTLY_BLOCKED',
        bannedAt: data?.bannedAt || Date.now(),
      });
    } catch {
      this.triggerBlock({
        blocked: true,
        reason,
        code: 'IP_PERMANENTLY_BLOCKED',
        bannedAt: Date.now(),
      });
    }
  }

  private lockReactDevToolsHook() {
    if (typeof window === 'undefined') return;
    try {
      const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook && typeof hook === 'object') {
        hook.inject = function () {};
        hook.onCommitFiberRoot = function () {};
        hook.onCommitFiberUnmount = function () {};
        if (hook.renderers && typeof hook.renderers.clear === 'function') {
          hook.renderers.clear();
        }
      }
    } catch {}
  }

  public init() {
    if (this.initialized || typeof window === 'undefined') return;
    this.initialized = true;

    this.lockReactDevToolsHook();

    // 1. Block all Developer Mode / Inspect Element / View Source / Save Page keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (this.isAdminContext()) return;

      const key = (e.key || '').toUpperCase();
      const code = e.keyCode || e.which;
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

      // F12 Developer Tools
      const isF12 = key === 'F12' || code === 123;

      // Windows/Linux: Ctrl+Shift+I (Inspect), Ctrl+Shift+J (Console), Ctrl+Shift+C (Element Picker), Ctrl+Shift+K (Firefox Console), Ctrl+Shift+E (Network)
      const isCtrlShiftInspector =
        e.ctrlKey && shift && ['I', 'J', 'C', 'K', 'E'].includes(key);

      // macOS: Cmd+Option+I, Cmd+Option+J, Cmd+Option+C, Cmd+Option+K, Cmd+Option+U, Cmd+Option+E
      const isMacInspector =
        e.metaKey && alt && ['I', 'J', 'C', 'K', 'U', 'E'].includes(key);

      // View Page Source (Ctrl+U / Cmd+U) or Save Webpage (Ctrl+S / Cmd+S)
      const isSourceOrSave = ctrlOrMeta && !shift && (key === 'U' || key === 'S');

      if (isF12 || isCtrlShiftInspector || isMacInspector || isSourceOrSave) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const shortcutLabel = isF12
          ? 'F12 Developer Tools Shortcut Blocked'
          : isSourceOrSave
          ? `Page Source / DOM Export Shortcut (Ctrl+${key}) Blocked`
          : `Developer Inspector Shortcut (${key}) Blocked`;

        this.triggerInspectionLock(shortcutLabel);
        return false;
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });

    // 2. Disable Right-Click Context Menu (Inspect Element) outside Admin
    const handleContextMenu = (e: MouseEvent) => {
      if (this.isAdminContext()) return;
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    window.addEventListener('contextmenu', handleContextMenu, { capture: true });

    // 3. Prevent dragging media/images/links to extract URLs
    const handleDragStart = (e: DragEvent) => {
      if (this.isAdminContext()) return;
      e.preventDefault();
      return false;
    };

    window.addEventListener('dragstart', handleDragStart, { capture: true });

    // 4. Prevent unauthorized copying of DOM/markup outside form inputs
    const handleCopyOrCut = (e: ClipboardEvent) => {
      if (this.isAdminContext()) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', 'Protected by Notflix Anti-Inspection Shield.');
      }
    };

    window.addEventListener('copy', handleCopyOrCut, { capture: true });
    window.addEventListener('cut', handleCopyOrCut, { capture: true });

    // 5. Check for automated headless browser / DOM scraping frameworks & injected mobile DevTools (Eruda / vConsole)
    const checkAutomationAndDevToolsHooks = () => {
      if (this.isAdminContext() || this.blockState.blocked) return;
      try {
        const w = window as any;
        const d = document as any;

        // Detect Headless / WebDriver scrapers
        if (
          w.callPhantom ||
          w._phantom ||
          w.__nightmare ||
          w.domAutomation ||
          w.domAutomationController ||
          d.__webdriver_script_fn ||
          d.__selenium_unwrapped ||
          d.__fxdriver_unwrapped
        ) {
          this.reportInterceptionAttempt(
            'Automated Headless DOM Scraper / WebDriver Framework Detected',
            'scraper'
          );
          return;
        }

        // Detect injected third-party DevTools (Eruda, vConsole, Firebug)
        const erudaEl = document.getElementById('eruda') || document.querySelector('.eruda-container');
        const vConsoleEl = document.getElementById('__vconsole');
        if (w.eruda || w.VConsole || erudaEl || vConsoleEl || w.Firebug?.chrome?.isInitialized) {
          if (erudaEl) erudaEl.remove();
          if (vConsoleEl) vConsoleEl.remove();
          this.reportInterceptionAttempt(
            'Unauthorized Injected Developer Console (Eruda/vConsole/Firebug) Detected',
            'interception'
          );
          return;
        }
      } catch {}
    };

    setTimeout(checkAutomationAndDevToolsHooks, 1200);

    // 6. Active Developer Mode (DevTools) Open Detection Loop
    // Combines top-level window viewport delta + debugger timing trap + console inspection trap
    let consecutiveViewportHits = 0;

    const detectActiveDevTools = () => {
      if (this.isAdminContext() || this.blockState.blocked) return;

      try {
        checkAutomationAndDevToolsHooks();

        // Vector A: Top-level window outer vs inner size threshold (Docked DevTools)
        // Only run when not inside an iframe (window.self === window.top) to avoid false positives in preview containers
        if (window.self === window.top) {
          const widthDiff = Math.abs(window.outerWidth - window.innerWidth);
          const heightDiff = Math.abs(window.outerHeight - window.innerHeight);
          // Account for browser zoom level
          const deviceZoom = window.devicePixelRatio || 1;
          const threshold = 220 * Math.max(1, deviceZoom * 0.65);

          if (widthDiff > threshold || heightDiff > threshold) {
            consecutiveViewportHits += 1;
            if (consecutiveViewportHits >= 2) {
              this.triggerInspectionLock(
                'Docked Browser Developer Mode (DevTools) Detected'
              );
              return;
            }
          } else {
            consecutiveViewportHits = 0;
          }
        }

        // Vector B: Debugger execution pause timing trap
        // If DevTools is open with breakpoints or active inspection, debugger statement pauses > 120ms
        const start = performance.now();
        try {
          // Dynamic Function constructor prevents static bundler stripping while remaining safe
          const dbg = new Function('debugger');
          dbg();
        } catch {}
        const elapsed = performance.now() - start;

        if (elapsed > 140) {
          this.triggerInspectionLock(
            'Active Developer Mode Debugger / Network Inspector Detected'
          );
          return;
        }
      } catch {}
    };

    setInterval(detectActiveDevTools, 2000);
    window.addEventListener('resize', () => {
      if (!this.isAdminContext() && window.self === window.top) {
        detectActiveDevTools();
      }
    });

    // 7. Passively monitor network resource requests via PerformanceObserver (zero mutation of window.fetch)
    try {
      if (typeof PerformanceObserver !== 'undefined') {
        const observer = new PerformanceObserver((list) => {
          if (this.isAdminContext() || this.blockState.blocked) return;
          for (const entry of list.getEntries()) {
            if (entry.name && entry.name.includes('/api/streams/')) {
              this.recordStreamRequest();
            }
          }
        });
        observer.observe({ entryTypes: ['resource'] });
      }
    } catch {}
  }
}

export const securitySentinel = new SecuritySentinel();
