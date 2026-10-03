import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { Play, X, Clock } from 'lucide-react';
import { MediaItem } from '../types';

interface SavedSession {
  item: MediaItem;
  season?: number;
  episode?: number;
  time: number;
  duration?: number;
  timestamp: number;
}

const formatSessionTime = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const ResumeBanner: React.FC = () => {
  const { activeModalItem, openPlayer } = useApp();
  const [session, setSession] = useState<SavedSession | null>(null);
  const [isDismissed, setIsDismissed] = useState<boolean>(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('notflix_last_session');
      if (raw) {
        const parsed: SavedSession = JSON.parse(raw);
        // Only show if played for more than 10 seconds and within 48 hours
        const isRecent = Date.now() - (parsed.timestamp || 0) < 48 * 60 * 60 * 1000;
        if (parsed.item && parsed.time > 10 && isRecent) {
          setSession(parsed);
        }
      }
    } catch (e) {
      console.warn('Error reading saved session:', e);
    }
  }, [activeModalItem]);

  if (!session || activeModalItem || isDismissed) return null;

  const title = session.item.title || session.item.name || 'Title';
  const isTV = session.item.type === 'tv' && session.season && session.episode;

  const handleResume = () => {
    openPlayer(session.item, session.season, session.episode);
    setIsDismissed(true);
  };

  const handleDismiss = () => {
    setIsDismissed(true);
    try {
      localStorage.removeItem('notflix_last_session');
    } catch {}
  };

  return (
    <div className="fixed bottom-20 md:bottom-6 right-4 md:right-6 z-40 max-w-sm w-[calc(100vw-2rem)] bg-[#0f172a]/95 backdrop-blur-md border border-white/20 rounded-2xl p-3.5 shadow-2xl shadow-black/80 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
      {/* Thumbnail */}
      {session.item.poster && (
        <img
          src={session.item.poster}
          alt={title}
          className="w-11 h-15 object-cover rounded-xl shrink-0 shadow border border-white/10"
        />
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-400 uppercase tracking-wider">
          <Clock className="w-3 h-3" />
          <span>Resume Watching</span>
        </div>
        <h4 className="text-white font-bold text-sm truncate">{title}</h4>
        <p className="text-xs text-slate-300 font-mono mt-0.5">
          {isTV ? `S${session.season}:E${session.episode} · ` : ''}
          at {formatSessionTime(session.time)}
        </p>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={handleResume}
          className="bg-rose-600 hover:bg-rose-500 active:scale-95 text-white text-xs font-bold px-3 py-2 rounded-xl flex items-center gap-1 transition-all shadow-md cursor-pointer"
          title="Resume Playback"
        >
          <Play className="w-3.5 h-3.5 fill-white" />
          <span>Resume</span>
        </button>

        <button
          onClick={handleDismiss}
          className="w-7 h-7 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white flex items-center justify-center transition-all cursor-pointer"
          aria-label="Dismiss Resume Banner"
          title="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
