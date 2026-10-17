/**
 * Smart Ad Frequency Controller
 * Dynamically adjusts ad delivery intervals and frequency caps based on
 * real-time user engagement metrics, interaction velocity, and friction signals.
 *
 * Goals:
 * 1. Maximize revenue during high-intent discovery windows.
 * 2. Protect user retention by backing off when high friction or deep playback immersion is detected.
 */

import { AdTriggerType, isAdminActive } from './adService';

export type UserEngagementTier =
  | 'onboarding'       // New visitor in first ~90s: gentle delivery to prevent bounce
  | 'discovery'        // Active browsing with healthy velocity: prime monetization window
  | 'immersive_watch'  // Deeply watching video: protects player immersion
  | 'high_friction'    // User experiencing frustration or rage-clicking: cools off ads
  | 'loyal_viewer';    // Returning patron with watchlist/favorites: balanced cadence

export interface SmartAdMetrics {
  tier: UserEngagementTier;
  multiplier: number;
  sessionDurationSeconds: number;
  totalInteractions: number;
  interactionVelocityPerMin: number;
  itemsExploredCount: number;
  watchTimeSeconds: number;
  frictionScore: number;
  adsDelivered: number;
  adsSuppressed: number;
  lastAdDeliveredTime: number;
  effectiveCooldowns: Record<string, number>;
}

// Base intervals in milliseconds (tuned for high repetition and rapid delivery)
const BASE_COOLDOWNS: Record<string, number> = {
  global: 3000,      // 3s minimum global spacing between ANY ad
  poster: 4000,      // 4s base for movie/show posters
  dock: 5000,        // 5s base for floating dock tabs
  tab: 5000,         // 5s base for category/tab switches
  fullscreen: 6000,  // 6s base for fullscreen toggles
  episode: 8000,     // 8s base for next-episode clicks
  download: 4000,    // 4s base for download triggers
  search: 4000,      // 4s base for search triggers
  play: 4000,        // 4s base for play triggers
  pip: 5000,         // 5s base for pip triggers
};

const STORAGE_KEY = 'notflix_smart_ad_metrics_v1';

class SmartAdFrequencyController {
  private sessionStartTime: number;
  private interactionLog: number[] = [];
  private totalInteractions = 0;
  private itemsExplored = 0;
  private watchTimeSeconds = 0;
  private isPlaybackActive = false;
  private frictionScore = 0;
  private adsDelivered = 0;
  private adsSuppressed = 0;
  private lastAdDeliveredTime = 0;
  private lastTriggerTimes: Record<string, number> = {};
  private listeners: Array<(metrics: SmartAdMetrics) => void> = [];

  constructor() {
    this.sessionStartTime = Date.now();
    this.loadState();

    // Periodic friction decay (friction naturally cools down every 20s)
    if (typeof window !== 'undefined') {
      window.setInterval(() => {
        if (this.frictionScore > 0) {
          this.frictionScore = Math.max(0, this.frictionScore - 0.5);
          this.saveState();
        }
      }, 20000);
    }
  }

