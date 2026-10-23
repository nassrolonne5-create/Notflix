import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Tv,
  Trophy,
  Play,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  X,
  RefreshCw,
  Search,
  GripVertical,
  AlertCircle,
  Download,
  Sparkles,
  Users,
} from 'lucide-react';
import { telemetry } from '../services/telemetry';

interface BroadcastAudioGraph {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  cleanGain: GainNode;
  bypassGain: GainNode;
}

const videoAudioGraphMap = new WeakMap<HTMLVideoElement, BroadcastAudioGraph>();

function attachOrUpdateBroadcastAudioFilter(
  video: HTMLVideoElement | null,
  enableCleanAudio: boolean
): void {
  if (!video || typeof window === 'undefined') return;
  try {
    let graph = videoAudioGraphMap.get(video);
    if (!graph) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx: AudioContext = new AudioCtx();
      const source = ctx.createMediaElementSource(video);

      // 1. Pre-gain headroom (-2.2 dB) to prevent over-driven satellite feed clipping
      const preGain = ctx.createGain();
      preGain.gain.value = 0.78;

      // 2. High-Pass Filter (95 Hz) to strip 50/60Hz satellite ground-loop hum & stadium rumble
      const highPass = ctx.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.value = 95;
      highPass.Q.value = 0.707;

      // 3. Peaking De-Harshness Filter (3.3 kHz, -4.5 dB) to tame clipped commentator mic distortion
      const deHarsh = ctx.createBiquadFilter();
      deHarsh.type = 'peaking';
      deHarsh.frequency.value = 3300;
      deHarsh.Q.value = 1.5;
      deHarsh.gain.value = -4.5;

      // 4. Low-Pass De-Hiss Filter (9.2 kHz) to remove high-frequency AAC quantization static/hiss
      const deHiss = ctx.createBiquadFilter();
      deHiss.type = 'lowpass';
      deHiss.frequency.value = 9200;
      deHiss.Q.value = 0.707;

      // 5. Broadcast Dynamics Compressor to level out sudden commentator shouts & crowd spikes
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -22;
      compressor.knee.value = 20;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.22;

      const cleanGain = ctx.createGain();
      const bypassGain = ctx.createGain();

      // Clean DSP path
      source.connect(preGain);
      preGain.connect(highPass);
      highPass.connect(deHarsh);
      deHarsh.connect(deHiss);
      deHiss.connect(compressor);
      compressor.connect(cleanGain);
      cleanGain.connect(ctx.destination);

      // Raw Bypass path
      source.connect(bypassGain);
      bypassGain.connect(ctx.destination);

      graph = { ctx, source, cleanGain, bypassGain };
      videoAudioGraphMap.set(video, graph);
    }

    if (graph.ctx.state === 'suspended') {
      graph.ctx.resume().catch(() => {});
    }

    graph.cleanGain.gain.setTargetAtTime(enableCleanAudio ? 1 : 0, graph.ctx.currentTime, 0.02);
    graph.bypassGain.gain.setTargetAtTime(enableCleanAudio ? 0 : 1, graph.ctx.currentTime, 0.02);
  } catch {
    // Fallback gracefully to native video audio if Web Audio API is restricted
  }
}

export interface RecommendedChannel {
  channelId: string;
  name: string;
  language: string;
  languageLabel: string;
  logo?: string;
  streamEndpoint?: string;
}

export interface LiveSportEvent {
  id: string;
  title: string;
  shortTitle?: string;
  sport: string;
  league: string;
  leagueSlug?: string;
  leagueLogo?: string;
  startTime: string;
  status: 'LIVE' | 'IN' | 'UPCOMING' | 'PRE' | 'FINISHED' | 'POST' | string;
  statusDetail?: string;
  homeTeam: {
    name: string;
    shortName?: string;
    logo?: string;
    score?: string | number;
  };
  awayTeam: {
    name: string;
    shortName?: string;
    logo?: string;
    score?: string | number;
  };
  broadcasts?: string[];
  recommendedChannels: RecommendedChannel[];
}

export interface LiveChannelStreamItem {
  id?: string;
  label: string;
  url: string;
  rawUrl?: string;
  quality: string;
  language: string;
  languageLabel?: string;
}

export interface LiveChannel {
  id: string;
  name: string;
  shortName?: string;
  network: string;
  category: string;
  language: string;
  languageLabel: string;
  country?: string;
  logo?: string;
  quality?: string;
  featured?: boolean;
  streams?: LiveChannelStreamItem[];
  defaultProxyUrl?: string;
}

export interface VerifiedStreamSource {
  id: string;
  server: string;
  url: string;
  rawUrl?: string;
  fallbackProxyUrl?: string;
  quality: string;
  language: string;
  languageLabel?: string;
  type?: string;
  verified?: boolean;
  latencyMs?: number;
}

const SPORT_FILTERS = [
  { id: 'all', label: 'All Sports' },
  { id: 'football', label: 'Football' },
  { id: 'basketball', label: 'Basketball' },
  { id: 'american-football', label: 'NFL' },
  { id: 'hockey', label: 'NHL' },
  { id: 'mma', label: 'MMA & UFC' },
  { id: 'motorsport', label: 'Motorsport' },
  { id: 'tennis', label: 'Tennis' },
];

const CHANNEL_CATEGORIES = [
  { id: 'all', label: 'All Networks (102)' },
  { id: 'bein', label: 'beIN Sports' },
  { id: 'mena', label: 'MENA & SSC / Alkass' },
  { id: 'movies', label: 'Movies & Cinema' },
  { id: 'entertainment', label: 'MBC & Arabic TV' },
  { id: 'europe', label: 'European Sports' },
  { id: 'sky', label: 'Sky Sports' },
  { id: 'usa', label: 'NBA / NFL / MLB' },
  { id: 'espn', label: 'ESPN' },
  { id: 'fox', label: 'Fox Sports' },
  { id: 'motorsport', label: 'Motorsport' },
  { id: 'combat', label: 'UFC & Combat' },
];

const CHANNEL_LANGUAGES = [
  { id: 'all', label: 'All' },
  { id: 'en', label: 'EN' },
  { id: 'ar', label: 'AR' },
  { id: 'fr', label: 'FR' },
  { id: 'es', label: 'ES' },
  { id: 'de', label: 'DE' },
  { id: 'pt', label: 'PT' },
  { id: 'tr', label: 'TR' },
];

function isEventLive(status?: string): boolean {
  const s = String(status || '').toUpperCase();
  return (
    s === 'LIVE' ||
    s === 'IN' ||
    s === 'IN_PROGRESS' ||
    s === 'HALFTIME' ||
    s === 'HT' ||
    s === '1H' ||
    s === '2H' ||
    s === 'Q1' ||
    s === 'Q2' ||
    s === 'Q3' ||
    s === 'Q4' ||
    s === 'OT'
  );
}

function isEventFinished(status?: string): boolean {
  const s = String(status || '').toUpperCase();
  return s === 'FINISHED' || s === 'POST' || s === 'FINAL' || s === 'FT' || s === 'ENDED';
}

function formatKickoffTime(isoString?: string): {
  time: string;
  dateLabel: string;
  relative: string;
  isToday: boolean;
} {
  if (!isoString) {
    return { time: 'TBD', dateLabel: 'Today', relative: 'Scheduled', isToday: true };
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return { time: 'TBD', dateLabel: 'Today', relative: 'Scheduled', isToday: true };
  }
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const dateLabel = isToday
    ? 'Today'
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const diffMs = date.getTime() - now.getTime();
  let relative = 'Starting soon';

  if (diffMs > 0) {
    const mins = Math.round(diffMs / 60000);
    if (mins < 60) {
      relative = `in ${mins}m`;
    } else if (mins < 1440) {
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      relative = remMins > 0 ? `in ${hrs}h ${remMins}m` : `in ${hrs}h`;
    } else {
      relative = dateLabel;
    }
  }

  return { time, dateLabel, relative, isToday };
}

function normalizeSportMatch(eventSport: string, filterSport: string): boolean {
  if (filterSport === 'all') return true;
  const s = String(eventSport || '').toLowerCase();
  if (filterSport === 'football') return s === 'soccer';
  if (filterSport === 'mma') return s === 'mma' || s === 'ufc' || s === 'boxing' || s === 'combat';
  if (filterSport === 'motorsport') return s === 'f1' || s === 'racing' || s === 'motorsport';
  if (filterSport === 'american-football') return s === 'football' || s === 'nfl' || s === 'american-football';
  if (filterSport === 'hockey') return s === 'hockey' || s === 'nhl';
  return s.includes(filterSport);
}

function toLiveArenaSeoSlug(text: string): string {
  return (
    (text || 'live')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'live'
  );
}

export function buildMatchSeoPath(ev: LiveSportEvent): string {
  const idPart = String(ev?.id || 'match').trim();
  const homeName = String(ev?.homeTeam?.name || '').trim();
  const awayName = String(ev?.awayTeam?.name || '').trim();
  const leagueName = String(ev?.league || '').trim();
  const rawTitle =
    homeName && awayName
      ? `${homeName} vs ${awayName} ${leagueName}`
      : `${ev?.title || 'live-match'} ${leagueName}`;
  return `/live/match/${encodeURIComponent(idPart)}-${toLiveArenaSeoSlug(rawTitle)}`;
}

export function buildChannelSeoPath(channelId: string): string {
  return `/live/channel/${encodeURIComponent(String(channelId || '').trim())}`;
}

function isLiveArenaUrlPath(pathname: string): boolean {
  return /^\/(live|arena)(\/|$)/i.test(pathname || '');
}

