import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface VideoPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  title: string;
}

export function VideoPlayerModal({ isOpen, onClose, videoUrl, title }: VideoPlayerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  // Pause video when closing
  useEffect(() => {
    if (!isOpen && videoRef.current) {
      videoRef.current.pause();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/90 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal Content */}
      <div className="relative w-full max-w-5xl mx-4 z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white font-medium truncate pr-4" title={title}>
            {title}
          </h3>
          <button
            onClick={onClose}
            className="p-2 bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Video Player */}
        <div className="relative bg-black rounded-xl overflow-hidden shadow-2xl">
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            autoPlay
            className="w-full max-h-[80vh]"
            controlsList="nodownload"
          >
            Your browser does not support the video tag.
          </video>
        </div>
      </div>
    </div>
  );
}
