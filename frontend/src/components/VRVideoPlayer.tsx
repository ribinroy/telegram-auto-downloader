import { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Play, Pause, Glasses, Maximize, Minimize, Volume2, Volume1, VolumeX } from 'lucide-react';
import { splitProjection, wrapSubtitle, fitFlatPlane, type Projection } from '../utils/vr';

interface VRVideoPlayerProps {
  /** The player's own <video>, kept playing across projection switches. */
  video: HTMLVideoElement;
  /** A sphere for 180°/360°, a fitted plane for a flat video. */
  projection: Projection;
  /** Current subtitle cue, drawn on a plane in front of the viewer. */
  subtitle: string;
  /** Fullscreen is the parent player's (toolbar included); the overlay only mirrors it. */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

// Layers: three's WebXR camera enables layer 1 on the left eye and 2 on the
// right, so a stereo file is two hemispheres, one per layer, each mapped to
// its half of the frame. Mono content sits on layer 0, which every camera
// sees. The desktop camera also takes layer 1, so it shows the left eye.
// Imperative <video> writes live here: the element arrives as a prop, and the
// React compiler's lint treats a write to a prop as a mutation.
const seekTo = (v: HTMLVideoElement, t: number) => { v.currentTime = t; };
const setVolume = (v: HTMLVideoElement, vol: number) => { v.volume = vol; };
const setMuted = (v: HTMLVideoElement, muted: boolean) => { v.muted = muted; };
const setRate = (v: HTMLVideoElement, rate: number) => { v.playbackRate = rate; };

const LEFT = 1;
const RIGHT = 2;
const RADIUS = 500;
const FOV = 75;
// A flat video is a plane this far in front of a fixed camera, sized to fit
// the view (`fitFlatPlane`) - the renderer's `object-fit: contain`. Nearer
// than the sphere, further than the subtitle plane (20, parented to the
// camera, drawn on top regardless).
const FLAT_DISTANCE = 30;

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function eyeGeometry(layout: '180' | '360', stereo: 'mono' | 'sbs' | 'tb', eye: 'left' | 'right') {
  const phiLength = layout === '180' ? Math.PI : Math.PI * 2;
  // The sphere is inverted (scale -1 on x) so the texture faces inward;
  // this start angle puts the middle of the frame straight ahead (-Z),
  // which is where a headset looks when the session starts.
  const phiStart = Math.PI * 1.5 - phiLength / 2;
  const geometry = new THREE.SphereGeometry(RADIUS, 64, 32, phiStart, phiLength);
  geometry.scale(-1, 1, 1);
  if (stereo !== 'mono') {
    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      if (stereo === 'sbs') {
        // Left eye is the left half of the frame.
        uv.setX(i, uv.getX(i) * 0.5 + (eye === 'right' ? 0.5 : 0));
      } else {
        // Top/bottom: left eye on top. uv.y runs 0 at the bottom, 1 at the top.
        uv.setY(i, uv.getY(i) * 0.5 + (eye === 'left' ? 0.5 : 0));
      }
    }
    uv.needsUpdate = true;
  }
  return geometry;
}

// The subtitle is text on a canvas, mapped onto a plane parented to the
// camera, so it stays in front of you however you turn - in the headset too.
const SUB_W = 1024;
const SUB_H = 320;

function drawSubtitle(canvas: HTMLCanvasElement, text: string) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, SUB_W, SUB_H);
  const lines = wrapSubtitle(text);
  if (!lines.length) return;
  const size = lines.length > 3 ? 40 : 52;
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.fillStyle = '#fff';
  const lineH = size * 1.25;
  const top = SUB_H / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, i) => {
    ctx.strokeText(line, SUB_W / 2, top + i * lineH);
    ctx.fillText(line, SUB_W / 2, top + i * lineH);
  });
}

