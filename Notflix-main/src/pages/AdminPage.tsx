import React, { useState, useEffect, useCallback } from 'react';
import {
  Lock,
  User,
  Eye,
  EyeOff,
  LogOut,
  Radio,
  Play,
  Clock,
  Search,
  Users,
  Smartphone,
  Monitor,
  Tablet,
  Tv,
  RefreshCw,
  TrendingUp,
  ArrowLeft,
  Server,
  Activity,
  Calendar,
  Compass,
  AlertCircle,
  CheckCircle2,
  Globe,
  Film,
} from 'lucide-react';

interface AdminPageProps {
  onExit: () => void;
}

interface AnalyticsKPIs {
  liveViewers: number;
  totalViews: number;
  totalWatchHours: number;
  totalWatchMinutes: number;
  totalSearches: number;
  uniqueVisitors: number;
}

interface LiveStreamItem {
  sessionId: string;
  title: string;
  device: string;
  mediaType?: string;
  season?: number;
  episode?: number;
  poster?: string;
  secondsAgo: number;
}

interface TimelinePoint {
  date: string;
  label: string;
  views: number;
  watchHours: number;
}

interface TopTitleItem {
  title: string;
  mediaType?: string;
  poster?: string;
  views: number;
  watchMinutes: number;
  avgMinutes: number;
}

interface TopSearchItem {
  query: string;
  count: number;
  lastSearched: number;
}

interface RecentEventItem {
  id: string;
  ts: number;
  type: string;
  title?: string;
  mediaType?: string;
  season?: number;
  episode?: number;
  poster?: string;
  device?: string;
  browser?: string;
  watchMinutes?: number;
  searchQuery?: string;
}

interface ServerHealthItem {
  server: string;
  success: number;
  error: number;
  total: number;
  rate: number;
}

interface AnalyticsResponse {
  success: boolean;
  range: string;
  kpis: AnalyticsKPIs;
  liveStreams: LiveStreamItem[];
  timeline: TimelinePoint[];
  hourlyDistribution: number[];
  topTitles: TopTitleItem[];
  topSearches: TopSearchItem[];
  recentEvents: RecentEventItem[];
  devices: { mobile: number; desktop: number; tablet: number; tv: number };
  browsers: Record<string, number>;
  operatingSystems: Record<string, number>;
  serverHealth: ServerHealthItem[];
}

