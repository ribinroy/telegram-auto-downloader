import { useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import { Captions, Globe, Maximize, Minimize } from 'lucide-react';
import { useSubtitleTracks, useDownloadProjection, useSaveDownloadProjection } from '../hooks/useMisc';
import { loadVRPlayer, preloadVRPlayer } from '../lib/vrPreload';
import { getSubtitleUrl, type SubtitleSource } from '../api/subtitles';
import {
  PROJECTIONS, detectProjection, recallProjection, rememberProjection, type Projection,
} from '../utils/vr';

const VRVideoPlayer = lazy(() => loadVRPlayer().then((m) => ({ default: m.VRVideoPlayer })));

export interface VideoPlayerProps {
  src: string;
  /** Filename (or path); drives the VR projection guess and the remembered pick. */
  name: string;
  /** Where to look for subtitle tracks. Omit for a video with none to offer. */
  subtitles?: SubtitleSource;
  onError?: () => void;
  autoPlay?: boolean;
  /** Extra controls rendered in the toolbar, after the player's own. */
  extraControls?: ReactNode;
  className?: string;
}

const OFF = '';

// TextTrack.mode is the browser's switch, written imperatively (the element
// is React state, so the write is kept out of the component body).
const setTrackMode = (t: TextTrack, mode: TextTrackMode) => { t.mode = mode; };

/**
 * One player for every video DownLee shows: the download list, the transfer
 * files modal and the file explorer. A hidden <video> element carries the
 * stream, the subtitle tracks and the playback position, and the three.js
 * renderer draws it - a flat video on a fitted plane, a VR one on a sphere -
 * so every file opens in the same player with the same controls, and a
 * projection switch never reloads or rewinds: the same element and the same
 * TextTrack feed every view.
 */
export function VideoPlayer({ src, name, subtitles, onError, autoPlay = true, extraControls, className }: VideoPlayerProps) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [aspect, setAspect] = useState<number | undefined>();
  const [manual, setManual] = useState<Projection | null>(() => recallProjection(name));
  const [trackId, setTrackId] = useState<string>(OFF);
  // The cue remembers which track it was read for, so a stale line from the
  // previous track is never shown after a switch.
  const [cueFor, setCueFor] = useState<{ track: string; text: string }>({ track: OFF, text: '' });
  const cue = cueFor.track === trackId ? cueFor.text : '';
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== 'undefined' && !!document.fullscreenEnabled;

  useEffect(() => { preloadVRPlayer(); }, []);

  const { data: tracks = [] } = useSubtitleTracks(subtitles ?? null);
  // A download's pick lives on the server too (the headset feed reads it);
  // an explorer path only has this browser's memory.
  const downloadId = subtitles && 'downloadId' in subtitles ? subtitles.downloadId : null;
  const serverPick = useDownloadProjection(downloadId);
  const savePick = useSaveDownloadProjection(downloadId);
  const detected = useMemo(() => detectProjection(name, aspect), [name, aspect]);
  const projection: Projection = manual ?? serverPick.data?.projection ?? detected;
  const vr = projection !== 'flat';

  // A new file resets the per-file state; done during render (React's
  // "adjusting state when a prop changes") rather than in an effect, so the
  // old file's pick never renders for a frame.
  const fileKey = `${src}\n${name}`;
  const [seenFile, setSeenFile] = useState(fileKey);
  if (seenFile !== fileKey) {
    setSeenFile(fileKey);
    setManual(recallProjection(name));
    setAspect(undefined);
    setTrackId(OFF);
  }

  const pickProjection = (p: Projection) => {
    const next = p === detected ? null : p;
    setManual(next);
    rememberProjection(name, next);
    if (downloadId != null) savePick.mutate(next);
  };

  // Drive the <track> modes from the picker. The chosen track is 'hidden' -
  // still firing cuechange, not painted onto the <video>, which nobody sees -
  // and the cue text goes to the renderer's subtitle plane.
  useEffect(() => {
    if (!video) return;
    const list = video.textTracks;
    let chosen: TextTrack | null = null;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const mine = t.id === `sub-${trackId}` && trackId !== OFF;
      setTrackMode(t, mine ? 'hidden' : 'disabled');
      if (mine) chosen = t;
    }
    if (!chosen) return;
    const track = chosen;
    const read = () => {
      const cues = track.activeCues;
      const parts: string[] = [];
      for (let i = 0; cues && i < cues.length; i++) {
        const c = cues[i] as VTTCue;
        parts.push(typeof c.getCueAsHTML === 'function' ? (c.getCueAsHTML().textContent ?? '') : c.text);
      }
      setCueFor({ track: trackId, text: parts.join('\n') });
    };
    track.addEventListener('cuechange', read);
    return () => track.removeEventListener('cuechange', read);
  }, [video, trackId, tracks]);

  // Fullscreen takes the whole player - toolbar included - so the subtitle
  // and view pickers stay reachable, and the VR canvas resizes with the box.
  useEffect(() => {
    const onChange = () => setFullscreen(!!wrapRef.current && document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  };

  useEffect(() => {
    if (!canFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setVideoEl = (el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideo(el);
  };

  return (
    <div ref={wrapRef} className={`${className ?? ''} ${fullscreen ? 'bg-black flex flex-col h-full w-full' : ''}`}>
      {/* Toolbar: view + subtitles + fullscreen. The renderer's overlay carries the playback controls. */}
      <div className={`flex items-center justify-end gap-2 flex-wrap ${fullscreen ? 'p-2 shrink-0' : 'mb-2'}`}>
        {extraControls}
        {tracks.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-slate-300 bg-slate-800/80 rounded-lg px-2 py-1.5" title="Subtitles">
            <Captions className="w-4 h-4 text-slate-400" />
            <select
              value={trackId}
              onChange={e => setTrackId(e.target.value)}
              className="bg-transparent text-white outline-none max-w-[12rem]"
              aria-label="Subtitles"
            >
              <option value={OFF}>Off</option>
              {tracks.map(t => (
                <option key={t.id} value={t.id}>
                  {t.label}{t.kind === 'sidecar' ? ` (.${t.format})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label
          className={`flex items-center gap-1.5 text-xs rounded-lg px-2 py-1.5 ${vr ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-800/80 text-slate-300'}`}
          title={manual ? 'View (chosen for this file)' : 'View (guessed from the filename)'}
        >
          <Globe className={`w-4 h-4 ${vr ? 'text-cyan-400' : 'text-slate-400'}`} />
          <select
            value={projection}
            onChange={e => pickProjection(e.target.value as Projection)}
            className="bg-transparent text-white outline-none"
            aria-label="View"
          >
            {PROJECTIONS.map(p => (
              <option key={p.value} value={p.value}>
                {p.label}{p.value === detected && detected !== 'flat' ? ' · auto' : ''}
              </option>
            ))}
          </select>
        </label>
        {canFullscreen && (
          <button
            onClick={toggleFullscreen}
            className={`p-1.5 rounded-lg transition-colors ${fullscreen ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-800/80 text-slate-300 hover:text-white'}`}
            title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          </button>
        )}
      </div>

      <div className={`relative bg-black overflow-hidden ${fullscreen ? 'flex-1 min-h-0' : 'rounded-xl shadow-2xl'}`}>
        <video
          ref={setVideoEl}
          src={src}
          autoPlay={autoPlay}
          playsInline
          className="hidden"
          controlsList="nodownload"
          crossOrigin="anonymous"
          onError={onError}
          onLoadedMetadata={e => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          }}
        >
          {subtitles && tracks.map(t => (
            <track
              key={t.id}
              id={`sub-${t.id}`}
              kind="subtitles"
              src={getSubtitleUrl(subtitles, t.id)}
              srcLang={t.lang ?? undefined}
              label={t.label}
            />
          ))}
          Your browser does not support the video tag.
        </video>

        {video && (
          <div className="w-full" style={{ height: fullscreen ? '100%' : '70vh' }}>
            <Suspense
              fallback={
                <div className="w-full h-full flex items-center justify-center text-slate-400">
                  Loading VR player...
                </div>
              }
            >
              <VRVideoPlayer video={video} projection={projection} subtitle={cue} fullscreen={fullscreen} onToggleFullscreen={canFullscreen ? toggleFullscreen : undefined} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
