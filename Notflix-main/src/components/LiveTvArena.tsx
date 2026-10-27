import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Tv,
  Trophy,
  Play,
  Pause,
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
  PictureInPicture2,
  Headphones,
} from 'lucide-react';
import { telemetry } from '../services/telemetry';

// IMPORTANT: Never call AudioContext.createMediaElementSource(video) on the live <video> element!
// On Android Chrome and iOS Safari, createMediaElementSource detaches the <video> from the native OS
// MediaSession hardware audio pipeline and routes it into Web Audio, which the mobile OS immediately
// suspends whenever the user switches to another app or locks the phone screen.
function attachOrUpdateBroadcastAudioFilter(
  video: HTMLVideoElement | null,
  enableCleanAudio: boolean
): void {
  if (!video || typeof window === 'undefined') return;
  try {
    if (!video.muted) {
      // Apply headroom leveling natively on the hardware media element (-0.7 dB clean headroom vs 0 dB raw)
      video.volume = enableCleanAudio ? 0.92 : 1.0;
    }
  } catch {}
}

function unlockAndUnmuteVideoAudio(
  video: HTMLVideoElement | null,
  enableCleanAudio: boolean
): void {
  if (!video) return;
  try {
    video.defaultMuted = false;
    video.muted = false;
    video.volume = enableCleanAudio ? 0.92 : 1.0;
  } catch {}
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

export interface LiveChannelEpgProgram {
  id?: string;
  eventId?: string | null;
  title: string;
  subtitle?: string;
  category?: string;
  league?: string;
  startTime: string;
  endTime?: string;
  status?: string;
  statusDetail?: string;
  isLive?: boolean;
  progressPct?: number;
  type?: string;
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
  epg?: {
    nowPlaying?: LiveChannelEpgProgram | null;
    nextUp?: LiveChannelEpgProgram | null;
    upcoming?: LiveChannelEpgProgram[];
    currentProgram?: LiveChannelEpgProgram | null;
    nextProgram?: LiveChannelEpgProgram | null;
  };
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
  { id: 'all', label: 'All Networks' },
  { id: 'bein', label: 'beIN Sports' },
  { id: 'starzplay', label: 'STARZPLAY' },
  { id: 'algeria', label: 'Algeria TV' },
  { id: 'canal', label: 'France TV & Canal+' },
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

function matchesChannelCategory(ch: LiveTvChannel, categoryId: string): boolean {
  if (!categoryId || categoryId === 'all') return true;
  const cat = String(ch.category || '').toLowerCase();
  const id = String(ch.id || '').toLowerCase();
  const country = String((ch as any).country || '').toUpperCase();

  if (categoryId === 'algeria') {
    return cat === 'algeria' || id.startsWith('algeria-') || country === 'DZ';
  }
  if (categoryId === 'starzplay') {
    return cat === 'starzplay' || id.startsWith('starzplay-') || id === 'starz-hd';
  }
  if (categoryId === 'canal') {
    return (
      cat === 'canal' ||
      id.startsWith('canal-plus-') ||
      id.startsWith('rmc-sport-') ||
      id === 'lequipe-fr' ||
      id === 'dazn-ligue1-fr' ||
      id === 'fifa-plus-fr' ||
      id.startsWith('bein-sports-fr-') ||
      id.startsWith('bein-sports-max-')
    );
  }
  if (categoryId === 'movies') {
    return cat === 'movies' || id === 'starz-hd';
  }
  if (categoryId === 'europe') {
    return cat === 'europe' || cat === 'eurosport';
  }
  if (categoryId === 'usa') {
    return cat === 'usa' || cat === 'us-sports';
  }
  return cat === categoryId;
}

const CHANNEL_LANGUAGES = [
  { id: 'all', label: 'All' },
  { id: 'en', label: 'EN' },
  { id: 'ar', label: 'AR' },
  { id: 'fr', label: 'FR' },
  { id: 'es', label: 'ES' },
  { id: 'it', label: 'IT' },
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
  minsUntilKickoff: number;
} {
  if (!isoString) {
    return { time: 'TBD', dateLabel: 'Today', relative: 'Scheduled', isToday: true, minsUntilKickoff: 999 };
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return { time: 'TBD', dateLabel: 'Today', relative: 'Scheduled', isToday: true, minsUntilKickoff: 999 };
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
  const minsUntilKickoff = Math.round(diffMs / 60000);
  let relative = 'Starting soon';

  if (diffMs > 0) {
    if (minsUntilKickoff < 60) {
      relative = `in ${minsUntilKickoff}m`;
    } else if (minsUntilKickoff < 1440) {
      const hrs = Math.floor(minsUntilKickoff / 60);
      const remMins = minsUntilKickoff % 60;
      relative = remMins > 0 ? `in ${hrs}h ${remMins}m` : `in ${hrs}h`;
    } else {
      relative = dateLabel;
    }
  }

  return { time, dateLabel, relative, isToday, minsUntilKickoff };
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

function formatCompactChannelBadge(channelId?: string, rawName?: string): string {
  const id = String(channelId || '').toLowerCase();
  const compactMap: Record<string, string> = {
    'sky-sports-premier-league': 'Sky Sports PL',
    'sky-sports-main-event': 'Sky Main Event',
    'sky-sports-football': 'Sky Football',
    'sky-sports-plus': 'Sky Sports+',
    'sky-sports-action': 'Sky Action',
    'sky-sports-arena': 'Sky Arena',
    'sky-sports-f1': 'Sky Sports F1',
    'sky-sports-mix': 'Sky Sports Mix',
    'sky-sports-news': 'Sky Sports News',
    'sky-sports-tennis': 'Sky Tennis',
    'sky-sports-golf': 'Sky Golf',
    'sky-sports-cricket': 'Sky Cricket',
    'supersport-premier-league': 'SuperSport PL',
    'supersport-football': 'SuperSport FB',
    'supersport-laliga': 'SuperSport LaLiga',
    'supersport-grandstand': 'SS Grandstand',
    'supersport-variety-1': 'SS Variety 1',
    'cbs-sports-golazo': 'CBS Golazo',
    'bein-sports-xtra-1': 'beIN Xtra 1',
    'bein-sports-max-1-ar': 'beIN Max 1',
    'bein-sports-max-2-ar': 'beIN Max 2',
    'bein-sports-1-fr': 'beIN FR 1',
    'bein-sports-2-fr': 'beIN FR 2',
    'bein-sports-3-fr': 'beIN FR 3',
    'bein-sports-fr-1': 'beIN FR 1',
    'bein-sports-fr-2': 'beIN FR 2',
    'bein-sports-fr-3': 'beIN FR 3',
    'bein-sports-en-1': 'beIN EN 1',
    'bein-sports-en-2': 'beIN EN 2',
    'bein-sports-en-3': 'beIN EN 3',
    'bein-sports-usa': 'beIN Sports US',
    'bein-sports-es': 'beIN Sports Ñ',
    'bein-sports-xtra-es': 'beIN Xtra Ñ',
    'bein-sports-1-tr': 'beIN TR 1',
    'bein-sports-2-tr': 'beIN TR 2',
    'movistar-laliga': 'M+ LaLiga',
    'movistar-champions': 'M+ Champions',
    'dazn-laliga': 'DAZN LaLiga',
    'dazn-laliga-es': 'DAZN LaLiga',
    'dazn-1-uk': 'DAZN 1 HD',
    'dazn-1-de': 'DAZN 1 DE',
    'dazn-2-de': 'DAZN 2 DE',
    'dazn-1-it': 'DAZN 1 IT',
    'dazn-2-it': 'DAZN 2 IT',
    'sky-sport-calcio-it': 'Sky Calcio IT',
    'sky-sport-uno-it': 'Sky Uno IT',
    'sky-sport-arena-it': 'Sky Arena IT',
    'sky-sport-max-it': 'Sky Max IT',
    'sky-sport-252-it': 'Sky 252 IT',
    'sky-sport-24-it': 'Sky Sport 24',
    'sky-sport-bundesliga-1-de': 'Sky Buli 1',
    'sky-sport-top-event-de': 'Sky Top Event',
    'starzplay-sports-1-ar': 'STARZPLAY 1',
    'starzplay-sports-2-ar': 'STARZPLAY 2',
    'starzplay-sports-3-ar': 'STARZPLAY 3',
    'starzplay-asia-1-ar': 'STARZPLAY Asia 1',
    'starzplay-asia-2-ar': 'STARZPLAY Asia 2',
    'starzplay-criclife-1': 'CricLife 1',
    'starzplay-criclife-2': 'CricLife 2',
    'starzplay-encore-hd': 'STARZPLAY Encore',
    'starzplay-action-hd': 'STARZPLAY Action',
    'starz-hd': 'STARZPLAY Cinema',
    'sport-tv-1-pt': 'Sport TV1',
    'sport-tv-2-pt': 'Sport TV2',
    'eleven-sports-1-pt': 'Eleven 1 PT',
    'canal-plus-fr': 'Canal+ FR',
    'canal-plus-foot-fr': 'Canal+ Foot',
    'canal-plus-sport-fr': 'Canal+ Sport',
    'canal-plus-sport-360-fr': 'Canal+ 360',
    'canal-plus-premier-league-fr': 'Canal+ PL',
    'canal-plus-top14-fr': 'Canal+ Top 14',
    'canal-plus-f1-fr': 'Canal+ F1',
    'canal-plus-motogp-fr': 'Canal+ MotoGP',
    'canal-plus-golf-fr': 'Canal+ Golf',
    'canal-plus-box-office-fr': 'Canal+ Box Office',
    'canal-plus-cinema-fr': 'Canal+ Cinéma',
    'canal-plus-grand-ecran-fr': 'Canal+ Grand Écran',
    'canal-plus-series-fr': 'Canal+ Séries',
    'canal-plus-docs-fr': 'Canal+ Docs',
    'rmc-sport-1-fr': 'RMC Sport 1',
    'rmc-sport-2-fr': 'RMC Sport 2',
    'lequipe-fr': "L'Équipe HD",
    'dazn-ligue1-fr': 'DAZN Ligue 1',
    'fifa-plus-fr': 'FIFA+ FR',
    'algeria-tv1-entv': 'TV1 Programme National',
    'algeria-tv2-canal': 'TV2 Canal Algérie',
    'algeria-tv3-news': 'TV3 Algérie A3',
    'algeria-tv4-tamazight': 'TV4 Tamazight',
    'algeria-tv5-coran': 'TV5 Coran',
    'algeria-tv6-youth': 'TV6 Algérie Sport',
    'algeria-tv7-elmaarifa': 'TV7 El Maarifa',
    'algeria-tv8-edhakira': 'TV8 Edhakira',
    'algeria-el-heddaf-tv': 'El Heddaf TV',
    'algeria-al24-news': 'AL24 News',
    'algeria-echorouk-tv': 'Echorouk TV',
    'algeria-echorouk-news': 'Echorouk News',
    'algeria-ennahar-tv': 'Ennahar TV',
    'algeria-el-bilad-tv': 'El Bilad TV',
    'algeria-samira-tv': 'Samira TV',
    'algeria-elwatania-tv': 'Elwatania TV',
    'algeria-amou-yazid-tv': 'Amou Yazid TV',
    'usa-network-hd': 'USA Network',
    'espn-deportes': 'ESPN Deportes',
    'fox-deportes': 'Fox Deportes',
    'tudn-usa': 'TUDN HD',
    'saudi-sbc-ar': 'SBC Saudi',
    'saudi-big-time-ar': 'Big Time+',
  };
  if (id && compactMap[id]) return compactMap[id];

  return String(rawName || id || 'Live HD')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .split(/\s+\/\s+/)[0]
    .replace(/\b(UK|USA|HD|FHD|4K)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatShortChannelName(rawName?: string): string {
  if (!rawName) return 'Live HD';
  return rawName
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .split(/\s+\/\s+/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCleanEpgTitle(rawTitle?: string): string {
  if (!rawTitle) return '';
  const cleaned = rawTitle
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || rawTitle.trim();
}

export const LiveTvArena: React.FC = () => {
  const [isArenaOpen, setIsArenaOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return isLiveArenaUrlPath(window.location.pathname);
  });
  const [isMiniPlayerMode, setIsMiniPlayerMode] = useState(false);
  const [activeView, setActiveView] = useState<'events' | 'channels'>(() => {
    if (typeof window !== 'undefined' && /^\/live\/channel\//i.test(window.location.pathname)) {
      return 'channels';
    }
    return 'events';
  });

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
  const [isVideoBuffering, setIsVideoBuffering] = useState<boolean>(false);
  const [bufferingLogoFailed, setBufferingLogoFailed] = useState<boolean>(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isAudioCleanEnabled, setIsAudioCleanEnabled] = useState<boolean>(true);
  const [isPipActive, setIsPipActive] = useState<boolean>(false);
  const [pipToastMessage, setPipToastMessage] = useState<string | null>(null);
  const [isBackgroundPlayEnabled, setIsBackgroundPlayEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      return localStorage.getItem('notflix_live_bg_play') !== 'false';
    } catch {
      return true;
    }
  });
  const [liveArenaViewersCount, setLiveArenaViewersCount] = useState<number>(0);

  // Video, Companion Pure-Audio (<audio>) & HLS refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgAudioActiveRef = useRef<boolean>(false);
  const bgVideoParkingRef = useRef<HTMLDivElement | null>(null);
  const arenaVideoSlotRef = useRef<HTMLDivElement | null>(null);
  const miniVideoSlotRef = useRef<HTMLDivElement | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const arenaScrollRef = useRef<HTMLDivElement | null>(null);
  const bufferingTimerRef = useRef<number | null>(null);
  const pipToastTimerRef = useRef<number | null>(null);
  const userPausedRef = useRef<boolean>(false);
  const userMutedRef = useRef<boolean>(false);
  const isAudioCleanEnabledRef = useRef<boolean>(isAudioCleanEnabled);
  const wakeLockRef = useRef<any>(null);
  const activeChannelRef = useRef<LiveChannel | null>(null);
  const isBackgroundPlayEnabledRef = useRef<boolean>(isBackgroundPlayEnabled);
  const resumeTimersRef = useRef<number[]>([]);

  useEffect(() => {
    activeChannelRef.current = activeChannel;
  }, [activeChannel]);

  useEffect(() => {
    isAudioCleanEnabledRef.current = isAudioCleanEnabled;
  }, [isAudioCleanEnabled]);

  const showPipHelperToast = useCallback((msg: string, durationMs = 5000) => {
    setPipToastMessage(msg);
    if (pipToastTimerRef.current !== null) {
      window.clearTimeout(pipToastTimerRef.current);
    }
    pipToastTimerRef.current = window.setTimeout(() => {
      setPipToastMessage(null);
      pipToastTimerRef.current = null;
    }, durationMs);
  }, []);

  const showFullscreenVideoCue = useCallback(
    (video: HTMLVideoElement | null, message: string, durationSec = 5) => {
      if (!video || typeof window === 'undefined') return;
      try {
        let track: TextTrack | null = null;
        for (let i = 0; i < video.textTracks.length; i++) {
          if (video.textTracks[i].label === 'notflix-pip-hint') {
            track = video.textTracks[i];
            break;
          }
        }
        if (!track && typeof video.addTextTrack === 'function') {
          track = video.addTextTrack('subtitles', 'notflix-pip-hint', 'en');
        }
        if (!track) return;
        track.mode = 'showing';
        if (track.cues) {
          while (track.cues.length > 0) {
            track.removeCue(track.cues[0]);
          }
        }
        const CueCtor = (window as any).VTTCue || (window as any).TextTrackCue;
        if (typeof CueCtor === 'function') {
          const start = Number.isFinite(video.currentTime) ? video.currentTime : 0;
          const cue = new CueCtor(start, start + durationSec, message);
          track.addCue(cue);
          window.setTimeout(() => {
            try {
              if (track) track.mode = 'disabled';
            } catch {}
          }, durationSec * 1000);
        }
      } catch {}
    },
    []
  );

  // Route audio output seamlessly between <video> (foreground / PiP) and the pure-audio <audio> element
  // (Chrome background / lock screen). In Chromium on Android, <video> (HasVideo() == true) is paused by
  // WebMediaPlayerImpl::OnFrameHidden() when backgrounded without PiP, whereas a pure-audio <audio> element
  // (HasVideo() == false) is NEVER paused by Chrome in the background or on the lock screen!
  const syncAudioOutputRouting = useCallback(() => {
    const v = videoRef.current as any;
    const a = bgAudioRef.current;
    if (!v) return;

    const isFirefox =
      typeof navigator !== 'undefined' && /Firefox|FxiOS/i.test(navigator.userAgent);
    const targetVol = isAudioCleanEnabledRef.current ? 0.92 : 1.0;

    if (isFirefox || !a) {
      bgAudioActiveRef.current = false;
      v.muted = userMutedRef.current;
      if (!userMutedRef.current) {
        v.volume = targetVol;
      }
      return;
    }

    const inPip =
      (typeof document !== 'undefined' && Boolean(document.pictureInPictureElement)) ||
      v.webkitPresentationMode === 'picture-in-picture' ||
      Boolean(v.webkitDisplayingFullscreen);

    const shouldUseBgAudio =
      typeof document !== 'undefined' &&
      document.hidden &&
      !inPip &&
      isBackgroundPlayEnabledRef.current &&
      Boolean(activeChannelRef.current) &&
      !userPausedRef.current;

    // Also toggle Chromium's native videoTracks selection on background transition as secondary optimization
    try {
      const vTracks = v.videoTracks;
      if (vTracks && vTracks.length > 0) {
        for (let i = 0; i < vTracks.length; i++) {
          vTracks[i].selected = !shouldUseBgAudio;
        }
      }
    } catch {}

    if (shouldUseBgAudio && a.readyState >= 1) {
      bgAudioActiveRef.current = true;
      a.muted = userMutedRef.current;
      a.volume = userMutedRef.current ? 0 : targetVol;
      v.volume = 0.0001;
      if (a.paused && !userPausedRef.current) {
        a.play()
          .then(() => setIsPlaying(true))
          .catch(() => {});
      }
    } else {
      bgAudioActiveRef.current = false;
      v.muted = userMutedRef.current;
      if (!userMutedRef.current) {
        v.volume = targetVol;
      }
      if (
        isBackgroundPlayEnabledRef.current &&
        !userPausedRef.current &&
        activeChannelRef.current &&
        a.readyState >= 2
      ) {
        // Keep pure-audio <audio> warm & playing at imperceptible volume (0.0005) while in foreground
        // so Android Chrome already registers an active HTMLAudioElement before screen lock occurs!
        a.muted = false;
        a.volume = 0.0005;
        if (a.paused) {
          a.play().catch(() => {});
        }
      } else {
        a.muted = true;
        a.volume = 0;
        if (!a.paused) {
          a.pause();
        }
      }
    }
  }, []);

  useEffect(() => {
    isBackgroundPlayEnabledRef.current = isBackgroundPlayEnabled;
    try {
      localStorage.setItem('notflix_live_bg_play', isBackgroundPlayEnabled ? 'true' : 'false');
    } catch {}
    const v = videoRef.current as any;
    if (v) {
      v.autoPictureInPicture = isBackgroundPlayEnabled;
      v.disablePictureInPicture = false;
      if (isBackgroundPlayEnabled) {
        v.setAttribute('autopictureinpicture', 'true');
        v.removeAttribute('disablepictureinpicture');
      } else {
        v.removeAttribute('autopictureinpicture');
      }
    }
    syncAudioOutputRouting();
  }, [isBackgroundPlayEnabled, syncAudioOutputRouting]);

  const clearResumeTimers = useCallback(() => {
    resumeTimersRef.current.forEach((id) => window.clearTimeout(id));
    resumeTimersRef.current = [];
  }, []);

  // Multi-stage persistent playback resumption:
  // When Android/iOS pauses the <video> during app-switching, screen-locking (verrouillage), or leaving PiP,
  // immediately route audio to the pure-audio <audio> companion in Chrome and retry playback at staggered intervals.
  const resumePlaybackPersistently = useCallback(() => {
    if (
      userPausedRef.current ||
      !activeChannelRef.current ||
      !isBackgroundPlayEnabledRef.current
    ) {
      return;
    }
    clearResumeTimers();

    const attemptPlay = () => {
      const v = videoRef.current;
      const a = bgAudioRef.current;
      if (
        !v ||
        userPausedRef.current ||
        !activeChannelRef.current ||
        !isBackgroundPlayEnabledRef.current
      ) {
        return;
      }
      syncAudioOutputRouting();

      if (bgAudioActiveRef.current && a) {
        if (a.paused && !a.ended) {
          a.play()
            .then(() => {
              setIsPlaying(true);
            })
            .catch(() => {});
        }
      } else {
        if (!userMutedRef.current && v.muted) {
          v.muted = false;
          if (v.volume === 0) v.volume = isAudioCleanEnabledRef.current ? 0.92 : 1.0;
        }
        if (v.paused && !v.ended) {
          v.play()
            .then(() => {
              setIsPlaying(true);
            })
            .catch(() => {});
        }
      }
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'playing';
        } catch {}
      }
    };

    attemptPlay();
    for (const delayMs of [35, 110, 260, 550, 1100, 2200]) {
      const tid = window.setTimeout(attemptPlay, delayMs);
      resumeTimersRef.current.push(tid);
    }
  }, [clearResumeTimers, syncAudioOutputRouting]);

  useEffect(() => {
    setBufferingLogoFailed(false);
    setIsVideoBuffering(false);
    userPausedRef.current = false;
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
  }, [activeChannel?.id, activeChannel?.logo]);

  // Ensure native video & companion background audio are unlocked on any user gesture
  useEffect(() => {
    if (!activeChannel || typeof window === 'undefined') return;
    const resumeAudioOnGesture = () => {
      const v = videoRef.current;
      const a = bgAudioRef.current;
      if (!v) return;
      if (!userMutedRef.current && v.muted && !bgAudioActiveRef.current) {
        v.muted = false;
        if (v.volume === 0) v.volume = isAudioCleanEnabled ? 0.92 : 1.0;
        setIsMuted(false);
      }
      if (!userPausedRef.current && v.paused && !document.hidden) {
        v.play().catch(() => {});
      }
      if (
        a &&
        !userPausedRef.current &&
        isBackgroundPlayEnabledRef.current &&
        a.paused &&
        a.readyState >= 2
      ) {
        a.muted = false;
        a.volume = bgAudioActiveRef.current ? (isAudioCleanEnabled ? 0.92 : 1.0) : 0.0005;
        a.play().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', resumeAudioOnGesture, { passive: true });
    window.addEventListener('keydown', resumeAudioOnGesture, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', resumeAudioOnGesture);
      window.removeEventListener('keydown', resumeAudioOnGesture);
    };
  }, [activeChannel, isAudioCleanEnabled]);

  const handleVideoWaiting = useCallback(() => {
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current);
    }
    bufferingTimerRef.current = window.setTimeout(() => {
      setIsVideoBuffering(true);
    }, 300);
  }, []);

  const handleVideoPlaying = useCallback(() => {
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
    userPausedRef.current = false;
    setIsPlaying(true);
    setIsVideoBuffering(false);
    setLoadingStream(false);
    const v = videoRef.current as any;
    if (v) {
      v.autoPictureInPicture = isBackgroundPlayEnabledRef.current;
      v.disablePictureInPicture = false;
      if (!userMutedRef.current && v.muted && !bgAudioActiveRef.current) {
        v.muted = false;
        if (v.volume === 0) v.volume = isAudioCleanEnabledRef.current ? 0.92 : 1.0;
        setIsMuted(false);
      }
    }
    syncAudioOutputRouting();
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = 'playing';
      } catch {}
    }
  }, [syncAudioOutputRouting]);

  const handleVideoTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    const a = bgAudioRef.current;
    if (!v || !a || userPausedRef.current || !activeChannelRef.current) return;
    if (!bgAudioActiveRef.current && a.readyState >= 2) {
      if (Number.isFinite(v.currentTime) && Math.abs(a.currentTime - v.currentTime) > 0.75) {
        try {
          a.currentTime = v.currentTime;
        } catch {}
      }
      if (isBackgroundPlayEnabledRef.current && a.paused) {
        a.muted = false;
        a.volume = 0.0005;
        a.play().catch(() => {});
      }
    }
  }, []);

  const handleBgAudioTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    const a = bgAudioRef.current;
    if (!v || !a || userPausedRef.current || !activeChannelRef.current) return;
    if (bgAudioActiveRef.current && isBackgroundPlayEnabledRef.current) {
      // Advance <video>.currentTime every ~1.5s while in background so Hls.js StreamController
      // sees the playhead progressing, flushes old back-buffer segments, and keeps fetching new live .ts segments!
      if (Number.isFinite(a.currentTime) && Math.abs(a.currentTime - v.currentTime) >= 1.5) {
        try {
          v.currentTime = a.currentTime;
        } catch {}
      }
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          if (navigator.mediaSession.playbackState !== 'playing') {
            navigator.mediaSession.playbackState = 'playing';
          }
        } catch {}
      }
    }
  }, []);

  const handleVideoVolumeChange = useCallback(() => {
    const v = videoRef.current;
    if (!v || bgAudioActiveRef.current) return;
    const effectivelyMuted = v.muted || v.volume === 0;
    setIsMuted(effectivelyMuted);
    if (!effectivelyMuted) {
      userMutedRef.current = false;
    }
  }, []);

  const lastVideoGestureMsRef = useRef<number>(0);

  const handleVideoPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // Distinguish a direct tap on the native <video controls> Pause button (gesture within last 600ms while visible)
    // from an OS-initiated pause when switching apps, exiting PiP, or locking the phone screen (verrouillage).
    const msSinceVideoGesture = Date.now() - lastVideoGestureMsRef.current;
    if (
      !document.hidden &&
      document.hasFocus?.() !== false &&
      msSinceVideoGesture >= 0 &&
      msSinceVideoGesture < 600
    ) {
      userPausedRef.current = true;
      bgAudioRef.current?.pause();
    }

    if (
      isBackgroundPlayEnabledRef.current &&
      activeChannelRef.current &&
      !userPausedRef.current &&
      !v.ended
    ) {
      resumePlaybackPersistently();
      return;
    }
    if (userPausedRef.current) {
      setIsPlaying(false);
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'paused';
        } catch {}
      }
    }
  }, [resumePlaybackPersistently]);

  // Mount the single persistent <video> element into whichever container slot is currently active (Full Arena, Mini-Player, or In-Viewport Background Parking)
  // Do NOT move the <video> inside a cleanup function on activeChannel metadata updates, as DOM reparenting pauses playback and exits PiP!
  const hasActiveChannel = Boolean(activeChannel);
  useEffect(() => {
    const video = videoRef.current;
    const parking = bgVideoParkingRef.current;
    if (!video || !parking) return;

    const targetHost =
      isArenaOpen && hasActiveChannel && arenaVideoSlotRef.current
        ? arenaVideoSlotRef.current
        : !isArenaOpen && isMiniPlayerMode && hasActiveChannel && miniVideoSlotRef.current
        ? miniVideoSlotRef.current
        : parking;

    if (video.parentElement !== targetHost) {
      targetHost.appendChild(video);
      if (hasActiveChannel && video.paused && !userPausedRef.current) {
        video.play().catch(() => {});
      }
    }
  }, [isArenaOpen, isMiniPlayerMode, hasActiveChannel]);

  const activeChannelLogo = useMemo(() => {
    if (!activeChannel) return '';
    return (
      activeChannel.logo ||
      channels.find((c) => c.id === activeChannel.id)?.logo ||
      activeMatch?.recommendedChannels?.find((r) => r.channelId === activeChannel.id)?.logo ||
      ''
    );
  }, [activeChannel, channels, activeMatch]);

  const cleanActiveChannelName = useMemo(() => {
    return formatShortChannelName(activeChannel?.name);
  }, [activeChannel?.name]);

  // Draggable Floating Icon / Mini-Player Position State
  // Always starts in the upper-right area below the top navbar when opening the website, while remaining freely movable anywhere.
  const floatingOrbElRef = useRef<HTMLDivElement | null>(null);
  const hasUserMovedOrbRef = useRef<boolean>(false);
  const [orbPos, setOrbPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === 'undefined') return { x: 20, y: 82 };
    try {
      localStorage.removeItem('notflix_live_orb_pos_v1');
    } catch {}
    return {
      x: Math.max(12, window.innerWidth - 204),
      y: 82,
    };
  });
  const orbPosRef = useRef<{ x: number; y: number }>(orbPos);

  useEffect(() => {
    orbPosRef.current = orbPos;
    if (floatingOrbElRef.current && !dragRef.current.isDown) {
      floatingOrbElRef.current.style.transform = `translate3d(${orbPos.x}px, ${orbPos.y}px, 0)`;
    }
  }, [orbPos]);

  // Align precisely with the upper-right hero area once the floating pill's exact DOM width is measured on mount
  useEffect(() => {
    if (typeof window === 'undefined' || hasUserMovedOrbRef.current) return;
    const el = floatingOrbElRef.current;
    const pillWidth = el?.offsetWidth || 186;
    const initialAligned = {
      x: Math.max(12, window.innerWidth - pillWidth - 18),
      y: 82,
    };
    orbPosRef.current = initialAligned;
    setOrbPos(initialAligned);
  }, []);

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
        const maxWidth = el?.offsetWidth || (isMiniPlayerMode ? 290 : 186);
        const maxHeight = el?.offsetHeight || (isMiniPlayerMode ? 200 : 56);
        if (!hasUserMovedOrbRef.current && !isMiniPlayerMode) {
          const defaultPos = {
            x: Math.max(12, window.innerWidth - maxWidth - 18),
            y: 82,
          };
          orbPosRef.current = defaultPos;
          return defaultPos;
        }
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

  const openArenaWithSeoUrl = useCallback((targetPath?: string) => {
    setIsArenaOpen(true);
    setIsMiniPlayerMode(false);
    if (typeof window !== 'undefined') {
      const nextPath =
        targetPath ||
        (isLiveArenaUrlPath(window.location.pathname) ? window.location.pathname : '/live');
      if (window.location.pathname !== nextPath) {
        try {
          window.history.replaceState({}, '', nextPath);
        } catch {}
      }
    }
  }, []);

  const closeArenaRestoreSeoUrl = useCallback((minimizeToFloating = false) => {
    setIsArenaOpen(false);
    if (minimizeToFloating) {
      setIsMiniPlayerMode(true);
    }
    if (typeof window !== 'undefined' && isLiveArenaUrlPath(window.location.pathname)) {
      try {
        window.history.replaceState({}, '', '/');
      } catch {}
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

  // Active viewer presence tracking while user is in Live Arena, Mini-Player, PiP, or Background Play
  useEffect(() => {
    if (!isArenaOpen && !isMiniPlayerMode && !activeChannel) return;
    telemetry.trackArenaPresence(25);
    const interval = window.setInterval(() => {
      telemetry.trackArenaPresence(25);
    }, 25000);
    return () => window.clearInterval(interval);
  }, [isArenaOpen, isMiniPlayerMode, Boolean(activeChannel)]);

  const scrollToPlayer = useCallback(() => {
    window.setTimeout(() => {
      if (playerContainerRef.current) {
        playerContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (arenaScrollRef.current) {
        arenaScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }, 60);
  }, []);

  const tuneRequestIdRef = useRef<number>(0);
  const tuneAbortRef = useRef<AbortController | null>(null);

  const tuneChannel = useCallback(
    async (channelId: string, matchContext?: LiveSportEvent | null, skipUrlUpdate = false) => {
      if (!channelId) return;
      const reqId = ++tuneRequestIdRef.current;
      if (tuneAbortRef.current) {
        tuneAbortRef.current.abort();
      }
      const controller = new AbortController();
      tuneAbortRef.current = controller;

      if (matchContext !== undefined) {
        setActiveMatch(matchContext);
      }
      if (typeof window !== 'undefined' && isArenaOpen && !skipUrlUpdate) {
        try {
          const nextSeoPath = matchContext
            ? buildMatchSeoPath(matchContext)
            : buildChannelSeoPath(channelId);
          if (window.location.pathname !== nextSeoPath) {
            window.history.replaceState({}, '', nextSeoPath);
          }
        } catch {}
      }
      // Synchronously unmute & unlock native audio while inside the user's click/tap gesture
      userMutedRef.current = false;
      userPausedRef.current = false;
      setIsMuted(false);
      unlockAndUnmuteVideoAudio(videoRef.current, isAudioCleanEnabled);

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
        const res = await fetch(`/api/live/stream/${encodeURIComponent(channelId)}`, {
          signal: controller.signal,
        });
        if (reqId !== tuneRequestIdRef.current) return;
        const data = await res.json();
        if (reqId !== tuneRequestIdRef.current) return;

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
            epg: data.channel.epg || prev?.epg,
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
          setLoadingStream(false);
          setStreamError('Stream mirrors are synchronizing. Try switching server or commentary language below.');
        }
      } catch (err: any) {
        if (err?.name === 'AbortError' || reqId !== tuneRequestIdRef.current) return;
        setLoadingStream(false);
        setStreamError('Unable to reach live stream gateway. Please retry or select another channel.');
      }
    },
    [channels, scrollToPlayer, isAudioCleanEnabled, isArenaOpen]
  );

  const playEventDirectly = useCallback(
    (ev: LiveSportEvent, preferredChannelId?: string, skipUrlUpdate = false) => {
      if (preferredChannelId) {
        tuneChannel(preferredChannelId, ev, skipUrlUpdate);
        return;
      }
      if (Array.isArray(ev.recommendedChannels) && ev.recommendedChannels.length > 0) {
        tuneChannel(ev.recommendedChannels[0].channelId, ev, skipUrlUpdate);
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
        tuneChannel(fallbackCh.id, ev, skipUrlUpdate);
      } else {
        tuneChannel('bein-sports-1-ar', ev, skipUrlUpdate);
      }
    },
    [channels, tuneChannel]
  );

  // Resolve SEO Deep-Links (/live, /live/match/:slug, /live/channel/:channelId) for Google Search visitors & Social Shares
  const initialDeepLinkResolvedRef = useRef<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined' || initialDeepLinkResolvedRef.current) return;
    const path = window.location.pathname || '';
    if (!isLiveArenaUrlPath(path)) {
      initialDeepLinkResolvedRef.current = true;
      return;
    }

    setIsArenaOpen(true);

    const channelMatch = path.match(/^\/live\/channel\/([^/?#]+)/i);
    if (channelMatch) {
      initialDeepLinkResolvedRef.current = true;
      const targetChannelId = decodeURIComponent(channelMatch[1]).trim().toLowerCase();
      if (targetChannelId) {
        setActiveView('channels');
        tuneChannel(targetChannelId, null, true);
      }
      return;
    }

    const matchRoute = path.match(/^\/live\/match\/([^/?#]+)/i);
    if (matchRoute) {
      if (events.length === 0) return; // Wait for events list to finish loading
      initialDeepLinkResolvedRef.current = true;
      const rawParam = decodeURIComponent(matchRoute[1]).trim();
      const matchedEv =
        events.find((e) => String(e.id) === rawParam) ||
        events.find((e) => rawParam.startsWith(`${e.id}-`)) ||
        events.find((e) => buildMatchSeoPath(e).toLowerCase().endsWith(rawParam.toLowerCase()));
      if (matchedEv) {
        setActiveView('events');
        playEventDirectly(matchedEv, undefined, true);
      }
      return;
    }

    initialDeepLinkResolvedRef.current = true;
  }, [events, tuneChannel, playEventDirectly]);

  // Dynamic Client-Side SEO Meta, OpenGraph, Canonical & Schema.org JSON-LD for Live Arena
  useEffect(() => {
    if (!isArenaOpen || typeof window === 'undefined') return;

    const currentPath = window.location.pathname || '/live';
    // If visitor landed directly on a deep /live/match/* or /live/channel/* URL and the match/channel
    // state is still resolving during initial mount, preserve the server-rendered SEO tags & canonical URL!
    if (
      !activeMatch &&
      !activeChannel &&
      (/^\/live\/match\//i.test(currentPath) || /^\/live\/channel\//i.test(currentPath))
    ) {
      return;
    }

    const origin = 'https://notflixtv.com';
    let title =
      'Notflix Arena — Watch Live Sports, Football Matches & 24/7 TV Channels Free in 1080p HD';
    let desc =
      'Watch live football matches (UEFA Champions League, Premier League, La Liga, El Clásico, Serie A), NBA, UFC, F1 & 102+ 24/7 live TV channels (beIN Sports AR/EN, Sky Sports, ESPN, SSC) free in 1080p HD.';
    let keywords =
      'Notflix Arena, live football stream free, watch football online hd, bein sports 1 live arabic, بث مباشر مباريات اليوم, مشاهدة بي ان سبورت, sky sports live stream, champions league live, premier league live, laliga live, el clasico live stream';
    let canonicalPath = currentPath.length > 1 ? currentPath.replace(/\/+$/, '') : '/live';
    let ogImage = 'https://image.tmdb.org/t/p/w1280/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg';
    let jsonLdPayload: Record<string, any> | null = null;

    if (activeMatch) {
      const homeName = activeMatch.homeTeam?.name || 'Home Team';
      const awayName = activeMatch.awayTeam?.name || 'Away Team';
      const matchTitle =
        activeMatch.homeTeam?.name && activeMatch.awayTeam?.name
          ? `${homeName} vs ${awayName}`
          : activeMatch.title || 'Live Sports Match';
      const leagueName = activeMatch.league || 'Live Sports Broadcast';
      const chNames = Array.isArray(activeMatch.recommendedChannels) && activeMatch.recommendedChannels.length > 0
        ? activeMatch.recommendedChannels
            .slice(0, 4)
            .map((c) => c.name.replace(/\s*\([^)]*\)/g, ''))
            .join(', ')
        : activeChannel?.name || 'beIN Sports HD, Sky Sports HD';

      title = `Watch ${matchTitle} Live Stream Free HD (${leagueName}) — ${chNames.split(',')[0]} | Notflix Arena`;
      desc = `Watch ${matchTitle} (${leagueName}) live stream online free in 1080p Full HD on ${chNames}. Instant multi-language commentary (Arabic, English, French, Spanish) on Notflix Arena.`.slice(
        0,
        160
      );
      keywords = `${matchTitle} live stream, watch ${homeName} vs ${awayName} free hd, ${homeName} live, ${awayName} live, ${leagueName} live stream, ${chNames}, بث مباشر ${homeName} و ${awayName}, مشاهدة مباراة ${homeName}`;
      canonicalPath = /^\/live\/match\//i.test(currentPath)
        ? currentPath.replace(/\/+$/, '')
        : buildMatchSeoPath(activeMatch);
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
            isAccessibleForFree: true,
            sport: activeMatch.sport || 'Soccer',
            image: [logoCandidate, ogImage].filter(Boolean),
            homeTeam: {
              '@type': 'SportsTeam',
              name: homeName,
            },
            awayTeam: {
              '@type': 'SportsTeam',
              name: awayName,
            },
          },
          {
            '@type': 'BroadcastEvent',
            '@id': `${fullUrl}#broadcast`,
            name: `Live Broadcast: ${matchTitle} (${leagueName})`,
            description: desc,
            isLiveBroadcast: true,
            isAccessibleForFree: true,
            startDate: startIso,
            endDate: endIso,
            videoFormat: 'HD 1080p',
            inLanguage: ['ar', 'en', 'fr', 'es'],
            workPerformed: { '@id': `${fullUrl}#sportsevent` },
          },
          {
            '@type': 'VideoObject',
            '@id': `${fullUrl}#video`,
            name: `Watch ${matchTitle} Live Stream Free HD — ${leagueName}`,
            description: desc,
            thumbnailUrl: [logoCandidate, ogImage].filter(Boolean),
            uploadDate: startIso,
            contentUrl: fullUrl,
            embedUrl: fullUrl,
            publication: {
              '@type': 'BroadcastEvent',
              isLiveBroadcast: true,
              startDate: startIso,
              endDate: endIso,
            },
          },
        ],
      };
    } else if (activeChannel) {
      const cleanName = activeChannel.name.replace(/\s*\([^)]*\)/g, '').trim();
      const langLabel = activeChannel.languageLabel || 'English';
      title = `Watch ${cleanName} (${langLabel}) Live Stream 24/7 Free in 1080p HD | Notflix Arena`;
      desc = `Watch ${activeChannel.name} live stream 24/7 online free in 1080p Full HD on Notflix Arena. Instant multi-mirror sports, football, and entertainment broadcast.`;
      keywords = `${cleanName} live stream, watch ${cleanName} online free hd, ${activeChannel.name} 24/7 live, ${cleanName} ${langLabel}, بث مباشر ${cleanName}, Notflix Arena`;
      canonicalPath = /^\/live\/channel\//i.test(currentPath)
        ? currentPath.replace(/\/+$/, '')
        : buildChannelSeoPath(activeChannel.id);
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
            isAccessibleForFree: true,
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
    setMeta('meta[name="keywords"]', 'content', keywords);
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
    if (!activeMatch && !activeChannel) return;

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
    const bgAudio = bgAudioRef.current;
    const currentSource = sources[activeSourceIndex];
    if (!video || !currentSource || !activeChannel) {
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
    userPausedRef.current = false;
    let playbackStarted = false;
    let failoverTriggered = false;
    let recoveryAttempts = 0;
    let recoveryTimeoutId: number | null = null;
    let isEffectDisposed = false;

    // Companion pure-audio MediaSource state for Chromium background / lock-screen playback
    const isFirefoxBrowser =
      typeof navigator !== 'undefined' && /Firefox|FxiOS/i.test(navigator.userAgent);
    let bgMs: MediaSource | null = null;
    let bgMsUrl: string | null = null;
    let bgSb: SourceBuffer | null = null;
    let bgCodecMime: string | null = null;
    const bgAudioQueue: Array<{ data: Uint8Array; timestampOffset?: number }> = [];

    const cleanupBgAudioMediaSource = () => {
      bgAudioQueue.length = 0;
      if (bgSb && bgMs && bgMs.readyState === 'open') {
        try {
          bgSb.abort();
        } catch {}
      }
      bgSb = null;
      bgCodecMime = null;
      if (bgAudio) {
        try {
          bgAudio.pause();
          bgAudio.removeAttribute('src');
          bgAudio.load();
        } catch {}
      }
      if (bgMsUrl) {
        try {
          URL.revokeObjectURL(bgMsUrl);
        } catch {}
        bgMsUrl = null;
      }
      bgMs = null;
    };

    const pumpBgAudioQueue = () => {
      if (isEffectDisposed || !bgSb || bgSb.updating || !bgMs || bgMs.readyState !== 'open') {
        return;
      }
      // Evict old back-buffer (>28s behind playhead) so companion audio SourceBuffer never hits quota limits
      if (bgAudio && bgSb.buffered.length > 0) {
        try {
          const start = bgSb.buffered.start(0);
          const end = bgSb.buffered.end(bgSb.buffered.length - 1);
          const playhead = bgAudio.currentTime || end;
          if (playhead - start > 28 && end - start > 34) {
            bgSb.remove(start, Math.max(start + 4, playhead - 12));
            return;
          }
        } catch {}
      }
      const nextChunk = bgAudioQueue.shift();
      if (!nextChunk) return;
      try {
        if (
          nextChunk.timestampOffset !== undefined &&
          Number.isFinite(nextChunk.timestampOffset) &&
          Math.abs((bgSb.timestampOffset || 0) - nextChunk.timestampOffset) > 0.05
        ) {
          bgSb.timestampOffset = nextChunk.timestampOffset;
        }
        bgSb.appendBuffer(nextChunk.data as unknown as BufferSource);
      } catch (err: any) {
        if (err?.name === 'QuotaExceededError' && bgSb.buffered.length > 0) {
          bgAudioQueue.unshift(nextChunk);
          try {
            const start = bgSb.buffered.start(0);
            const end = bgSb.buffered.end(bgSb.buffered.length - 1);
            bgSb.remove(start, start + Math.max(4, (end - start) * 0.4));
          } catch {}
        }
      }
    };

    const tryInitBgAudioSourceBuffer = () => {
      if (isEffectDisposed || bgSb || !bgCodecMime || !bgMs || bgMs.readyState !== 'open') {
        return;
      }
      try {
        let candidateMime = bgCodecMime;
        if (!MediaSource.isTypeSupported(candidateMime)) {
          if (MediaSource.isTypeSupported('audio/mp4;codecs="mp4a.40.2"')) {
            candidateMime = 'audio/mp4;codecs="mp4a.40.2"';
          } else if (MediaSource.isTypeSupported('audio/mpeg')) {
            candidateMime = 'audio/mpeg';
          } else {
            return;
          }
        }
        bgSb = bgMs.addSourceBuffer(candidateMime);
        bgSb.addEventListener('updateend', () => {
          if (isEffectDisposed || !bgSb) return;
          pumpBgAudioQueue();
          if (
            bgAudio &&
            bgSb.buffered.length > 0 &&
            !userPausedRef.current &&
            isBackgroundPlayEnabledRef.current
          ) {
            try {
              const bufStart = bgSb.buffered.start(0);
              const bufEnd = bgSb.buffered.end(bgSb.buffered.length - 1);
              if (bgAudio.currentTime < bufStart || bgAudio.currentTime > bufEnd + 2) {
                bgAudio.currentTime =
                  video.currentTime >= bufStart && video.currentTime <= bufEnd
                    ? video.currentTime
                    : Math.max(bufStart, bufEnd - 2.5);
              }
            } catch {}
            syncAudioOutputRouting();
            if (bgAudio.paused) {
              bgAudio.play().catch(() => {});
            }
          }
        });
        pumpBgAudioQueue();
      } catch {}
    };

    const setupCompanionBgAudioPipeline = () => {
      if (isFirefoxBrowser || !bgAudio || typeof MediaSource === 'undefined') return;
      cleanupBgAudioMediaSource();
      try {
        bgMs = new MediaSource();
        bgMsUrl = URL.createObjectURL(bgMs);
        bgMs.addEventListener('sourceopen', tryInitBgAudioSourceBuffer, { once: true });
        bgAudio.src = bgMsUrl;
      } catch {}
    };

    const showSignalInterruptedOverlay = () => {
      if (failoverTriggered) return;
      failoverTriggered = true;
      // Only try alternate server mirrors for the SAME selected TV channel; never silently jump to a different TV channel
      if (activeSourceIndex + 1 < sources.length) {
        setUsingFallbackProxy(false);
        setActiveSourceIndex((prev) => prev + 1);
      } else {
        setLoadingStream(false);
        setStreamError('Signal interrupted on this channel mirror. Click Retry Signal or choose another broadcast channel below.');
      }
    };

    const watchdogTimer = window.setTimeout(() => {
      if (!playbackStarted) {
        showSignalInterruptedOverlay();
      }
    }, 22000);

    const isIosDevice =
      typeof navigator !== 'undefined' &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    const canPlayNativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));

    const startHlsJsPlayback = () => {
      if (!Hls.isSupported()) return false;
      setupCompanionBgAudioPipeline();

      const hls = new Hls({
        // Keep enableWorker: false so HLS demuxing runs on the active media-exempt main thread
        // and is never throttled or suspended by Android/iOS when the screen is locked or app is backgrounded
        enableWorker: false,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 45,
        maxMaxBufferLength: 90,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
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

      // Mirror pure audio track into companion <audio> MediaSource for uninterrupted Chrome background / lock-screen audio
      hls.on(Hls.Events.BUFFER_CODECS, (_event, data: any) => {
        if (isFirefoxBrowser || !bgAudio) return;
        const audioTrack = data?.audio;
        if (audioTrack && !bgCodecMime) {
          const container = audioTrack.container || 'audio/mp4';
          const codec = audioTrack.levelCodec || audioTrack.codec || 'mp4a.40.2';
          bgCodecMime = `${container};codecs=${codec}`;
          tryInitBgAudioSourceBuffer();
        }
      });

      hls.on(Hls.Events.BUFFER_APPENDING, (_event, eventData: any) => {
        if (isFirefoxBrowser || !bgAudio) return;
        if (eventData?.type === 'audio' && eventData?.data) {
          if (!bgCodecMime) {
            const mainAudioTrack = (hls as any).bufferController?.tracks?.audio;
            const container = mainAudioTrack?.container || 'audio/mp4';
            const codec = mainAudioTrack?.codec || mainAudioTrack?.levelCodec || 'mp4a.40.2';
            bgCodecMime = `${container};codecs=${codec}`;
            tryInitBgAudioSourceBuffer();
          }
          const srcBytes: Uint8Array = eventData.data;
          const copy = new Uint8Array(srcBytes.byteLength);
          copy.set(new Uint8Array(srcBytes.buffer, srcBytes.byteOffset, srcBytes.byteLength));
          const mainAudioSb = (hls as any).bufferController?.tracks?.audio?.buffer;
          const tsOffset =
            typeof eventData.offset === 'number' && Number.isFinite(eventData.offset)
              ? eventData.offset
              : typeof mainAudioSb?.timestampOffset === 'number' &&
                Number.isFinite(mainAudioSb.timestampOffset)
              ? mainAudioSb.timestampOffset
              : undefined;
          bgAudioQueue.push({
            data: copy,
            timestampOffset: tsOffset,
          });
          pumpBgAudioQueue();
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const shouldMute = userMutedRef.current;
        video.defaultMuted = shouldMute;
        video.muted = shouldMute;
        if (!shouldMute && video.volume === 0) {
          video.volume = 1;
        }
        setIsMuted(shouldMute);
        attachOrUpdateBroadcastAudioFilter(video, isAudioCleanEnabled);

        video
          .play()
          .then(() => {
            setIsPlaying(true);
            if (!userMutedRef.current) {
              video.muted = false;
              setIsMuted(false);
            }
            attachOrUpdateBroadcastAudioFilter(video, isAudioCleanEnabled);
            syncAudioOutputRouting();
          })
          .catch((err: any) => {
            if (err?.name === 'AbortError') {
              return;
            }
            if (err?.name === 'NotAllowedError') {
              video.muted = true;
              setIsMuted(true);
              video.play().then(() => setIsPlaying(true)).catch(() => {});
            }
          });
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
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
        if (!userPausedRef.current) {
          if (bgAudioActiveRef.current && bgAudio && bgAudio.paused) {
            bgAudio.play().then(() => setIsPlaying(true)).catch(() => {});
          } else if (!bgAudioActiveRef.current && video.paused) {
            if (!userMutedRef.current) {
              video.muted = false;
              setIsMuted(false);
            }
            video.play().then(() => setIsPlaying(true)).catch(() => {});
          }
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (recoveryAttempts < 5) {
            recoveryAttempts++;
            if (recoveryTimeoutId !== null) {
              window.clearTimeout(recoveryTimeoutId);
            }
            recoveryTimeoutId = window.setTimeout(() => {
              if (hlsRef.current === hls) {
                hls.startLoad();
              }
            }, 1000);
            return;
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (recoveryAttempts < 3) {
            recoveryAttempts++;
            hls.recoverMediaError();
            return;
          }
        }

        showSignalInterruptedOverlay();
      });
      return true;
    };

    // On iOS/iPadOS, prefer native AVPlayer HLS over ManagedMediaSource so lock-screen audio
    // and automatic OS Picture-in-Picture work natively when switching apps or locking the phone
    if ((isIosDevice && canPlayNativeHls) || (!Hls.isSupported() && canPlayNativeHls)) {
      video.src = playUrl;
      video.addEventListener(
        'loadedmetadata',
        () => {
          playbackStarted = true;
          window.clearTimeout(watchdogTimer);
          setLoadingStream(false);
          const shouldMute = userMutedRef.current;
          video.defaultMuted = shouldMute;
          video.muted = shouldMute;
          if (!shouldMute && video.volume === 0) {
            video.volume = 1;
          }
          setIsMuted(shouldMute);
          attachOrUpdateBroadcastAudioFilter(video, isAudioCleanEnabled);
          video
            .play()
            .then(() => setIsPlaying(true))
            .catch((err: any) => {
              if (err?.name === 'NotAllowedError') {
                video.muted = true;
                setIsMuted(true);
                video.play().then(() => setIsPlaying(true)).catch(() => {});
              }
            });
        },
        { once: true }
      );
      video.addEventListener(
        'error',
        () => {
          if (!playbackStarted && startHlsJsPlayback()) {
            return;
          }
          showSignalInterruptedOverlay();
        },
        { once: true }
      );
    } else {
      startHlsJsPlayback();
    }

    return () => {
      isEffectDisposed = true;
      window.clearTimeout(watchdogTimer);
      if (recoveryTimeoutId !== null) {
        window.clearTimeout(recoveryTimeoutId);
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      cleanupBgAudioMediaSource();
    };
  }, [sources, activeSourceIndex, usingFallbackProxy, Boolean(activeChannel), syncAudioOutputRouting]);

  useEffect(() => {
    if (videoRef.current && activeChannel) {
      attachOrUpdateBroadcastAudioFilter(videoRef.current, isAudioCleanEnabled);
      syncAudioOutputRouting();
    }
  }, [isAudioCleanEnabled, activeChannel, syncAudioOutputRouting]);

  const stopLiveStream = useCallback(() => {
    userPausedRef.current = true;
    bgAudioActiveRef.current = false;
    clearResumeTimers();
    if (typeof document !== 'undefined' && document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    setIsPipActive(false);
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
    if (bgAudioRef.current) {
      try {
        bgAudioRef.current.pause();
        bgAudioRef.current.removeAttribute('src');
        bgAudioRef.current.load();
      } catch {}
    }
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = 'none';
        navigator.mediaSession.metadata = null;
      } catch {}
    }
    setActiveChannel(null);
    setActiveMatch(null);
    setSources([]);
    setIsPlaying(false);
    setIsMiniPlayerMode(false);
  }, [clearResumeTimers]);

  const togglePlayPause = useCallback(() => {
    const v = videoRef.current;
    const a = bgAudioRef.current;
    if (!v || !activeChannelRef.current) return;
    if (v.paused && (!bgAudioActiveRef.current || !a || a.paused) || userPausedRef.current) {
      userPausedRef.current = false;
      syncAudioOutputRouting();
      if (!userMutedRef.current && v.muted && !bgAudioActiveRef.current) {
        v.muted = false;
        setIsMuted(false);
      }
      v.play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
      if (a && isBackgroundPlayEnabledRef.current && a.readyState >= 2) {
        a.play()
          .then(() => setIsPlaying(true))
          .catch(() => {});
      }
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'playing';
        } catch {}
      }
    } else {
      userPausedRef.current = true;
      clearResumeTimers();
      v.pause();
      a?.pause();
      setIsPlaying(false);
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'paused';
        } catch {}
      }
    }
  }, [clearResumeTimers, syncAudioOutputRouting]);

  const togglePictureInPicture = useCallback(async () => {
    const video = videoRef.current as any;
    if (!video) return;
    const doc = document as any;

    try {
      // 1. If already in W3C Picture-in-Picture (Chrome / Edge / Brave / Samsung Internet), exit PiP
      if (typeof document !== 'undefined' && document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPipActive(false);
        return;
      }
      // 2. If already in Safari / iOS Picture-in-Picture, exit PiP
      if (
        typeof video.webkitSetPresentationMode === 'function' &&
        video.webkitPresentationMode === 'picture-in-picture'
      ) {
        video.webkitSetPresentationMode('inline');
        setIsPipActive(false);
        return;
      }
      // 3. Standard W3C Picture-in-Picture API (Chrome Desktop & Android, Edge, Brave, Opera)
      if (
        typeof document !== 'undefined' &&
        document.pictureInPictureEnabled &&
        typeof video.requestPictureInPicture === 'function'
      ) {
        // Call requestPictureInPicture synchronously BEFORE any await so transient user activation is never lost
        const pipPromise = video.requestPictureInPicture();
        if (video.paused && !userPausedRef.current) {
          video.play().catch(() => {});
        }
        await pipPromise;
        setIsPipActive(true);
        return;
      }
      // 4. Apple WebKit Picture-in-Picture API (Safari iOS / iPadOS / macOS)
      if (typeof video.webkitSetPresentationMode === 'function') {
        video.webkitSetPresentationMode('picture-in-picture');
        if (video.paused && !userPausedRef.current) {
          video.play().catch(() => {});
        }
        setIsPipActive(true);
        return;
      }

      // 5. Mozilla Firefox (Android & Desktop):
      // Firefox does not expose video.requestPictureInPicture().
      // On Firefox for Android (Fenix / GeckoView), native Android OS Picture-in-Picture is triggered
      // by GeckoView's PictureInPictureFeature when the <video> element is in Fullscreen mode
      // (document.fullscreenElement === video) with MediaSession playing and the user presses/swipes the Home button!
      const isCurrentlyFullscreen =
        doc.fullscreenElement === video ||
        doc.mozFullScreenElement === video ||
        Boolean(doc.fullscreenElement);

      if (isCurrentlyFullscreen) {
        if (typeof doc.exitFullscreen === 'function') {
          await doc.exitFullscreen().catch(() => {});
        } else if (typeof doc.mozCancelFullScreen === 'function') {
          try {
            doc.mozCancelFullScreen();
          } catch {}
        }
        try {
          (window.screen?.orientation as any)?.unlock?.();
        } catch {}
        setIsPipActive(false);
        return;
      }

      // Ensure video is actively playing and MediaSession is marked 'playing' for Firefox's PiP detector
      video.controls = true;
      if (video.paused && !userPausedRef.current) {
        video.play().catch(() => {});
      }
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'playing';
        } catch {}
      }

      const isMobileFirefox =
        typeof navigator !== 'undefined' &&
        /Android|Mobile|Tablet/i.test(navigator.userAgent);
      const hintText = isMobileFirefox
        ? 'Firefox PiP Ready: Swipe or press your Home button now for floating Picture-in-Picture!'
        : 'Firefox PiP: Click the Picture-in-Picture icon on the right edge of the video (or press Ctrl+Shift+])';

      showPipHelperToast(hintText, 5500);
      showFullscreenVideoCue(video, hintText, 5.5);

      const lockLandscape = () => {
        try {
          (window.screen?.orientation as any)?.lock?.('landscape')?.catch?.(() => {});
        } catch {}
      };

      if (typeof video.requestFullscreen === 'function') {
        await video.requestFullscreen();
        lockLandscape();
        setIsPipActive(true);
        return;
      }
      if (typeof video.mozRequestFullScreen === 'function') {
        video.mozRequestFullScreen();
        lockLandscape();
        setIsPipActive(true);
        return;
      }

      if (isArenaOpen) {
        closeArenaRestoreSeoUrl(true);
      }
    } catch {
      if (isArenaOpen) {
        closeArenaRestoreSeoUrl(true);
      }
    }
  }, [isArenaOpen, closeArenaRestoreSeoUrl, showPipHelperToast, showFullscreenVideoCue]);

  // Picture-in-Picture & Fullscreen-PiP event listeners (Standard Web API + Safari + Mozilla Firefox)
  useEffect(() => {
    const video = videoRef.current as any;
    if (!video) return;

    const onEnterPip = () => {
      setIsPipActive(true);
      syncAudioOutputRouting();
      if (activeChannelRef.current && !userPausedRef.current && video.paused) {
        video.play().catch(() => {});
      }
    };
    const onLeavePip = () => {
      setIsPipActive(false);
      // When the user locks their phone while in PiP, Android exits PiP and pauses the <video>.
      // Immediately switch audio output to the companion <audio> element and resume playback!
      syncAudioOutputRouting();
      if (activeChannelRef.current && !userPausedRef.current) {
        resumePlaybackPersistently();
      }
    };
    const onWebkitModeChange = () => {
      const inPip = video.webkitPresentationMode === 'picture-in-picture';
      setIsPipActive(inPip);
      syncAudioOutputRouting();
      if (!inPip && activeChannelRef.current && !userPausedRef.current) {
        resumePlaybackPersistently();
      }
    };
    const onFullscreenChange = () => {
      const doc = document as any;
      const fsEl = doc.fullscreenElement || doc.mozFullScreenElement || doc.webkitFullscreenElement;
      const isFirefox =
        typeof navigator !== 'undefined' && /Firefox|FxiOS/i.test(navigator.userAgent);
      if (isFirefox) {
        setIsPipActive(Boolean(fsEl));
      }
      if (!fsEl && activeChannelRef.current && !userPausedRef.current) {
        resumePlaybackPersistently();
      }
    };

    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    video.addEventListener('webkitpresentationmodechanged', onWebkitModeChange);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('mozfullscreenchange', onFullscreenChange);

    return () => {
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
      video.removeEventListener('webkitpresentationmodechanged', onWebkitModeChange);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('mozfullscreenchange', onFullscreenChange);
    };
  }, [resumePlaybackPersistently, syncAudioOutputRouting]);

  // Background Play, MediaSession Lock-Screen Controls & Screen Wake Lock
  useEffect(() => {
    if (!activeChannel || typeof window === 'undefined') return;

    // 1. Configure MediaSession metadata & lock-screen / headset transport controls
    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      try {
        const title = activeMatch
          ? `${activeMatch.homeTeam?.name || 'Home'} vs ${activeMatch.awayTeam?.name || 'Away'}`
          : cleanActiveChannelName;
        const artist = activeMatch
          ? `${activeMatch.league || 'Live Sports'} · ${cleanActiveChannelName}`
          : `${activeChannel.network || 'Notflix Live Arena'} · ${activeChannel.languageLabel || 'HD'}`;
        const artworkUrl =
          activeChannelLogo && activeChannelLogo.startsWith('http')
            ? activeChannelLogo
            : activeMatch?.homeTeam?.logo ||
              activeMatch?.leagueLogo ||
              `${window.location.origin}/icon-192.png`;

        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist,
          album: 'Notflix Live Arena',
          artwork: artworkUrl
            ? [
                { src: artworkUrl, sizes: '192x192', type: 'image/png' },
                { src: artworkUrl, sizes: '512x512', type: 'image/png' },
              ]
            : [],
        });

        navigator.mediaSession.playbackState = userPausedRef.current ? 'paused' : 'playing';

        navigator.mediaSession.setActionHandler('play', () => {
          userPausedRef.current = false;
          syncAudioOutputRouting();
          const v = videoRef.current;
          const a = bgAudioRef.current;
          if (bgAudioActiveRef.current && a) {
            a.play()
              .then(() => setIsPlaying(true))
              .catch(() => {});
          } else if (v) {
            if (!userMutedRef.current && v.muted) {
              v.muted = false;
              setIsMuted(false);
            }
            v.play()
              .then(() => setIsPlaying(true))
              .catch(() => {});
          }
          navigator.mediaSession.playbackState = 'playing';
        });

        navigator.mediaSession.setActionHandler('pause', () => {
          userPausedRef.current = true;
          clearResumeTimers();
          videoRef.current?.pause();
          bgAudioRef.current?.pause();
          setIsPlaying(false);
          navigator.mediaSession.playbackState = 'paused';
        });

        navigator.mediaSession.setActionHandler('stop', () => {
          stopLiveStream();
        });

        navigator.mediaSession.setActionHandler('nexttrack', () => {
          if (activeMatch?.recommendedChannels && activeMatch.recommendedChannels.length > 1) {
            const curIdx = activeMatch.recommendedChannels.findIndex((r) => r.channelId === activeChannel.id);
            const nextCh =
              activeMatch.recommendedChannels[(curIdx + 1) % activeMatch.recommendedChannels.length];
            if (nextCh) tuneChannel(nextCh.channelId, activeMatch);
          } else if (sources.length > 1) {
            setUsingFallbackProxy(false);
            setActiveSourceIndex((prev) => (prev + 1) % sources.length);
          }
        });

        navigator.mediaSession.setActionHandler('previoustrack', () => {
          if (activeMatch?.recommendedChannels && activeMatch.recommendedChannels.length > 1) {
            const curIdx = activeMatch.recommendedChannels.findIndex((r) => r.channelId === activeChannel.id);
            const prevCh =
              activeMatch.recommendedChannels[
                (curIdx - 1 + activeMatch.recommendedChannels.length) %
                  activeMatch.recommendedChannels.length
              ];
            if (prevCh) tuneChannel(prevCh.channelId, activeMatch);
          } else if (sources.length > 1) {
            setUsingFallbackProxy(false);
            setActiveSourceIndex((prev) => (prev - 1 + sources.length) % sources.length);
          }
        });

        try {
          (navigator.mediaSession as any).setActionHandler('enterpictureinpicture', () => {
            const v = videoRef.current as any;
            if (!v) return;
            if (typeof v.requestPictureInPicture === 'function') {
              v.requestPictureInPicture()
                .then(() => setIsPipActive(true))
                .catch(() => {});
            } else if (typeof v.webkitSetPresentationMode === 'function') {
              try {
                v.webkitSetPresentationMode('picture-in-picture');
                setIsPipActive(true);
              } catch {}
            }
          });
        } catch {}
      } catch {}
    }

    // 2. Keep stream alive across app switches, window blur & mobile screen lock (verrouillage)
    const handleVisibilityOrBlur = () => {
      const v = videoRef.current as any;
      const a = bgAudioRef.current;
      if (!v || !activeChannelRef.current) return;
      syncAudioOutputRouting();

      if (document.hidden) {
        if (isBackgroundPlayEnabledRef.current && !userPausedRef.current) {
          resumePlaybackPersistently();
        }
      } else {
        // Returned to foreground: sync <video> playhead to <audio> playhead if background audio was running
        if (
          a &&
          Number.isFinite(a.currentTime) &&
          a.currentTime > 0 &&
          Math.abs(v.currentTime - a.currentTime) > 0.6
        ) {
          try {
            v.currentTime = a.currentTime;
          } catch {}
        }
        if (!userPausedRef.current && v.paused) {
          v.play()
            .then(() => setIsPlaying(true))
            .catch(() => {});
        }
        if ('wakeLock' in navigator && !wakeLockRef.current) {
          (navigator as any).wakeLock
            .request('screen')
            .then((lock: any) => {
              wakeLockRef.current = lock;
            })
            .catch(() => {});
        }
      }
    };

    const handleWindowBlur = () => {
      if (isBackgroundPlayEnabledRef.current && !userPausedRef.current && activeChannelRef.current) {
        syncAudioOutputRouting();
        resumePlaybackPersistently();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrBlur);
    window.addEventListener('pagehide', handleWindowBlur);
    window.addEventListener('blur', handleWindowBlur);

    // Continuous 1s background watchdog while stream is active so OS sleep/lock transitions never leave audio paused
    const bgWatchdog = window.setInterval(() => {
      const v = videoRef.current;
      const a = bgAudioRef.current;
      if (
        !v ||
        userPausedRef.current ||
        !activeChannelRef.current ||
        !isBackgroundPlayEnabledRef.current
      ) {
        return;
      }
      syncAudioOutputRouting();

      if (bgAudioActiveRef.current && a) {
        if (a.paused && !a.ended && !loadingStream) {
          a.play()
            .then(() => setIsPlaying(true))
            .catch(() => {});
        }
        if (Number.isFinite(a.currentTime) && Math.abs(a.currentTime - v.currentTime) >= 1.5) {
          try {
            v.currentTime = a.currentTime;
          } catch {}
        }
      } else if (v.paused && !v.ended && !loadingStream) {
        v.play()
          .then(() => setIsPlaying(true))
          .catch(() => {});
      }
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          if (navigator.mediaSession.playbackState !== 'playing') {
            navigator.mediaSession.playbackState = 'playing';
          }
        } catch {}
      }
    }, 1000);

    // 3. Acquire Screen Wake Lock while watching live sports
    if ('wakeLock' in navigator && !document.hidden) {
      (navigator as any).wakeLock
        .request('screen')
        .then((lock: any) => {
          wakeLockRef.current = lock;
        })
        .catch(() => {});
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityOrBlur);
      window.removeEventListener('pagehide', handleWindowBlur);
      window.removeEventListener('blur', handleWindowBlur);
      window.clearInterval(bgWatchdog);
      if (wakeLockRef.current) {
        try {
          wakeLockRef.current.release();
        } catch {}
        wakeLockRef.current = null;
      }
    };
  }, [
    activeChannel?.id,
    activeMatch?.id,
    cleanActiveChannelName,
    activeChannelLogo,
    isBackgroundPlayEnabled,
    sources.length,
    loadingStream,
    clearResumeTimers,
    resumePlaybackPersistently,
    syncAudioOutputRouting,
    stopLiveStream,
    tuneChannel,
  ]);

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
      hasUserMovedOrbRef.current = true;
      const finalPos = { ...orbPosRef.current };
      setOrbPos(finalPos);
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
      if (!matchesChannelCategory(ch, channelCategory)) return false;
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
    const a = bgAudioRef.current;
    if (!v) return;
    const nextMuted = !userMutedRef.current;
    userMutedRef.current = nextMuted;
    v.defaultMuted = nextMuted;
    v.muted = nextMuted;
    if (a) {
      a.muted = bgAudioActiveRef.current ? nextMuted : false;
    }
    if (!nextMuted) {
      if (v.volume === 0) v.volume = 1;
      unlockAndUnmuteVideoAudio(v, isAudioCleanEnabled);
    }
    setIsMuted(nextMuted);
    syncAudioOutputRouting();
  };

  const toggleFullscreen = () => {
    const video = videoRef.current as any;
    const container = playerContainerRef.current as any;
    if (!video && !container) return;

    const doc = document as any;
    if (
      doc.fullscreenElement ||
      doc.mozFullScreenElement ||
      doc.webkitFullscreenElement ||
      video?.webkitDisplayingFullscreen
    ) {
      if (typeof doc.exitFullscreen === 'function' && doc.fullscreenElement) {
        doc.exitFullscreen().catch(() => {});
      } else if (typeof doc.mozCancelFullScreen === 'function') {
        try {
          doc.mozCancelFullScreen();
        } catch {}
      } else if (typeof doc.webkitExitFullscreen === 'function') {
        try {
          doc.webkitExitFullscreen();
        } catch {}
      } else if (typeof video?.webkitExitFullscreen === 'function') {
        try {
          video.webkitExitFullscreen();
        } catch {}
      }
      try {
        (window.screen?.orientation as any)?.unlock?.();
      } catch {}
      return;
    }

    const lockLandscapeIfSupported = () => {
      try {
        (window.screen?.orientation as any)?.lock?.('landscape')?.catch?.(() => {});
      } catch {}
    };

    // Always prioritize native <video> element fullscreen first (gives true edge-to-edge hardware video player on mobile & desktop, and enables Firefox Android OS PiP!)
    if (typeof video?.requestFullscreen === 'function') {
      video
        .requestFullscreen()
        .then(lockLandscapeIfSupported)
        .catch(() => {
          if (typeof video?.mozRequestFullScreen === 'function') {
            try {
              video.mozRequestFullScreen();
              lockLandscapeIfSupported();
            } catch {}
          } else if (typeof video?.webkitEnterFullscreen === 'function') {
            try {
              video.webkitEnterFullscreen();
            } catch {}
          } else if (typeof container?.requestFullscreen === 'function') {
            container.requestFullscreen().then(lockLandscapeIfSupported).catch(() => {});
          }
        });
    } else if (typeof video?.mozRequestFullScreen === 'function') {
      try {
        video.mozRequestFullScreen();
        lockLandscapeIfSupported();
      } catch {}
    } else if (typeof video?.webkitEnterFullscreen === 'function') {
      try {
        video.webkitEnterFullscreen();
      } catch {}
    } else if (typeof video?.webkitRequestFullscreen === 'function') {
      try {
        video.webkitRequestFullscreen();
        lockLandscapeIfSupported();
      } catch {}
    } else if (typeof container?.requestFullscreen === 'function') {
      container.requestFullscreen().then(lockLandscapeIfSupported).catch(() => {});
    }
  };

  return (
    <>
      {pipToastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[120] max-w-md w-[92vw] px-4 py-2.5 rounded-xl bg-indigo-950/95 border border-indigo-400/50 text-white text-xs font-bold shadow-2xl flex items-center gap-2.5 backdrop-blur-md pointer-events-none">
          <PictureInPicture2 className="w-4 h-4 text-indigo-300 shrink-0" />
          <span>{pipToastMessage}</span>
        </div>
      )}

      {/* Persistent In-Viewport Parking Host for the Single Shared Live TV <video> Element + Companion Pure-Audio <audio> Element
          Kept inside the viewport at 2x2px with 1% opacity so Chromium's IntersectionObserver
          always treats the video as in-viewport for autoPictureInPicture, and the pure-audio <audio> (HasVideo() == false)
          keeps playing uninterrupted in Chrome when switching apps or locking the phone screen! */}
      <div
        ref={bgVideoParkingRef}
        className="fixed bottom-0 right-0 w-[2px] h-[2px] overflow-hidden opacity-[0.01] pointer-events-none z-0"
        aria-hidden="true"
      >
        <video
          ref={videoRef}
          controls={isArenaOpen || !isMiniPlayerMode}
          playsInline
          autoPlay
          muted={isMuted}
          onPointerDown={() => {
            lastVideoGestureMsRef.current = Date.now();
          }}
          onTouchStart={() => {
            lastVideoGestureMsRef.current = Date.now();
          }}
          onDoubleClick={toggleFullscreen}
          onTimeUpdate={handleVideoTimeUpdate}
          onWaiting={handleVideoWaiting}
          onPlaying={handleVideoPlaying}
          onCanPlay={handleVideoPlaying}
          onPause={handleVideoPause}
          onVolumeChange={handleVideoVolumeChange}
          className="w-full h-full object-contain cursor-pointer bg-black"
        />
        <audio
          ref={bgAudioRef}
          playsInline
          preload="auto"
          onTimeUpdate={handleBgAudioTimeUpdate}
          className="hidden"
        />
      </div>

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
                      : cleanActiveChannelName}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0" data-no-drag="true">
                  <button
                    type="button"
                    onClick={togglePlayPause}
                    title={isPlaying ? 'Pause' : 'Play'}
                    className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer"
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 text-emerald-400" />}
                  </button>
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
                    onClick={togglePictureInPicture}
                    title={isPipActive ? 'Exit Picture-in-Picture' : 'Picture-in-Picture (PiP)'}
                    className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                      isPipActive
                        ? 'bg-indigo-600 text-white'
                        : 'hover:bg-white/10 text-indigo-400 hover:text-indigo-300'
                    }`}
                  >
                    <PictureInPicture2 className="w-3.5 h-3.5" />
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
                <div ref={miniVideoSlotRef} className="w-full h-full flex items-center justify-center" />
                {(loadingStream || isVideoBuffering) && !streamError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[#070b14]/90 backdrop-blur-sm select-none pointer-events-none">
                    <div className="relative flex items-center justify-center">
                      <span className="w-12 h-12 rounded-full border-2 border-white/10 border-t-rose-500 border-r-rose-400/60 animate-spin" />
                      <div className="absolute w-8 h-8 rounded-xl bg-white/95 p-1 shadow-[0_0_20px_rgba(225,29,72,0.4)] flex items-center justify-center overflow-hidden">
                        {activeChannelLogo && !bufferingLogoFailed ? (
                          <img
                            src={activeChannelLogo}
                            alt={cleanActiveChannelName}
                            onError={() => setBufferingLogoFailed(true)}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <Tv className="w-4 h-4 text-rose-600" />
                        )}
                      </div>
                    </div>
                    <span className="text-[10px] font-extrabold text-white tracking-tight truncate max-w-[200px] px-2">
                      {formatCompactChannelBadge(activeChannel.id, activeChannel.name)}
                    </span>
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
                    {channels.length || 175}
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
                        : `Search ${channels.length || 175}+ live sports, movie & TV channels...`
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
                        const catCount =
                          cat.id === 'all'
                            ? channels.length
                            : channels.filter((ch) => matchesChannelCategory(ch, cat.id)).length;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setChannelCategory(cat.id)}
                            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                              active
                                ? 'bg-white text-slate-950 font-bold'
                                : 'bg-white/[0.04] text-slate-400 hover:text-white'
                            }`}
                          >
                            <span>{cat.label}</span>
                            {catCount > 0 && (
                              <span
                                className={`text-[10px] font-mono ${
                                  active ? 'text-slate-600' : 'text-slate-500'
                                }`}
                              >
                                {catCount}
                              </span>
                            )}
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
                  <div ref={arenaVideoSlotRef} className="w-full h-full flex items-center justify-center" />

                  {(loadingStream || isVideoBuffering) && !streamError && (
                    <div className="absolute inset-0 bg-[#070b14]/90 backdrop-blur-md flex flex-col items-center justify-center z-10 select-none pointer-events-none">
                      <div className="relative flex items-center justify-center">
                        <div className="w-24 h-24 rounded-full bg-rose-600/15 blur-2xl animate-pulse absolute" />
                        <span className="w-20 h-20 rounded-full border border-rose-500/25 animate-ping opacity-30 absolute" />
                        <span className="w-20 h-20 rounded-full border-2 border-white/[0.08] border-t-rose-500 border-r-rose-400/70 animate-spin" />
                        <div className="absolute w-14 h-14 rounded-2xl bg-white/95 p-2 shadow-[0_8px_28px_rgba(225,29,72,0.38)] flex items-center justify-center overflow-hidden">
                          {activeChannelLogo && !bufferingLogoFailed ? (
                            <img
                              src={activeChannelLogo}
                              alt={cleanActiveChannelName}
                              onError={() => setBufferingLogoFailed(true)}
                              className="w-full h-full object-contain"
                            />
                          ) : (
                            <Tv className="w-6 h-6 text-rose-600" />
                          )}
                        </div>
                      </div>

                      <div className="mt-3 flex flex-col items-center gap-1.5 px-4 text-center">
                        {(!activeChannelLogo || bufferingLogoFailed) && (
                          <span className="text-xs font-extrabold tracking-tight text-white truncate max-w-[180px]">
                            {cleanActiveChannelName}
                          </span>
                        )}
                        <div className="flex items-end gap-1 h-2.5" aria-hidden="true">
                          <span className="w-1 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                          <span
                            className="w-1 h-2.5 rounded-full bg-rose-400 animate-pulse"
                            style={{ animationDelay: '150ms' }}
                          />
                          <span
                            className="w-1 h-2 rounded-full bg-rose-500 animate-pulse"
                            style={{ animationDelay: '300ms' }}
                          />
                          <span
                            className="w-1 h-1.5 rounded-full bg-rose-400 animate-pulse"
                            style={{ animationDelay: '450ms' }}
                          />
                        </div>
                      </div>
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

                {/* Stream Bar: Compact Title + Mirrors + Controls */}
                <div className="p-2 sm:px-3.5 bg-[#101829] border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping shrink-0" />
                    <span className="text-xs font-bold text-white truncate max-w-[200px] sm:max-w-[260px]">
                      {activeMatch
                        ? `${activeMatch.homeTeam?.shortName || activeMatch.homeTeam?.name} vs ${activeMatch.awayTeam?.shortName || activeMatch.awayTeam?.name}`
                        : cleanActiveChannelName}
                    </span>
                    {!loadingStream && !isVideoBuffering && !activeMatch && (activeChannel.epg?.nowPlaying || activeChannel.epg?.currentProgram) && (
                      <span className="hidden sm:inline-block px-2 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/35 text-[10px] font-semibold text-rose-300 truncate max-w-[220px]">
                        {formatCleanEpgTitle((activeChannel.epg?.nowPlaying || activeChannel.epg?.currentProgram)?.title)}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {activeMatch &&
                      activeMatch.recommendedChannels &&
                      activeMatch.recommendedChannels.length > 0 &&
                      activeMatch.recommendedChannels.map((rc) => {
                        const isCurrent = rc.channelId === activeChannel.id;
                        const cleanName = formatCompactChannelBadge(rc.channelId, rc.name);
                        const langTag = (rc.language || rc.languageLabel?.slice(0, 2) || 'HD').toUpperCase();
                        return (
                          <button
                            key={rc.channelId}
                            type="button"
                            onClick={() => tuneChannel(rc.channelId, activeMatch)}
                            title={`${rc.name} (${rc.languageLabel})`}
                            className={`px-2 py-1 rounded-md text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1 ${
                              isCurrent
                                ? 'bg-rose-600 text-white shadow-[0_2px_10px_rgba(225,29,72,0.4)]'
                                : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-300'
                            }`}
                          >
                            <Tv className="w-2.5 h-2.5 shrink-0 opacity-80" />
                            <span className="truncate max-w-[110px]">{cleanName}</span>
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
                            userMutedRef.current = false;
                            setIsMuted(false);
                            unlockAndUnmuteVideoAudio(videoRef.current, isAudioCleanEnabled);
                            setUsingFallbackProxy(false);
                            setActiveSourceIndex(idx);
                          }}
                          className={`px-2 py-1 rounded-md text-[10px] font-mono font-bold transition-colors cursor-pointer ${
                            idx === activeSourceIndex
                              ? 'bg-emerald-600 text-white'
                              : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-300'
                          }`}
                        >
                          S{idx + 1}
                        </button>
                      ))}

                    <button
                      type="button"
                      onClick={togglePlayPause}
                      title={isPlaying ? 'Pause Stream' : 'Play Stream'}
                      className="px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 bg-white/[0.07] hover:bg-white/[0.14] text-slate-200 transition-colors cursor-pointer"
                    >
                      {isPlaying ? (
                        <Pause className="w-3.5 h-3.5 text-amber-400" />
                      ) : (
                        <Play className="w-3.5 h-3.5 text-emerald-400" />
                      )}
                      <span>{isPlaying ? 'Pause' : 'Play'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={toggleMute}
                      title={isMuted ? 'Unmute Audio' : 'Mute Audio'}
                      className={`px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                        isMuted
                          ? 'bg-rose-500/25 border border-rose-500/50 text-rose-300'
                          : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-200'
                      }`}
                    >
                      {isMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400" />}
                      <span>{isMuted ? 'Muted' : 'Sound'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsAudioCleanEnabled((prev) => !prev)}
                      title="Broadcast Noise Reduction & Anti-Clipping Filter"
                      className={`px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                        isAudioCleanEnabled
                          ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-300'
                          : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-400'
                      }`}
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>Clean</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsBackgroundPlayEnabled((prev) => !prev)}
                      title="Background Play & Lock-Screen Audio"
                      className={`px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                        isBackgroundPlayEnabled
                          ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                          : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-400'
                      }`}
                    >
                      <Headphones className="w-3 h-3" />
                      <span>BG</span>
                    </button>

                    <button
                      type="button"
                      onClick={togglePictureInPicture}
                      title={isPipActive ? 'Exit Picture-in-Picture' : 'Picture-in-Picture (PiP)'}
                      className={`px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                        isPipActive
                          ? 'bg-indigo-600 text-white shadow-[0_2px_10px_rgba(79,70,229,0.45)]'
                          : 'bg-white/[0.07] hover:bg-white/[0.14] text-slate-200 hover:text-white'
                      }`}
                    >
                      <PictureInPicture2 className="w-3.5 h-3.5" />
                      <span>PiP</span>
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
                      'Live Sports HD';
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
                        onClick={() => {
                          if (!finished) {
                            playEventDirectly(ev, displayedChannelObj?.channelId);
                          }
                        }}
                        className={`group rounded-2xl px-3.5 pt-3 pb-2.5 border transition-all duration-200 ${
                          finished ? 'cursor-default opacity-85' : 'cursor-pointer'
                        } ${
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
                              recChannels.slice(0, 4).map((rc, idx) => {
                                const isActiveCh =
                                  (isWatching && activeChannel?.id === rc.channelId) ||
                                  (!isWatching && idx === 0);
                                const shortChName = formatCompactChannelBadge(rc.channelId, rc.name);
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
                                    <span className="whitespace-nowrap">{shortChName}</span>
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

                          {finished ? (
                            <span className="px-3 py-1 rounded-full bg-slate-800/80 border border-white/10 text-[10px] sm:text-[11px] font-bold text-slate-400 shrink-0">
                              Match Ended
                            </span>
                          ) : (
                            <a
                              href={buildMatchSeoPath(ev)}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                playEventDirectly(ev, displayedChannelObj?.channelId);
                              }}
                              title={
                                live
                                  ? 'Watch Live Match Broadcast'
                                  : `Match starts at ${kickoff.time} (${kickoff.relative}) — preview channel broadcast`
                              }
                              className={`px-3.5 py-1 rounded-full text-[11px] sm:text-xs font-bold text-white flex items-center gap-1.5 transition-all shrink-0 cursor-pointer ${
                                live
                                  ? 'bg-rose-600 hover:bg-rose-500 shadow-[0_4px_12px_rgba(225,29,72,0.35)]'
                                  : kickoff.minsUntilKickoff <= 30
                                  ? 'bg-[#1d63ff] hover:bg-blue-500 shadow-[0_4px_12px_rgba(29,99,255,0.35)]'
                                  : 'bg-slate-800 hover:bg-slate-700 border border-white/15 text-slate-200'
                              }`}
                            >
                              <span>
                                {isWatching
                                  ? 'Watching'
                                  : live
                                  ? 'Watch Live'
                                  : kickoff.minsUntilKickoff <= 30
                                  ? 'Pre-Match'
                                  : 'Channel Preview'}
                              </span>
                              <Play className="w-2.5 h-2.5 fill-current" />
                            </a>
                          )}
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
                VIEW 2: 24/7 SPORTS TV CHANNELS GRID (GROUPED BY CATEGORY IN ALL VIEW)
                ================================================================= */}
            {activeView === 'channels' && (
              <section className="max-w-5xl mx-auto pb-12 space-y-6">
                {(() => {
                  const renderChannelCard = (ch: LiveChannel) => {
                    const isSelected = activeChannel?.id === ch.id;
                    const nowProg = ch.epg?.nowPlaying || ch.epg?.currentProgram;
                    const nextProg = ch.epg?.nextUp || ch.epg?.nextProgram;
                    const isLiveMatchProgram = Boolean(
                      nowProg && (nowProg.type === 'live_match' || nowProg.eventId || nowProg.isLive)
                    );
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
                            {formatShortChannelName(ch.name)}
                          </h3>
                          <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                            <span>{ch.languageLabel || 'English'}</span>
                            <span>·</span>
                            <span className="text-emerald-400 font-mono">
                              {ch.quality || '1080p'}
                            </span>
                          </div>
                          {nowProg ? (
                            <div
                              title={`ON AIR: ${nowProg.title}${nowProg.league || nowProg.subtitle ? ` (${nowProg.league || nowProg.subtitle})` : ''}`}
                              className={`mt-1 text-[10px] font-bold truncate flex items-center gap-1 ${
                                isLiveMatchProgram ? 'text-rose-400' : 'text-emerald-400/90'
                              }`}
                            >
                              <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  isLiveMatchProgram ? 'bg-rose-500 animate-ping' : 'bg-emerald-400'
                                }`}
                              />
                              <span className="truncate">{formatCleanEpgTitle(nowProg.title)}</span>
                            </div>
                          ) : null}
                          {nextProg ? (
                            <div
                              title={`UP NEXT (${formatKickoffTime(nextProg.startTime).time}): ${nextProg.title}`}
                              className="mt-0.5 text-[9.5px] font-medium text-cyan-400/85 truncate"
                            >
                              Next {formatKickoffTime(nextProg.startTime).time}: {formatCleanEpgTitle(nextProg.title)}
                            </div>
                          ) : null}
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
                  };

                  if (channelCategory === 'all' && !searchQuery.trim()) {
                    const seenIds = new Set<string>();
                    const categorySections = CHANNEL_CATEGORIES.filter((c) => c.id !== 'all')
                      .map((catDef) => {
                        const groupItems = filteredChannels.filter((ch) => {
                          if (seenIds.has(ch.id)) return false;
                          if (matchesChannelCategory(ch, catDef.id)) {
                            seenIds.add(ch.id);
                            return true;
                          }
                          return false;
                        });
                        return { ...catDef, items: groupItems };
                      })
                      .filter((sec) => sec.items.length > 0);

                    const uncategorized = filteredChannels.filter((ch) => !seenIds.has(ch.id));
                    if (uncategorized.length > 0) {
                      categorySections.push({
                        id: 'other',
                        label: 'International Channels',
                        items: uncategorized,
                      });
                    }

                    return categorySections.map((sec) => (
                      <div key={sec.id} className="space-y-2.5">
                        <div className="flex items-center justify-between px-1">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-[#1d63ff]" />
                            <h2 className="text-xs sm:text-sm font-extrabold uppercase tracking-wider text-white">
                              {sec.label}
                            </h2>
                            <span className="px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/10 text-[10px] font-mono font-bold text-slate-300">
                              {sec.items.length}
                            </span>
                          </div>
                          {sec.id !== 'other' && (
                            <button
                              type="button"
                              onClick={() => setChannelCategory(sec.id)}
                              className="text-[11px] font-bold text-sky-400 hover:text-sky-300 transition-colors cursor-pointer"
                            >
                              View {sec.label} →
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
                          {sec.items.map((ch) => renderChannelCard(ch))}
                        </div>
                      </div>
                    ));
                  }

                  return (
                    <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
                      {filteredChannels.map((ch) => renderChannelCard(ch))}
                    </div>
                  );
                })()}
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
};
