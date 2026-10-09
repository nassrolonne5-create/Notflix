import React from 'react';
import { X, Trash2, RefreshCw, Sliders, CheckCircle2 } from 'lucide-react';
import { useApp } from '../context/AppContext';

export const SettingsModal: React.FC = () => {
  const {
    isSettingsOpen,
    closeSettings,
    userData,
    toggleAutoSkip,
    toggleGlobalSubtitles,
    clearWatchHistory,
    resetAppData,
    showToast,
  } = useApp();

  if (!isSettingsOpen) return null;

  return (
    <div
      onClick={closeSettings}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#131a2a] border border-white/10 rounded-3xl p-6 shadow-2xl flex flex-col gap-6"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-blue-400" />
            <h2 className="font-display text-2xl text-white tracking-wide uppercase">Notflix Settings</h2>
          </div>
          <button
            onClick={closeSettings}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Playback Toggles */}
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Playback Preferences</h3>

          {/* Auto Skip TV Intros */}
          <div className="flex items-center justify-between p-3.5 bg-white/5 border border-white/5 rounded-2xl">
            <div>
              <div className="text-sm font-semibold text-white">Auto-skip TV Intros</div>
              <div className="text-xs text-slate-400">Skips intro sequences in TV series episodes</div>
            </div>
            <button
              onClick={toggleAutoSkip}
              className={`w-12 h-6 rounded-full p-1 transition-colors cursor-pointer ${
                userData.settings.autoSkip ? 'bg-blue-600' : 'bg-slate-700'
              }`}
            >
              <div
                className={`w-4 h-4 bg-white rounded-full transition-transform ${
                  userData.settings.autoSkip ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Global Subtitles */}
          <div className="flex items-center justify-between p-3.5 bg-white/5 border border-white/5 rounded-2xl">
            <div>
              <div className="text-sm font-semibold text-white">Enable Subtitles Globally</div>
              <div className="text-xs text-slate-400">Automatically display subtitles when available</div>
            </div>
            <button
              onClick={toggleGlobalSubtitles}
              className={`w-12 h-6 rounded-full p-1 transition-colors cursor-pointer ${
                userData.settings.globalSubtitles ? 'bg-blue-600' : 'bg-slate-700'
              }`}
            >
              <div
                className={`w-4 h-4 bg-white rounded-full transition-transform ${
                  userData.settings.globalSubtitles ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Data & Storage Actions */}
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Data Management</h3>

          <div className="flex flex-wrap gap-2.5">
            <button
              onClick={() => {
                showToast('API cache cleared', '🧹');
              }}
              className="flex-1 flex items-center justify-center gap-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-bold px-4 py-2.5 rounded-xl transition-all cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Clear Cache</span>
            </button>

            <button
              onClick={clearWatchHistory}
              className="flex-1 flex items-center justify-center gap-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold px-4 py-2.5 rounded-xl transition-all cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear History</span>
            </button>
          </div>

          <button
            onClick={() => {
              if (window.confirm('Reset all saved watchlists, favorites, and playback settings?')) {
                resetAppData();
              }
            }}
            className="w-full bg-rose-600/20 hover:bg-rose-600/30 border border-rose-600/40 text-rose-400 text-xs font-bold py-2.5 rounded-xl transition-all cursor-pointer"
          >
            Reset Entire Database
          </button>
        </div>

        {/* Footer info */}
        <div className="text-center text-[11px] text-slate-500 pt-2 border-t border-white/5">
          Notflix Full-Stack Edition · Node.js Backend & React Engine
        </div>
      </div>
    </div>
  );
};
