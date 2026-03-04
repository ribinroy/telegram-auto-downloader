import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { X, Globe } from 'lucide-react';

const VRVideoPlayer = lazy(() =>
  import('./VRVideoPlayer').then((m) => ({ default: m.VRVideoPlayer }))
);

interface VideoPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  title: string;
}

export function VideoPlayerModal({ isOpen, onClose, videoUrl, title }: VideoPlayerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [vrMode, setVrMode] = useState(false);

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

  // Reset VR mode when modal closes
  useEffect(() => {
    if (!isOpen) {
      setVrMode(false);
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setVrMode(!vrMode)}
              className={`p-2 rounded-lg transition-colors ${
                vrMode
                  ? 'bg-cyan-500/30 text-cyan-400'
                  : 'bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white'
              }`}
              title={vrMode ? 'Switch to flat view' : 'Switch to 360° view'}
            >
              <Globe className="w-5 h-5" />
            </button>
            <button
              onClick={onClose}
              className="p-2 bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Video Player */}
        <div className="relative bg-black rounded-xl overflow-hidden shadow-2xl">
          {vrMode ? (
            <div className="w-full" style={{ height: '70vh' }}>
              <Suspense
                fallback={
                  <div className="w-full h-full flex items-center justify-center text-slate-400">
                    Loading 360° player...
                  </div>
                }
              >
                <VRVideoPlayer videoUrl={videoUrl} autoPlay />
              </Suspense>
            </div>
          ) : (
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              autoPlay
              playsInline
              className="w-full max-h-[80vh]"
              controlsList="nodownload"
              onError={(e) => {
                const video = e.currentTarget;
                console.error('Video error:', video.error?.message, video.error?.code);
              }}
              onLoadedMetadata={() => console.log('Video metadata loaded')}
              onCanPlay={() => console.log('Video can play')}
            >
              Your browser does not support the video tag.
            </video>
          )}
        </div>
      </div>
    </div>
  );
}
