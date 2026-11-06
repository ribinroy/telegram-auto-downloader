import { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Play, Pause, Glasses, Maximize, Minimize } from 'lucide-react';
import { splitProjection, wrapSubtitle, type Projection } from '../utils/vr';

interface VRVideoPlayerProps {
  /** The player's own <video>, kept playing across flat/VR switches. */
  video: HTMLVideoElement;
  projection: Exclude<Projection, 'flat'>;
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

const LEFT = 1;
const RIGHT = 2;
const RADIUS = 500;

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
    texture: THREE.VideoTexture;
    subPlane: THREE.Mesh;
    subCanvas: HTMLCanvasElement;
    subTexture: THREE.CanvasTexture;
  } | null>(null);
  const meshesRef = useRef<THREE.Mesh[]>([]);

  const [isPlaying, setIsPlaying] = useState(!video.paused);
  const [currentTime, setCurrentTime] = useState(video.currentTime);
  const [duration, setDuration] = useState(video.duration || 0);
  const [xrSupported, setXrSupported] = useState(false);
  const [inXr, setInXr] = useState(false);

  // Scene, renderer, controls - built once per video element.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
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

    // setAnimationLoop (not rAF) is what lets WebXR drive the frame rate.
    renderer.setAnimationLoop(() => {
      if (!renderer.xr.isPresenting) controls.update();
      renderer.render(scene, camera);
    });

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    sceneRef.current = { renderer, scene, camera, texture, subPlane, subCanvas, subTexture };

    let cancelled = false;
    if (navigator.xr?.isSessionSupported) {
      navigator.xr.isSessionSupported('immersive-vr')
        .then(ok => { if (!cancelled) setXrSupported(ok); })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      ro.disconnect();
      renderer.setAnimationLoop(null);
      const session = renderer.xr.getSession();
      if (session) session.end().catch(() => {});
      controls.dispose();
      for (const m of meshesRef.current) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      meshesRef.current = [];
      subPlane.geometry.dispose();
      subMat.dispose();
      subTexture.dispose();
      texture.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [video]);

  // The sphere(s) follow the projection; everything else stays.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    for (const m of meshesRef.current) {
      s.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    const { layout, stereo } = splitProjection(projection);
    if (layout === 'flat') return;
    const meshes: THREE.Mesh[] = [];
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
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onMeta);
    };
  }, [video]);

  const togglePlayPause = useCallback(() => {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, [video]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    seekTo(video, parseFloat(e.target.value));
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

  // Space and arrows - the flat view's native controls do this themselves.
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [video, togglePlayPause]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return (h ? `${h}:${m.toString().padStart(2, '0')}` : `${m}`) + `:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="relative w-full h-full bg-black">
      <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing" onDoubleClick={togglePlayPause} />

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
