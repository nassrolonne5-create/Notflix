import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import {
  detectAdBlocker,
  isAdBlockBannerDismissed,
  dismissAdBlockBanner,
} from '../services/adblockDetector';
import { Heart, X, HelpCircle, RefreshCw, CheckCircle2 } from 'lucide-react';

export const AdBlockerBanner: React.FC = () => {
  const { activeModalItem } = useApp();
  const [isAdBlockDetected, setIsAdBlockDetected] = useState<boolean>(false);
  const [isDismissed, setIsDismissed] = useState<boolean>(true);
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [justWhitelisted, setJustWhitelisted] = useState<boolean>(false);

  useEffect(() => {
    // If dismissed recently, don't run detection
    if (isAdBlockBannerDismissed()) {
      setIsDismissed(true);
      return;
    }

    // Delay detection slightly so page paint finishes smoothly
    const timer = window.setTimeout(async () => {
      const detected = await detectAdBlocker();
      if (detected) {
        setIsAdBlockDetected(true);
        setIsDismissed(false);
      }
    }, 2000);

    return () => window.clearTimeout(timer);
  }, []);

  const handleDismiss = () => {
    setIsDismissed(true);
    dismissAdBlockBanner();
  };

  const handleRecheck = async () => {
    setIsChecking(true);
    const stillBlocked = await detectAdBlocker();
    setIsChecking(false);

    if (!stillBlocked) {
      setJustWhitelisted(true);
      window.setTimeout(() => {
        setIsDismissed(true);
        dismissAdBlockBanner();
        window.location.reload();
      }, 1500);
    } else {
      setShowGuide(true);
    }
  };

  // Never render if: dismissed, not detected, or video player modal is currently playing
  if (isDismissed || !isAdBlockDetected || activeModalItem) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label="Ad Blocker Notice"
      className="fixed bottom-20 md:bottom-6 left-4 md:left-24 z-30 max-w-md w-[calc(100vw-2rem)] md:w-auto bg-[#0d1424]/95 backdrop-blur-xl border border-amber-500/25 rounded-2xl p-4 shadow-2xl shadow-black/80 text-slate-200 animate-in fade-in slide-in-from-bottom-4 duration-300"
    >
      {justWhitelisted ? (
        <div className="flex items-center gap-3 text-emerald-400 py-1">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <p className="text-xs font-semibold">
            Thank you for supporting Notflix! Refreshing page...
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {/* Header Row */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                <Heart className="w-3.5 h-3.5 text-rose-400 fill-rose-400/30" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-white tracking-wide">
                  Support Free Streaming
                </h4>
                <div className="text-[11px] text-amber-400/90 font-medium flex items-center gap-1">
                  <span>Ad blocker detected</span>
                </div>
              </div>
            </div>

            <button
              onClick={handleDismiss}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="Dismiss ad blocker notification"
              title="Dismiss for 24 hours"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Description */}
          <p className="text-xs text-slate-300 leading-relaxed">
            Notflix is 100% free with minimal, safe ads. Please consider
            whitelisting us or pausing your ad blocker to help cover our
            high-speed streaming servers.
          </p>

          {/* Whitelist Guide Accordion */}
          {showGuide && (
            <div className="p-2.5 bg-black/40 border border-white/5 rounded-xl text-[11px] text-slate-300 space-y-1.5 animate-in fade-in duration-200">
              <p className="font-semibold text-white">How to whitelist Notflix:</p>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li>Click your ad blocker extension icon in the browser toolbar.</li>
                <li>Toggle <span className="text-slate-200 font-medium">"Pause on this site"</span> or turn off protection for this domain.</li>
                <li>Click the button below to refresh and enjoy uninterrupted streaming.</li>
              </ol>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={handleRecheck}
              disabled={isChecking}
              className="flex-1 bg-rose-600 hover:bg-rose-500 active:scale-98 text-white text-xs font-semibold py-1.5 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${isChecking ? 'animate-spin' : ''}`} />
              <span>{isChecking ? 'Checking...' : "I've Disabled It"}</span>
            </button>

            <button
              onClick={() => setShowGuide(!showGuide)}
              className="px-2.5 py-1.5 rounded-xl border border-white/10 hover:border-white/20 hover:bg-white/5 text-slate-300 text-xs font-medium flex items-center gap-1 transition-all cursor-pointer"
              title="View step-by-step instructions"
            >
              <HelpCircle className="w-3 h-3 text-slate-400" />
              <span>{showGuide ? 'Hide Guide' : 'How To'}</span>
            </button>

            <button
              onClick={handleDismiss}
              className="px-2.5 py-1.5 rounded-xl text-slate-400 hover:text-slate-200 text-xs font-medium transition-colors cursor-pointer"
            >
              Later
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