  private loadState() {
    if (typeof window === 'undefined') return;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.adsDelivered = parsed.adsDelivered || 0;
        this.adsSuppressed = parsed.adsSuppressed || 0;
        this.itemsExplored = parsed.itemsExplored || 0;
        this.watchTimeSeconds = parsed.watchTimeSeconds || 0;
        this.frictionScore = parsed.frictionScore || 0;
        this.lastAdDeliveredTime = parsed.lastAdDeliveredTime || 0;
        this.lastTriggerTimes = parsed.lastTriggerTimes || {};
      }
    } catch {}
  }

  private saveState() {
    if (typeof window === 'undefined') return;
    try {
      const payload = {
        adsDelivered: this.adsDelivered,
        adsSuppressed: this.adsSuppressed,
        itemsExplored: this.itemsExplored,
        watchTimeSeconds: this.watchTimeSeconds,
        frictionScore: this.frictionScore,
        lastAdDeliveredTime: this.lastAdDeliveredTime,
        lastTriggerTimes: this.lastTriggerTimes,
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      this.notifyListeners();
    } catch {}
  }

  private notifyListeners() {
    if (this.listeners.length === 0) return;
    const currentMetrics = this.getMetrics();
    this.listeners.forEach((fn) => {
      try {
        fn(currentMetrics);
      } catch {}
    });
  }

  /**
   * Computes the current user interaction velocity (actions per minute)
   */
  public getInteractionVelocity(): number {
    const now = Date.now();
    const oneMinAgo = now - 60000;
    this.interactionLog = this.interactionLog.filter((t) => t >= oneMinAgo);
    return this.interactionLog.length;
  }

  /**
   * Evaluates the current user engagement tier dynamically
   */
  public getEngagementTier(): { tier: UserEngagementTier; multiplier: number } {
    const sessionAgeSec = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const velocity = this.getInteractionVelocity();

    // 1. High Friction / Rage-Click Detection
    if (this.frictionScore >= 4 || velocity >= 25) {
      return { tier: 'high_friction', multiplier: 1.1 };
    }

    // 2. Active Video Playback Immersion
    if (this.isPlaybackActive || this.watchTimeSeconds >= 180) {
      return { tier: 'immersive_watch', multiplier: 1.0 };
    }

    // 3. New User Onboarding (first 20 seconds only)
    if (sessionAgeSec < 20 && this.itemsExplored < 1) {
      return { tier: 'onboarding', multiplier: 1.0 };
    }

    // 4. Loyal Returning Visitor
    let isLoyal = false;
    try {
      if (typeof window !== 'undefined') {
        const wl = localStorage.getItem('notflix_watchlist');
        const fav = localStorage.getItem('notflix_favorites');
        if ((wl && wl.length > 20) || (fav && fav.length > 20) || sessionAgeSec > 600) {
          isLoyal = true;
        }
      }
    } catch {}

    if (isLoyal) {
      return { tier: 'loyal_viewer', multiplier: 0.8 };
    }

    // 5. High-Intent Discovery Mode (Browsing, search, exploring cards)
    return { tier: 'discovery', multiplier: 0.65 }; // 0.65x interval: repetitive delivery
  }

  /**
   * Returns current effective cooldown interval for a specific trigger type
   */
  public getEffectiveCooldown(type: AdTriggerType | 'global'): number {
    const base = BASE_COOLDOWNS[type] || BASE_COOLDOWNS.global;
    const { multiplier } = this.getEngagementTier();
    return Math.round(base * multiplier);
  }

  /**
   * Evaluates whether an ad should be triggered based on engagement metrics
   */
  public evaluateTrigger(type: AdTriggerType): {
    allowed: boolean;
    reason: string;
    effectiveCooldownMs: number;
    tier: UserEngagementTier;
  } {
    // Admin check: 100% blocked
    if (isAdminActive()) {
      return {
        allowed: false,
        reason: 'admin_dashboard_bypass',
        effectiveCooldownMs: 0,
        tier: 'loyal_viewer',
      };
    }

    const now = Date.now();
    const { tier, multiplier } = this.getEngagementTier();

    // 1. Global Cooldown Check
    const effectiveGlobalCooldown = Math.round(BASE_COOLDOWNS.global * multiplier);
    const globalElapsed = now - this.lastAdDeliveredTime;
    if (this.lastAdDeliveredTime > 0 && globalElapsed < effectiveGlobalCooldown) {
      this.adsSuppressed++;
      this.saveState();
      return {
        allowed: false,
        reason: `global_cooldown_active (${Math.round((effectiveGlobalCooldown - globalElapsed) / 1000)}s left)`,
        effectiveCooldownMs: effectiveGlobalCooldown,
        tier,
      };
    }

    // 2. Trigger-Specific Cooldown Check
    const effectiveTypeCooldown = this.getEffectiveCooldown(type);
    const typeElapsed = now - (this.lastTriggerTimes[type] || 0);
    if (this.lastTriggerTimes[type] && typeElapsed < effectiveTypeCooldown) {
      this.adsSuppressed++;
      this.saveState();
      return {
        allowed: false,
        reason: `${type}_cooldown_active (${Math.round((effectiveTypeCooldown - typeElapsed) / 1000)}s left)`,
        effectiveCooldownMs: effectiveTypeCooldown,
        tier,
      };
    }

    // Allowed!
    return {
      allowed: true,
      reason: `approved_for_${tier}`,
      effectiveCooldownMs: effectiveTypeCooldown,
      tier,
    };
  }

  /**
   * Records that an ad was delivered successfully
   */
  public recordAdDelivered(type: AdTriggerType) {
    const now = Date.now();
    this.adsDelivered++;
    this.lastAdDeliveredTime = now;
    this.lastTriggerTimes[type] = now;
    this.saveState();
  }

  /**
   * Tracks user interaction for click velocity & engagement metrics
   */
  public recordInteraction(actionType: string) {
    const now = Date.now();
    this.totalInteractions++;
    this.interactionLog.push(now);

    if (actionType === 'poster' || actionType === 'quickview') {
      this.itemsExplored++;
    }

    this.saveState();
  }

  /**
   * Records video watch time in seconds
   */
  public recordWatchTime(seconds: number) {
    if (seconds > 0) {
      this.watchTimeSeconds += seconds;
      this.saveState();
    }
  }

  /**
   * Sets whether active video playback is in progress
   */
  public setPlaybackActive(active: boolean) {
    this.isPlaybackActive = active;
    this.notifyListeners();
  }

  /**
   * Records friction event (rapid dismissals, fast pauses, modal abandonments)
   */
  public recordFriction(weight = 1.0, reason = 'rapid_exit') {
    this.frictionScore = Math.min(5, this.frictionScore + weight);
    this.saveState();
    console.log(`[SmartAdController] Friction recorded (+${weight}, reason: ${reason}). New score: ${this.frictionScore}`);
  }

  /**
   * Subscribes to real-time metric updates
   */
  public subscribe(callback: (metrics: SmartAdMetrics) => void): () => void {
    this.listeners.push(callback);
    callback(this.getMetrics());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  /**
   * Returns complete metrics snapshot
   */
  public getMetrics(): SmartAdMetrics {
    const { tier, multiplier } = this.getEngagementTier();
    const effectiveCooldowns: Record<string, number> = {};
    Object.keys(BASE_COOLDOWNS).forEach((key) => {
      effectiveCooldowns[key] = Math.round(BASE_COOLDOWNS[key] * multiplier);
    });

    return {
      tier,
      multiplier,
      sessionDurationSeconds: Math.floor((Date.now() - this.sessionStartTime) / 1000),
      totalInteractions: this.totalInteractions,
      interactionVelocityPerMin: this.getInteractionVelocity(),
      itemsExploredCount: this.itemsExplored,
      watchTimeSeconds: this.watchTimeSeconds,
      frictionScore: Math.round(this.frictionScore * 10) / 10,
      adsDelivered: this.adsDelivered,
      adsSuppressed: this.adsSuppressed,
      lastAdDeliveredTime: this.lastAdDeliveredTime,
      effectiveCooldowns,
    };
  }
}

// Global singleton instance
export const smartAdController = new SmartAdFrequencyController();

if (typeof window !== 'undefined') {
  (window as any).smartAdController = smartAdController;
}
