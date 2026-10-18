// Client-Side Anti-Interception, Anti-Scraping & Anti-Page-Inspection Sentinel
// Prevents Developer Mode shortcuts (F12, Inspect Element, View Source, Save Page) and Right-Click
// Zero false positives on Firefox, Chrome, Safari, Edge, Brave, or Mobile browsers.

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
    this.blockState = {
      ...this.blockState,
      ...info,
      blocked: true,
    };
    this.notifyListeners();
  }

  public recordStreamRequest() {
    // Stream rate limiting is handled accurately on the server by distinct TMDB IDs
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
    category: 'scraper' | 'interception' = 'scraper'
  ) {
    if (this.isAdminContext() || this.blockState.blocked) return;
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
      if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        if (data?.code === 'IP_PERMANENTLY_BLOCKED') {
          this.triggerBlock({
            blocked: true,
            ip: data?.ip || 'Detected Network IP',
            reason: data?.reason || reason,
            code: 'IP_PERMANENTLY_BLOCKED',
            bannedAt: data?.bannedAt || Date.now(),
          });
        }
      }
    } catch {}
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

    // 1. Prevent Developer Mode / Inspect Element / View Source / Save Page keyboard shortcuts
    // Blocks the browser shortcut silently without banning legitimate users who press a key by mistake
    const handleKeyDown = (e: KeyboardEvent) => {
      if (this.isAdminContext()) return;

      const key = (e.key || '').toUpperCase();
      const code = e.keyCode || e.which;
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

      // F12 Developer Tools
      const isF12 = key === 'F12' || code === 123;

      // Windows/Linux: Ctrl+Shift+I (Inspect), Ctrl+Shift+J (Console), Ctrl+Shift+C (Element Picker), Ctrl+Shift+K (Firefox Console), Ctrl+Shift+E (Firefox Network)
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
    };

    window.addEventListener('copy', handleCopyOrCut, { capture: true });
    window.addEventListener('cut', handleCopyOrCut, { capture: true });

    // 5. Only report 100% confirmed headless scraping frameworks (PhantomJS, Nightmare, Selenium WebDriver)
    const checkHeadlessScraperFrameworks = () => {
      if (this.isAdminContext() || this.blockState.blocked) return;
      try {
        const w = window as any;
        const d = document as any;

        if (
          w.callPhantom ||
          w._phantom ||
          w.__nightmare ||
          d.__webdriver_script_fn ||
          d.__selenium_unwrapped ||
          d.__fxdriver_unwrapped
        ) {
          this.reportInterceptionAttempt(
            'Confirmed Headless Scraper Framework (PhantomJS/Selenium/Nightmare)',
            'scraper'
          );
        }
      } catch {}
    };

    setTimeout(checkHeadlessScraperFrameworks, 2000);
  }
}

export const securitySentinel = new SecuritySentinel();
