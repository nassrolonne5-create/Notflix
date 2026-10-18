// Client-Side Anti-Interception & Anti-Scraping Sentinel
// Detects automated headless scrapers, stream API harvesting, and unauthorized network interception
// Safe across all browser and iframe environments (never mutates read-only/getter-only window properties)

export interface PermanentBlockInfo {
  blocked: boolean;
  ip?: string;
  reason?: string;
  code?: string;
  bannedAt?: number;
}

type BlockListener = (info: PermanentBlockInfo) => void;

class SecuritySentinel {
  private initialized = false;
  private blockState: PermanentBlockInfo = { blocked: false };
  private listeners: Set<BlockListener> = new Set();
  private streamFetchTimestamps: number[] = [];

  public subscribe(listener: BlockListener): () => void {
    this.listeners.add(listener);
    if (this.blockState.blocked) {
      listener(this.blockState);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getBlockState(): PermanentBlockInfo {
    return this.blockState;
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

  public triggerBlock(info: PermanentBlockInfo) {
    if (this.isAdminContext()) return;
    this.blockState = { ...info, blocked: true };
    this.listeners.forEach((cb) => cb(this.blockState));
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

  public init() {
    if (this.initialized || typeof window === 'undefined') return;
    this.initialized = true;

    // 1. Check for automated headless browser / DOM scraping frameworks
    const checkAutomationHooks = () => {
      if (this.isAdminContext()) return;
      try {
        const w = window as any;
        const d = document as any;
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
        }
      } catch {}
    };

    setTimeout(checkAutomationHooks, 1500);

    // 2. Passively monitor network resource requests via PerformanceObserver (zero mutation of window.fetch)
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