export const AdminPage: React.FC<AdminPageProps> = ({ onExit }) => {
  // Authentication State
  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem('notflix_admin_token') || null;
  });
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(true);

  // Login Form State (Always clean and empty - never prefilled or exposed)
  const [usernameInput, setUsernameInput] = useState<string>('');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loginLoading, setLoginLoading] = useState<boolean>(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Analytics Dashboard State
  const [dateRange, setDateRange] = useState<'today' | '7d' | '30d' | 'all'>('7d');
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [loadingData, setLoadingData] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [lastFetchedTime, setLastFetchedTime] = useState<Date>(new Date());
  const [activeHoverPoint, setActiveHoverPoint] = useState<TimelinePoint | null>(null);

  // Verify existing token on mount
  useEffect(() => {
    if (!token) {
      setIsVerifying(false);
      setIsAuthenticated(false);
      return;
    }

    fetch('/api/admin/verify', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.valid) {
          setIsAuthenticated(true);
        } else {
          localStorage.removeItem('notflix_admin_token');
          setToken(null);
          setIsAuthenticated(false);
        }
      })
      .catch(() => {
        localStorage.removeItem('notflix_admin_token');
        setToken(null);
        setIsAuthenticated(false);
      })
      .finally(() => {
        setIsVerifying(false);
      });
  }, [token]);

  // Handle Login submission
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameInput.trim(),
          password: passwordInput,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success && data.token) {
        localStorage.setItem('notflix_admin_token', data.token);
        setToken(data.token);
        setIsAuthenticated(true);
      } else {
        setLoginError(data.error || 'Invalid credentials. Please verify your username and password.');
      }
    } catch {
      setLoginError('Connection error. Could not contact the authentication server.');
    } finally {
      setLoginLoading(false);
    }
  };

  // Handle Logout
  const handleLogout = async () => {
    if (token) {
      try {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {}
    }
    localStorage.removeItem('notflix_admin_token');
    setToken(null);
    setIsAuthenticated(false);
  };

  // Fetch Analytics Data
  const fetchAnalytics = useCallback(async () => {
    if (!token) return;
    setLoadingData(true);

    try {
      const res = await fetch(`/api/admin/analytics?range=${dateRange}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401) {
        handleLogout();
        return;
      }

      const data = await res.json();
      if (data.success) {
        setAnalytics(data);
        setLastFetchedTime(new Date());
      }
    } catch (err) {
      console.error('Failed to load analytics:', err);
    } finally {
      setLoadingData(false);
    }
  }, [token, dateRange]);

  // Initial fetch and on dateRange change
  useEffect(() => {
    if (isAuthenticated) {
      fetchAnalytics();
    }
  }, [isAuthenticated, dateRange, fetchAnalytics]);

  // Auto-refresh timer (polls every 10 seconds for real live stream updates)
  useEffect(() => {
    if (!isAuthenticated || !autoRefresh) return;
    const interval = setInterval(() => {
      fetchAnalytics();
    }, 10000);
    return () => clearInterval(interval);
  }, [isAuthenticated, autoRefresh, fetchAnalytics]);

  // -------------------------------------------------------------
  // RENDER: Loading check
  // -------------------------------------------------------------
  if (isVerifying) {
    return (
      <div className="min-h-screen bg-[#080c14] text-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-slate-400 font-mono tracking-widest uppercase">
            Verifying Admin Session...
          </p>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // RENDER: Login Screen
  // -------------------------------------------------------------
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#080c14] text-white flex flex-col justify-center items-center p-4 relative overflow-hidden selection:bg-blue-600">
        {/* Ambient background glow */}
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-rose-600/10 rounded-full blur-3xl pointer-events-none" />

        {/* Back to Site Button */}
        <button
          onClick={onExit}
          className="absolute top-6 left-6 flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 px-3.5 py-2 rounded-xl border border-white/10 transition-all cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Notflix</span>
        </button>

        {/* Login Card */}
        <div className="w-full max-w-md bg-[#0e1424] border border-white/10 rounded-2xl md:rounded-3xl p-6 sm:p-8 shadow-2xl relative z-10">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-rose-600 p-0.5 mb-4 shadow-lg shadow-blue-900/30">
              <div className="w-full h-full bg-[#080c14] rounded-[14px] flex items-center justify-center">
                <Radio className="w-6 h-6 text-blue-400 animate-pulse" />
              </div>
            </div>
            <h1 className="font-display text-3xl uppercase tracking-wider text-white">
              Notflix<span className="text-blue-500">.</span> Studio
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Admin Command Center & Real Analytics Engine
            </p>
          </div>

          {loginError && (
            <div className="mb-5 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-start gap-2.5 text-rose-300 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                Admin Username
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  required
                  autoComplete="username"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder="Enter admin username"
                  className="w-full bg-[#131a2a] border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                Admin Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Enter admin password"
                  className="w-full bg-[#131a2a] border border-white/10 rounded-xl pl-10 pr-11 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="mt-2 w-full py-3 px-4 bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white text-sm font-bold uppercase tracking-wider rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-blue-900/40 disabled:opacity-50"
            >
              {loginLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <span>Access Studio Analytics</span>
              )}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-white/5 text-center">
            <p className="text-[11px] text-slate-500">
              Authorized personnel only. All access and streaming telemetry are recorded.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // RENDER: YouTube Studio Analytics Dashboard
  // -------------------------------------------------------------
  const kpis = analytics?.kpis || {
    liveViewers: 0,
    totalViews: 0,
    totalWatchHours: 0,
    totalWatchMinutes: 0,
    totalSearches: 0,
    uniqueVisitors: 0,
  };

  const devices = analytics?.devices || { mobile: 0, desktop: 0, tablet: 0, tv: 0 };
  const totalDeviceEvents = devices.mobile + devices.desktop + devices.tablet + devices.tv || 1;

  // Max value calculation for timeline graph SVG
  const timelinePoints = analytics?.timeline || [];
  const maxViews = Math.max(...timelinePoints.map((p) => p.views), 1);

  return (
    <div className="min-h-screen bg-[#080c14] text-white flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      {/* =========================================================
          Top Studio Header
         ========================================================= */}
      <header className="sticky top-0 z-40 bg-[#0c101d]/90 backdrop-blur-md border-b border-white/10 px-4 md:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Brand & Live Beacon */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="font-display text-2xl tracking-wider text-white uppercase">
              Notflix<span className="text-blue-500">.</span>
            </span>
            <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-blue-600/20 text-blue-400 border border-blue-500/30">
              Studio
            </span>
          </div>

          <div className="h-5 w-px bg-white/10 hidden sm:block" />

          {/* Real Live Viewers Beacon */}
          <div className="flex items-center gap-2 bg-[#12192b] border border-white/10 px-3 py-1 rounded-full">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
            <span className="text-xs font-bold text-slate-200">
              <span className="text-emerald-400 font-mono font-extrabold">{kpis.liveViewers}</span>{' '}
              {kpis.liveViewers === 1 ? 'Live Viewer' : 'Live Viewers'}
            </span>
          </div>
        </div>

        {/* Date Filters & Action Controls */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Segmented Date Range Picker */}
          <div className="flex items-center bg-[#131a2b] border border-white/10 rounded-xl p-1 gap-1 text-xs">
            {(
              [
                { id: 'today', label: 'Today' },
                { id: '7d', label: 'Last 7 Days' },
                { id: '30d', label: 'Last 30 Days' },
                { id: 'all', label: 'All Time' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                onClick={() => setDateRange(item.id)}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                  dateRange === item.id
                    ? 'bg-blue-600 text-white font-bold shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Auto Refresh Toggle */}
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            title="Auto-refresh every 10 seconds"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold cursor-pointer transition-all ${
              autoRefresh
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Auto (10s)</span>
          </button>

          {/* Manual Refresh Button */}
          <button
            onClick={fetchAnalytics}
            disabled={loadingData}
            title="Refresh analytics data"
            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 active:scale-95 text-slate-300 hover:text-white border border-white/10 transition-all cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loadingData ? 'animate-spin text-blue-400' : ''}`} />
          </button>

          {/* Back to Website */}
          <button
            onClick={onExit}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 text-xs font-semibold transition-all cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 text-blue-400" />
            <span>View Site</span>
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            title="Sign out of Admin Studio"
            className="p-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 transition-all cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* =========================================================
          Main Dashboard Content
         ========================================================= */}
      <main className="flex-1 p-4 md:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
        {/* Top KPI Summary Cards (YouTube Studio Style) */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4">
          {/* 1. Live Viewers */}
          <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-4 flex flex-col justify-between relative overflow-hidden group hover:border-emerald-500/40 transition-colors">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Live Viewers
              </span>
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
            </div>
            <div className="text-3xl md:text-4xl font-extrabold font-mono text-white tracking-tight">
              {kpis.liveViewers}
            </div>
            <div className="text-[11px] text-emerald-400 mt-2 font-medium flex items-center gap-1">
              <span>● Active streams right now</span>
            </div>
          </div>

          {/* 2. Total Views */}
          <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-4 flex flex-col justify-between hover:border-blue-500/40 transition-colors">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Total Views
              </span>
              <Play className="w-4 h-4 text-blue-400" />
            </div>
            <div className="text-3xl md:text-4xl font-extrabold font-mono text-white tracking-tight">
              {kpis.totalViews.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-2 flex items-center gap-1">
              <TrendingUp className="w-3 h-3 text-blue-400" />
              <span>Real stream starts</span>
            </div>
          </div>

          {/* 3. Watch Time */}
          <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-4 flex flex-col justify-between hover:border-amber-500/40 transition-colors">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Watch Time
              </span>
              <Clock className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-3xl md:text-4xl font-extrabold font-mono text-white tracking-tight">
              {kpis.totalWatchHours}{' '}
              <span className="text-base font-normal text-slate-400">hrs</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-2">
              {kpis.totalWatchMinutes.toLocaleString()} minutes streamed
            </div>
          </div>

          {/* 4. Searches */}
          <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-4 flex flex-col justify-between hover:border-purple-500/40 transition-colors">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Searches
              </span>
              <Search className="w-4 h-4 text-purple-400" />
            </div>
            <div className="text-3xl md:text-4xl font-extrabold font-mono text-white tracking-tight">
              {kpis.totalSearches.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-2">Queries conducted</div>
          </div>

          {/* 5. Unique Visitors */}
          <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-4 flex flex-col justify-between col-span-2 md:col-span-1 hover:border-teal-500/40 transition-colors">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Unique Visitors
              </span>
              <Users className="w-4 h-4 text-teal-400" />
            </div>
            <div className="text-3xl md:text-4xl font-extrabold font-mono text-white tracking-tight">
              {kpis.uniqueVisitors.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-2">Audience sessions</div>
          </div>
        </div>

        {/* Live Streamers Monitor (Shows who is actively watching right now) */}
        {analytics?.liveStreams && analytics.liveStreams.length > 0 && (
          <div className="bg-[#0e1424] border border-emerald-500/30 rounded-2xl p-4 shadow-lg shadow-emerald-950/20">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-white">
                  Active Live Streams Right Now ({analytics.liveStreams.length})
                </h3>
              </div>
              <span className="text-[11px] text-slate-400">Updated every 10s</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
              {analytics.liveStreams.map((stream, idx) => (
                <div
                  key={stream.sessionId + idx}
                  className="bg-[#131b2e] border border-white/10 rounded-xl p-3 flex items-center gap-3"
                >
                  {stream.poster ? (
                    <img
                      src={stream.poster}
                      alt={stream.title}
                      className="w-10 h-14 object-cover rounded-lg shrink-0 bg-black/40"
                    />
                  ) : (
                    <div className="w-10 h-14 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
                      <Film className="w-5 h-5 text-blue-400" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-white truncate">{stream.title}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                      {stream.mediaType === 'tv'
                        ? `Season ${stream.season} · Ep ${stream.episode}`
                        : 'Feature Movie'}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 text-[10px] font-mono text-emerald-400">
                      <span className="capitalize">{stream.device}</span>
                      <span>·</span>
                      <span>{stream.secondsAgo}s ago</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* =========================================================
            Analytics Charts: Views & Watch Time Trend
           ========================================================= */}
        <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-5 md:p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-base font-bold text-white">Views & Watch Duration Trend</h2>
              <p className="text-xs text-slate-400">
                Visual activity progression across the selected time period
              </p>
            </div>
            {activeHoverPoint && (
              <div className="bg-[#141d33] border border-blue-500/40 px-3 py-1.5 rounded-xl text-xs flex items-center gap-3">
                <span className="font-bold text-white">{activeHoverPoint.label}</span>
                <span className="text-blue-400 font-mono font-bold">
                  {activeHoverPoint.views} views
                </span>
                <span className="text-amber-400 font-mono">
                  {activeHoverPoint.watchHours} hrs
                </span>
              </div>
            )}
          </div>

          {/* SVG Interactive Trend Chart */}
          <div className="relative w-full h-48 md:h-64 mt-2">
            {timelinePoints.length > 0 ? (
              <div className="w-full h-full flex flex-col justify-between">
                {/* SVG Curves */}
                <svg className="w-full h-4/5 overflow-visible" viewBox="0 0 1000 200" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="viewsGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal grid lines */}
                  <line x1="0" y1="50" x2="1000" y2="50" stroke="#ffffff" strokeOpacity="0.05" strokeDasharray="4 4" />
                  <line x1="0" y1="100" x2="1000" y2="100" stroke="#ffffff" strokeOpacity="0.05" strokeDasharray="4 4" />
                  <line x1="0" y1="150" x2="1000" y2="150" stroke="#ffffff" strokeOpacity="0.05" strokeDasharray="4 4" />

                  {/* Dynamic Area polygon */}
                  {(() => {
                    const coords = timelinePoints.map((pt, i) => {
                      const x = (i / Math.max(1, timelinePoints.length - 1)) * 1000;
                      const y = 190 - (pt.views / maxViews) * 160;
                      return { x, y, pt };
                    });

                    const areaPoints = [
                      `0,200`,
                      ...coords.map((c) => `${c.x},${c.y}`),
                      `1000,200`,
                    ].join(' ');

                    const linePoints = coords.map((c) => `${c.x},${c.y}`).join(' ');

                    return (
                      <>
                        <polygon points={areaPoints} fill="url(#viewsGradient)" />
                        <polyline
                          fill="none"
                          stroke="#3b82f6"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          points={linePoints}
                        />
                        {coords.map((c, idx) => (
                          <circle
                            key={idx}
                            cx={c.x}
                            cy={c.y}
                            r="4.5"
                            className="fill-white stroke-blue-600 stroke-2 hover:r-7 transition-all cursor-pointer"
                            onMouseEnter={() => setActiveHoverPoint(c.pt)}
                          />
                        ))}
                      </>
                    );
                  })()}
                </svg>

                {/* Date Labels bottom axis */}
                <div className="flex justify-between text-[11px] font-mono text-slate-500 pt-2 border-t border-white/5">
                  {timelinePoints.map((pt, idx) => (
                    <span key={idx} className="truncate px-1">
                      {pt.label}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 text-xs gap-1 border border-dashed border-white/10 rounded-xl">
                <Calendar className="w-6 h-6 text-slate-600" />
                <span>No streaming activity logged for this time range yet</span>
              </div>
            )}
          </div>
        </div>

        {/* =========================================================
            Two Column Grid: Content Performance & Audience Insights
           ========================================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* LEFT 2 COLUMNS: Top Content Leaderboard (YouTube Studio Style) */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            {/* Top Titles Table */}
            <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-5 md:p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                    Top Performing Content
                  </h3>
                  <p className="text-xs text-slate-400">
                    Ranked by real viewers and cumulative watch hours
                  </p>
                </div>
                <span className="text-xs font-mono text-blue-400">
                  {analytics?.topTitles.length || 0} Titles
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-slate-400 text-[10px] uppercase font-bold tracking-wider">
                      <th className="py-2.5 px-3">#</th>
                      <th className="py-2.5 px-3">Title</th>
                      <th className="py-2.5 px-3 text-right">Views</th>
                      <th className="py-2.5 px-3 text-right">Watch Time</th>
                      <th className="py-2.5 px-3 text-right">Avg Retention</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {analytics?.topTitles && analytics.topTitles.length > 0 ? (
                      analytics.topTitles.map((item, idx) => (
                        <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-500">
                            {idx + 1}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-2.5">
                              {item.poster ? (
                                <img
                                  src={item.poster}
                                  alt={item.title}
                                  className="w-7 h-10 object-cover rounded shadow shrink-0"
                                />
                              ) : (
                                <div className="w-7 h-10 rounded bg-white/5 flex items-center justify-center shrink-0">
                                  <Film className="w-3.5 h-3.5 text-slate-400" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="font-bold text-white truncate max-w-[200px] md:max-w-[280px]">
                                  {item.title}
                                </div>
                                <div className="text-[10px] text-slate-400 capitalize">
                                  {item.mediaType === 'tv' ? 'TV Series' : 'Movie'}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-white">
                            {item.views.toLocaleString()}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-amber-400">
                            {item.watchMinutes} min
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-slate-400">
                            {item.avgMinutes} min / view
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-500 text-xs">
                          No titles played yet. Play a video to start collecting real metrics!
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Real-Time Live Feed */}
            <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-5 md:p-6 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-blue-400" />
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                    Recent Stream & Search Feed
                  </h3>
                </div>
                <span className="text-[10px] text-slate-400 font-mono">Real events</span>
              </div>

              <div className="flex flex-col gap-2 max-h-80 overflow-y-auto pr-1">
                {analytics?.recentEvents && analytics.recentEvents.length > 0 ? (
                  analytics.recentEvents.map((ev) => (
                    <div
                      key={ev.id}
                      className="flex items-center justify-between p-2.5 rounded-xl bg-[#11182a] border border-white/5 text-xs"
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            ev.type === 'play'
                              ? 'bg-blue-400'
                              : ev.type === 'heartbeat'
                              ? 'bg-emerald-400'
                              : ev.type === 'search'
                              ? 'bg-purple-400'
                              : 'bg-slate-400'
                          }`}
                        />
                        <div className="truncate">
                          {ev.type === 'play' && (
                            <span className="text-white">
                              Started watching <strong className="text-blue-300">{ev.title}</strong>
                            </span>
                          )}
                          {ev.type === 'heartbeat' && (
                            <span className="text-slate-300">
                              Active playback on <strong className="text-emerald-300">{ev.title}</strong>{' '}
                              (+{ev.watchMinutes}m)
                            </span>
                          )}
                          {ev.type === 'search' && (
                            <span className="text-slate-300">
                              Searched for <strong className="text-purple-300">"{ev.searchQuery}"</strong>
                            </span>
                          )}
                          {ev.type === 'pageview' && (
                            <span className="text-slate-400">Visited page {ev.title}</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 text-[10px] font-mono text-slate-400">
                        <span className="capitalize">{ev.device}</span>
                        <span>·</span>
                        <span>{new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="py-6 text-center text-xs text-slate-500">
                    Activity feed will populate as viewers watch content.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT 1 COLUMN: Audience & Server Telemetry */}
          <div className="flex flex-col gap-6">
            {/* Devices Breakdown */}
            <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-blue-400" />
                <span>Audience Devices</span>
              </h3>

              <div className="flex flex-col gap-3">
                {[
                  {
                    name: 'Mobile Phone',
                    count: devices.mobile,
                    icon: Smartphone,
                    color: 'bg-blue-500',
                  },
                  {
                    name: 'Desktop PC / Mac',
                    count: devices.desktop,
                    icon: Monitor,
                    color: 'bg-emerald-500',
                  },
                  {
                    name: 'Tablet / iPad',
                    count: devices.tablet,
                    icon: Tablet,
                    color: 'bg-purple-500',
                  },
                  {
                    name: 'Smart TV',
                    count: devices.tv,
                    icon: Tv,
                    color: 'bg-amber-500',
                  },
                ].map((d) => {
                  const percent = Math.round((d.count / totalDeviceEvents) * 100);
                  const Icon = d.icon;
                  return (
                    <div key={d.name} className="flex flex-col gap-1 text-xs">
                      <div className="flex items-center justify-between text-slate-300">
                        <div className="flex items-center gap-2">
                          <Icon className="w-3.5 h-3.5 text-slate-400" />
                          <span>{d.name}</span>
                        </div>
                        <span className="font-mono font-bold text-white">{percent}%</span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full ${d.color} rounded-full transition-all duration-500`}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top Search Queries Leaderboard */}
            <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <Search className="w-4 h-4 text-purple-400" />
                  <span>Top Searches</span>
                </h3>
                <span className="text-[10px] text-slate-400">User intent</span>
              </div>

              <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
                {analytics?.topSearches && analytics.topSearches.length > 0 ? (
                  analytics.topSearches.map((s, idx) => (
                    <div
                      key={s.query}
                      className="flex items-center justify-between p-2 rounded-xl bg-white/5 text-xs"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-slate-500 font-mono font-bold w-4">{idx + 1}</span>
                        <span className="text-slate-200 font-medium truncate capitalize">
                          {s.query}
                        </span>
                      </div>
                      <span className="font-mono text-purple-400 font-bold px-2 py-0.5 rounded bg-purple-500/15 border border-purple-500/20 text-[10px]">
                        {s.count} searches
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="py-4 text-center text-xs text-slate-500">
                    No searches recorded yet
                  </div>
                )}
              </div>
            </div>

            {/* Streaming Server Health & Reliability */}
            <div className="bg-[#0e1424] border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <Server className="w-4 h-4 text-teal-400" />
                  <span>Server Reliability</span>
                </h3>
                <span className="text-[10px] text-emerald-400 font-bold">100% Online</span>
              </div>

              <div className="flex flex-col gap-2">
                {[
                  { name: 'CinePro Cloud Scraper', status: 'Operational', uptime: '99.8%' },
                  { name: 'TMDB Embed Gateway', status: 'Operational', uptime: '99.9%' },
                  { name: 'Fast Direct Mirrors', status: 'Operational', uptime: '100%' },
                  { name: 'Subtitle Proxy Cluster', status: 'Operational', uptime: '100%' },
                ].map((srv) => (
                  <div
                    key={srv.name}
                    className="flex items-center justify-between p-2 rounded-xl bg-[#131b2e] border border-white/5 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-slate-300 font-medium">{srv.name}</span>
                    </div>
                    <span className="text-emerald-400 font-mono text-[10px] font-bold">
                      {srv.uptime}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-4 px-8 text-center text-xs text-slate-500 flex items-center justify-between flex-wrap gap-2">
        <span>Notflix Studio Telemetry Engine v2.4</span>
        <span className="font-mono text-[11px]">
          Last telemetry sync: {lastFetchedTime.toLocaleTimeString()}
        </span>
      </footer>
    </div>
  );
};