export function VRVideoPlayer({ video, projection, subtitle, fullscreen = false, onToggleFullscreen }: VRVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    texture: THREE.VideoTexture;
    subPlane: THREE.Mesh;
    subCanvas: HTMLCanvasElement;
    subTexture: THREE.CanvasTexture;
    /** Resize the flat plane (if any) to the current view and video shape. */
    fitFlat: () => void;
  } | null>(null);
  const meshesRef = useRef<THREE.Mesh[]>([]);
  const flatRef = useRef<THREE.Mesh | null>(null);
  const flat = projection === 'flat';

  const [isPlaying, setIsPlaying] = useState(!video.paused);
  const [currentTime, setCurrentTime] = useState(video.currentTime);
  const [duration, setDuration] = useState(video.duration || 0);
  const [volume, setVolumeState] = useState(video.volume);
  const [muted, setMutedState] = useState(video.muted);
  const [rate, setRateState] = useState(video.playbackRate || 1);
  const [xrSupported, setXrSupported] = useState(false);
  const [inXr, setInXr] = useState(false);

  // Scene, renderer, controls - built once per video element.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 0, 0.1);
    camera.layers.enable(LEFT);
    scene.add(camera);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);

    const texture = new THREE.VideoTexture(video);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;

    const subCanvas = document.createElement('canvas');
    subCanvas.width = SUB_W;
    subCanvas.height = SUB_H;
    const subTexture = new THREE.CanvasTexture(subCanvas);
    subTexture.colorSpace = THREE.SRGBColorSpace;
    const subMat = new THREE.MeshBasicMaterial({ map: subTexture, transparent: true, depthTest: false });
    // 20 units out, ~50° wide, a little below eye level: readable without
    // covering the action.
    const subPlane = new THREE.Mesh(new THREE.PlaneGeometry(18.6, 18.6 * (SUB_H / SUB_W)), subMat);
    subPlane.position.set(0, -6.5, -20);
    subPlane.renderOrder = 10;
    subPlane.visible = false;
    camera.add(subPlane);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.rotateSpeed = -0.3;
    controls.target.set(0, 0, 0);
    // The straight-ahead pose, restored when a flat plane replaces the sphere.
    controls.saveState();

    // setAnimationLoop (not rAF) is what lets WebXR drive the frame rate.
    renderer.setAnimationLoop(() => {
      if (!renderer.xr.isPresenting && controls.enabled) controls.update();
      renderer.render(scene, camera);
    });

    const fitFlat = () => {
      const plane = flatRef.current;
      if (!plane) return;
      const videoAspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
      const { width, height } = fitFlatPlane(FOV, FLAT_DISTANCE, camera.aspect, videoAspect);
      plane.scale.set(width, height, 1);
    };

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      fitFlat();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    // The plane's shape is the video's, known once the metadata is in.
    video.addEventListener('loadedmetadata', fitFlat);

    sceneRef.current = { renderer, scene, camera, controls, texture, subPlane, subCanvas, subTexture, fitFlat };

    let cancelled = false;
    if (navigator.xr?.isSessionSupported) {
      navigator.xr.isSessionSupported('immersive-vr')
        .then(ok => { if (!cancelled) setXrSupported(ok); })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      ro.disconnect();
      video.removeEventListener('loadedmetadata', fitFlat);
      renderer.setAnimationLoop(null);
      const session = renderer.xr.getSession();
      if (session) session.end().catch(() => {});
      controls.dispose();
      for (const m of meshesRef.current) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      meshesRef.current = [];
      flatRef.current = null;
      subPlane.geometry.dispose();
      subMat.dispose();
      subTexture.dispose();
      texture.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [video]);

  // The sphere(s) - or the flat plane - follow the projection; everything else stays.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    for (const m of meshesRef.current) {
      s.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    flatRef.current = null;
    const { layout, stereo } = splitProjection(projection);
    const meshes: THREE.Mesh[] = [];
    if (layout === 'flat') {
      // A unit plane straight ahead, scaled to fit by fitFlat. Dragging
      // a flat picture around makes no sense, so the camera is pinned
      // back to its straight-ahead pose - a sphere may have left it turned.
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: s.texture }));
      plane.position.set(0, 0, -FLAT_DISTANCE);
      meshes.push(plane);
      flatRef.current = plane;
      s.controls.reset();
      s.controls.enabled = false;
      s.fitFlat();
    } else {
      s.controls.enabled = true;
      if (stereo === 'mono') {
        const mesh = new THREE.Mesh(eyeGeometry(layout, 'mono', 'left'), new THREE.MeshBasicMaterial({ map: s.texture }));
        meshes.push(mesh);
      } else {
        const left = new THREE.Mesh(eyeGeometry(layout, stereo, 'left'), new THREE.MeshBasicMaterial({ map: s.texture }));
        left.layers.set(LEFT);
        const right = new THREE.Mesh(eyeGeometry(layout, stereo, 'right'), new THREE.MeshBasicMaterial({ map: s.texture }));
        right.layers.set(RIGHT);
        meshes.push(left, right);
      }
    }
    meshes.forEach(m => s.scene.add(m));
    meshesRef.current = meshes;
  }, [projection]);

  // Subtitle cue -> canvas texture; redrawn only when the text changes.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const text = subtitle.trim();
    s.subPlane.visible = !!text;
    if (text) {
      drawSubtitle(s.subCanvas, text);
      s.subTexture.needsUpdate = true;
    }
  }, [subtitle]);

  // Mirror the shared element's state for the overlay controls.
  useEffect(() => {
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => setCurrentTime(video.currentTime);
    const onMeta = () => setDuration(video.duration || 0);
    const onVolume = () => { setVolumeState(video.volume); setMutedState(video.muted); };
    const onRate = () => setRateState(video.playbackRate || 1);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('ratechange', onRate);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onMeta);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('ratechange', onRate);
    };
  }, [video]);

  const togglePlayPause = useCallback(() => {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, [video]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    seekTo(video, parseFloat(e.target.value));
  }, [video]);

  const toggleMute = useCallback(() => {
    setMuted(video, !video.muted);
  }, [video]);

  const handleVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(video, v);
    // Dragging the slider up is "I want to hear it", mute or not.
    if (v > 0 && video.muted) setMuted(video, false);
  }, [video]);

  const handleRate = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setRate(video, parseFloat(e.target.value));
  }, [video]);

  const enterXr = useCallback(async () => {
    const s = sceneRef.current;
    if (!s || !navigator.xr) return;
    try {
      const session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor'],
      });
      session.addEventListener('end', () => setInXr(false));
      await s.renderer.xr.setSession(session);
      setInXr(true);
      // A headset session is user activation enough for autoplay.
      void video.play().catch(() => {});
    } catch (err) {
      console.error('Could not start the VR session:', err);
    }
  }, [video]);

  const exitXr = useCallback(() => {
    sceneRef.current?.renderer.xr.getSession()?.end().catch(() => {});
  }, []);

  // Space, arrows and M - the flat view's native controls do this themselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekTo(video, Math.max(0, video.currentTime - 5));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekTo(video, Math.min(video.duration || 0, video.currentTime + 5));
      } else if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleMute();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [video, togglePlayPause, toggleMute]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return (h ? `${h}:${m.toString().padStart(2, '0')}` : `${m}`) + `:${s.toString().padStart(2, '0')}`;
  };

  const silent = muted || volume === 0;
  const VolumeIcon = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="relative w-full h-full bg-black">
      <div
        ref={containerRef}
        className={`w-full h-full ${flat ? '' : 'cursor-grab active:cursor-grabbing'}`}
        onDoubleClick={togglePlayPause}
      />

      {/* Overlay controls */}
      <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-4 bg-gradient-to-t from-black/80 to-transparent">
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={togglePlayPause}
            className="p-2 text-white hover:text-cyan-400 transition-colors"
            title={isPlaying ? 'Pause (space)' : 'Play (space)'}
          >
            {isPlaying ? <Pause className="w-5 h-5" fill="currentColor" /> : <Play className="w-5 h-5" fill="currentColor" />}
          </button>
          <span className="text-white text-xs sm:text-sm font-mono tabular-nums whitespace-nowrap">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={Math.min(currentTime, duration || 0)}
            onChange={handleSeek}
            step={0.1}
            className="flex-1 h-1 accent-cyan-400"
            aria-label="Seek"
          />
          <div className="flex items-center gap-1 group">
            <button
              onClick={toggleMute}
              className="p-2 text-white hover:text-cyan-400 transition-colors"
              title={silent ? 'Unmute (M)' : 'Mute (M)'}
              aria-label={silent ? 'Unmute' : 'Mute'}
            >
              <VolumeIcon className="w-5 h-5" />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={handleVolume}
              className="w-0 group-hover:w-16 group-focus-within:w-16 sm:w-16 h-1 accent-cyan-400 transition-[width]"
              aria-label="Volume"
            />
          </div>
          <select
            value={String(rate)}
            onChange={handleRate}
            className="bg-transparent text-white text-xs sm:text-sm outline-none cursor-pointer"
            title="Playback speed"
            aria-label="Playback speed"
          >
            {(PLAYBACK_RATES.includes(rate) ? PLAYBACK_RATES : [...PLAYBACK_RATES, rate].sort((a, b) => a - b)).map(r => (
              <option key={r} value={String(r)} className="bg-slate-900">{r}×</option>
            ))}
          </select>
          {xrSupported && (
            <button
              onClick={inXr ? exitXr : enterXr}
              className={`p-2 rounded-lg transition-colors ${inXr ? 'text-cyan-400' : 'text-white hover:text-cyan-400'}`}
              title={inXr ? 'Leave the headset' : 'Watch in the headset'}
            >
              <Glasses className="w-5 h-5" />
            </button>
          )}
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="p-2 text-white hover:text-cyan-400 transition-colors"
              title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            >
              {fullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
