import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Shield, CheckCircle2, AlertCircle, RefreshCw, Lock } from 'lucide-react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        options: {
          sitekey: string;
          theme?: 'dark' | 'light' | 'auto';
          size?: 'normal' | 'compact';
          action?: string;
          retry?: 'auto' | 'never';
          'refresh-expired'?: 'auto' | 'manual' | 'never';
          callback?: (token: string) => void;
          'error-callback'?: (err?: any) => void;
          'expired-callback'?: () => void;
        }
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

const DEFAULT_PROD_SITE_KEY = '0x4AAAAAAFtBNaXqrUAtPyOc';
const CF_TEST_SITE_KEY = '1x00000000000000000000AA';

const SESSION_TOKEN_KEY = 'notflix_turnstile_session_token';
const SESSION_VERIFIED_KEY = 'notflix_turnstile_verified';

interface TurnstileStatusResponse {
  success: boolean;
  enabled: boolean;
  mode: 'custom' | 'test';
  siteKey: string;
  theme: 'dark' | 'auto';
  verified: boolean;
}

export const TurnstileGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialBootstrap = typeof window !== 'undefined' ? (window as any).__NOTFLIX_TURNSTILE__ : undefined;
  const isAlreadyVerifiedSession = (() => {
    try {
      return typeof window !== 'undefined' && sessionStorage.getItem(SESSION_VERIFIED_KEY) === '1';
    } catch {
      return false;
    }
  })();

  const [checking, setChecking] = useState<boolean>(() => {
    if (isAlreadyVerifiedSession) return false;
    // If server injected Turnstile config into HTML <head>, we already know synchronously at 0ms!
    if (initialBootstrap && typeof initialBootstrap.enabled === 'boolean') {
      return false;
    }
    // Never block initial page render with a full-screen spinner by default
    return false;
  });
  const [gateRequired, setGateRequired] = useState<boolean>(() => {
    if (isAlreadyVerifiedSession) return false;
    return Boolean(initialBootstrap?.enabled);
  });
  const [siteKey, setSiteKey] = useState<string>(() => initialBootstrap?.siteKey || DEFAULT_PROD_SITE_KEY);
  const [theme, setTheme] = useState<'dark' | 'auto'>(() => initialBootstrap?.theme || 'dark');
  const [previewFallback, setPreviewFallback] = useState<boolean>(false);
  const [verifiedSuccess, setVerifiedSuccess] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState<boolean>(false);

  const widgetContainerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  const checkStatus = useCallback(async (forceNetwork = false) => {
    try {
      let savedToken = '';
      try {
        savedToken = sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
      } catch {}

      // If server already told us Turnstile is disabled on initial load and this isn't a manual policy update, skip redundant round-trip!
      if (!forceNetwork && initialBootstrap && initialBootstrap.enabled === false && !savedToken) {
        setGateRequired(false);
        setChecking(false);
        return;
      }

      const res = await fetch(`/api/security/turnstile/status?_cb=${Date.now()}`, {
        cache: 'no-store',
        headers: savedToken ? { 'x-turnstile-token': savedToken } : {},
      });

      if (!res.ok) {
        setGateRequired(false);
        setChecking(false);
        return;
      }

      const data: TurnstileStatusResponse = await res.json();
      if (!data.enabled || data.verified) {
        try {
          if (data.verified) {
            sessionStorage.setItem(SESSION_VERIFIED_KEY, '1');
          }
        } catch {}
        setGateRequired(false);
        setChecking(false);
        return;
      }

      // Gate is enabled and this browser session is not yet verified
      try {
        sessionStorage.removeItem(SESSION_VERIFIED_KEY);
      } catch {}
      setSiteKey(data.siteKey || DEFAULT_PROD_SITE_KEY);
      setTheme(data.theme || 'dark');
      setPreviewFallback(false);
      setGateRequired(true);
      setChecking(false);
    } catch {
      // Fail-open on network errors so legitimate viewers aren't stranded during server restarts
      setGateRequired(false);
      setChecking(false);
    }
  }, [initialBootstrap]);

  useEffect(() => {
    checkStatus(false);
  }, [checkStatus]);

  // Listen for live admin policy changes in the same browser
  useEffect(() => {
    const handlePolicyChanged = () => {
      checkStatus(true);
    };
    window.addEventListener('notflix:turnstile-updated', handlePolicyChanged);
    return () => window.removeEventListener('notflix:turnstile-updated', handlePolicyChanged);
  }, [checkStatus]);

  // Load Cloudflare Turnstile explicit script only when gateRequired is true
  useEffect(() => {
    if (!gateRequired) return;

    if (window.turnstile) {
      setScriptLoaded(true);
      return;
    }

    const existingScript = document.querySelector(
      'script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]'
    ) as HTMLScriptElement | null;

    if (existingScript) {
      const checkInterval = setInterval(() => {
        if (window.turnstile) {
          setScriptLoaded(true);
          clearInterval(checkInterval);
        }
      }, 100);
      return () => clearInterval(checkInterval);
    }

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      setScriptLoaded(true);
    };
    script.onerror = () => {
      setErrorMsg('Could not load Cloudflare Turnstile challenge script. Please check your connection or ad blocker.');
    };
    document.head.appendChild(script);
  }, [gateRequired]);

  const handleVerifyToken = useCallback(async (token: string, isFallback = false) => {
    setErrorMsg(null);
    try {
      const res = await fetch('/api/security/turnstile/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, previewFallback: isFallback }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        try {
          if (data.sessionToken) {
            sessionStorage.setItem(SESSION_TOKEN_KEY, data.sessionToken);
          }
          sessionStorage.setItem(SESSION_VERIFIED_KEY, '1');
        } catch {}
        setVerifiedSuccess(true);
        setTimeout(() => {
          setGateRequired(false);
        }, 350);
      } else {
        setErrorMsg(data.error || 'Verification failed. Please complete the challenge again.');
        if (window.turnstile && widgetIdRef.current) {
          try {
            window.turnstile.reset(widgetIdRef.current);
          } catch {}
        }
      }
    } catch {
      setErrorMsg('Network error while verifying security token. Please retry.');
    }
  }, []);

  // Render widget when scriptLoaded and container ref is ready
  useEffect(() => {
    const activeKeyToRender = previewFallback ? CF_TEST_SITE_KEY : siteKey;
    if (!gateRequired || !scriptLoaded || !activeKeyToRender || !widgetContainerRef.current || !window.turnstile) {
      return;
    }

    if (widgetIdRef.current) {
      try {
        window.turnstile.remove(widgetIdRef.current);
      } catch {}
      widgetIdRef.current = null;
    }

    widgetContainerRef.current.innerHTML = '';

    try {
      const id = window.turnstile.render(widgetContainerRef.current, {
        sitekey: activeKeyToRender,
        theme: theme === 'auto' ? 'auto' : 'dark',
        action: 'notflix_entry_gate',
        retry: 'auto',
        'refresh-expired': 'auto',
        callback: (token: string) => {
          handleVerifyToken(token, previewFallback);
        },
        'error-callback': (errCode?: any) => {
          const host = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : '';
          const isPreviewHost =
            host.includes('.run.app') || host.includes('localhost') || host.startsWith('127.0.0.1');
          // If the custom widget rejects the AI Studio preview domain (110200), gracefully use preview test key
          if (isPreviewHost && !previewFallback && activeKeyToRender !== CF_TEST_SITE_KEY) {
            setPreviewFallback(true);
            return;
          }
          setErrorMsg(
            `Cloudflare challenge encountered an error${errCode ? ` (${String(errCode)})` : ''}. Click Retry below.`
          );
        },
        'expired-callback': () => {
          if (window.turnstile && widgetIdRef.current) {
            try {
              window.turnstile.reset(widgetIdRef.current);
            } catch {}
          }
        },
      });
      widgetIdRef.current = id;
    } catch {
      setErrorMsg('Failed to initialize Cloudflare Turnstile widget.');
    }

    return () => {
      if (window.turnstile && widgetIdRef.current) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {}
        widgetIdRef.current = null;
      }
    };
  }, [gateRequired, scriptLoaded, siteKey, theme, previewFallback, handleVerifyToken]);

  const handleRetryWidget = () => {
    setErrorMsg(null);
    if (window.turnstile && widgetIdRef.current) {
      try {
        window.turnstile.reset(widgetIdRef.current);
        return;
      } catch {}
    }
    checkStatus(true);
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-[#080c14] text-white flex items-center justify-center p-6 select-none">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-[11px] font-mono uppercase tracking-widest text-slate-400">
            Initializing Security Shield...
          </span>
        </div>
      </div>
    );
  }

  if (!gateRequired) {
    return <>{children}</>;
  }

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      className="min-h-screen bg-[#080c14] text-white flex flex-col items-center justify-center p-4 sm:p-6 relative overflow-hidden select-none"
    >
      {/* Subtle ambient glow */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-rose-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-sm bg-[#0e1424] border border-white/10 rounded-2xl px-4 py-6 sm:p-7 shadow-2xl relative z-10 flex flex-col items-center text-center">
        {/* Brand Header (Red Rectangle Area) */}
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/25 text-blue-400 mb-3.5 shadow-lg shadow-blue-950/40">
          {verifiedSuccess ? (
            <CheckCircle2 className="w-7 h-7 text-emerald-400 animate-pulse" />
          ) : (
            <Shield className="w-7 h-7 text-blue-400" />
          )}
        </div>

        <div className="font-display text-2xl tracking-wider text-white uppercase mb-2">
          Notflix<span className="text-blue-500">.</span>
        </div>

        <div className="inline-flex items-center justify-center gap-1.5 px-3 py-1 rounded-md bg-blue-500/10 border border-blue-500/25 text-blue-300 text-[10px] font-mono font-bold uppercase tracking-widest mb-5">
          <Lock className="w-3 h-3 shrink-0" />
          <span>Cloudflare Turnstile Connection Check</span>
        </div>

        {/* Original Cloudflare Turnstile Widget */}
        <div className="w-full flex flex-col items-center justify-center min-h-[65px]">
          {!scriptLoaded && !errorMsg && (
            <div className="flex items-center gap-2 text-xs text-slate-400 font-mono py-3">
              <RefreshCw className="w-4 h-4 animate-spin text-blue-400" />
              <span>Loading Cloudflare...</span>
            </div>
          )}

          <div ref={widgetContainerRef} className="flex items-center justify-center" />
        </div>

        {errorMsg && (
          <div className="w-full bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 mt-4 text-left flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
            <button
              type="button"
              onClick={handleRetryWidget}
              className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-[11px] font-bold text-rose-200 shrink-0 cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