export const LiveTvArena: React.FC = () => {
  const [isArenaOpen, setIsArenaOpen] = useState<boolean>(false);
  const [isMiniPlayerMode, setIsMiniPlayerMode] = useState(false);
  const [activeView, setActiveView] = useState<'events' | 'channels'>('events');

  // Data state
  const [events, setEvents] = useState<LiveSportEvent[]>([]);
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(false);

  // Filters & Search
  const [sportFilter, setSportFilter] = useState<string>('all');
  const [statusTab, setStatusTab] = useState<'all' | 'live' | 'upcoming' | 'finished'>('all');
  const [channelCategory, setChannelCategory] = useState<string>('all');
  const [channelLang, setChannelLang] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);

  // Active Playback State
  const [activeChannel, setActiveChannel] = useState<LiveChannel | null>(null);
  const [activeMatch, setActiveMatch] = useState<LiveSportEvent | null>(null);
  const [sources, setSources] = useState<VerifiedStreamSource[]>([]);
  const [activeSourceIndex, setActiveSourceIndex] = useState<number>(0);
  const [usingFallbackProxy, setUsingFallbackProxy] = useState<boolean>(false);
  const [loadingStream, setLoadingStream] = useState<boolean>(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isAudioCleanEnabled, setIsAudioCleanEnabled] = useState<boolean>(true);
  const [liveArenaViewersCount, setLiveArenaViewersCount] = useState<number>(0);

  // Video & HLS refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const arenaScrollRef = useRef<HTMLDivElement | null>(null);

  // Draggable Floating Icon / Mini-Player Position State
  const floatingOrbElRef = useRef<HTMLDivElement | null>(null);
  const [orbPos, setOrbPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === 'undefined') return { x: 20, y: 120 };
    try {
      const saved = localStorage.getItem('notflix_live_orb_pos_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          return {
            x: Math.min(Math.max(8, parsed.x), Math.max(8, window.innerWidth - 172)),
            y: Math.min(Math.max(8, parsed.y), Math.max(8, window.innerHeight - 80)),
          };
        }
      }
    } catch {}
    return {
      x: Math.max(12, window.innerWidth - 176),
      y: Math.max(76, window.innerHeight - 168),
    };
  });
  const orbPosRef = useRef<{ x: number; y: number }>(orbPos);

  useEffect(() => {
    orbPosRef.current = orbPos;
    if (floatingOrbElRef.current && !dragRef.current.isDown) {
      floatingOrbElRef.current.style.transform = `translate3d(${orbPos.x}px, ${orbPos.y}px, 0)`;
    }
  }, [orbPos]);

  // Transparency state when user scrolls/navigates up and down for movies or series
  const [isNavigatingPage, setIsNavigatingPage] = useState<boolean>(false);
  const navScrollTimeoutRef = useRef<number | null>(null);

  // Sliding index inside the compact Live Arena pill (0 = LIVE ARENA brand, then slides in Live / Upcoming / Results)
  const [orbTickerIndex, setOrbTickerIndex] = useState<number>(0);

  const dragRef = useRef<{
    isDown: boolean;
    hasMoved: boolean;
    pointerId: number | null;
    startX: number;
    startY: number;
    initialOrbX: number;
    initialOrbY: number;
    offsetX: number;
    offsetY: number;
  }>({
    isDown: false,
    hasMoved: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    initialOrbX: 0,
    initialOrbY: 0,
    offsetX: 0,
    offsetY: 0,
  });

  useEffect(() => {
    const handleResize = () => {
      setOrbPos((prev) => {
        const el = floatingOrbElRef.current;
        const maxWidth = el?.offsetWidth || (isMiniPlayerMode ? 290 : 172);
        const maxHeight = el?.offsetHeight || (isMiniPlayerMode ? 200 : 56);
        const clamped = {
          x: Math.min(Math.max(8, prev.x), Math.max(8, window.innerWidth - maxWidth - 8)),
          y: Math.min(Math.max(8, prev.y), Math.max(8, window.innerHeight - maxHeight - 8)),
        };
        orbPosRef.current = clamped;
        return clamped;
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMiniPlayerMode]);

  // Make floating Live Arena transparent while navigating/scrolling up and down for movies or series
  useEffect(() => {
    if (isArenaOpen) {
      setIsNavigatingPage(false);
      return;
    }

    const triggerNavTransparency = () => {
      if (dragRef.current.isDown) return;
      setIsNavigatingPage(true);
      if (navScrollTimeoutRef.current !== null) {
        window.clearTimeout(navScrollTimeoutRef.current);
      }
      navScrollTimeoutRef.current = window.setTimeout(() => {
        setIsNavigatingPage(false);
      }, 420);
    };

    window.addEventListener('scroll', triggerNavTransparency, { passive: true, capture: true });
    window.addEventListener('wheel', triggerNavTransparency, { passive: true });
    window.addEventListener('touchmove', triggerNavTransparency, { passive: true });

    return () => {
      window.removeEventListener('scroll', triggerNavTransparency, true);
      window.removeEventListener('wheel', triggerNavTransparency);
      window.removeEventListener('touchmove', triggerNavTransparency);
      if (navScrollTimeoutRef.current !== null) {
        window.clearTimeout(navScrollTimeoutRef.current);
      }
    };
  }, [isArenaOpen]);

  const fetchLiveEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const res = await fetch('/api/live/events');
      const data = await res.json();
      if (Array.isArray(data?.events)) {
        setEvents(data.events);
      }
    } catch (err) {
      console.warn('Failed to load live events:', err);
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  const fetchLiveChannels = useCallback(async () => {
    setLoadingChannels(true);
    try {
      const res = await fetch('/api/live/channels');
      const data = await res.json();
      if (Array.isArray(data?.channels)) {
        setChannels(data.channels);
      }
    } catch (err) {
      console.warn('Failed to load live channels:', err);
    } finally {
      setLoadingChannels(false);
    }
  }, []);

  const openArenaWithSeoUrl = useCallback((_targetPath?: string) => {
    setIsArenaOpen(true);
    setIsMiniPlayerMode(false);
  }, []);

  const closeArenaRestoreSeoUrl = useCallback((minimizeToFloating = false) => {
    setIsArenaOpen(false);
    if (minimizeToFloating) {
      setIsMiniPlayerMode(true);
    }
    if (typeof window !== 'undefined' && isLiveArenaUrlPath(window.location.pathname)) {
      window.history.replaceState({}, '', '/');
    }
    const existingArenaSchema = document.getElementById('notflix-live-arena-jsonld');
    if (existingArenaSchema) existingArenaSchema.remove();
  }, []);

  useEffect(() => {
    const handleOpenLive = () => {
      openArenaWithSeoUrl();
      fetchLiveEvents();
      fetchLiveChannels();
    };
    window.addEventListener('notflix:open-live-tv', handleOpenLive);
    return () => window.removeEventListener('notflix:open-live-tv', handleOpenLive);
  }, [fetchLiveEvents, fetchLiveChannels, openArenaWithSeoUrl]);

  useEffect(() => {
    fetchLiveEvents();
    fetchLiveChannels();
    const interval = window.setInterval(() => {
      fetchLiveEvents();
    }, 40000);
    return () => window.clearInterval(interval);
  }, [fetchLiveEvents, fetchLiveChannels]);

  // Real-time Live Arena viewers count poll (aggregated viewers only)
  const fetchLiveArenaViewers = useCallback(async () => {
    try {
      const res = await fetch('/api/live/viewers');
      if (res.ok) {
        const data = await res.json();
        if (typeof data.liveArenaViewers === 'number') {
          setLiveArenaViewersCount(data.liveArenaViewers);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchLiveArenaViewers();
    const interval = window.setInterval(fetchLiveArenaViewers, 20000);
    return () => window.clearInterval(interval);
  }, [fetchLiveArenaViewers]);

  // Active viewer presence tracking while user is in Live Arena
  useEffect(() => {
    if (!isArenaOpen && !isMiniPlayerMode) return;
    telemetry.trackArenaPresence(25);
    const interval = window.setInterval(() => {
      telemetry.trackArenaPresence(25);
    }, 25000);
    return () => window.clearInterval(interval);
  }, [isArenaOpen, isMiniPlayerMode]);

  const scrollToPlayer = useCallback(() => {
    window.setTimeout(() => {
      if (playerContainerRef.current) {
        playerContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (arenaScrollRef.current) {
        arenaScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }, 60);
  }, []);

  const tuneChannel = useCallback(
    async (channelId: string, matchContext?: LiveSportEvent | null) => {
      if (!channelId) return;
      if (matchContext !== undefined) {
        setActiveMatch(matchContext);
      }
      setLoadingStream(true);
      setStreamError(null);
      setUsingFallbackProxy(false);

      const existingCh = channels.find((c) => c.id === channelId);
      if (existingCh) {
        setActiveChannel(existingCh);
      } else {
        const recCh = matchContext?.recommendedChannels?.find((r) => r.channelId === channelId);
        setActiveChannel({
          id: channelId,
          name: recCh?.name || channelId.replace(/-/g, ' ').toUpperCase(),
          network: 'Live Sports Network',
          category: 'bein',
          language: recCh?.language || 'en',
          languageLabel: recCh?.languageLabel || 'English',
          logo: recCh?.logo,
          quality: '1080p HD',
        });
      }

      scrollToPlayer();

      try {
        const res = await fetch(`/api/live/stream/${encodeURIComponent(channelId)}`);
        const data = await res.json();
        const fetchedSources: VerifiedStreamSource[] = Array.isArray(data?.sources)
          ? data.sources.filter((s: any) => Boolean(s?.url))
          : [];

        if (existingCh && Array.isArray(existingCh.streams)) {
          existingCh.streams.forEach((st, idx) => {
            if (st.url && !fetchedSources.some((fs) => (fs.rawUrl && fs.rawUrl === st.rawUrl) || fs.url === st.url)) {
              fetchedSources.push({
                id: `${channelId}-dir-${idx}`,
                server: st.label || `${existingCh.name} Mirror ${idx + 1}`,
                url: st.url,
                rawUrl: st.rawUrl,
                quality: st.quality || '1080p',
                language: existingCh.languageLabel || 'English',
                languageLabel: existingCh.languageLabel || 'English',
              });
            }
          });
        }

        if (data?.channel) {
          setActiveChannel((prev) => ({
            ...(prev || {
              id: channelId,
              network: 'Live Sports',
              category: 'bein',
              language: 'en',
              languageLabel: 'English',
            }),
            name: data.channel.name || prev?.name || channelId,
            logo: data.channel.logo || prev?.logo,
            languageLabel: data.channel.languageLabel || data.channel.language || prev?.languageLabel || 'English',
          }));
        }

        if (fetchedSources.length > 0) {
          setSources(fetchedSources);
          setActiveSourceIndex(0);
        } else if (existingCh?.defaultProxyUrl) {
          setSources([
            {
              id: `${channelId}-default`,
              server: `${existingCh.name} (Primary HD)`,
              url: existingCh.defaultProxyUrl,
              quality: existingCh.quality || '1080p',
              language: existingCh.languageLabel || 'English',
            },
          ]);
          setActiveSourceIndex(0);
        } else {
          setSources([]);
          setStreamError('Stream mirrors are synchronizing. Try switching server or commentary language below.');
        }
      } catch {
        setStreamError('Unable to reach live stream gateway. Please retry or select another channel.');
      } finally {
        setLoadingStream(false);
      }
    },
    [channels, scrollToPlayer]
  );

  const playEventDirectly = useCallback(
    (ev: LiveSportEvent, preferredChannelId?: string) => {
      if (preferredChannelId) {
        tuneChannel(preferredChannelId, ev);
        return;
      }
      if (Array.isArray(ev.recommendedChannels) && ev.recommendedChannels.length > 0) {
        tuneChannel(ev.recommendedChannels[0].channelId, ev);
        return;
      }
      const s = (ev.sport || '').toLowerCase();
      const fallbackCh =
        channels.find((c) => {
          const cName = c.name.toLowerCase();
          if (s.includes('soccer') || s.includes('football')) {
            return cName.includes('bein') || cName.includes('sky sports');
          }
          if (s.includes('basketball')) {
            return c.category === 'us-sports' || cName.includes('nba') || cName.includes('espn');
          }
          if (s.includes('mma') || s.includes('ufc') || s.includes('boxing')) {
            return c.category === 'combat' || cName.includes('ufc') || cName.includes('tnt');
          }
          if (s.includes('motor') || s.includes('f1')) {
            return c.category === 'motorsport' || cName.includes('f1');
          }
          return false;
        }) || channels[0];

      if (fallbackCh) {
        tuneChannel(fallbackCh.id, ev);
      } else {
        tuneChannel('bein-sports-1-ar', ev);
      }
    },
    [channels, tuneChannel]
  );

  // Keep each device session independent: never auto-tune a channel or match from the browser URL
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isLiveArenaUrlPath(window.location.pathname)) {
      window.history.replaceState({}, '', '/');
    }
  }, []);

  // Dynamic Client-Side SEO Meta, OpenGraph, Canonical & Schema.org JSON-LD for Live Arena
  useEffect(() => {
    if (!isArenaOpen || typeof window === 'undefined') return;

    const origin = window.location.origin || 'https://notflixtv.com';
    let title =
      'Notflix Arena — Watch Live Sports, Football Matches & 24/7 TV Channels Free in 1080p HD';
    let desc =
      'Watch live football matches (UEFA Champions League, Premier League, La Liga, Serie A, Saudi Pro League), NBA, UFC, F1 & 102+ 24/7 live TV channels (beIN Sports, Sky Sports, ESPN, SSC) free in 1080p HD.';
    let canonicalPath = '/live';
    let ogImage = 'https://image.tmdb.org/t/p/w1280/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg';
    let jsonLdPayload: Record<string, any> | null = null;

    if (activeMatch) {
      const matchTitle =
        activeMatch.homeTeam?.name && activeMatch.awayTeam?.name
          ? `${activeMatch.homeTeam.name} vs ${activeMatch.awayTeam.name}`
          : activeMatch.title || 'Live Sports Match';
      const leagueName = activeMatch.league || 'Live Sports Broadcast';
      const chNames = Array.isArray(activeMatch.recommendedChannels)
        ? activeMatch.recommendedChannels
            .slice(0, 4)
            .map((c) => c.name.replace(/\s*\([^)]*\)/g, ''))
            .join(', ')
        : activeChannel?.name || 'beIN Sports HD, Sky Sports HD';

      title = `Watch ${matchTitle} Live Stream Free HD — ${leagueName} | Notflix Arena`;
      desc = `Watch ${matchTitle} (${leagueName}) live stream online free in 1080p Full HD on Notflix Arena. Multi-language commentary on ${chNames}.`.slice(
        0,
        158
      );
      canonicalPath = buildMatchSeoPath(activeMatch);
      const logoCandidate = [
        activeMatch.homeTeam?.logo,
        activeMatch.awayTeam?.logo,
        activeMatch.leagueLogo,
      ].find((u) => typeof u === 'string' && u.startsWith('http'));
      if (logoCandidate) ogImage = logoCandidate;

      const startIso = activeMatch.startTime || new Date().toISOString();
      const startMs = Date.parse(startIso) || Date.now();
      const endIso = new Date(startMs + 2 * 60 * 60 * 1000).toISOString();
      const fullUrl = `${origin}${canonicalPath}`;

      jsonLdPayload = {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'SportsEvent',
            '@id': `${fullUrl}#sportsevent`,
            name: `${matchTitle} — ${leagueName}`,
            description: desc,
            url: fullUrl,
            startDate: startIso,
            endDate: endIso,
            eventStatus: isEventLive(activeMatch.status)
              ? 'https://schema.org/EventInProgress'
              : 'https://schema.org/EventScheduled',
            eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
            sport: activeMatch.sport || 'Soccer',
            image: [logoCandidate, ogImage].filter(Boolean),
            homeTeam: {
              '@type': 'SportsTeam',
              name: activeMatch.homeTeam?.name || 'Home Team',
            },
            awayTeam: {
              '@type': 'SportsTeam',
              name: activeMatch.awayTeam?.name || 'Away Team',
            },
          },
          {
            '@type': 'BroadcastEvent',
            '@id': `${fullUrl}#broadcast`,
            name: `Live Broadcast: ${matchTitle} (${leagueName})`,
            description: desc,
            isLiveBroadcast: true,
            startDate: startIso,
            endDate: endIso,
            videoFormat: 'HD 1080p',
            inLanguage: ['en', 'ar', 'fr', 'es'],
            workPerformed: { '@id': `${fullUrl}#sportsevent` },
          },
        ],
      };
    } else if (activeChannel) {
      const cleanName = activeChannel.name.replace(/\s*\([^)]*\)/g, '').trim();
      const langLabel = activeChannel.languageLabel || 'English';
      title = `Watch ${cleanName} (${langLabel}) Live Stream 24/7 Free in 1080p HD | Notflix Arena`;
      desc = `Watch ${activeChannel.name} live stream 24/7 online free in 1080p Full HD on Notflix Arena. Instant multi-mirror sports and entertainment broadcast.`;
      canonicalPath = buildChannelSeoPath(activeChannel.id);
      if (activeChannel.logo && activeChannel.logo.startsWith('http')) {
        ogImage = activeChannel.logo;
      }
      const fullUrl = `${origin}${canonicalPath}`;
      jsonLdPayload = {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'TelevisionChannel',
            '@id': `${fullUrl}#channel`,
            name: activeChannel.name,
            url: fullUrl,
            image: ogImage,
            description: desc,
            inLanguage: activeChannel.language || 'en',
          },
          {
            '@type': 'BroadcastEvent',
            name: `${cleanName} 24/7 Live Broadcast`,
            isLiveBroadcast: true,
            videoFormat: '1080p HD',
            inLanguage: activeChannel.language || 'en',
            publishedOn: { '@id': `${fullUrl}#channel` },
          },
        ],
      };
    } else {
      const fullUrl = `${origin}/live`;
      jsonLdPayload = {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: title,
        description: desc,
        url: fullUrl,
      };
    }

    const fullCanonical = `${origin}${canonicalPath}`;
    document.title = title;
    const setMeta = (selector: string, attr: string, value: string) => {
      const el = document.querySelector(selector);
      if (el) el.setAttribute(attr, value);
    };
    setMeta('meta[name="description"]', 'content', desc);
    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', desc);
    setMeta('meta[property="og:url"]', 'content', fullCanonical);
    setMeta('meta[property="og:image"]', 'content', ogImage);
    setMeta('meta[name="twitter:title"]', 'content', title);
    setMeta('meta[name="twitter:description"]', 'content', desc);
    setMeta('meta[name="twitter:image"]', 'content', ogImage);
    setMeta('link[rel="canonical"]', 'href', fullCanonical);

    try {
      const schemaId = 'notflix-live-arena-jsonld';
      let scriptEl = document.getElementById(schemaId) as HTMLScriptElement | null;
      if (!scriptEl) {
        scriptEl = document.createElement('script');
        scriptEl.id = schemaId;
        scriptEl.type = 'application/ld+json';
        document.head.appendChild(scriptEl);
      }
      scriptEl.textContent = JSON.stringify(jsonLdPayload);
    } catch {}
  }, [isArenaOpen, activeMatch, activeChannel, activeView]);

  // Real-time Telemetry Tracking for Live Arena (sends play & 25s heartbeats to Admin Dashboard)
  useEffect(() => {
    if ((!isArenaOpen && !isMiniPlayerMode) || (!activeMatch && !activeChannel)) return;

    const telemetryTitle = activeMatch
      ? activeMatch.homeTeam?.name && activeMatch.awayTeam?.name
        ? `${activeMatch.homeTeam.name} vs ${activeMatch.awayTeam.name} (${activeMatch.league || 'Live'})`
        : `${activeMatch.title} (${activeMatch.league || 'Live'})`
      : activeChannel?.name || 'Live Arena Broadcast';

    const telemetryPoster =
      activeMatch?.homeTeam?.logo ||
      activeMatch?.leagueLogo ||
      activeChannel?.logo ||
      '';

    const serverLabel = activeChannel?.name || 'Live Arena HD';

    telemetry.trackLivePlay(telemetryTitle, telemetryPoster, serverLabel);

    const hbInterval = window.setInterval(() => {
      telemetry.trackLiveHeartbeat(telemetryTitle, 25, telemetryPoster, serverLabel);
    }, 25000);

    return () => {
      window.clearInterval(hbInterval);
    };
  }, [isArenaOpen, isMiniPlayerMode, activeMatch?.id, activeChannel?.id]);

  useEffect(() => {
    const video = videoRef.current;
    const currentSource = sources[activeSourceIndex];
    if (!video || !currentSource || (!isArenaOpen && !isMiniPlayerMode)) {
      return;
    }

    const playUrl = currentSource.url;
    if (!playUrl) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    setStreamError(null);
    setLoadingStream(true);
    let playbackStarted = false;
    let failoverTriggered = false;
    let recoveryAttempts = 0;
    let recoveryTimeoutId: number | null = null;

    const showSignalInterruptedOverlay = () => {
      if (failoverTriggered) return;
      failoverTriggered = true;
      if (activeSourceIndex + 1 < sources.length) {
        setUsingFallbackProxy(false);
        setActiveSourceIndex((prev) => prev + 1);
      } else if (
        activeMatch &&
        Array.isArray(activeMatch.recommendedChannels) &&
        activeMatch.recommendedChannels.length > 1 &&
        activeChannel
      ) {
        const curIdx = activeMatch.recommendedChannels.findIndex(
          (rc) => rc.channelId === activeChannel.id
        );
        const nextIdx = curIdx >= 0 ? curIdx + 1 : 1;
        if (nextIdx < activeMatch.recommendedChannels.length) {
          tuneChannel(activeMatch.recommendedChannels[nextIdx].channelId, activeMatch);
          return;
        }
        setLoadingStream(false);
        setStreamError('Signal interrupted on this mirror. Pick another server or commentary option.');
      } else {
        setLoadingStream(false);
        setStreamError('Signal interrupted on this mirror. Pick another server or commentary option.');
      }
    };

    const watchdogTimer = window.setTimeout(() => {
      if (!playbackStarted) {
        showSignalInterruptedOverlay();
      }
    }, 22000);

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false, // Keep false for 1080p stability on mobile 4G
        backBufferLength: 60,
        maxBufferLength: 45,
        maxMaxBufferLength: 90,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        // Built-in automatic retries before firing a fatal error
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 1000,
        levelLoadingTimeOut: 15000,
        levelLoadingMaxRetry: 6,
        levelLoadingRetryDelay: 1000,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
      });
      hlsRef.current = hls;
      hls.loadSource(playUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.muted = isMuted;
        attachOrUpdateBroadcastAudioFilter(video, isAudioCleanEnabled);
        video
          .play()
          .then(() => {
            setIsPlaying(true);
            attachOrUpdateBroadcastAudioFilter(video, isAudioCleanEnabled);
          })
          .catch(() => {
            video.muted = true;
            setIsMuted(true);
            video.play().then(() => setIsPlaying(true)).catch(() => {});
          });
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        // Reset error counter whenever a video segment loads successfully
        recoveryAttempts = 0;
        if (!playbackStarted) {
          playbackStarted = true;
          window.clearTimeout(watchdogTimer);
          setLoadingStream(false);
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (!playbackStarted) {
          playbackStarted = true;
          window.clearTimeout(watchdogTimer);
          setLoadingStream(false);
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return; // Ignore non-fatal warnings!

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (recoveryAttempts < 5) {
            recoveryAttempts++;
            console.log(`Auto-recovering stream network hiccup (${recoveryAttempts}/5)...`);
            if (recoveryTimeoutId !== null) {
              window.clearTimeout(recoveryTimeoutId);
            }
            recoveryTimeoutId = window.setTimeout(() => {
              if (hlsRef.current === hls) {
                hls.startLoad();
              }
            }, 1000);
            return; // Do NOT show the "Signal interrupted / Retry" screen yet
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (recoveryAttempts < 3) {
            recoveryAttempts++;
            hls.recoverMediaError();
            return;
          }
        }

        // Only show the "Retry Signal" UI if 5 consecutive auto-recoveries failed
        showSignalInterruptedOverlay();
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playUrl;
      video.addEventListener(
        'loadedmetadata',
        () => {
          playbackStarted = true;
          window.clearTimeout(watchdogTimer);
          setLoadingStream(false);
          video.play().then(() => setIsPlaying(true)).catch(() => {});
        },
        { once: true }
      );
      video.addEventListener(
        'error',
        () => {
          showSignalInterruptedOverlay();
        },
        { once: true }
      );
    }

    return () => {
      window.clearTimeout(watchdogTimer);
      if (recoveryTimeoutId !== null) {
        window.clearTimeout(recoveryTimeoutId);
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [sources, activeSourceIndex, usingFallbackProxy, isArenaOpen, isMiniPlayerMode]);

  useEffect(() => {
    if (videoRef.current) {
      attachOrUpdateBroadcastAudioFilter(videoRef.current, isAudioCleanEnabled);
    }
  }, [isAudioCleanEnabled]);

  const stopLiveStream = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
    setActiveChannel(null);
    setActiveMatch(null);
    setSources([]);
    setIsPlaying(false);
    setIsMiniPlayerMode(false);
  }, []);

  const handleOrbPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag="true"]')) return;

    if (navScrollTimeoutRef.current !== null) {
      window.clearTimeout(navScrollTimeoutRef.current);
      navScrollTimeoutRef.current = null;
    }
    setIsNavigatingPage(false);

    const currentX = orbPosRef.current.x;
    const currentY = orbPosRef.current.y;

    dragRef.current = {
      isDown: true,
      hasMoved: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initialOrbX: currentX,
      initialOrbY: currentY,
      offsetX: e.clientX - currentX,
      offsetY: e.clientY - currentY,
    };

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };

  const handleOrbPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current.isDown) return;
    if (dragRef.current.pointerId !== null && e.pointerId !== dragRef.current.pointerId) return;

    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    if (!dragRef.current.hasMoved) {
      if (Math.hypot(dx, dy) < 3) return;
      dragRef.current.hasMoved = true;
      // Re-anchor offset at the exact moment movement starts so there is zero initial jump
      dragRef.current.offsetX = e.clientX - dragRef.current.initialOrbX;
      dragRef.current.offsetY = e.clientY - dragRef.current.initialOrbY;
    }

    const el = floatingOrbElRef.current;
    const widgetW = el?.offsetWidth || (isMiniPlayerMode ? 290 : 172);
    const widgetH = el?.offsetHeight || (isMiniPlayerMode ? 200 : 52);

    const nextX = Math.min(
      Math.max(6, e.clientX - dragRef.current.offsetX),
      Math.max(6, window.innerWidth - widgetW - 6)
    );
    const nextY = Math.min(
      Math.max(6, e.clientY - dragRef.current.offsetY),
      Math.max(6, window.innerHeight - widgetH - 6)
    );

    orbPosRef.current = { x: nextX, y: nextY };
    if (el) {
      el.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
    }
  };

  const finishOrbPointerInteraction = (e: React.PointerEvent<HTMLElement>, isCancel = false) => {
    if (!dragRef.current.isDown) return;
    const wasDrag = dragRef.current.hasMoved;
    dragRef.current.isDown = false;
    dragRef.current.pointerId = null;

    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {}

    if (wasDrag) {
      const finalPos = { ...orbPosRef.current };
      setOrbPos(finalPos);
      try {
        localStorage.setItem('notflix_live_orb_pos_v1', JSON.stringify(finalPos));
      } catch {}
    } else if (!isCancel && !isMiniPlayerMode) {
      openArenaWithSeoUrl('/live');
      fetchLiveEvents();
      fetchLiveChannels();
    }
  };

  const baseFilteredEvents = useMemo(() => {
    return events.filter((ev) => {
      if (!normalizeSportMatch(ev.sport, sportFilter)) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchHome = ev.homeTeam?.name?.toLowerCase().includes(q);
        const matchAway = ev.awayTeam?.name?.toLowerCase().includes(q);
        const matchLeague = ev.league?.toLowerCase().includes(q);
        const matchTitle = ev.title?.toLowerCase().includes(q);
        const matchChannel = ev.recommendedChannels?.some((c) => c.name.toLowerCase().includes(q));
        if (!matchHome && !matchAway && !matchLeague && !matchTitle && !matchChannel) return false;
      }
      return true;
    });
  }, [events, sportFilter, searchQuery]);

  const liveEvents = useMemo(
    () => baseFilteredEvents.filter((ev) => isEventLive(ev.status)),
    [baseFilteredEvents]
  );

  const upcomingEvents = useMemo(
    () => baseFilteredEvents.filter((ev) => !isEventLive(ev.status) && !isEventFinished(ev.status)),
    [baseFilteredEvents]
  );

  const finishedEvents = useMemo(
    () => baseFilteredEvents.filter((ev) => isEventFinished(ev.status)),
    [baseFilteredEvents]
  );

  const allLiveEventsGlobal = useMemo(
    () => events.filter((ev) => isEventLive(ev.status)),
    [events]
  );
  const allUpcomingEventsGlobal = useMemo(
    () => events.filter((ev) => !isEventLive(ev.status) && !isEventFinished(ev.status)),
    [events]
  );
  const allFinishedEventsGlobal = useMemo(
    () => events.filter((ev) => isEventFinished(ev.status)),
    [events]
  );

  // Sliding sequence inside the original compact pill:
  // First comes "LIVE ARENA", then it disappears and slides in Live Results, Upcoming Events, and Finished Results
  const orbSlideSequence = useMemo(() => {
    const items: Array<{ kind: 'brand' } | { kind: 'event'; event: LiveSportEvent }> = [
      { kind: 'brand' },
    ];
    const maxRounds = 8;
    for (let i = 0; i < maxRounds; i++) {
      if (allLiveEventsGlobal.length > 0) {
        items.push({ kind: 'event', event: allLiveEventsGlobal[i % allLiveEventsGlobal.length] });
      }
      if (i < allUpcomingEventsGlobal.length) {
        items.push({ kind: 'event', event: allUpcomingEventsGlobal[i] });
      }
      if (i < allFinishedEventsGlobal.length) {
        items.push({ kind: 'event', event: allFinishedEventsGlobal[i] });
      }
      // Bring back "LIVE ARENA" brand slide after every cycle of events
      if (items.length > 1) {
        items.push({ kind: 'brand' });
      }
    }
    return items;
  }, [allLiveEventsGlobal, allUpcomingEventsGlobal, allFinishedEventsGlobal]);

  useEffect(() => {
    if (isArenaOpen || orbSlideSequence.length <= 1) return;
    const timer = window.setInterval(() => {
      setOrbTickerIndex((prev) => (prev + 1) % orbSlideSequence.length);
    }, 2800);
    return () => window.clearInterval(timer);
  }, [isArenaOpen, orbSlideSequence.length]);

  const upcomingLeagueGroups = useMemo(() => {
    const groups = new Map<
      string,
      { league: string; leagueLogo?: string; matches: LiveSportEvent[] }
    >();
    upcomingEvents.forEach((ev) => {
      const key = ev.league || 'International';
      const existing = groups.get(key);
      if (existing) {
        existing.matches.push(ev);
      } else {
        groups.set(key, {
          league: key,
          leagueLogo: ev.leagueLogo,
          matches: [ev],
        });
      }
    });
    return Array.from(groups.values());
  }, [upcomingEvents]);

  const totalLiveCount = allLiveEventsGlobal.length;

  const filteredChannels = useMemo(() => {
    return channels.filter((ch) => {
      if (channelCategory !== 'all') {
        const cat = String(ch.category || '').toLowerCase();
        if (channelCategory === 'europe' && cat !== 'europe' && cat !== 'eurosport') return false;
        else if (channelCategory === 'usa' && cat !== 'usa' && cat !== 'us-sports') return false;
        else if (channelCategory !== 'europe' && channelCategory !== 'usa' && cat !== channelCategory) return false;
      }
      if (channelLang !== 'all' && ch.language !== channelLang) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = ch.name?.toLowerCase().includes(q);
        const matchNet = ch.network?.toLowerCase().includes(q);
        const matchLang = ch.languageLabel?.toLowerCase().includes(q);
        const matchCat = ch.category?.toLowerCase().includes(q);
        if (!matchName && !matchNet && !matchLang && !matchCat) return false;
      }
      return true;
    });
  }, [channels, channelCategory, channelLang, searchQuery]);

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  };

  const toggleFullscreen = () => {
    const container = playerContainerRef.current || videoRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (container.requestFullscreen) {
      container.requestFullscreen().catch(() => {});
    }
  };

  return (
    <>
      {/* =====================================================================
          1. MOVABLE FLOATING LIVE TV ICON / DRAGGABLE MINI-PLAYER
             - Original compact pill design
             - First shows "LIVE ARENA", then disappears & slides in Live/Upcoming/Result events
             - Becomes transparent when scrolling/navigating up & down
          ===================================================================== */}
      {!isArenaOpen && (
        <div
          ref={floatingOrbElRef}
          style={{
            left: 0,
            top: 0,
            transform: `translate3d(${orbPos.x}px, ${orbPos.y}px, 0)`,
            touchAction: 'none',
            willChange: 'transform',
          }}
          onPointerDown={handleOrbPointerDown}
          onPointerMove={handleOrbPointerMove}
          onPointerUp={(e) => finishOrbPointerInteraction(e, false)}
          onPointerCancel={(e) => finishOrbPointerInteraction(e, true)}
          onMouseEnter={() => setIsNavigatingPage(false)}
          className={`fixed z-50 select-none cursor-grab active:cursor-grabbing transition-opacity duration-200 ${
            isNavigatingPage ? 'opacity-55' : 'opacity-100'
          }`}
        >
          {isMiniPlayerMode && activeChannel ? (
            <div
              className={`w-[275px] sm:w-[310px] rounded-2xl border border-rose-500/40 shadow-[0_20px_50px_rgba(0,0,0,0.85)] overflow-hidden transition-colors duration-200 ${
                isNavigatingPage
                  ? 'bg-[#0b101d]/60 backdrop-blur-sm'
                  : 'bg-[#0b101d]/95 backdrop-blur-xl'
              }`}
            >
              <div className="flex items-center justify-between px-3 py-2 bg-[#11182b] border-b border-white/10">
                <div className="flex items-center gap-2 min-w-0">
                  <GripVertical className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping shrink-0" />
                  <span className="text-[11px] font-bold text-white truncate">
                    {activeMatch
                      ? `${activeMatch.homeTeam?.shortName || activeMatch.homeTeam?.name} vs ${activeMatch.awayTeam?.shortName || activeMatch.awayTeam?.name}`
                      : activeChannel.name}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0" data-no-drag="true">
                  <button
                    type="button"
                    onClick={toggleMute}
                    title={isMuted ? 'Unmute' : 'Mute'}
                    className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer"
                  >
                    {isMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      openArenaWithSeoUrl();
                      scrollToPlayer();
                    }}
                    title="Expand Live Arena"
                    className="p-1.5 rounded-lg hover:bg-white/10 text-sky-400 hover:text-sky-300 transition-colors cursor-pointer"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={stopLiveStream}
                    title="Close Live Stream"
                    className="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="relative aspect-video bg-black">
                <video
                  ref={videoRef}
                  playsInline
                  autoPlay
                  muted={isMuted}
                  className="w-full h-full object-contain"
                />
                {loadingStream && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                    <RefreshCw className="w-5 h-5 text-rose-500 animate-spin" />
                  </div>
                )}
                <div
                  data-no-drag="true"
                  onClick={() => {
                    openArenaWithSeoUrl();
                    scrollToPlayer();
                  }}
                  className="absolute bottom-2 right-2 px-2 py-1 rounded-md bg-black/80 border border-white/15 text-[10px] font-bold text-white hover:bg-rose-600 transition-colors cursor-pointer"
                >
                  Expand
                </div>
              </div>
            </div>
          ) : (
            <div
              title="Drag to move · Tap to open Live Arena"
              className={`group relative flex items-center gap-2 pl-2 pr-3 py-2 rounded-2xl border border-rose-500/40 hover:border-rose-400 shadow-[0_12px_32px_rgba(0,0,0,0.75)] transition-colors duration-200 ${
                isNavigatingPage
                  ? 'bg-[#0e1525]/60 backdrop-blur-sm'
                  : 'bg-[#0e1525]/95 backdrop-blur-xl'
              }`}
            >
              <GripVertical className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-300 transition-colors shrink-0" />
              <div className="relative w-8 h-8 rounded-xl bg-rose-600 flex items-center justify-center text-white shrink-0">
                <Tv className="w-4 h-4" />
                <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500 border border-white/70" />
                </span>
              </div>

              {/* Sliding Slot: First shows "LIVE ARENA", then disappears & slides in Live/Upcoming/Finished Events */}
              <div className="w-[104px] h-[28px] overflow-hidden relative text-left">
                <div
                  className="flex flex-col transition-transform duration-500 ease-in-out will-change-transform"
                  style={{
                    transform: `translate3d(0, -${(orbTickerIndex % orbSlideSequence.length) * 28}px, 0)`,
                  }}
                >
                  {orbSlideSequence.map((slide, idx) => {
                    if (slide.kind === 'brand') {
                      return (
                        <div
                          key={`brand-${idx}`}
                          className="h-[28px] min-h-[28px] max-h-[28px] shrink-0 overflow-hidden flex flex-col justify-center gap-0.5 text-left"
                        >
                          <span className="text-[11px] font-extrabold tracking-wider uppercase text-white leading-none truncate">
                            LIVE ARENA
                          </span>
                          <span className="text-[9px] font-medium text-slate-400 leading-none truncate">
                            {totalLiveCount > 0 ? `${totalLiveCount} Live Now` : `${events.length || 58} Matches`}
                          </span>
                        </div>
                      );
                    }

                    const ev = slide.event;
                    const evLive = isEventLive(ev.status);
                    const evFin = isEventFinished(ev.status);
                    const kickoff = formatKickoffTime(ev.startTime);
                    const homeShort =
                      ev.homeTeam?.shortName || ev.homeTeam?.name?.slice(0, 3).toUpperCase() || 'HOM';
                    const awayShort =
                      ev.awayTeam?.shortName || ev.awayTeam?.name?.slice(0, 3).toUpperCase() || 'AWY';

                    return (
                      <div
                        key={`${ev.id}-${idx}`}
                        className="h-[28px] min-h-[28px] max-h-[28px] shrink-0 overflow-hidden flex flex-col justify-center gap-0.5 text-left"
                      >
                        <span className="text-[10px] font-extrabold text-white leading-none truncate tabular-nums">
                          {evLive || evFin
                            ? `${homeShort} ${ev.homeTeam?.score ?? 0}-${ev.awayTeam?.score ?? 0} ${awayShort}`
                            : `${homeShort} vs ${awayShort}`}
                        </span>
                        <span
                          className={`text-[9px] font-bold leading-none truncate ${
                            evLive
                              ? 'text-rose-400'
                              : evFin
                              ? 'text-emerald-400'
                              : 'text-cyan-400'
                          }`}
                        >
                          {evLive
                            ? `● LIVE · ${ev.statusDetail || 'In Play'}`
                            : evFin
                            ? `FT · Result`
                            : `UP · ${kickoff.time}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          2. FULL-SCREEN LIVE ARENA OVERLAY (ZERO OVERFLOW, FULL TEAM NAMES)
          ===================================================================== */}
      {isArenaOpen && (
        <div className="fixed inset-0 z-50 bg-[#080c14] text-slate-100 flex flex-col overflow-hidden animate-fadeIn select-none">
          {/* -----------------------------------------------------------------
              CLEAN, NON-OVERFLOWING HEADER
              ----------------------------------------------------------------- */}
          <header className="shrink-0 bg-[#0c1220] border-b border-white/[0.08] z-30">
            <div className="max-w-5xl mx-auto px-3 sm:px-6 pt-2.5 pb-2 space-y-2">
              {/* Row 1: Brand Title on Left + Action Controls on Right (Never overflows!) */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500" />
                  </span>
                  <span className="font-display text-lg sm:text-xl tracking-wider uppercase text-white truncate">
                    NOTFLIX <span className="text-rose-500">ARENA</span>
                  </span>
                  {liveArenaViewersCount > 0 && (
                    <span
                      title={`${liveArenaViewersCount} active viewers currently in Live Arena`}
                      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/30 text-[11px] font-mono font-bold text-rose-300 shrink-0"
                    >
                      <Users className="w-3 h-3 text-rose-400" />
                      <span>{liveArenaViewersCount} {liveArenaViewersCount === 1 ? 'Viewer' : 'Viewers'}</span>
                    </span>
                  )}
                </div>

                {/* Right Action Buttons: Search, Refresh, Mini-TV, Close */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setIsSearchOpen((prev) => !prev)}
                    title="Search teams, leagues, or channels"
                    aria-label="Search"
                    className={`w-8 h-8 rounded-lg flex items-center justify-center border transition-colors cursor-pointer ${
                      isSearchOpen || searchQuery
                        ? 'bg-rose-600/20 border-rose-500/50 text-rose-400'
                        : 'bg-white/[0.05] hover:bg-white/[0.1] border-white/[0.08] text-slate-300 hover:text-white'
                    }`}
                  >
                    <Search className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      fetchLiveEvents();
                      fetchLiveChannels();
                    }}
                    title="Refresh Live Scores & Channels"
                    aria-label="Refresh"
                    className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] flex items-center justify-center text-slate-300 hover:text-white transition-colors cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        loadingEvents || loadingChannels ? 'animate-spin text-rose-400' : ''
                      }`}
                    />
                  </button>

                  <a
                    href="/api/live/playlist.m3u8"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download IPTV M3U8 Playlist"
                    className="hidden sm:inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] font-semibold text-slate-300 hover:text-white transition-colors"
                  >
                    <Download className="w-3 h-3 text-sky-400" />
                    <span>M3U8</span>
                  </a>

                  {activeChannel && (
                    <button
                      type="button"
                      onClick={() => closeArenaRestoreSeoUrl(true)}
                      title="Minimize to Floating Player"
                      className="h-8 px-2.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 flex items-center gap-1 text-xs font-bold text-sky-300 transition-colors cursor-pointer"
                    >
                      <Minimize2 className="w-3.5 h-3.5" />
                      <span className="hidden xs:inline">Mini</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => closeArenaRestoreSeoUrl(Boolean(activeChannel))}
                    title="Close Live Arena"
                    aria-label="Close"
                    className="h-8 px-3 rounded-lg bg-rose-500/15 hover:bg-rose-600 border border-rose-500/30 hover:border-rose-500 flex items-center gap-1 text-xs font-bold text-rose-300 hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Close</span>
                  </button>
                </div>
              </div>

              {/* Row 2: Full-Width Balanced 2-Column Switcher (Matches vs 24/7 Channels) */}
              <div className="grid grid-cols-2 gap-1.5 bg-[#080c15] p-1 rounded-xl border border-white/[0.07]">
                <button
                  type="button"
                  onClick={() => setActiveView('events')}
                  className={`flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    activeView === 'events'
                      ? 'bg-rose-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Trophy className="w-3.5 h-3.5 shrink-0" />
                  <span>Live Matches</span>
                  <span
                    className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${
                      activeView === 'events' ? 'bg-black/30 text-white' : 'bg-white/5 text-slate-400'
                    }`}
                  >
                    {events.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveView('channels')}
                  className={`flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    activeView === 'channels'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Tv className="w-3.5 h-3.5 shrink-0" />
                  <span>24/7 TV Channels</span>
                  <span
                    className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${
                      activeView === 'channels' ? 'bg-black/30 text-white' : 'bg-white/5 text-slate-400'
                    }`}
                  >
                    {channels.length || 102}
                  </span>
                </button>
              </div>

              {/* Optional Search Input (Only when toggled) */}
              {isSearchOpen && (
                <div className="relative flex items-center pt-0.5">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
                  <input
                    type="text"
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={
                      activeView === 'events'
                        ? 'Search team, league, or channel...'
                        : 'Search 102+ live sports, movie & TV channels...'
                    }
                    className="w-full pl-8 pr-8 py-1.5 rounded-lg bg-[#080c15] border border-white/15 focus:border-rose-500 focus:outline-none text-xs text-white placeholder-slate-500"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}

              {/* Row 3: Horizontal Category Strip */}
              <div className="flex items-center justify-between gap-2 overflow-x-auto no-scrollbar pt-0.5">
                {activeView === 'events' ? (
                  <>
                    <div className="flex items-center gap-1 shrink-0">
                      {SPORT_FILTERS.map((cat) => {
                        const active = sportFilter === cat.id;
                        const count =
                          cat.id === 'all'
                            ? events.length
                            : events.filter((e) => normalizeSportMatch(e.sport, cat.id)).length;
                        if (cat.id !== 'all' && count === 0) return null;

                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setSportFilter(cat.id)}
                            className={`shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                              active
                                ? 'bg-white text-slate-950 font-bold'
                                : 'bg-white/[0.04] text-slate-400 hover:text-white'
                            }`}
                          >
                            <span>{cat.label}</span>
                            <span
                              className={`text-[10px] font-mono ${
                                active ? 'text-slate-600' : 'text-slate-500'
                              }`}
                            >
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-1 shrink-0 pl-2 border-l border-white/10">
                      {[
                        { id: 'all' as const, label: 'All Today', count: baseFilteredEvents.length },
                        { id: 'live' as const, label: 'Live Now', count: liveEvents.length },
                        { id: 'upcoming' as const, label: 'Upcoming', count: upcomingEvents.length },
                        { id: 'finished' as const, label: 'Results', count: finishedEvents.length },
                      ].map((st) => {
                        if (st.id !== 'all' && st.count === 0) return null;
                        const isCurrent = statusTab === st.id;
                        return (
                          <button
                            key={st.id}
                            type="button"
                            onClick={() => setStatusTab(st.id)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1 ${
                              isCurrent
                                ? st.id === 'live'
                                  ? 'bg-rose-600 text-white'
                                  : st.id === 'finished'
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-blue-600 text-white'
                                : 'bg-white/[0.04] text-slate-400 hover:text-white'
                            }`}
                          >
                            <span>{st.label}</span>
                            <span className="text-[10px] font-mono opacity-80">({st.count})</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-1 shrink-0">
                      {CHANNEL_CATEGORIES.map((cat) => {
                        const active = channelCategory === cat.id;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setChannelCategory(cat.id)}
                            className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                              active
                                ? 'bg-white text-slate-950 font-bold'
                                : 'bg-white/[0.04] text-slate-400 hover:text-white'
                            }`}
                          >
                            {cat.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-1 shrink-0 pl-2 border-l border-white/10">
                      {CHANNEL_LANGUAGES.map((lg) => {
                        const active = channelLang === lg.id;
                        return (
                          <button
                            key={lg.id}
                            type="button"
                            onClick={() => setChannelLang(lg.id)}
                            className={`px-2 py-1 rounded-md text-[11px] font-mono font-bold transition-colors cursor-pointer ${
                              active
                                ? 'bg-blue-600 text-white'
                                : 'bg-white/[0.04] text-slate-400 hover:text-white'
                            }`}
                          >
                            {lg.label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </header>

          {/* -----------------------------------------------------------------
              SCROLLABLE CONTENT BODY
              ----------------------------------------------------------------- */}
          <div
            ref={arenaScrollRef}
            id="notflix-arena-scroll-body"
            className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 space-y-5"
          >
            {/* =================================================================
                DOCKED VIDEO PLAYER (WHEN STREAMING A MATCH OR CHANNEL)
                ================================================================= */}
            {activeChannel && (
              <section
                ref={playerContainerRef}
                className="max-w-5xl mx-auto bg-[#0c1220] border border-rose-500/40 rounded-xl overflow-hidden shadow-2xl"
              >
                <div className="relative aspect-video max-h-[52vh] w-full bg-black flex items-center justify-center overflow-hidden">
                  <video
                    ref={videoRef}
                    playsInline
                    autoPlay
                    controls
                    className="w-full h-full object-contain"
                  />

                  {loadingStream && (
                    <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-2 z-10">
                      <RefreshCw className="w-7 h-7 text-rose-500 animate-spin" />
                      <p className="text-xs font-bold text-white">
                        Connecting to {activeChannel.name}...
                      </p>
                    </div>
                  )}

                  {streamError && !loadingStream && (
                    <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center p-5 text-center z-10">
                      <AlertCircle className="w-8 h-8 text-amber-400 mb-2" />
                      <p className="text-xs sm:text-sm font-bold text-white max-w-md mb-3">
                        {streamError}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap justify-center">
                        <button
                          type="button"
                          onClick={() => tuneChannel(activeChannel.id, activeMatch)}
                          className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-bold text-white cursor-pointer"
                        >
                          Retry Signal
                        </button>
                        {sources.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              setUsingFallbackProxy(false);
                              setActiveSourceIndex((prev) => (prev + 1) % sources.length);
                            }}
                            className="px-3.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-bold text-white cursor-pointer"
                          >
                            Next Server ({activeSourceIndex + 1}/{sources.length})
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Stream Bar: Title + Commentary Languages + Mirrors */}
                <div className="p-2.5 sm:px-4 bg-[#101829] border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping shrink-0" />
                    <span className="text-xs font-bold text-white truncate">
                      {activeMatch
                        ? `${activeMatch.homeTeam?.name} vs ${activeMatch.awayTeam?.name}`
                        : activeChannel.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {activeMatch &&
                      activeMatch.recommendedChannels &&
                      activeMatch.recommendedChannels.length > 0 &&
                      activeMatch.recommendedChannels.map((rc) => {
                        const isCurrent = rc.channelId === activeChannel.id;
                        const cleanName = rc.name.replace(/\s*\([^)]*\)/g, '').trim();
                        const langTag = (rc.language || rc.languageLabel?.slice(0, 2) || 'HD').toUpperCase();
                        return (
                          <button
                            key={rc.channelId}
                            type="button"
                            onClick={() => tuneChannel(rc.channelId, activeMatch)}
                            title={`${cleanName} (${rc.languageLabel})`}
                            className={`px-2 py-1 rounded-md text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1 ${
                              isCurrent
                                ? 'bg-rose-600 text-white shadow-[0_2px_10px_rgba(225,29,72,0.4)]'
                                : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-300'
                            }`}
                          >
                            <Tv className="w-2.5 h-2.5 shrink-0 opacity-80" />
                            <span className="truncate max-w-[125px]">{cleanName}</span>
                            <span className="opacity-75 text-[9px]">({langTag})</span>
                          </button>
                        );
                      })}

                    {sources.length > 1 &&
                      sources.map((src, idx) => (
                        <button
                          key={src.id || idx}
                          type="button"
                          onClick={() => {
                            setUsingFallbackProxy(false);
                            setActiveSourceIndex(idx);
                          }}
                          className={`px-2 py-1 rounded-md text-[10px] font-mono font-bold transition-colors cursor-pointer ${
                            idx === activeSourceIndex
                              ? 'bg-emerald-600 text-white'
                              : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-300'
                          }`}
                        >
                          Server {idx + 1}
                        </button>
                      ))}

                    <button
                      type="button"
                      onClick={() => setIsAudioCleanEnabled((prev) => !prev)}
                      title="Broadcast Noise Reduction & Anti-Clipping Filter (Cuts satellite hiss, 50/60Hz hum & mic distortion)"
                      className={`px-2.5 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                        isAudioCleanEnabled
                          ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-300'
                          : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-400'
                      }`}
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>{isAudioCleanEnabled ? 'Clean Audio ON' : 'Clean Audio OFF'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={toggleFullscreen}
                      title="Fullscreen"
                      className="p-1.5 rounded-md bg-white/[0.07] hover:bg-white/[0.14] text-slate-300 hover:text-white cursor-pointer"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={stopLiveStream}
                      title="Close Player"
                      className="p-1.5 rounded-md bg-rose-500/20 hover:bg-rose-600 text-rose-300 hover:text-white cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* =================================================================
                VIEW 1: MATCHES SCHEDULE (COMPACT VS CARDS DESIGN)
                ================================================================= */}
            {activeView === 'events' && (
              <div className="max-w-5xl mx-auto space-y-4 pb-12">
                {(() => {
                  const renderVsCard = (ev: LiveSportEvent) => {
                    const live = isEventLive(ev.status);
                    const finished = isEventFinished(ev.status);
                    const kickoff = formatKickoffTime(ev.startTime);
                    const isWatching = activeMatch?.id === ev.id;
                    const recChannels = Array.isArray(ev.recommendedChannels) ? ev.recommendedChannels : [];
                    const displayedChannelObj =
                      (isWatching && activeChannel
                        ? recChannels.find((r) => r.channelId === activeChannel.id)
                        : null) || recChannels[0];
                    const primaryChannelName =
                      displayedChannelObj?.name?.replace(/\s*\([^)]*\)/g, '').trim() ||
                      ev.broadcasts?.[0] ||
                      'beIN Sports 1 HD';
                    const primaryLangTag = (
                      displayedChannelObj?.language ||
                      displayedChannelObj?.languageLabel?.slice(0, 2) ||
                      ''
                    ).toUpperCase();

                    const primaryChannelLogo =
                      displayedChannelObj?.logo ||
                      channels.find((c) => c.id === displayedChannelObj?.channelId)?.logo;

                    return (
                      <div
                        key={ev.id}
                        onClick={() => playEventDirectly(ev, displayedChannelObj?.channelId)}
                        className={`group rounded-2xl px-3.5 pt-3 pb-2.5 border transition-all duration-200 cursor-pointer ${
                          isWatching
                            ? 'bg-[#151f38] border-blue-500/60 shadow-[0_8px_24px_rgba(29,99,255,0.2)]'
                            : live
                            ? 'bg-[#111827] border-rose-500/35 hover:border-rose-500/60 hover:bg-[#141d30]'
                            : 'bg-[#111827] border-white/[0.07] hover:border-white/[0.15] hover:bg-[#141d30]'
                        }`}
                      >
                        {/* Top 3-Column VS Matchup Area */}
                        <div className="grid grid-cols-3 items-center gap-2">
                          {/* Home Team Column */}
                          <div className="flex flex-col items-center min-w-0">
                            <div className="w-11 h-11 rounded-2xl bg-[#1a2336] border border-white/[0.08] flex items-center justify-center p-1.5 mb-1.5 shadow-inner shrink-0">
                              {ev.homeTeam?.logo ? (
                                <img
                                  src={ev.homeTeam.logo}
                                  alt={ev.homeTeam.name}
                                  className="w-7 h-7 object-contain"
                                />
                              ) : (
                                <span className="text-xs font-extrabold text-white">
                                  {ev.homeTeam?.shortName?.slice(0, 3) ||
                                    ev.homeTeam?.name?.slice(0, 2) ||
                                    'HM'}
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] sm:text-xs font-bold text-white text-center truncate w-full px-0.5">
                              {ev.homeTeam?.name}
                            </span>
                          </div>

                          {/* Center Kickoff / Score Column */}
                          <div className="flex flex-col items-center justify-center min-w-0">
                            {live ? (
                              <>
                                <span className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-rose-400 mb-0.5 flex items-center gap-1">
                                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping" />
                                  LIVE
                                </span>
                                <div className="text-base sm:text-lg font-extrabold text-white tracking-tight leading-none my-0.5 tabular-nums">
                                  {ev.homeTeam?.score ?? 0} - {ev.awayTeam?.score ?? 0}
                                </div>
                                <span className="mt-1 px-2.5 py-0.5 rounded-full bg-rose-950/70 border border-rose-500/30 text-[10px] font-semibold text-rose-300 whitespace-nowrap">
                                  {ev.statusDetail || 'In Play'}
                                </span>
                              </>
                            ) : finished ? (
                              <>
                                <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-emerald-400 mb-0.5">
                                  FULL TIME
                                </span>
                                <div className="text-base sm:text-lg font-extrabold text-white tracking-tight leading-none my-0.5 tabular-nums">
                                  {ev.homeTeam?.score ?? 0} - {ev.awayTeam?.score ?? 0}
                                </div>
                                <span className="mt-1 px-2.5 py-0.5 rounded-full bg-slate-800/80 border border-white/10 text-[10px] font-semibold text-slate-300 whitespace-nowrap">
                                  {ev.statusDetail && ev.statusDetail !== 'Scheduled' ? ev.statusDetail : 'FT'}
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400 mb-0.5">
                                  {kickoff.isToday ? 'TODAY' : kickoff.dateLabel.toUpperCase()}
                                </span>
                                <div className="text-base sm:text-lg font-extrabold text-white tracking-tight leading-none my-0.5 tabular-nums">
                                  {kickoff.time}
                                </div>
                                <span className="mt-1 px-2.5 py-0.5 rounded-full bg-[#0d2838] border border-cyan-500/30 text-[10px] font-semibold text-cyan-400 whitespace-nowrap">
                                  {kickoff.relative}
                                </span>
                              </>
                            )}
                          </div>

                          {/* Away Team Column */}
                          <div className="flex flex-col items-center min-w-0">
                            <div className="w-11 h-11 rounded-2xl bg-[#1a2336] border border-white/[0.08] flex items-center justify-center p-1.5 mb-1.5 shadow-inner shrink-0">
                              {ev.awayTeam?.logo ? (
                                <img
                                  src={ev.awayTeam.logo}
                                  alt={ev.awayTeam.name}
                                  className="w-7 h-7 object-contain"
                                />
                              ) : (
                                <span className="text-xs font-extrabold text-white">
                                  {ev.awayTeam?.shortName?.slice(0, 3) ||
                                    ev.awayTeam?.name?.slice(0, 2) ||
                                    'AW'}
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] sm:text-xs font-bold text-white text-center truncate w-full px-0.5">
                              {ev.awayTeam?.name}
                            </span>
                          </div>
                        </div>

                        {/* Subtle Divider + Bottom Broadcast & Watch Bar */}
                        <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto no-scrollbar">
                            {recChannels.length > 0 ? (
                              recChannels.slice(0, 3).map((rc, idx) => {
                                const isActiveCh =
                                  (isWatching && activeChannel?.id === rc.channelId) ||
                                  (!isWatching && idx === 0);
                                const shortChName = rc.name
                                  .replace(/\s*\([^)]*\)/g, '')
                                  .replace(/\bHD\b/gi, '')
                                  .trim();
                                const langCode = (
                                  rc.language ||
                                  rc.languageLabel?.slice(0, 2) ||
                                  'HD'
                                ).toUpperCase();
                                const chLogo =
                                  rc.logo || channels.find((c) => c.id === rc.channelId)?.logo;

                                return (
                                  <button
                                    key={rc.channelId}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      playEventDirectly(ev, rc.channelId);
                                    }}
                                    title={`Watch on ${rc.name} (${rc.languageLabel})`}
                                    className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] sm:text-[11px] font-semibold transition-all cursor-pointer ${
                                      isActiveCh
                                        ? 'bg-white/[0.09] border-white/20 text-white'
                                        : 'bg-white/[0.03] hover:bg-white/[0.08] border-white/[0.07] text-slate-300'
                                    }`}
                                  >
                                    <span className="w-4 h-4 rounded bg-white/95 p-0.5 flex items-center justify-center shrink-0 overflow-hidden">
                                      {chLogo ? (
                                        <img
                                          src={chLogo}
                                          alt={shortChName}
                                          className="w-full h-full object-contain"
                                        />
                                      ) : (
                                        <Tv className="w-2.5 h-2.5 text-rose-600" />
                                      )}
                                    </span>
                                    <span className="truncate max-w-[105px]">{shortChName}</span>
                                    <span className="px-1 py-0.2 rounded bg-black/40 text-[8px] font-mono font-bold text-slate-300">
                                      {langCode}
                                    </span>
                                  </button>
                                );
                              })
                            ) : (
                              <div className="flex items-center gap-1.5 min-w-0">
                                <div className="w-6 h-6 rounded-lg bg-white/95 p-0.5 flex items-center justify-center shrink-0 overflow-hidden">
                                  {primaryChannelLogo ? (
                                    <img
                                      src={primaryChannelLogo}
                                      alt={primaryChannelName}
                                      className="w-full h-full object-contain"
                                    />
                                  ) : (
                                    <Tv className="w-3.5 h-3.5 text-rose-600" />
                                  )}
                                </div>
                                <span className="text-[11px] sm:text-xs font-semibold text-slate-200 truncate">
                                  {primaryChannelName}
                                </span>
                                {primaryLangTag && (
                                  <span className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/10 text-[9px] font-bold text-slate-400 shrink-0">
                                    {primaryLangTag}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          <a
                            href={buildMatchSeoPath(ev)}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              playEventDirectly(ev, displayedChannelObj?.channelId);
                            }}
                            className={`px-3.5 py-1 rounded-full text-[11px] sm:text-xs font-bold text-white flex items-center gap-1.5 transition-all shrink-0 cursor-pointer ${
                              live
                                ? 'bg-rose-600 hover:bg-rose-500 shadow-[0_4px_12px_rgba(225,29,72,0.35)]'
                                : 'bg-[#1d63ff] hover:bg-blue-500 shadow-[0_4px_12px_rgba(29,99,255,0.35)]'
                            }`}
                          >
                            <span>{isWatching ? 'Watching' : 'Watch'}</span>
                            <Play className="w-2.5 h-2.5 fill-current" />
                          </a>
                        </div>
                      </div>
                    );
                  };

                  const showLiveSection = statusTab === 'all' || statusTab === 'live';
                  const showUpcomingSection = statusTab === 'all' || statusTab === 'upcoming';
                  const showFinishedSection = statusTab === 'all' || statusTab === 'finished';

                  return (
                    <>
                      {/* 1. LIVE IN-PLAY MATCHES */}
                      {showLiveSection && liveEvents.length > 0 && (
                        <section className="space-y-2.5">
                          <div className="flex items-center justify-between px-1">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
                              <h2 className="text-xs font-extrabold uppercase tracking-wider text-rose-400">
                                Live Now ({liveEvents.length})
                              </h2>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                            {liveEvents.map((ev) => renderVsCard(ev))}
                          </div>
                        </section>
                      )}

                      {/* 2. UPCOMING MATCHES GROUPED BY LEAGUE */}
                      {showUpcomingSection && (
                        <>
                          {loadingEvents && events.length === 0 ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                              {[1, 2, 3, 4].map((n) => (
                                <div
                                  key={n}
                                  className="h-32 rounded-2xl bg-[#111827] border border-white/5 animate-pulse"
                                />
                              ))}
                            </div>
                          ) : (
                            upcomingLeagueGroups.length > 0 && (
                              <div className="space-y-4">
                                <div className="flex items-center justify-between px-1 pt-1">
                                  <h2 className="text-xs font-extrabold uppercase tracking-wider text-cyan-400">
                                    Upcoming Matches ({upcomingEvents.length})
                                  </h2>
                                </div>
                                {upcomingLeagueGroups.map((group) => (
                                  <section key={group.league} className="space-y-2">
                                    <div className="flex items-center justify-between px-1">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <div className="w-4 h-4 rounded bg-white/95 p-0.5 flex items-center justify-center shrink-0">
                                          {group.leagueLogo ? (
                                            <img
                                              src={group.leagueLogo}
                                              alt={group.league}
                                              className="w-full h-full object-contain"
                                            />
                                          ) : (
                                            <Trophy className="w-3 h-3 text-amber-500" />
                                          )}
                                        </div>
                                        <h3 className="text-xs font-bold text-slate-200 truncate">
                                          {group.league}
                                        </h3>
                                      </div>
                                      <span className="text-[10px] font-mono text-slate-400 shrink-0">
                                        {group.matches.length}
                                      </span>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                      {group.matches.map((ev) => renderVsCard(ev))}
                                    </div>
                                  </section>
                                ))}
                              </div>
                            )
                          )}
                        </>
                      )}

                      {/* 3. TODAY'S FINISHED RESULTS */}
                      {showFinishedSection && finishedEvents.length > 0 && (
                        <section className="space-y-2.5 pt-2">
                          <div className="flex items-center justify-between px-1">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-emerald-500" />
                              <h2 className="text-xs font-extrabold uppercase tracking-wider text-emerald-400">
                                Today&apos;s Finished Results ({finishedEvents.length})
                              </h2>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                            {finishedEvents.map((ev) => renderVsCard(ev))}
                          </div>
                        </section>
                      )}

                      {!loadingEvents && baseFilteredEvents.length === 0 && (
                        <div className="rounded-2xl bg-[#111827] border border-white/[0.07] p-8 text-center">
                          <p className="text-sm font-bold text-white mb-1">
                            No matches found for this filter
                          </p>
                          <p className="text-xs text-slate-400 mb-3">
                            Try selecting All Sports or browse 24/7 TV Channels.
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setSportFilter('all');
                              setStatusTab('all');
                              setSearchQuery('');
                            }}
                            className="px-3.5 py-1.5 rounded-full bg-[#1d63ff] text-xs font-bold text-white cursor-pointer"
                          >
                            Reset Filters
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {/* =================================================================
                VIEW 2: 24/7 SPORTS TV CHANNELS GRID
                ================================================================= */}
            {activeView === 'channels' && (
              <section className="max-w-5xl mx-auto pb-12">
                <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
                  {filteredChannels.map((ch) => {
                    const isSelected = activeChannel?.id === ch.id;
                    return (
                      <a
                        key={ch.id}
                        href={buildChannelSeoPath(ch.id)}
                        onClick={(e) => {
                          e.preventDefault();
                          tuneChannel(ch.id, null);
                        }}
                        className={`group rounded-xl p-3 border transition-all cursor-pointer flex items-center gap-3 ${
                          isSelected
                            ? 'bg-rose-950/40 border-rose-500 shadow-lg'
                            : 'bg-[#0c1220] border-white/[0.08] hover:border-blue-500/50 hover:bg-[#121a2e]'
                        }`}
                      >
                        <div className="w-11 h-11 rounded-lg bg-white/95 p-0.5 flex items-center justify-center shrink-0 shadow-xs overflow-hidden">
                          {ch.logo ? (
                            <img
                              src={ch.logo}
                              alt={ch.name}
                              loading="lazy"
                              className="w-full h-full object-contain"
                            />
                          ) : (
                            <Tv className="w-5 h-5 text-rose-600" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <h3 className="text-xs sm:text-sm font-bold text-white truncate group-hover:text-rose-400 transition-colors">
                            {ch.name.replace(/\s*\((Arabic|English|French|Spanish|Turkish|German|Portuguese)\)/gi, '')}
                          </h3>
                          <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                            <span>{ch.languageLabel || 'English'}</span>
                            <span>·</span>
                            <span className="text-emerald-400 font-mono">
                              {ch.quality || '1080p'}
                            </span>
                          </div>
                        </div>

                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                            isSelected
                              ? 'bg-rose-600 text-white'
                              : 'bg-white/[0.07] group-hover:bg-rose-600 text-slate-200 group-hover:text-white'
                          }`}
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                        </div>
                      </a>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
};
