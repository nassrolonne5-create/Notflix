import React from 'react';
import { useApp } from '../context/AppContext';

export const Toast: React.FC = () => {
  const { toast } = useApp();

  if (!toast.show) return null;

  return (
    <div className="fixed bottom-24 md:bottom-8 left-1/2 -translate-x-1/2 z-50 pointer-events-none animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="bg-[#1e293b]/95 border border-white/15 text-slate-100 text-xs md:text-sm font-semibold px-4 py-2.5 rounded-2xl shadow-2xl shadow-black/80 flex items-center gap-2 backdrop-blur-md">
        {toast.icon && <span className="text-base">{toast.icon}</span>}
        <span>{toast.message}</span>
      </div>
    </div>
  );
};
