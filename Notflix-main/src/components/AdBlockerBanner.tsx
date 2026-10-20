import React, { useEffect, useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import {
  detectAdBlocker,
  isAdBlockBannerDismissed,
  dismissAdBlockBanner,
  fetchAdBlockPolicy,
  getCachedAdBlockPolicyMode,
  AdBlockPopupMode,
} from '../services/adblockDetector';
import { Heart, X, HelpCircle, RefreshCw, CheckCircle2, Lock, AlertCircle } from 'lucide-react';

export const AdBlockerBanner: React.FC = () => {
  const { activeModalItem } = useApp();
  const [policyMode, setPolicyMode] = useState<AdBlockPopupMode>(() => getCachedAdBlockPolicyMode());
  const [isAdBlockDetected, setIsAdBlockDetected] = useState<boolean>(false);
  const [isDismissed, setIsDismissed] = useState<boolean>(() => isAdBlockBannerDismissed());
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [justWhitelisted, setJustWhitelisted] = useState<boolean>(false);
  const [stillActiveWarning, setStillActiveWarning] = useState<boolean>(false);

  const runPolicyAndDetection = useCallback(async () => {
    const currentMode = await fetchAdBlockPolicy();
    setPolicyMode(currentMode);

    // In 'dismissible' mode, honor the 24-hour user dismissal
    if (currentMode === 'dismissible' && isAdBlockBannerDismissed()) {
      setIsDismissed(true);
      return;
    }

    const detected = await detectAdBlocker();
    if (detected) {
      setIsAdBlockDetected(true);
      if (currentMode === 'strict') {
        // Strict mode can never be dismissed while ad blocker is active
        setIsDismissed(false);
      } else if (!isAdBlockBannerDismissed()) {
        setIsDismissed(false);
      }
    } else {
      setIsAdBlockDetected(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      runPolicyAndDetection();
    }, 1500);

    const handlePolicyChanged = () => {
      runPolicyAndDetection();
    };
    window.addEventListener('notflix:adblock-policy-changed', handlePolicyChanged);

    // Poll policy & detection periodically so admin mode switches take effect live
    const pollInterval = window.setInterval(() => {
      runPolicyAndDetection();
    }, 15000);

    return () => {
      window.clearTimeout(timer);
      window.clearInterval(pollInterval);
      window.removeEventListener('notflix:adblock-policy-changed', handlePolicyChanged);
    };
  }, [runPolicyAndDetection]);

  // While the popup is visible, auto-verify in the background every 4s so if the user disables their ad blocker, it unlocks automatically
  useEffect(() => {
    const isPopupVisible =
      isAdBlockDetected && (policyMode === 'strict' || (!isDismissed && !activeModalItem));
    if (!isPopupVisible || justWhitelisted) return;

    const verifyTimer = window.setInterval(async () => {
      const stillBlocked = await detectAdBlocker();
      if (!stillBlocked) {
        setStillActiveWarning(false);
        setJustWhitelisted(true);
        window.setTimeout(() => {
          setIsAdBlockDetected(false);
          setIsDismissed(true);
          dismissAdBlockBanner();
          window.location.reload();
        }, 1200);
      }
    }, 4000);

    return () => window.clearInterval(verifyTimer);
  }, [isAdBlockDetected, policyMode, isDismissed, activeModalItem, justWhitelisted]);

  const handleDismiss = () => {
    // Only allowed when policyMode is 'dismissible'
    if (policyMode === 'strict') return;
    setIsDismissed(true);
    dismissAdBlockBanner();
  };

  const handleRecheck = async () => {
    setIsChecking(true);
    setStillActiveWarning(false);
    const stillBlocked = await detectAdBlocker();
    setIsChecking(false);

    if (!stillBlocked) {
      setJustWhitelisted(true);
      window.setTimeout(() => {
        setIsAdBlockDetected(false);
        setIsDismissed(true);
        dismissAdBlockBanner();
        window.location.reload();
      }, 1400);
    } else {
      setStillActiveWarning(true);
      setShowGuide(true);
    }
  };

  const isStrict = policyMode === 'strict';

  // In 'dismissible' mode: hide if dismissed, not detected, or video player modal is playing.
  // In 'strict' mode: NEVER hide while ad blocker is detected (cannot be closed or bypassed until ad blocker is disabled).
  if (!isAdBlockDetected) {
    return null;
  }
  if (!isStrict && (isDismissed || activeModalItem)) {
    return null;
  }

  const cardContent = (
    <div
      role="dialog"
      aria-modal={isStrict ? 'true' : 'false'}
      aria-label="Ad Blocker Notice"
      className={
        isStrict
          ? 'relative max-w-md w-full bg-[#0d1424] border border-rose-500/40 rounded-2xl p-5 shadow-2xl shadow-black/90 text-slate-200 animate-in fade-in zoom-in-95 duration-200'
          : 'fixed bottom-20 md:bottom-6 left-4 md:left-24 z-30 max-w-md w-[calc(100vw-2rem)] md:w-auto bg-[#0d1424]/95 backdrop-blur-xl border border-amber-500/25 rounded-2xl p-4 shadow-2xl shadow-black/80 text-slate-200 animate-in fade-in slide-in-from-bottom-4 duration-300'
      }
    >
      {justWhitelisted ? (
        <div className="flex items-center gap-3 text-emerald-400 py-2">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <p className="text-xs font-semibold">
            Thank you for disabling your ad blocker! Unlocking Notflix...
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Header Row */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                {isStrict ? (
                  <Lock className="w-4 h-4 text-rose-400" />
                ) : (
                  <Heart className="w-4 h-4 text-rose-400 fill-rose-400/30" />
                )}
              </div>
              <div>
                <h4 className="text-sm font-bold text-white tracking-wide flex items-center gap-2 flex-wrap">
                  <span>Support Free Streaming</span>
                  {isStrict && (
                    <span className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/40 text-[9px] font-extrabold uppercase tracking-wider text-rose-300">
                      Required
                    </span>
                  )}
                </h4>
                <div className="text-[11px] text-amber-400/90 font-medium flex items-center gap-1">
                  <span>
                    {isStrict
                      ? 'Ad blocker detected — Please disable to continue watching'
                      : 'Ad blocker detected'}
                  </span>
                </div>
              </div>
            </div>

            {/* Close (X) button ONLY rendered in 'dismissible' mode */}
            {!isStrict && (
              <button
                type="button"
                onClick={handleDismiss}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Dismiss ad blocker notification"
                title="Dismiss for 24 hours"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Description */}
          <p className="text-xs text-slate-300 leading-relaxed">
            {isStrict
              ? 'Notflix is 100% free with minimal, safe ads. To continue browsing and watching streams in HD, please pause or disable your ad blocker for this website.'
              : 'Notflix is 100% free with minimal, safe ads. Please consider whitelisting us or pausing your ad blocker to help cover our high-speed streaming servers.'}
          </p>

          {/* Warning if user clicked "I've Disabled It" while ad blocker is still active */}
          {stillActiveWarning && (
            <div className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/35 text-[11px] text-rose-200 flex items-start gap-2 animate-in fade-in duration-150">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>
                Your ad blocker is still active. Please pause or turn off your ad blocker extension (or Brave Shields / DNS filter) for <strong>notflixtv.com</strong>, then click <strong>&quot;I&apos;ve Disabled It&quot;</strong>.
              </span>
            </div>
          )}

          {/* Whitelist Guide Accordion */}
          {showGuide && (
            <div className="p-2.5 bg-black/40 border border-white/5 rounded-xl text-[11px] text-slate-300 space-y-1.5 animate-in fade-in duration-200">
              <p className="font-semibold text-white">How to disable your ad blocker on Notflix:</p>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li>Click your ad blocker icon (or Brave/Browser Shield icon) in the address bar.</li>
                <li>
                  Toggle <span className="text-slate-200 font-medium">&quot;Pause on this site&quot;</span> or turn off protection for <strong>notflixtv.com</strong>.
                </li>
                <li>Click <strong>&quot;I&apos;ve Disabled It&quot;</strong> below to unlock streaming immediately.</li>
              </ol>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={handleRecheck}
              disabled={isChecking}
              className="flex-1 bg-rose-600 hover:bg-rose-500 active:scale-98 text-white text-xs font-semibold py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              <span>{isChecking ? 'Verifying...' : "I've Disabled It"}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowGuide(!showGuide)}
              className="px-3 py-2 rounded-xl border border-white/10 hover:border-white/20 hover:bg-white/5 text-slate-300 text-xs font-medium flex items-center gap-1 transition-all cursor-pointer"
              title="View step-by-step instructions"
            >
              <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
              <span>{showGuide ? 'Hide Guide' : 'How To'}</span>
            </button>

            {/* "Later" button ONLY rendered in 'dismissible' mode */}
            {!isStrict && (
              <button
                type="button"
                onClick={handleDismiss}
                className="px-2.5 py-2 rounded-xl text-slate-400 hover:text-slate-200 text-xs font-medium transition-colors cursor-pointer"
              >
                Later
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  // In 'strict' mode, wrap in an unclosable full-screen backdrop overlay so the user must disable their ad blocker
  if (isStrict) {
    return (
      <div
        onContextMenu={(e) => e.preventDefault()}
        className="fixed inset-0 z-[120] bg-[#060912]/80 backdrop-blur-md flex items-center justify-center p-4 select-none"
      >
        {cardContent}
      </div>
    );
  }

  return cardContent;
};
