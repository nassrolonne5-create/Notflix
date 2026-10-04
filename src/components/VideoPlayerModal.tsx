import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import {
  X,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  PictureInPicture,
  Subtitles,
  Sliders,
  Download,
  FastForward,
  Rewind,
  Sun,
  Layers,
  Sparkles,
  Server,
  RotateCcw,
  Plus,
  Minus,
  ExternalLink,
  Languages,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  fetchStreams,
  fetchSubtitles,
  fetchTvSeasons,
  fetchTvEpisodes,
  fetchMediaDetails,
  isSafe,
  checkDeepSafety,
  TMDB_IMG,
} from '../services/api';
import { StreamSource, SubtitleTrack, Season, Episode, CastMember, MediaItem } from '../types';
import { MediaCard } from './MediaCard';
import { triggerAd, initAdResumeListeners } from '../services/adService';

const formatTime = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const VideoPlayerModal: React.FC = () => {
  const {
    activeModalItem,
    closePlayer,
    activeSeason,
    activeEpisode,
    openPlayer,
    userData,
    updatePlaybackPosition,
    showToast,
  } = useApp();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimeoutRef = useRef<number | null>(null);
  const progressBgRef = useRef<HTMLDivElement | null>(null);

  // Stream & playback state
  const [streams, setStreams] = useState<StreamSource[]>([]);
  const [activeStreamIndex, setActiveStreamIndex] = useState<number>(0);
  const [isLoadingStreams, setIsLoadingStreams] = useState<boolean>(true);
  const [streamError, setStreamError] = useState<string | null>(null);

  // TV Seasons & Episodes
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [currentSeason, setCurrentSeason] = useState<number>(activeSeason);
  const [currentEpisode, setCurrentEpisode] = useState<number>(activeEpisode);

  // Media Extra Details
  const [cast, setCast] = useState<CastMember[]>([]);
  const [similar, setSimilar] = useState<MediaItem[]>([]);
  const [imdbId, setImdbId] = useState<string | undefined>(undefined);

  // Subtitles
  const [subtitleGroups, setSubtitleGroups] = useState<Record<string, SubtitleTrack[]>>({});
  const [activeSubLabel, setActiveSubLabel] = useState<string>('Off');
  const [subOffset, setSubOffset] = useState<number>(0);
  const [rawSubText, setRawSubText] = useState<string>('');

  // Audio & Quality tracks
  const [audioTracks, setAudioTracks] = useState<Array<{ id: number; name: string; lang: string }>>([]);
  const [activeAudioTrackId, setActiveAudioTrackId] = useState<number>(-1);
  const [qualityLevels, setQualityLevels] = useState<Array<{ id: number; height: number; bitrate: number }>>([]);
  const [activeQualityId, setActiveQualityId] = useState<number>(-1);

  // Controls UI state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isControlsVisible, setIsControlsVisible] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [showSkipIntro, setShowSkipIntro] = useState<boolean>(false);
  const [resumePrompt, setResumePrompt] = useState<{ time: number } | null>(null);
  const hasResumedRef = useRef<boolean>(false);
  const lastSavedTimeRef = useRef<number>(0);

  // Gesture states (Swipe to adjust Brightness & Seek)
  const [brightness, setBrightness] = useState<number>(1.0);
  const [gestureIndicator, setGestureIndicator] = useState<{
    type: 'brightness' | 'seek' | 'volume' | 'mute';
    value: string;
    subValue?: string;
    percent?: number;
  } | null>(null);
  const gestureIndicatorTimerRef = useRef<number | null>(null);
  const touchStartRef = useRef<{
    x: number;
    y: number;
    time: number;
    initialBrightness: number;
    initialCurrentTime: number;
    isSwiping: boolean;
    swipeType: 'vertical' | 'horizontal' | null;
  } | null>(null);

  // Floating Action Panels: null | 'subtitles' | 'quality' | 'audio' | 'speed' | 'episodes' | 'download'
  const [activePanel, setActivePanel] = useState<string | null>(null);

  const isTV =
    activeModalItem?.type === 'tv' ||
    activeModalItem?.media_type === 'tv' ||
    Boolean(!activeModalItem?.title && activeModalItem?.name);

  // Load TV Seasons & Credits
  useEffect(() => {
    if (!activeModalItem) return;
    let isMounted = true;
    if (isTV) {
      fetchTvSeasons(activeModalItem.id).then((sList) => {
        if (isMounted) setSeasons(sList);
      });
    }

    fetchMediaDetails(activeModalItem.type, activeModalItem.id).then((details) => {
      if (isMounted) {
        setCast(details.cast);
        setSimilar(details.similar);
        setImdbId(details.imdbId);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [activeModalItem?.id, activeModalItem?.type, isTV]);

  // Load Episodes when currentSeason changes
  useEffect(() => {
    if (!activeModalItem || !isTV) return;
    fetchTvEpisodes(activeModalItem.id, currentSeason).then((eps) => {
      setEpisodes(eps);
    });
  }, [activeModalItem?.id, isTV, currentSeason]);

  // Safety verification
  useEffect(() => {
    if (!activeModalItem) return;
    if (!isSafe(activeModalItem)) {
      showToast('This content is blocked by SafeFilter.', '🛡️');
      closePlayer();
      return;
    }
    checkDeepSafety(activeModalItem.type, activeModalItem.id).then((safe) => {
      if (!safe) {
        showToast('This content is blocked by SafeFilter.', '🛡️');
        closePlayer();
      }
    });
  }, [activeModalItem?.id, activeModalItem?.type]);

  // Load Streams from backend
  useEffect(() => {
    if (!activeModalItem) return;

    let isMounted = true;
    setIsLoadingStreams(true);
    setStreamError(null);
    setStreams([]);
    setActiveStreamIndex(0);

    fetchStreams(activeModalItem.type, activeModalItem.id, currentSeason, currentEpisode)
      .then((fetchedStreams) => {
        if (!isMounted) return;
        if (!fetchedStreams || fetchedStreams.length === 0) {
          setStreamError('No playable streams responded. Try checking other servers or titles.');
          setIsLoadingStreams(false);
          return;
        }

        // Prioritize English language audio servers to show first
        const sortedStreams = [...fetchedStreams].sort((a, b) => {
          const aText = `${a.provider || ''} ${a.quality || ''} ${a.rawTitle || ''} ${a.language || ''}`.toUpperCase();
          const bText = `${b.provider || ''} ${b.quality || ''} ${b.rawTitle || ''} ${b.language || ''}`.toUpperCase();

          const aIsEng = aText.includes('ENG') || aText.includes('ENGLISH') || aText.includes('ORIGINAL') || a.language?.toLowerCase() === 'english';
          const bIsEng = bText.includes('ENG') || bText.includes('ENGLISH') || bText.includes('ORIGINAL') || b.language?.toLowerCase() === 'english';

          const aForeign = (aText.includes('HINDI') || aText.includes('LATINO') || aText.includes('ESPANOL') || aText.includes('FRENCH') || aText.includes('GERMAN') || aText.includes('RUSSIAN')) && !aIsEng;
          const bForeign = (bText.includes('HINDI') || bText.includes('LATINO') || bText.includes('ESPANOL') || bText.includes('FRENCH') || bText.includes('GERMAN') || bText.includes('RUSSIAN')) && !bIsEng;

          if (aIsEng && !bIsEng) return -1;
          if (!aIsEng && bIsEng) return 1;
          if (aForeign && !bForeign) return 1;
          if (!aForeign && bForeign) return -1;
          return 0;
        });

        setStreams(sortedStreams);
        setIsLoadingStreams(false);
      })
      .catch(() => {
        if (!isMounted) return;
        setStreamError('Failed to retrieve streaming sources from backend.');
        setIsLoadingStreams(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeModalItem?.id, activeModalItem?.type, currentSeason, currentEpisode]);

  // Load Subtitles
  useEffect(() => {
    if (!activeModalItem || !imdbId) return;
    fetchSubtitles(imdbId, activeModalItem.id, activeModalItem.type, currentSeason, currentEpisode).then((groups) => {
      setSubtitleGroups(groups);
    });
  }, [imdbId, activeModalItem?.id, activeModalItem?.type, currentSeason, currentEpisode]);

  // Auto-switch states for short dummy/sample clips (e.g. Rickroll / teasers)
  const isAutoSwitchingRef = useRef<boolean>(false);
  const invalidServerIndicesRef = useRef<Set<number>>(new Set());
  const [invalidServerIndices, setInvalidServerIndices] = useState<number[]>([]);

  // Reset invalid servers on title, season, or episode change
  useEffect(() => {
    invalidServerIndicesRef.current.clear();
    setInvalidServerIndices([]);
    isAutoSwitchingRef.current = false;
  }, [activeModalItem?.id, currentSeason, currentEpisode]);

  const triggerAutoSwitch = useCallback((badIndex: number, _clipDuration?: number) => {
    if (isAutoSwitchingRef.current) return;
    isAutoSwitchingRef.current = true;

    invalidServerIndicesRef.current.add(badIndex);
    setInvalidServerIndices(Array.from(invalidServerIndicesRef.current));

    // Find next untested server in the list
    let nextIdx = -1;
    for (let i = badIndex + 1; i < streams.length; i++) {
      if (!invalidServerIndicesRef.current.has(i)) {
        nextIdx = i;
        break;
      }
    }
    if (nextIdx === -1) {
      for (let i = 0; i < streams.length; i++) {
        if (!invalidServerIndicesRef.current.has(i)) {
          nextIdx = i;
          break;
        }
      }
    }

    if (nextIdx !== -1 && nextIdx !== badIndex) {
      // Small clean notification of switching between servers
      showToast(`Switching to Server ${nextIdx + 1}...`, '⚡');

      // Immediately switch server and auto-play
      setIsLoadingStreams(true);
      setActiveStreamIndex(nextIdx);
      isAutoSwitchingRef.current = false;
    } else {
      isAutoSwitchingRef.current = false;
      setStreamError('All available servers returned short sample clips or errors. Try another title.');
    }
  }, [streams, showToast]);

  // Attach Stream to Native Video or HLS.js
  useEffect(() => {
    const video = videoRef.current;
    if (!video || streams.length === 0) return;

    const stream = streams[activeStreamIndex];
    if (!stream) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isM3U8 =
      stream.isM3U8 !== false &&
      (stream.url.includes('.m3u8') || !stream.url.match(/\.(mp4|webm|mkv)/i));

    if (isM3U8 && Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 600,
        enableWorker: true,
      });
      hlsRef.current = hls;

      hls.loadSource(stream.url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        // Collect Quality levels
        const levels = data.levels.map((lvl, idx) => ({
          id: idx,
          height: lvl.height,
          bitrate: lvl.bitrate,
        }));
        setQualityLevels(levels);
        setIsLoadingStreams(false);
        setStreamError(null);

        // Resume saved playback timestamp
        resumeSavedPlayback();
        video.play().then(() => {
          setIsPlaying(true);
        }).catch(() => {});
      });

      hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
        const totalDur = data.details?.totalduration;
        const minAllowed = isTV ? 240 : 480;
        if (totalDur && isFinite(totalDur) && totalDur > 0 && totalDur < minAllowed) {
          triggerAutoSwitch(activeStreamIndex, totalDur);
        }
      });

      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
        const tracks = data.audioTracks.map((t, idx) => ({
          id: t.id,
          name: t.name || `Track ${idx + 1}`,
          lang: (t.lang || '').toLowerCase(),
        }));

        // Sort so English audio tracks are prioritized first in the list
        tracks.sort((a, b) => {
          const aEng = a.lang.startsWith('en') || a.name.toLowerCase().includes('eng') || a.name.toLowerCase().includes('english') || a.name.toLowerCase().includes('original') ? -1 : 1;
          const bEng = b.lang.startsWith('en') || b.name.toLowerCase().includes('eng') || b.name.toLowerCase().includes('english') || b.name.toLowerCase().includes('original') ? -1 : 1;
          return aEng - bEng;
        });
        setAudioTracks(tracks);

        // Auto-select English audio track if available
        const englishIndex = data.audioTracks.findIndex((t) => {
          const l = (t.lang || '').toLowerCase();
          const n = (t.name || '').toLowerCase();
          return l.startsWith('en') || n.includes('eng') || n.includes('english') || n.includes('original');
        });

        if (englishIndex !== -1) {
          const engTrack = data.audioTracks[englishIndex];
          hls.audioTrack = engTrack.id;
          setActiveAudioTrackId(engTrack.id);
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.warn('Fatal HLS stream error, failover to next server...', data);
          triggerAutoSwitch(activeStreamIndex);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Apple HLS (iOS Safari, Mobile Chrome on iOS, iPadOS)
      video.src = stream.url;
      const onReady = () => {
        setIsLoadingStreams(false);
        setStreamError(null);
        resumeSavedPlayback();

        // Check for short sample video
        const dur = video.duration;
        const minAllowed = isTV ? 240 : 480;
        if (dur && isFinite(dur) && dur > 0 && dur < minAllowed) {
          triggerAutoSwitch(activeStreamIndex, dur);
          return;
        }

        // Check native audio tracks and prioritize English
        const v = video as any;
        if (v.audioTracks && v.audioTracks.length > 0) {
          for (let i = 0; i < v.audioTracks.length; i++) {
            const t = v.audioTracks[i];
            const l = (t.language || '').toLowerCase();
            const label = (t.label || '').toLowerCase();
            if (l.startsWith('en') || label.includes('eng') || label.includes('english') || label.includes('original')) {
              t.enabled = true;
            } else {
              t.enabled = false;
            }
          }
        }

        video.play().then(() => {
          setIsPlaying(true);
        }).catch(() => {
          setIsPlaying(false);
        });
      };
      video.addEventListener('loadedmetadata', onReady, { once: true });
      video.addEventListener('canplay', onReady, { once: true });
      video.onerror = () => {
        triggerAutoSwitch(activeStreamIndex);
      };
    } else {
      video.src = stream.url;
      const onReady = () => {
        setIsLoadingStreams(false);
        setStreamError(null);
        resumeSavedPlayback();

        const dur = video.duration;
        const minAllowed = isTV ? 240 : 480;
        if (dur && isFinite(dur) && dur > 0 && dur < minAllowed) {
          triggerAutoSwitch(activeStreamIndex);
          return;
        }

        video.play().then(() => {
          setIsPlaying(true);
        }).catch(() => {
          setIsPlaying(false);
        });
      };
      video.addEventListener('loadeddata', onReady, { once: true });
      video.addEventListener('canplay', onReady, { once: true });
      video.onerror = () => {
        triggerAutoSwitch(activeStreamIndex);
      };
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [streams, activeStreamIndex]);

  // Reset resumed status when changing title, season, or episode
  useEffect(() => {
    hasResumedRef.current = false;
    setResumePrompt(null);
  }, [activeModalItem?.id, currentSeason, currentEpisode]);

  // Dismiss resume notification after 6 seconds
  useEffect(() => {
    if (resumePrompt) {
      const timer = window.setTimeout(() => setResumePrompt(null), 6000);
      return () => window.clearTimeout(timer);
    }
  }, [resumePrompt]);

  // Synchronously save current playback (AppContext + localStorage)
  const saveCurrentPlaybackNow = useCallback(() => {
    const video = videoRef.current;
    if (!video || !activeModalItem) return;
    const ct = video.currentTime;
    if (ct < 2) return;

    lastSavedTimeRef.current = ct;
    const trackKey = `${activeModalItem.type}-${activeModalItem.id}`;

    if (isTV) {
      updatePlaybackPosition(trackKey, {
        s: currentSeason,
        e: currentEpisode,
        [`time_${currentSeason}_${currentEpisode}`]: ct,
        [`duration_${currentSeason}_${currentEpisode}`]: video.duration || 0,
      });
    } else {
      updatePlaybackPosition(trackKey, {
        time: ct,
        duration: video.duration || 0,
      });
    }

    try {
      const sessionData = {
        item: activeModalItem,
        season: currentSeason,
        episode: currentEpisode,
        time: ct,
        duration: video.duration || 0,
        timestamp: Date.now(),
      };
      localStorage.setItem('notflix_last_session', JSON.stringify(sessionData));

      const savedPb = localStorage.getItem('notflix_playback');
      const pbObj = savedPb ? JSON.parse(savedPb) : {};
      const currentTrack = pbObj[trackKey] || {};
      if (isTV) {
        pbObj[trackKey] = {
          ...currentTrack,
          s: currentSeason,
          e: currentEpisode,
          [`time_${currentSeason}_${currentEpisode}`]: ct,
          [`duration_${currentSeason}_${currentEpisode}`]: video.duration || 0,
        };
      } else {
        pbObj[trackKey] = {
          ...currentTrack,
          time: ct,
          duration: video.duration || 0,
        };
      }
      localStorage.setItem('notflix_playback', JSON.stringify(pbObj));
    } catch (e) {
      console.warn('LocalStorage save error:', e);
    }
  }, [activeModalItem, currentSeason, currentEpisode, isTV, updatePlaybackPosition]);

  const saveCurrentPlaybackRef = useRef(saveCurrentPlaybackNow);
  saveCurrentPlaybackRef.current = saveCurrentPlaybackNow;

  // Save on tab switch, window close, or modal unmount
  useEffect(() => {
    const handleUnloadOrHide = () => {
      saveCurrentPlaybackRef.current();
    };

    window.addEventListener('beforeunload', handleUnloadOrHide);
    document.addEventListener('visibilitychange', handleUnloadOrHide);
    window.addEventListener('pagehide', handleUnloadOrHide);

    return () => {
      window.removeEventListener('beforeunload', handleUnloadOrHide);
      document.removeEventListener('visibilitychange', handleUnloadOrHide);
      window.removeEventListener('pagehide', handleUnloadOrHide);
      saveCurrentPlaybackRef.current();
    };
  }, []);

  // Resume saved playback position
  const resumeSavedPlayback = () => {
    const video = videoRef.current;
    if (!video || !activeModalItem || hasResumedRef.current) return;

    const trackKey = `${activeModalItem.type}-${activeModalItem.id}`;
    let savedTime = 0;

    // 1. Check userData state
    const pobj = userData.playbackPosition[trackKey];
    if (pobj) {
      savedTime = isTV ? pobj[`time_${currentSeason}_${currentEpisode}`] || 0 : pobj.time || 0;
    }

    // 2. Direct localStorage fallback
    if (!savedTime) {
      try {
        const directPb = JSON.parse(localStorage.getItem('notflix_playback') || '{}');
        const dObj = directPb[trackKey];
        if (dObj) {
          savedTime = isTV ? dObj[`time_${currentSeason}_${currentEpisode}`] || 0 : dObj.time || 0;
        }
      } catch {}
    }

    // 3. Fallback to notflix_last_session
    if (!savedTime) {
      try {
        const sess = JSON.parse(localStorage.getItem('notflix_last_session') || '{}');
        if (sess?.item?.id === activeModalItem.id) {
          if (!isTV || (sess.season === currentSeason && sess.episode === currentEpisode)) {
            savedTime = sess.time || 0;
          }
        }
      } catch {}
    }

    if (savedTime > 4) {
      hasResumedRef.current = true;
      const executeSeek = () => {
        const dur = video.duration || 0;
        if (!dur || savedTime < dur - 15) {
          try {
            video.currentTime = savedTime;
            setCurrentTime(savedTime);
            setResumePrompt({ time: savedTime });
            showToast(`Resumed from ${formatTime(savedTime)}`, '⏱️');
          } catch (e) {
            console.warn('Could not seek immediately:', e);
          }
        }
      };

      if (video.readyState >= 1) {
        executeSeek();
      } else {
        video.addEventListener('loadedmetadata', executeSeek, { once: true });
        video.addEventListener('canplay', executeSeek, { once: true });
      }
    }
  };

  // Video Event Handlers
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration;
    if (dur && isFinite(dur) && dur > 0) {
      setDuration(dur);
      const minAllowed = isTV ? 240 : 480;
      if (dur < minAllowed) {
        triggerAutoSwitch(activeStreamIndex, dur);
      }
    }
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !activeModalItem) return;

    const ct = video.currentTime;
    const dur = video.duration || 0;
    setCurrentTime(ct);
    setDuration(dur);

    // Auto-detect short video sample / dummy trailer and failover to next server
    if (dur > 0 && isFinite(dur)) {
      const minAllowed = isTV ? 240 : 480;
      if (dur < minAllowed) {
        triggerAutoSwitch(activeStreamIndex, dur);
        return;
      }
    }

    // Skip intro detection
    const stream = streams[activeStreamIndex];
    if (isTV && stream?.intro && stream.intro.start !== undefined && stream.intro.end !== undefined) {
      if (ct >= stream.intro.start && ct < stream.intro.end) {
        if (userData.settings.autoSkip) {
          video.currentTime = stream.intro.end;
        } else {
          setShowSkipIntro(true);
        }
      } else {
        setShowSkipIntro(false);
      }
    }

    // Save playback position periodically (every ~2 seconds)
    if (ct > 3 && !video.paused && Math.abs(ct - lastSavedTimeRef.current) >= 2) {
      saveCurrentPlaybackNow();
    }
  };

  const handleEnded = () => {
    const video = videoRef.current;
    const dur = video?.duration || duration || 0;
    const minAllowed = isTV ? 240 : 480;
    if (dur > 0 && isFinite(dur) && dur < minAllowed) {
      triggerAutoSwitch(activeStreamIndex, dur);
      return;
    }

    if (isTV) {
      // Auto-advance episode
      const nextEp = currentEpisode + 1;
      const seasonObj = seasons.find((s) => s.season_number === currentSeason);
      if (seasonObj && nextEp <= seasonObj.episode_count) {
        showToast(`Playing Episode ${nextEp}...`, '⏭️');
        setCurrentEpisode(nextEp);
      }
    }
  };

  // Ad return auto-resume listener
  useEffect(() => {
    const cleanup = initAdResumeListeners(() => videoRef.current);
    return cleanup;
  }, []);

  const togglePlay = () => {
    triggerAd('play', videoRef.current);
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
    showControlsTemporarily();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
    showControlsTemporarily();
  };

  const toggleFullscreen = async () => {
    // 1. Trigger the fullscreen ad in external page
    triggerAd('fullscreen', videoRef.current);

    const container = document.getElementById('playerContainer');
    const video = videoRef.current;
    if (!container) return;

    const isCurrentlyFs = Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement);

    if (!isCurrentlyFs) {
      try {
        if (container.requestFullscreen) {
          await container.requestFullscreen();
        } else if ((container as any).webkitRequestFullscreen) {
          await (container as any).webkitRequestFullscreen();
        } else if ((video as any)?.webkitEnterFullscreen) {
          (video as any).webkitEnterFullscreen();
        }
      } catch (err) {
        console.warn('Fullscreen request failed:', err);
      }
      setIsFullscreen(true);

      // Force rotate screen to landscape on supported devices
      try {
        if (screen.orientation && typeof (screen.orientation as any).lock === 'function') {
          await (screen.orientation as any).lock('landscape').catch(() => {});
        } else if ((screen as any).lockOrientation) {
          (screen as any).lockOrientation('landscape');
        } else if ((screen as any).mozLockOrientation) {
          (screen as any).mozLockOrientation('landscape');
        } else if ((screen as any).msLockOrientation) {
          (screen as any).msLockOrientation('landscape');
        }
      } catch (err) {
        console.warn('Screen orientation lock failed:', err);
      }
    } else {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        }
      } catch (err) {
        console.warn('Exit fullscreen failed:', err);
      }
      setIsFullscreen(false);

      // Unlock orientation
      try {
        if (screen.orientation && typeof screen.orientation.unlock === 'function') {
          screen.orientation.unlock();
        } else if ((screen as any).unlockOrientation) {
          (screen as any).unlockOrientation();
        }
      } catch {}
    }
  };

  const togglePip = async () => {
    triggerAd('pip', videoRef.current);
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      showToast('Picture-in-Picture not supported on this device');
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.preventDefault();
    if (triggerAd('download', videoRef.current)) {
      return;
    }
    const dlUrl = isTV
      ? `https://vidvault.ru/tv/${activeModalItem?.id}/${currentSeason}/${currentEpisode}`
      : `https://vidvault.ru/movie/${activeModalItem?.id}`;

    if ((window as any).AndroidInterface?.openExternal) {
      (window as any).AndroidInterface.openExternal(dlUrl);
    } else {
      window.open(dlUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    const bg = progressBgRef.current;
    if (!video || !bg || !duration) return;
    const rect = bg.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * duration;
    showControlsTemporarily();
  };

  // Auto-hide controls and floating icons when playing
  useEffect(() => {
    if (isPlaying) {
      if (controlsTimeoutRef.current) window.clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = window.setTimeout(() => {
        if (!activePanel) {
          setIsControlsVisible(false);
        }
      }, 3000);
    } else {
      setIsControlsVisible(true);
      if (controlsTimeoutRef.current) window.clearTimeout(controlsTimeoutRef.current);
    }

    return () => {
      if (controlsTimeoutRef.current) window.clearTimeout(controlsTimeoutRef.current);
    };
  }, [isPlaying, activePanel]);

  const showControlsTemporarily = () => {
    setIsControlsVisible(true);
    if (controlsTimeoutRef.current) window.clearTimeout(controlsTimeoutRef.current);
    if (isPlaying) {
      controlsTimeoutRef.current = window.setTimeout(() => {
        if (!activePanel) {
          setIsControlsVisible(false);
        }
      }, 3000);
    }
  };

  // Keep isFullscreen in sync with native browser fullscreen state & orientation
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement);
      setIsFullscreen(isFs);
      if (!isFs) {
        try {
          if (screen.orientation && typeof screen.orientation.unlock === 'function') {
            screen.orientation.unlock();
          } else if ((screen as any).unlockOrientation) {
            (screen as any).unlockOrientation();
          }
        } catch {}
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    // Auto-fullscreen when device is physically turned sideways to landscape
    const mql = window.matchMedia('(orientation: landscape)');
    const handleOrientationChange = (e: MediaQueryListEvent | MediaQueryList) => {
      const container = document.getElementById('playerContainer');
      const isFs = Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement);
      if (e.matches && !isFs && container) {
        if (container.requestFullscreen) {
          container.requestFullscreen().catch(() => {});
        } else if ((container as any).webkitRequestFullscreen) {
          (container as any).webkitRequestFullscreen();
        }
      } else if (!e.matches && isFs) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if ((document as any).webkitExitFullscreen) {
          (document as any).webkitExitFullscreen();
        }
      }
    };

    if (mql.addEventListener) {
      mql.addEventListener('change', handleOrientationChange);
    } else if ((mql as any).addListener) {
      (mql as any).addListener(handleOrientationChange);
    }

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      if (mql.removeEventListener) {
        mql.removeEventListener('change', handleOrientationChange);
      } else if ((mql as any).removeListener) {
        (mql as any).removeListener(handleOrientationChange);
      }
    };
  }, []);

  // Global Keyboard Shortcuts (Space/K, M, F, Arrows, J/L, C, P, 0-9, Esc)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't fire shortcuts if the user is typing in an input or textarea
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      const code = e.code;
      const key = e.key;

      // Number keys 0 - 9: jump to percentage (0% to 90%)
      if (!e.ctrlKey && !e.altKey && !e.metaKey && code.startsWith('Digit')) {
        const digit = parseInt(code.replace('Digit', ''), 10);
        if (!isNaN(digit) && duration > 0) {
          e.preventDefault();
          const targetTime = (digit / 10) * duration;
          video.currentTime = targetTime;
          setCurrentTime(targetTime);
          setGestureIndicator({
            type: 'seek',
            value: `${digit * 10}%`,
            subValue: `${formatTime(targetTime)} / ${formatTime(duration)}`,
          });
          if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
          gestureIndicatorTimerRef.current = window.setTimeout(() => setGestureIndicator(null), 700);
          showControlsTemporarily();
          return;
        }
      }

      switch (code) {
        // Space or K: Play / Pause
        case 'Space':
        case 'KeyK': {
          e.preventDefault();
          togglePlay();
          break;
        }

        // M: Mute / Unmute
        case 'KeyM': {
          e.preventDefault();
          video.muted = !video.muted;
          setIsMuted(video.muted);
          setGestureIndicator({
            type: 'mute',
            value: video.muted ? 'Muted' : 'Unmuted',
          });
          if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
          gestureIndicatorTimerRef.current = window.setTimeout(() => setGestureIndicator(null), 700);
          showControlsTemporarily();
          break;
        }

        // F: Toggle Fullscreen
        case 'KeyF': {
          e.preventDefault();
          toggleFullscreen();
          break;
        }

        // P: Picture in Picture
        case 'KeyP': {
          e.preventDefault();
          togglePip();
          break;
        }

        // C: Subtitles Panel
        case 'KeyC': {
          e.preventDefault();
          setActivePanel((prev) => (prev === 'subtitles' ? null : 'subtitles'));
          break;
        }

        // Left Arrow or J: Seek back 10s
        case 'ArrowLeft':
        case 'KeyJ': {
          e.preventDefault();
          const targetTime = Math.max(0, (video.currentTime || 0) - 10);
          video.currentTime = targetTime;
          setCurrentTime(targetTime);
          setGestureIndicator({
            type: 'seek',
            value: '-10s',
            subValue: `${formatTime(targetTime)} / ${formatTime(duration)}`,
          });
          if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
          gestureIndicatorTimerRef.current = window.setTimeout(() => setGestureIndicator(null), 700);
          showControlsTemporarily();
          break;
        }

        // Right Arrow or L: Seek forward 10s
        case 'ArrowRight':
        case 'KeyL': {
          e.preventDefault();
          const targetTime = Math.min(duration || 0, (video.currentTime || 0) + 10);
          video.currentTime = targetTime;
          setCurrentTime(targetTime);
          setGestureIndicator({
            type: 'seek',
            value: '+10s',
            subValue: `${formatTime(targetTime)} / ${formatTime(duration)}`,
          });
          if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
          gestureIndicatorTimerRef.current = window.setTimeout(() => setGestureIndicator(null), 700);
          showControlsTemporarily();
          break;
        }

        // Up Arrow: Volume Up 10%
        case 'ArrowUp': {
          e.preventDefault();
          video.muted = false;
          setIsMuted(false);
          const newVol = Math.min(1, Math.round((video.volume + 0.1) * 10) / 10);
          video.volume = newVol;
          setGestureIndicator({
            type: 'volume',
            value: `${Math.round(newVol * 100)}%`,
          });
          if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
          gestureIndicatorTimerRef.current = window.setTimeout(() => setGestureIndicator(null), 700);
          showControlsTemporarily();
          break;
        }

        // Down Arrow: Volume Down 10%
        case 'ArrowDown': {
          e.preventDefault();
          const newVol = Math.max(0, Math.round((video.volume - 0.1) * 10) / 10);
          video.volume = newVol;
          if (newVol === 0) {
            video.muted = true;
            setIsMuted(true);
            setGestureIndicator({
              type: 'mute',
              value: 'Muted',
            });
          } else {
            setGestureIndicator({
              type: 'volume',
              value: `${Math.round(newVol * 100)}%`,
            });
          }
          if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
          gestureIndicatorTimerRef.current = window.setTimeout(() => setGestureIndicator(null), 700);
          showControlsTemporarily();
          break;
        }

        // Slash or Question mark: Open Keyboard Shortcuts Cheat Sheet
        case 'Slash': {
          if (key === '?' || key === '/') {
            e.preventDefault();
            setActivePanel((prev) => (prev === 'shortcuts' ? null : 'shortcuts'));
          }
          break;
        }

        // Escape: Close active panel, or exit player if not in fullscreen
        case 'Escape': {
          if (activePanel) {
            e.preventDefault();
            setActivePanel(null);
          } else if (!document.fullscreenElement) {
            closePlayer();
          }
          break;
        }

        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    activePanel,
    duration,
    togglePlay,
    toggleMute,
    toggleFullscreen,
    togglePip,
    closePlayer,
    showControlsTemporarily,
  ]);

  // Subtitle Selection & Sync Engine
  const handleSelectSubtitle = async (lang: string) => {
    setActiveSubLabel(lang);
    setSubOffset(0);

    if (lang === 'Off') {
      setRawSubText('');
      removeSubTracks();
      setActivePanel(null);
      showToast('Subtitles disabled', 'CC');
      return;
    }

    const tracks = subtitleGroups[lang] || [];
    if (!tracks.length) return;

    try {
      const res = await fetch(tracks[0].url);
      if (!res.ok) throw new Error('Failed to load subtitle');
      let text = await res.text();
      setRawSubText(text);
      applyVttTrack(text, 0, lang);
      showToast(`Subtitles: ${lang}`, 'CC');
    } catch {
      showToast(`Could not load ${lang} track.`, '❌');
    }
    setActivePanel(null);
  };

  const adjustSubOffset = (delta: number) => {
    const newOffset = Math.round((subOffset + delta) * 10) / 10;
    setSubOffset(newOffset);
    if (rawSubText) {
      applyVttTrack(rawSubText, newOffset, activeSubLabel);
    }
  };

  const applyVttTrack = (vttText: string, offsetSeconds: number, label: string) => {
    const video = videoRef.current;
    if (!video) return;

    removeSubTracks();

    let modified = vttText;
    if (offsetSeconds !== 0) {
      modified = vttText.replace(/(\d{2}:\d{2}:\d{2}\.\d{3})/g, (match) => {
        const parts = match.split(':');
        const secParts = parts[2].split('.');
        let total =
          parseInt(parts[0], 10) * 3600 +
          parseInt(parts[1], 10) * 60 +
          parseInt(secParts[0], 10) +
          parseInt(secParts[1], 10) / 1000;

        total = Math.max(0, total + offsetSeconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);
        const ms = Math.round((total - Math.floor(total)) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
      });
    }

    const blob = new Blob([modified], { type: 'text/vtt' });
    const blobUrl = URL.createObjectURL(blob);

    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.srclang = 'en';
    track.src = blobUrl;
    track.default = true;

    video.appendChild(track);

    setTimeout(() => {
      if (video.textTracks && video.textTracks.length > 0) {
        for (let i = 0; i < video.textTracks.length; i++) {
          video.textTracks[i].mode =
            userData.settings.globalSubtitles && video.textTracks[i].label === label ? 'showing' : 'hidden';
        }
      }
    }, 50);
  };

  const removeSubTracks = () => {
    const video = videoRef.current;
    if (!video) return;
    Array.from(video.querySelectorAll('track')).forEach((t) => t.remove());
  };

  const handleSelectQuality = (id: number) => {
    if (!hlsRef.current) return;
    hlsRef.current.currentLevel = id;
    setActiveQualityId(id);
    setActivePanel(null);
    showToast(id === -1 ? 'Quality: Auto (ABR)' : `Quality forced: ${qualityLevels[id]?.height}p`, 'HD');
  };

  const handleSelectAudio = (id: number) => {
    if (!hlsRef.current) return;
    hlsRef.current.audioTrack = id;
    setActiveAudioTrackId(id);
    setActivePanel(null);
    showToast('Audio track changed', '🔊');
  };

  const handleSelectSpeed = (speed: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    setPlaybackRate(speed);
    setActivePanel(null);
    showToast(`Speed: ${speed}x`, '⚡');
  };

  // Gesture Handlers (Vertical Swipe = Brightness / Light, Horizontal Swipe = Seek)
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
      initialBrightness: brightness,
      initialCurrentTime: currentTime,
      isSwiping: false,
      swipeType: null,
    };
    showControlsTemporarily();
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;

    if (!touchStartRef.current.isSwiping) {
      if (Math.abs(deltaY) > 12 && Math.abs(deltaY) > Math.abs(deltaX)) {
        touchStartRef.current.isSwiping = true;
        touchStartRef.current.swipeType = 'vertical';
      } else if (Math.abs(deltaX) > 12 && Math.abs(deltaX) > Math.abs(deltaY)) {
        touchStartRef.current.isSwiping = true;
        touchStartRef.current.swipeType = 'horizontal';
      }
    }

    if (!touchStartRef.current.isSwiping) return;

    if (touchStartRef.current.swipeType === 'vertical') {
      // Swiping up increases light (-deltaY is positive), swiping down decreases light
      const change = -deltaY / 180;
      const nextBrightness = Math.max(0.2, Math.min(1.8, touchStartRef.current.initialBrightness + change));
      setBrightness(nextBrightness);

      const percent = Math.round(((nextBrightness - 0.2) / 1.6) * 100);
      setGestureIndicator({
        type: 'brightness',
        value: `${Math.round(nextBrightness * 100)}%`,
        percent: Math.max(5, Math.min(100, percent)),
      });
      if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
    } else if (touchStartRef.current.swipeType === 'horizontal') {
      // Swiping right fast forwards (+deltaX), swiping left rewinds (-deltaX)
      const seekDelta = Math.round(deltaX / 6);
      const targetTime = Math.max(0, Math.min(duration || 0, touchStartRef.current.initialCurrentTime + seekDelta));
      const diffFormatted = seekDelta > 0 ? `+${seekDelta}s` : `${seekDelta}s`;

      setGestureIndicator({
        type: 'seek',
        value: diffFormatted,
        subValue: `${formatTime(targetTime)} / ${formatTime(duration)}`,
        percent: duration ? (targetTime / duration) * 100 : 0,
      });
      if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const durationMs = Date.now() - touchStartRef.current.time;
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;

    if (touchStartRef.current.isSwiping && touchStartRef.current.swipeType === 'horizontal') {
      const seekDelta = Math.round(deltaX / 6);
      const targetTime = Math.max(0, Math.min(duration || 0, touchStartRef.current.initialCurrentTime + seekDelta));
      const video = videoRef.current;
      if (video) {
        video.currentTime = targetTime;
        setCurrentTime(targetTime);
      }
    } else if (!touchStartRef.current.isSwiping && durationMs < 300 && Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) {
      // Tap on video player shows/toggles controls, does NOT stop the movie
      if (isControlsVisible && isPlaying) {
        setIsControlsVisible(false);
        if (controlsTimeoutRef.current) window.clearTimeout(controlsTimeoutRef.current);
      } else {
        showControlsTemporarily();
      }
    }

    if (gestureIndicatorTimerRef.current) window.clearTimeout(gestureIndicatorTimerRef.current);
    gestureIndicatorTimerRef.current = window.setTimeout(() => {
      setGestureIndicator(null);
    }, 700);

    touchStartRef.current = null;
  };

  const handlePlayerOverlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Clicking on video player only toggles controls visibility, does NOT pause the movie
    if (isControlsVisible && isPlaying) {
      setIsControlsVisible(false);
      if (controlsTimeoutRef.current) window.clearTimeout(controlsTimeoutRef.current);
    } else {
      showControlsTemporarily();
    }
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (!activeModalItem) return null;

  return (
    <div
      id="modalOverlay"
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-0 md:p-6 overflow-y-auto"
    >
      <div className="w-full max-w-6xl h-full md:h-auto min-h-screen md:min-h-0 md:max-h-[92vh] bg-[#0c101c]/95 border border-white/10 md:rounded-3xl shadow-2xl flex flex-col overflow-hidden relative">
        {/* Modal Top Header */}
        <div className="flex items-center justify-between p-4 md:px-6 md:py-4 border-b border-white/5 shrink-0 z-20">
          <div>
            <h2 className="font-display text-2xl md:text-3xl text-white uppercase tracking-wider line-clamp-1">
              {activeModalItem.title || activeModalItem.name}
            </h2>
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 mt-0.5">
              <span className="text-amber-400 font-bold">★ {activeModalItem.rating || '8.5'}</span>
              <span>·</span>
              <span>{activeModalItem.year}</span>
              <span>·</span>
              <span>{isTV ? `Season ${currentSeason} · Episode ${currentEpisode}` : 'Feature Film'}</span>
              <span>·</span>
              <span className="text-emerald-400 uppercase tracking-widest text-[10px]">1080p/4K</span>
            </div>
          </div>

          <button
            onClick={closePlayer}
            aria-label="Close Player"
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white flex items-center justify-center transition-all cursor-pointer border border-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Video Player Container */}
        <div
          id="playerContainer"
          onMouseMove={showControlsTemporarily}
          onTouchStart={showControlsTemporarily}
          onClick={showControlsTemporarily}
          className="relative w-full aspect-video bg-black overflow-hidden flex items-center justify-center shrink-0 group select-none"
        >
          {/* Backdrop Glow */}
          <div
            className="absolute inset-0 bg-cover bg-center opacity-30 filter blur-xl scale-110 pointer-events-none"
            style={{ backgroundImage: `url(${activeModalItem.backdrop || activeModalItem.poster})` }}
          />

          {/* Native Video Stream Element with dynamic brightness filter */}
          <video
            ref={videoRef}
            playsInline
            crossOrigin="anonymous"
            style={{ filter: `brightness(${brightness})` }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => {
              setIsPlaying(false);
              saveCurrentPlaybackNow();
            }}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onDurationChange={handleLoadedMetadata}
            onEnded={handleEnded}
            className="w-full h-full object-contain relative z-10 bg-black transition-[filter] duration-75"
          />

          {/* Touch Gesture Layer: Swipe vertical for light, swipe horizontal for fast forward/back */}
          <div
            onClick={handlePlayerOverlayClick}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className="absolute inset-0 z-20 cursor-pointer touch-none"
          />

          {/* Gesture Overlay HUD (Transparent Icon + Percentage / Offset) */}
          {gestureIndicator && (
            <div className="absolute inset-0 z-35 flex items-center justify-center pointer-events-none select-none">
              {gestureIndicator.type === 'brightness' ? (
                <div className="flex flex-col items-center gap-1.5 transition-all animate-in fade-in zoom-in-95 duration-100 drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]">
                  <Sun className="w-12 h-12 text-white/90 stroke-[2.2]" />
                  <span className="text-2xl font-black text-white font-mono tracking-wider drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">
                    {gestureIndicator.value}
                  </span>
                </div>
              ) : gestureIndicator.type === 'volume' ? (
                <div className="flex flex-col items-center gap-1.5 transition-all animate-in fade-in zoom-in-95 duration-100 drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]">
                  <Volume2 className="w-12 h-12 text-white/90 stroke-[2.2]" />
                  <span className="text-2xl font-black text-white font-mono tracking-wider drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">
                    {gestureIndicator.value}
                  </span>
                </div>
              ) : gestureIndicator.type === 'mute' ? (
                <div className="flex flex-col items-center gap-1.5 transition-all animate-in fade-in zoom-in-95 duration-100 drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]">
                  {gestureIndicator.value === 'Muted' ? (
                    <VolumeX className="w-12 h-12 text-rose-400 stroke-[2.2]" />
                  ) : (
                    <Volume2 className="w-12 h-12 text-emerald-400 stroke-[2.2]" />
                  )}
                  <span className="text-2xl font-black text-white font-mono tracking-wider drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">
                    {gestureIndicator.value}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1.5 transition-all animate-in fade-in zoom-in-95 duration-100 drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]">
                  {gestureIndicator.value.startsWith('+') ? (
                    <FastForward className="w-12 h-12 text-white/90 stroke-[2.2]" />
                  ) : (
                    <Rewind className="w-12 h-12 text-white/90 stroke-[2.2]" />
                  )}
                  <span className="text-2xl font-black text-white font-mono tracking-wider drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">
                    {gestureIndicator.value}
                  </span>
                  {gestureIndicator.subValue && (
                    <span className="text-xs font-bold text-white/85 font-mono drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
                      {gestureIndicator.subValue}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Center Floating Play / Pause Button (Fully Glass Transparent) */}
          {(!isPlaying || isControlsVisible) && !isLoadingStreams && !streamError && !gestureIndicator && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
              aria-label={isPlaying ? 'Pause Video' : 'Play Video'}
              className="absolute z-25 w-16 h-16 md:w-20 md:h-20 rounded-full active:scale-90 text-white flex items-center justify-center transition-all duration-200 cursor-pointer pointer-events-auto bg-white/10 hover:bg-white/20 active:bg-white/25 backdrop-blur-xl border border-white/30 hover:border-white/50 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
            >
              {isPlaying ? (
                <Pause className="w-7 h-7 md:w-8 md:h-8 fill-white/95 text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]" />
              ) : (
                <Play className="w-8 h-8 md:w-9 md:h-9 fill-white/95 text-white ml-1 drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]" />
              )}
            </button>
          )}

          {/* Stream Loader Overlay (while loading) */}
          {isLoadingStreams && (
            <div className="absolute inset-0 z-30 bg-black/75 backdrop-blur-sm flex flex-col items-center justify-center gap-3 text-white pointer-events-none p-4">
              <div className="w-10 h-10 rounded-full border-3 border-red-500 border-t-transparent animate-spin shadow-lg" />
              <div className="text-center">
                <p className="text-sm font-semibold text-white tracking-wide">Loading stream sources...</p>
                <p className="text-[11px] text-white/50 mt-0.5">Finding best playback quality</p>
              </div>
            </div>
          )}

          {/* Stream Error Notice */}
          {streamError && !isLoadingStreams && (
            <div className="absolute inset-0 z-30 bg-black/85 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center text-white">
              <p className="text-amber-400 font-bold text-sm max-w-md mb-3">{streamError}</p>
              <button
                onClick={() => {
                  setIsLoadingStreams(true);
                  setStreamError(null);
                  setActiveStreamIndex(0);
                  fetchStreams(activeModalItem.type, activeModalItem.id, currentSeason, currentEpisode)
                    .then((sList) => {
                      setStreams(sList);
                      setIsLoadingStreams(false);
                    })
                    .catch(() => {
                      setIsLoadingStreams(false);
                      setStreamError('Failed to retrieve streaming sources.');
                    });
                }}
                className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold uppercase tracking-wider px-5 py-2.5 rounded-full transition-all cursor-pointer"
              >
                Retry Stream Fetch
              </button>
            </div>
          )}

          {/* Skip Intro Overlay Button */}
          {showSkipIntro && (
            <button
              onClick={() => {
                const video = videoRef.current;
                const stream = streams[activeStreamIndex];
                if (video && stream?.intro?.end) {
                  video.currentTime = stream.intro.end;
                } else if (video) {
                  video.currentTime = 85;
                }
                setShowSkipIntro(false);
              }}
              className="absolute bottom-20 right-6 z-40 bg-white/10 hover:bg-white/20 backdrop-blur-md border border-white/20 text-white text-xs font-bold px-4 py-2 rounded-xl shadow-lg flex items-center gap-2 cursor-pointer transition-all animate-bounce"
            >
              <FastForward className="w-4 h-4 text-amber-400" />
              <span>Skip Intro</span>
            </button>
          )}

          {/* Resume Playback Notification Pill */}
          {resumePrompt && (
            <div className="absolute top-4 left-4 z-40 bg-black/85 backdrop-blur-md border border-white/20 text-white text-xs font-semibold px-3 py-1.5 rounded-xl shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-300">
              <span className="text-amber-400 font-bold">⏱️ Resumed</span>
              <span className="font-mono text-slate-200">from {formatTime(resumePrompt.time)}</span>
              <button
                onClick={() => {
                  const video = videoRef.current;
                  if (video) {
                    video.currentTime = 0;
                    setCurrentTime(0);
                    showToast('Started from beginning', '⏮️');
                  }
                  setResumePrompt(null);
                }}
                className="ml-1 bg-white/15 hover:bg-white/25 active:scale-95 text-white text-[11px] font-bold px-2 py-0.5 rounded-lg transition-all cursor-pointer"
              >
                Start Over
              </button>
              <button
                onClick={() => setResumePrompt(null)}
                className="text-slate-400 hover:text-white text-xs cursor-pointer ml-0.5"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}

          {/* TV Episode Selector Floating Icon Button (Top right in player) */}
          {isTV && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setActivePanel((prev) => (prev === 'episodes' ? null : 'episodes'));
              }}
              title="Seasons & Episodes"
              aria-label="Seasons and Episodes"
              className={`absolute top-4 right-4 z-40 bg-black/70 hover:bg-black/90 active:scale-95 border border-white/20 hover:border-blue-400/60 text-white text-xs font-bold px-3 py-1.5 rounded-xl backdrop-blur-md flex items-center gap-1.5 shadow-xl transition-all cursor-pointer group ${
                isControlsVisible || !isPlaying
                  ? 'opacity-100 pointer-events-auto'
                  : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-blue-400 group-hover:text-blue-300 transition-colors" />
              <span>
                S{currentSeason} · E{currentEpisode}
              </span>
            </button>
          )}

          {/* Controls Overlay Bar */}
          <div
            className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-3 md:px-5 pt-6 pb-2 md:pb-3.5 transition-opacity duration-300 pointer-events-auto ${
              isControlsVisible || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            {/* Scrub Progress Bar */}
            <div
              ref={progressBgRef}
              onClick={handleScrub}
              className="relative w-full h-1.5 hover:h-2 bg-white/25 hover:bg-white/35 rounded-full cursor-pointer transition-all mb-1.5 md:mb-2 group/progress"
            >
              <div
                className="h-full bg-rose-600 rounded-full relative transition-all"
                style={{ width: `${progressPercent}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md scale-0 group-hover/progress:scale-100 transition-transform" />
              </div>
            </div>

            {/* Bottom Controls Row */}
            <div className="flex items-center justify-between gap-1.5 md:gap-2">
              <div className="flex items-center gap-1.5 md:gap-2.5">
                {/* Play / Pause */}
                <button
                  onClick={togglePlay}
                  title={isPlaying ? 'Pause (Space / K)' : 'Play (Space / K)'}
                  aria-label={isPlaying ? 'Pause (Space / K)' : 'Play (Space / K)'}
                  className="w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 text-white flex items-center justify-center transition-all cursor-pointer"
                >
                  {isPlaying ? <Pause className="w-3.5 h-3.5 md:w-4 md:h-4 fill-white" /> : <Play className="w-3.5 h-3.5 md:w-4 md:h-4 fill-white ml-0.5" />}
                </button>

                {/* Mute */}
                <button
                  onClick={toggleMute}
                  title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
                  aria-label={isMuted ? 'Unmute (M)' : 'Mute (M)'}
                  className="w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 text-white flex items-center justify-center transition-all cursor-pointer"
                >
                  {isMuted ? <VolumeX className="w-3.5 h-3.5 md:w-4 md:h-4 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5 md:w-4 md:h-4" />}
                </button>

                {/* Timestamps */}
                <span className="text-[11px] md:text-xs font-mono font-medium text-slate-300">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
              </div>

              {/* Action Buttons Right */}
              <div className="flex items-center gap-1 md:gap-1.5">
                {/* Download Button (VidVault) */}
                <button
                  onClick={handleDownload}
                  title="Download Video"
                  className="w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 active:scale-95 text-emerald-400 hover:text-emerald-300 flex items-center justify-center transition-all cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 md:w-4 md:h-4 text-emerald-400" />
                </button>

                {/* Audio Track Selector (when multiple audio tracks present) */}
                {audioTracks.length > 1 && (
                  <button
                    onClick={() => setActivePanel((prev) => (prev === 'audio' ? null : 'audio'))}
                    title="Audio Language"
                    className={`w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl flex items-center justify-center transition-all cursor-pointer ${
                      activePanel === 'audio' ? 'bg-blue-600 text-white' : 'bg-white/10 hover:bg-white/20 text-white'
                    }`}
                  >
                    <Languages className="w-3.5 h-3.5 md:w-4 md:h-4" />
                  </button>
                )}

                {/* Subtitles Button */}
                <button
                  onClick={() => setActivePanel((prev) => (prev === 'subtitles' ? null : 'subtitles'))}
                  title="Subtitles (C)"
                  aria-label="Subtitles (C)"
                  className={`w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl flex items-center justify-center transition-all cursor-pointer ${
                    activeSubLabel !== 'Off' ? 'bg-blue-600 text-white' : 'bg-white/10 hover:bg-white/20 text-white'
                  }`}
                >
                  <Subtitles className="w-3.5 h-3.5 md:w-4 md:h-4" />
                </button>

                {/* Speed Button */}
                <button
                  onClick={() => setActivePanel((prev) => (prev === 'speed' ? null : 'speed'))}
                  title="Playback Speed"
                  className="w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all cursor-pointer text-xs font-bold font-mono"
                >
                  {playbackRate}x
                </button>

                {/* PiP */}
                <button
                  onClick={togglePip}
                  title="Picture in Picture (P)"
                  aria-label="Picture in Picture (P)"
                  className="w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all cursor-pointer hidden sm:flex"
                >
                  <PictureInPicture className="w-3.5 h-3.5 md:w-4 md:h-4" />
                </button>

                {/* Fullscreen */}
                <button
                  onClick={toggleFullscreen}
                  title={isFullscreen ? 'Exit Fullscreen (F / Esc)' : 'Fullscreen (F)'}
                  aria-label={isFullscreen ? 'Exit Fullscreen (F / Esc)' : 'Fullscreen (F)'}
                  className="w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all cursor-pointer"
                >
                  {isFullscreen ? <Minimize className="w-3.5 h-3.5 md:w-4 md:h-4" /> : <Maximize className="w-3.5 h-3.5 md:w-4 md:h-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* =========================================
              FLOATING ACTION PANELS
             ========================================= */}
          {activePanel && (
            <div
              onClick={() => setActivePanel(null)}
              className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm max-h-[80%] bg-[#131a2a]/95 border border-white/15 rounded-2xl p-4 shadow-2xl overflow-y-auto flex flex-col gap-3 animate-in fade-in zoom-in-95 duration-200"
              >
                {/* Panel Header */}
                <div className="flex items-center justify-between pb-2 border-b border-white/10">
                  <h3 className="font-bold text-sm text-white capitalize tracking-wide">
                    {activePanel === 'subtitles' && 'Subtitle Tracks & Sync'}
                    {activePanel === 'quality' && 'Video Resolution'}
                    {activePanel === 'audio' && 'Audio Track (English Prioritized)'}
                    {activePanel === 'speed' && 'Playback Speed'}
                    {activePanel === 'episodes' && `Select Episode (Season ${currentSeason})`}
                    {activePanel === 'shortcuts' && 'Keyboard Shortcuts'}
                  </h3>
                  <button
                    onClick={() => setActivePanel(null)}
                    className="text-slate-400 hover:text-white p-1 rounded-full"
                  >
                    ✕
                  </button>
                </div>

                {/* Subtitles Panel Content */}
                {activePanel === 'subtitles' && (
                  <div className="flex flex-col gap-2">
                    {/* Subtitle Offset Tool */}
                    {activeSubLabel !== 'Off' && (
                      <div className="bg-white/5 border border-white/10 rounded-xl p-3 flex items-center justify-between mb-2">
                        <div>
                          <div className="text-xs font-bold text-blue-400 uppercase">Subtitle Sync</div>
                          <div className="text-[11px] text-slate-400">Shift audio delay</div>
                        </div>
                        <div className="flex items-center gap-1.5 bg-black/40 px-2 py-1 rounded-lg border border-white/10">
                          <button
                            onClick={() => adjustSubOffset(-0.5)}
                            className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 text-white font-bold text-xs"
                          >
                            <Minus className="w-3 h-3 mx-auto" />
                          </button>
                          <span className="text-xs font-mono font-bold w-12 text-center text-white">
                            {subOffset > 0 ? `+${subOffset.toFixed(1)}s` : `${subOffset.toFixed(1)}s`}
                          </span>
                          <button
                            onClick={() => adjustSubOffset(0.5)}
                            className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 text-white font-bold text-xs"
                          >
                            <Plus className="w-3 h-3 mx-auto" />
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Off Option */}
                    <button
                      onClick={() => handleSelectSubtitle('Off')}
                      className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold cursor-pointer transition-all ${
                        activeSubLabel === 'Off'
                          ? 'bg-blue-600/20 border-blue-500 text-white'
                          : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <span>Off (Disabled)</span>
                      {activeSubLabel === 'Off' && <span className="text-blue-400 font-bold">✓</span>}
                    </button>

                    {/* Subtitle Language List */}
                    {Object.keys(subtitleGroups).map((lang) => (
                      <button
                        key={lang}
                        onClick={() => handleSelectSubtitle(lang)}
                        className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold cursor-pointer transition-all ${
                          activeSubLabel === lang
                            ? 'bg-blue-600/20 border-blue-500 text-white'
                            : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        <span className="capitalize">{lang}</span>
                        {activeSubLabel === lang && <span className="text-blue-400 font-bold">✓</span>}
                      </button>
                    ))}

                    {Object.keys(subtitleGroups).length === 0 && (
                      <p className="text-xs text-slate-400 text-center py-4">No subtitles found for this title.</p>
                    )}
                  </div>
                )}

                {/* Quality Panel Content */}
                {activePanel === 'quality' && (
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => handleSelectQuality(-1)}
                      className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold cursor-pointer ${
                        activeQualityId === -1
                          ? 'bg-blue-600/20 border-blue-500 text-white'
                          : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <span>Auto Adaptive (Recommended)</span>
                      {activeQualityId === -1 && <span className="text-blue-400">✓</span>}
                    </button>

                    {qualityLevels.map((lvl) => (
                      <button
                        key={lvl.id}
                        onClick={() => handleSelectQuality(lvl.id)}
                        className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold cursor-pointer ${
                          activeQualityId === lvl.id
                            ? 'bg-blue-600/20 border-blue-500 text-white'
                            : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        <span>{lvl.height}p HD</span>
                        {activeQualityId === lvl.id && <span className="text-blue-400">✓</span>}
                      </button>
                    ))}
                  </div>
                )}

                {/* Playback Speed Content */}
                {activePanel === 'speed' && (
                  <div className="flex flex-col gap-2">
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((spd) => (
                      <button
                        key={spd}
                        onClick={() => handleSelectSpeed(spd)}
                        className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold cursor-pointer ${
                          playbackRate === spd
                            ? 'bg-blue-600/20 border-blue-500 text-white'
                            : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        <span>
                          {spd}x {spd === 1 ? '(Normal)' : ''}
                        </span>
                        {playbackRate === spd && <span className="text-blue-400">✓</span>}
                      </button>
                    ))}
                  </div>
                )}

                {/* Audio Tracks Panel Content (English Prioritized) */}
                {activePanel === 'audio' && (
                  <div className="flex flex-col gap-2">
                    {audioTracks.map((trk) => {
                      const isEng =
                        trk.lang.startsWith('en') ||
                        trk.name.toLowerCase().includes('eng') ||
                        trk.name.toLowerCase().includes('english') ||
                        trk.name.toLowerCase().includes('original');

                      return (
                        <button
                          key={trk.id}
                          onClick={() => handleSelectAudio(trk.id)}
                          className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold cursor-pointer ${
                            activeAudioTrackId === trk.id
                              ? 'bg-blue-600/20 border-blue-500 text-white'
                              : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span>{trk.name}</span>
                            {isEng && (
                              <span className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold uppercase">
                                🇬🇧 English
                              </span>
                            )}
                          </div>
                          {activeAudioTrackId === trk.id && <span className="text-blue-400 font-bold">✓</span>}
                        </button>
                      );
                    })}

                    {audioTracks.length === 0 && (
                      <p className="text-xs text-slate-400 text-center py-4">
                        Default English audio track active.
                      </p>
                    )}
                  </div>
                )}

                {/* TV Episodes Panel */}
                {activePanel === 'episodes' && (
                  <div className="flex flex-col gap-3">
                    {/* Season Selector */}
                    <div className="relative">
                      <select
                        value={currentSeason}
                        onChange={(e) => setCurrentSeason(parseInt(e.target.value, 10))}
                        className="w-full bg-white/10 border border-white/15 text-white text-xs font-bold rounded-xl p-3 outline-none cursor-pointer"
                      >
                        {seasons.length > 0 ? (
                          seasons.map((s) => (
                            <option key={s.season_number} value={s.season_number} className="bg-[#131a2a] text-white">
                              Season {s.season_number}
                            </option>
                          ))
                        ) : (
                          <option value={currentSeason} className="bg-[#131a2a] text-white">
                            Season {currentSeason}
                          </option>
                        )}
                      </select>
                    </div>

                    {/* Episodes List */}
                    <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                      {episodes.length > 0 ? (
                        episodes.map((ep) => {
                          const isCurrent = ep.episode_number === currentEpisode;
                          return (
                            <button
                              key={ep.episode_number}
                              onClick={() => {
                                triggerAd('episode', videoRef.current);
                                setCurrentEpisode(ep.episode_number);
                                setActivePanel(null);
                              }}
                              className={`flex items-center gap-3 p-3 rounded-xl border text-left cursor-pointer transition-all ${
                                isCurrent
                                  ? 'bg-blue-600/20 border-blue-500 text-white'
                                  : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                              }`}
                            >
                              <span className="font-bold text-sm text-slate-400 w-6 shrink-0">
                                {ep.episode_number}
                              </span>
                              <div className="flex-1 truncate">
                                <div className="text-xs font-semibold truncate text-white">
                                  {ep.name || `Episode ${ep.episode_number}`}
                                </div>
                              </div>
                              {isCurrent && (
                                <span className="text-[10px] uppercase font-bold text-blue-400 bg-blue-500/20 px-2 py-0.5 rounded">
                                  Playing
                                </span>
                              )}
                            </button>
                          );
                        })
                      ) : (
                        <div className="text-xs text-slate-400 text-center py-6">
                          Loading episodes...
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Keyboard Shortcuts Content */}
                {activePanel === 'shortcuts' && (
                  <div className="flex flex-col gap-2 py-1">
                    {[
                      { key: 'Space / K', desc: 'Play / Pause Video' },
                      { key: 'M', desc: 'Mute / Unmute Audio' },
                      { key: 'F', desc: 'Toggle Fullscreen' },
                      { key: '← / → (J / L)', desc: 'Seek Backward / Forward 10s' },
                      { key: '↑ / ↓', desc: 'Volume Up / Down (10%)' },
                      { key: '0 – 9', desc: 'Seek 0% to 90% of Movie' },
                      { key: 'C', desc: 'Subtitles & Captions' },
                      { key: 'P', desc: 'Picture-in-Picture' },
                      { key: 'Esc', desc: 'Close Modal / Exit Fullscreen' },
                    ].map((item) => (
                      <div
                        key={item.key}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-white/5 border border-white/5 text-xs"
                      >
                        <span className="text-slate-300 font-medium">{item.desc}</span>
                        <kbd className="px-2 py-1 rounded bg-black/60 border border-white/20 font-mono font-bold text-amber-300 text-[11px] shadow-sm">
                          {item.key}
                        </kbd>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Body & Server Switcher */}
        <div className="p-4 md:p-6 overflow-y-auto flex-1 flex flex-col gap-6">
          {/* Server Streams Row */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-200">
                  Servers
                </span>
                <span className="text-[10px] font-mono text-amber-400/90 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.2 rounded-full">
                  {streams.length}
                </span>
              </div>
              <span className="text-[10px] text-slate-500 font-medium">
                Switch if buffering
              </span>
            </div>

            <div className="flex items-center gap-2 overflow-x-auto pb-1.5 scrollbar-thin">
              {streams.map((st, idx) => {
                const isActive = idx === activeStreamIndex;
                const serverNum = idx + 1;

                // Format resolution compactly
                const rawQuality = st.quality || '1080p';
                let resolutionBadge = '1080p';
                let is4K = false;
                let isFHD = false;

                const qUpper = rawQuality.toUpperCase();
                if (qUpper.includes('2160') || qUpper.includes('4K') || qUpper.includes('UHD')) {
                  resolutionBadge = '4K';
                  is4K = true;
                } else if (qUpper.includes('1080') || qUpper.includes('FHD')) {
                  resolutionBadge = '1080p';
                  isFHD = true;
                } else if (qUpper.includes('720') || qUpper.includes('HD')) {
                  resolutionBadge = '720p';
                } else if (qUpper.includes('480')) {
                  resolutionBadge = '480p';
                } else if (qUpper.includes('AUTO')) {
                  resolutionBadge = 'Auto';
                } else {
                  resolutionBadge = rawQuality;
                }

                const isBadServer = invalidServerIndices.includes(idx);

                return (
                  <button
                    key={idx}
                    onClick={() => {
                      isAutoSwitchingRef.current = false;
                      setActiveStreamIndex(idx);
                      setStreamError(null);
                      showToast(`Connected to Server ${serverNum} · ${resolutionBadge}`, '⚡');
                    }}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border shrink-0 transition-all text-xs font-semibold cursor-pointer ${
                      isActive
                        ? 'bg-blue-600 text-white border-blue-400 shadow-md shadow-blue-900/30'
                        : isBadServer
                        ? 'bg-rose-950/20 text-slate-400 border-rose-500/20 opacity-60 hover:opacity-85'
                        : 'bg-white/5 hover:bg-white/10 text-slate-300 border-white/10 hover:border-white/20'
                    }`}
                  >
                    {/* Live status dot */}
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isActive
                          ? 'bg-emerald-400 animate-pulse'
                          : isBadServer
                          ? 'bg-rose-500'
                          : 'bg-slate-500'
                      }`}
                    />

                    {/* Server Label */}
                    <span className={`font-semibold text-xs tracking-tight whitespace-nowrap ${isBadServer ? 'line-through text-slate-400' : ''}`}>
                      Server {serverNum}
                    </span>

                    {/* Bad server indicator or Resolution & Language badges */}
                    {isBadServer ? (
                      <span className="text-[9px] font-bold px-1.5 py-0.2 rounded border uppercase tracking-tight bg-rose-500/15 text-rose-400 border-rose-500/30">
                        Short Sample
                      </span>
                    ) : (
                      <>
                        <span
                          className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border uppercase tracking-tight ${
                            isActive
                              ? 'bg-white/20 text-white border-white/30'
                              : is4K
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                              : isFHD
                              ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                              : 'bg-white/10 text-slate-400 border-white/10'
                          }`}
                        >
                          {resolutionBadge}
                        </span>

                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.2 rounded border uppercase tracking-tight ${
                            isActive
                              ? 'bg-emerald-400/25 text-emerald-200 border-emerald-300/40'
                              : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          }`}
                        >
                          {st.language?.toUpperCase().includes('ENG') || st.language?.toLowerCase() === 'english'
                            ? '🇬🇧 ENG'
                            : st.language || 'ENG'}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Overview Text */}
          <div className="text-slate-300 text-sm leading-relaxed max-w-4xl">
            {activeModalItem.overview || 'No synopsis provided for this title.'}
          </div>

          {/* Cast & Crew Horizontal Scroller */}
          {cast.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                Cast & Characters
              </h4>
              <div className="flex items-center gap-3 overflow-x-auto pb-2 no-scrollbar">
                {cast.map((actor) => (
                  <div key={actor.id} className="flex flex-col items-center text-center w-20 shrink-0">
                    <img
                      src={actor.profile_path || `https://picsum.photos/seed/${actor.id}/120/120`}
                      alt={actor.name}
                      className="w-14 h-14 rounded-full object-cover border border-white/10 shadow mb-1.5"
                    />
                    <span className="text-xs font-semibold text-white line-clamp-1 w-full">
                      {actor.name}
                    </span>
                    <span className="text-[10px] text-slate-400 line-clamp-1 w-full">
                      {actor.character || 'Actor'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* More Like This (Recommendations) */}
          {similar.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                More Like This
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {similar.slice(0, 6).map((item) => (
                  <MediaCard key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
