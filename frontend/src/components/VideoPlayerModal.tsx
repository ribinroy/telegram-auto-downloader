import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { VideoPlayer } from './VideoPlayer';
import type { SubtitleSource } from '../api/subtitles';

interface VideoPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  title: string;
  /** Where to look for subtitle tracks (download record or explorer path). */
  subtitles?: SubtitleSource;
}

export function VideoPlayerModal({ isOpen, onClose, videoUrl, title, subtitles }: VideoPlayerModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      // Leave a headset session or fullscreen first; the next Escape closes.
      if (e.key === 'Escape' && !document.fullscreenElement) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-5xl mx-4 z-10">
        <div className="flex items-center justify-between mb-3 gap-3">
          <h3 className="text-white font-medium truncate" title={title}>
            {title}
          </h3>
          <button
            onClick={onClose}
            className="p-2 bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors shrink-0"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <VideoPlayer src={videoUrl} name={title} subtitles={subtitles} />
      </div>
    </div>,
    document.body
  );
}
