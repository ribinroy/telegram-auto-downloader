import { useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import { Captions, Globe } from 'lucide-react';
import { useSubtitleTracks } from '../hooks/useMisc';
import { getSubtitleUrl, type SubtitleSource } from '../api/subtitles';
import {
  PROJECTIONS, detectProjection, recallProjection, rememberProjection, type Projection,
} from '../utils/vr';

const VRVideoPlayer = lazy(() =>
  import('./VRVideoPlayer').then((m) => ({ default: m.VRVideoPlayer }))
);

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

/**
 * One player for every video DownLee shows: the download list, the transfer
 * files modal and the file explorer. A single <video> element carries the
 * stream, the subtitle tracks and the playback position; switching to VR
 * hides it and hands it to the three.js renderer as a texture, so nothing is
 * reloaded or rewound by the switch and the same TextTrack feeds both views.
 */
export function VideoPlayer({ src, name, subtitles, onError, autoPlay = true, extraControls, className }: VideoPlayerProps) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [aspect, setAspect] = useState<number | undefined>();
  const [manual, setManual] = useState<Projection | null>(() => recallProjection(name));
  const [trackId, setTrackId] = useState<string>(OFF);
  const [cue, setCue] = useState('');

  const { data: tracks = [] } = useSubtitleTracks(subtitles ?? null);
  const detected = useMemo(() => detectProjection(name, aspect), [name, aspect]);
  const projection: Projection = manual ?? detected;
  const vr = projection !== 'flat';

  useEffect(() => {
    setManual(recallProjection(name));
    setAspect(undefined);
    setTrackId(OFF);
    setCue('');
  }, [name, src]);

  const pickProjection = (p: Projection) => {
    const next = p === detected ? null : p;
    setManual(next);
    rememberProjection(name, next);
  };

  // Drive the <track> modes from the picker. In the flat view the browser
  // renders the chosen track; in VR it is 'hidden' - still firing cuechange,
  // not painted onto a <video> nobody can see - and the cue text goes to the
  // renderer's subtitle plane.
  useEffect(() => {
    if (!video) return;
    const list = video.textTracks;
    let chosen: TextTrack | null = null;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const mine = t.id === `sub-${trackId}` && trackId !== OFF;
      t.mode = mine ? (vr ? 'hidden' : 'showing') : 'disabled';
      if (mine) chosen = t;
    }
    if (!chosen) {
      setCue('');
      return;
    }
    const read = () => {
      const cues = chosen!.activeCues;
      if (!cues) return setCue('');
      const parts: string[] = [];
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i] as VTTCue;
        parts.push(typeof c.getCueAsHTML === 'function' ? (c.getCueAsHTML().textContent ?? '') : c.text);
      }
      setCue(parts.join('\n'));
    };
    read();
    chosen.addEventListener('cuechange', read);
    return () => chosen!.removeEventListener('cuechange', read);
  }, [video, trackId, vr, tracks]);

  const setVideoEl = (el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideo(el);
  };

  return (
    <div className={className}>
      {/* Toolbar: view + subtitles. Native controls stay on the flat <video>. */}
      <div className="flex items-center justify-end gap-2 mb-2 flex-wrap">
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
      </div>

      <div className="relative bg-black rounded-xl overflow-hidden shadow-2xl">
        <video
          ref={setVideoEl}
          src={src}
          controls={!vr}
          autoPlay={autoPlay}
          playsInline
          className={vr ? 'hidden' : 'w-full max-h-[80vh]'}
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

        {vr && video && (
          <div className="w-full" style={{ height: '70vh' }}>
            <Suspense
              fallback={
                <div className="w-full h-full flex items-center justify-center text-slate-400">
                  Loading VR player...
                </div>
              }
            >
              <VRVideoPlayer video={video} projection={projection} subtitle={cue} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
