import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VRVideoPlayer } from './VRVideoPlayer';

// jsdom has no WebGL. three.js is replaced by stubs that only record what the
// player does to them - which geometry it builds, on which layer, what it
// disposes - so the tests are about the player's decisions, not rendering.
interface Vec { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void }
interface Obj { children: Obj[]; layers: { mask: number }; position: Vec; scale: Vec; visible: boolean; add: (o: Obj) => void; remove: (o: Obj) => void }
interface Geometry { params?: { radius: number; phiStart: number; phiLength: number }; attributes?: { uv: { array: Float32Array; count: number; needsUpdate: boolean } }; width?: number; height?: number; scale: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
interface Material { map: unknown; dispose: ReturnType<typeof vi.fn> }
interface MeshObj extends Obj { geometry: Geometry; material: Material }
interface Renderer {
  domElement: HTMLCanvasElement; loop: (() => void) | null;
  setSize: ReturnType<typeof vi.fn>; setPixelRatio: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
  xr: { enabled: boolean; isPresenting: boolean; session: unknown; getSession: () => unknown; setSession: ReturnType<typeof vi.fn> };
}
interface Controls { update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; enabled: boolean; enableZoom: boolean; enablePan: boolean }
interface Texture { needsUpdate: boolean; dispose: ReturnType<typeof vi.fn> }

const made = vi.hoisted(() => ({
  renderers: [] as unknown[], scenes: [] as unknown[], controls: [] as unknown[], videoTextures: [] as unknown[], canvasTextures: [] as unknown[],
}));

vi.mock('three', () => {
  class Layers { mask = 1; enable(l: number) { this.mask |= 1 << l; } set(l: number) { this.mask = 1 << l; } }
  class Vector3 { x = 0; y = 0; z = 0; set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }
  class Object3D {
    children: Object3D[] = []; layers = new Layers(); position = new Vector3(); scale = new Vector3(); visible = true; renderOrder = 0;
    add(o: Object3D) { this.children.push(o); }
    remove(o: Object3D) { this.children = this.children.filter(c => c !== o); }
  }
  class Scene extends Object3D { constructor() { super(); made.scenes.push(this); } }
  class PerspectiveCamera extends Object3D {
    updateProjectionMatrix = vi.fn();
    fov: number; aspect: number; near: number; far: number;
    constructor(fov: number, aspect: number, near: number, far: number) {
      super();
      this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    }
  }
  class BufferAttribute {
    needsUpdate = false;
    array: Float32Array; itemSize: number;
    constructor(array: Float32Array, itemSize: number) { this.array = array; this.itemSize = itemSize; }
    get count() { return this.array.length / this.itemSize; }
    getX(i: number) { return this.array[i * this.itemSize]; }
    setX(i: number, v: number) { this.array[i * this.itemSize] = v; }
    getY(i: number) { return this.array[i * this.itemSize + 1]; }
    setY(i: number, v: number) { this.array[i * this.itemSize + 1] = v; }
  }
  class SphereGeometry {
    params: { radius: number; phiStart: number; phiLength: number };
    attributes: { uv: BufferAttribute };
    scale = vi.fn(); dispose = vi.fn();
    constructor(radius: number, _w: number, _h: number, phiStart: number, phiLength: number) {
      this.params = { radius, phiStart, phiLength };
      // Four corners of the frame: (0,0) (1,0) (0,1) (1,1)
      this.attributes = { uv: new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2) };
    }
  }
  class PlaneGeometry { dispose = vi.fn(); width: number; height: number; constructor(width: number, height: number) { this.width = width; this.height = height; } }
  class MeshBasicMaterial { map: unknown; transparent = false; depthTest = true; dispose = vi.fn(); constructor(p: Record<string, unknown>) { Object.assign(this, p); } }
  class Mesh extends Object3D { geometry: unknown; material: unknown; constructor(geometry: unknown, material: unknown) { super(); this.geometry = geometry; this.material = material; } }
  class VideoTexture { minFilter: unknown; magFilter: unknown; colorSpace: unknown; dispose = vi.fn(); video: HTMLVideoElement; constructor(video: HTMLVideoElement) { this.video = video; made.videoTextures.push(this); } }
  class CanvasTexture { needsUpdate = false; colorSpace: unknown; dispose = vi.fn(); canvas: HTMLCanvasElement; constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; made.canvasTextures.push(this); } }
  class WebGLRenderer {
    domElement = document.createElement('canvas');
    loop: (() => void) | null = null;
    setSize = vi.fn(); setPixelRatio = vi.fn(); render = vi.fn(); dispose = vi.fn();
    xr = {
      enabled: false, isPresenting: false, session: null as unknown,
      getSession() { return this.session; },
      setSession: vi.fn(async function (this: { session: unknown }, s: unknown) { this.session = s; }),
    };
    constructor() { made.renderers.push(this); }
    setAnimationLoop(fn: (() => void) | null) { this.loop = fn; }
  }
  return {
    Scene, PerspectiveCamera, WebGLRenderer, VideoTexture, CanvasTexture, MeshBasicMaterial, Mesh,
    PlaneGeometry, SphereGeometry, BufferAttribute, LinearFilter: 1006, SRGBColorSpace: 'srgb',
  };
});
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    enabled = true; enableZoom = true; enablePan = true; rotateSpeed = 1; target = { set: vi.fn() };
    update = vi.fn(); dispose = vi.fn(); saveState = vi.fn(); reset = vi.fn();
    camera: unknown; dom: unknown;
    constructor(camera: unknown, dom: unknown) { this.camera = camera; this.dom = dom; made.controls.push(this); }
  },
}));

const last = <T,>(list: unknown[]) => list[list.length - 1] as T;
const renderer = () => last<Renderer>(made.renderers);
const scene = () => last<Obj>(made.scenes);
const camera = () => scene().children.find(c => 'updateProjectionMatrix' in c)!;
const subPlane = () => camera().children[0] as MeshObj;
const spheres = () => scene().children.filter((c): c is MeshObj => 'geometry' in c && !!(c as MeshObj).geometry.params);
const flatPlane = () => scene().children.find((c): c is MeshObj => 'geometry' in c && !(c as MeshObj).geometry.params) ?? null;
const controls = () => last<Controls>(made.controls);
const uvs = (m: MeshObj, axis: 'x' | 'y') => {
  const a = m.geometry.attributes!.uv.array;
  return Array.from({ length: a.length / 2 }, (_, i) => a[i * 2 + (axis === 'x' ? 0 : 1)]);
};

function makeVideo(duration = 125) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { configurable: true, get: () => duration });
  video.play = vi.fn().mockResolvedValue(undefined);
  video.pause = vi.fn(() => { Object.defineProperty(video, 'paused', { configurable: true, value: true }); });
  return video;
}

type Props = Partial<Parameters<typeof VRVideoPlayer>[0]>;
function renderPlayer(over: Props = {}) {
  const video = over.video ?? makeVideo();
  const props = { video, projection: '180-sbs' as const, subtitle: '', ...over };
  const view = render(<VRVideoPlayer {...props} />);
  return { ...view, video, props };
}

let ctx: { clearRect: ReturnType<typeof vi.fn>; strokeText: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn>; font: string; lineWidth: number };

beforeEach(() => {
  made.renderers.length = 0; made.scenes.length = 0; made.controls.length = 0; made.videoTextures.length = 0; made.canvasTextures.length = 0;
  ctx = { clearRect: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(), font: '', lineWidth: 0 };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
});
afterEach(() => {
  delete (navigator as { xr?: unknown }).xr;
});

const stubXr = (supported: boolean) => {
  const listeners: Record<string, () => void> = {};
  const session = { addEventListener: (t: string, f: () => void) => { listeners[t] = f; }, end: vi.fn().mockResolvedValue(undefined) };
  const xr = { isSessionSupported: vi.fn().mockResolvedValue(supported), requestSession: vi.fn().mockResolvedValue(session) };
  Object.defineProperty(navigator, 'xr', { configurable: true, value: xr });
  return { xr, session, listeners };
};

describe('VRVideoPlayer - the scene', () => {
  it('puts the renderer\'s canvas in the box, wires the video in as a texture and runs the frame loop', () => {
    const { container, video } = renderPlayer();
    const r = renderer();
    expect(container.querySelector('.cursor-grab canvas')).toBe(r.domElement);
    expect(r.xr.enabled).toBe(true);
    expect(r.setSize).toHaveBeenCalledTimes(1);
    expect(r.setPixelRatio).toHaveBeenCalledWith(Math.min(window.devicePixelRatio, 2));
    expect((last<{ video: HTMLVideoElement }>(made.videoTextures)).video).toBe(video);
    // The desktop camera shows the left eye
    expect(camera().layers.mask & (1 << 1)).toBeTruthy();
    // Outside a headset session the loop drives the drag controls
    const c = controls();
    expect(c.enableZoom).toBe(false);
    expect(c.enablePan).toBe(false);
    expect(c.saveState).toHaveBeenCalledTimes(1);     // the straight-ahead pose, for a later flat plane
    act(() => { r.loop!(); });
    expect(c.update).toHaveBeenCalledTimes(1);
    expect(r.render).toHaveBeenCalledWith(scene(), camera());
    r.xr.isPresenting = true;
    act(() => { r.loop!(); });
    expect(c.update).toHaveBeenCalledTimes(1);
    expect(r.render).toHaveBeenCalledTimes(2);
  });

  it('a stereo side-by-side file is two half-spheres, one per eye layer, each on its half of the frame', () => {
    renderPlayer({ projection: '180-sbs' });
    const [left, right] = spheres();
    expect(spheres()).toHaveLength(2);
    expect(left.layers.mask).toBe(1 << 1);
    expect(right.layers.mask).toBe(1 << 2);
    for (const m of [left, right]) {
      expect(m.geometry.params!.phiLength).toBeCloseTo(Math.PI);
      expect(m.geometry.params!.phiStart).toBeCloseTo(Math.PI);     // 1.5π - π/2: the middle of the frame straight ahead
      expect(m.geometry.scale).toHaveBeenCalledWith(-1, 1, 1);       // inverted, texture facing inward
      expect(m.geometry.attributes!.uv.needsUpdate).toBe(true);
      expect(m.material.map).toBe(last(made.videoTextures));
    }
    expect(uvs(left, 'x')).toEqual([0, 0.5, 0, 0.5]);
    expect(uvs(right, 'x')).toEqual([0.5, 1, 0.5, 1]);
    expect(uvs(left, 'y')).toEqual([0, 0, 1, 1]);                   // untouched
  });

  it('top/bottom puts the left eye on the top half; mono is one full sphere on the shared layer', () => {
    const { rerender, props } = renderPlayer({ projection: '360-tb' });
    const [left, right] = spheres();
    expect(left.geometry.params!.phiLength).toBeCloseTo(Math.PI * 2);
    expect(left.geometry.params!.phiStart).toBeCloseTo(Math.PI / 2);
    expect(uvs(left, 'y')).toEqual([0.5, 0.5, 1, 1]);
    expect(uvs(right, 'y')).toEqual([0, 0, 0.5, 0.5]);
    expect(uvs(left, 'x')).toEqual([0, 1, 0, 1]);

    rerender(<VRVideoPlayer {...props} projection="180-mono" />);
    const [mono] = spheres();
    expect(spheres()).toHaveLength(1);
    expect(mono.layers.mask).toBe(1);
    expect(mono.geometry.params!.phiLength).toBeCloseTo(Math.PI);
    expect(mono.geometry.attributes!.uv.needsUpdate).toBe(false);
    expect(uvs(mono, 'x')).toEqual([0, 1, 0, 1]);
    // The old pair was taken down and freed
    expect(left.geometry.dispose).toHaveBeenCalledTimes(1);
    expect(right.material.dispose).toHaveBeenCalledTimes(1);
    expect(scene().children).not.toContain(left);
  });

  it('a flat video is a plane straight ahead, fitted to the view, with the camera pinned', () => {
    const video = makeVideo();
    const { container, rerender, props } = renderPlayer({ video, projection: 'flat' });
    expect(spheres()).toHaveLength(0);
    const plane = flatPlane()!;
    expect(plane.geometry.width).toBe(1);
    expect(plane.position.z).toBe(-30);
    expect(plane.layers.mask).toBe(1);
    expect(controls().reset).toHaveBeenCalledTimes(1);
    expect(controls().enabled).toBe(false);
    expect(container.querySelector('.cursor-grab')).toBeNull();
    // Sized for 16:9 until the metadata says otherwise, then refitted
    const before = { x: plane.scale.x, y: plane.scale.y };
    expect(before.x / before.y).toBeCloseTo(16 / 9);
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1000 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 500 });
    fireEvent(video, new Event('loadedmetadata'));
    expect(plane.scale.x / plane.scale.y).toBeCloseTo(2);
    expect(plane.scale.z).toBe(1);
    // The loop skips the drag controls while they are off
    act(() => { renderer().loop!(); });
    expect(controls().update).not.toHaveBeenCalled();
    // Back to a sphere: the plane goes, the controls come back
    rerender(<VRVideoPlayer {...props} projection="360-mono" />);
    expect(flatPlane()).toBeNull();
    expect(plane.geometry.dispose).toHaveBeenCalledTimes(1);
    expect(controls().enabled).toBe(true);
    expect(spheres()).toHaveLength(1);
    expect(container.querySelector('.cursor-grab')).not.toBeNull();
  });

  it('a new video element rebuilds the whole scene', () => {
    const { rerender, props } = renderPlayer();
    const first = renderer();
    rerender(<VRVideoPlayer {...props} video={makeVideo()} />);
    expect(made.renderers).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(first.loop).toBeNull();
    expect(renderer()).not.toBe(first);
    // The spheres are built into the new scene, not left behind with the old one
    expect(spheres()).toHaveLength(2);
    expect(spheres()[0].material.map).toBe(last(made.videoTextures));
  });

  it('unmounting frees everything and ends a headset session that is still open', () => {
    const { unmount, container } = renderPlayer();
    const r = renderer();
    const end = vi.fn().mockResolvedValue(undefined);
    r.xr.session = { end };
    const [left, right] = spheres();
    const c = controls();
    unmount();
    expect(r.loop).toBeNull();
    expect(end).toHaveBeenCalledTimes(1);
    expect(c.dispose).toHaveBeenCalledTimes(1);
    expect(left.geometry.dispose).toHaveBeenCalledTimes(1);
    expect(right.material.dispose).toHaveBeenCalledTimes(1);
    expect(subPlane().geometry.dispose).toHaveBeenCalledTimes(1);
    expect(last<Texture>(made.videoTextures).dispose).toHaveBeenCalledTimes(1);
    expect(last<Texture>(made.canvasTextures).dispose).toHaveBeenCalledTimes(1);
    expect(r.dispose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('canvas')).toBeNull();
  });
});

describe('VRVideoPlayer - subtitles on a plane', () => {
  it('the plane is hidden without a cue and drawn in front of the camera with one', () => {
    const { rerender, props } = renderPlayer();
    const plane = subPlane();
    expect(plane.visible).toBe(false);
    expect(plane.position.z).toBe(-20);
    rerender(<VRVideoPlayer {...props} subtitle="  Hello there  " />);
    expect(plane.visible).toBe(true);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 1024, 320);
    expect(ctx.strokeText).toHaveBeenCalledWith('Hello there', 512, 160);
    expect(ctx.fillText).toHaveBeenCalledWith('Hello there', 512, 160);
    expect(ctx.font).toContain('52px');
    expect(last<Texture>(made.canvasTextures).needsUpdate).toBe(true);
    rerender(<VRVideoPlayer {...props} subtitle="" />);
    expect(plane.visible).toBe(false);
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });

  it('a long cue is wrapped onto several lines, smaller past three', () => {
    const { rerender, props } = renderPlayer();
    rerender(<VRVideoPlayer {...props} subtitle={'word '.repeat(40).trim()} />);
    const lines = ctx.fillText.mock.calls.map(c => c[0] as string);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every(l => l.length <= 42)).toBe(true);
    expect(ctx.font).toContain('40px');
    const ys = ctx.fillText.mock.calls.map(c => c[2] as number);
    expect(ys[1] - ys[0]).toBeCloseTo(50);     // 40px * 1.25
  });

  it('survives a canvas without a 2d context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { rerender, props } = renderPlayer();
    rerender(<VRVideoPlayer {...props} subtitle="x" />);
    expect(subPlane().visible).toBe(true);
  });
});

describe('VRVideoPlayer - overlay controls', () => {
  it('mirrors play/pause, the clock and the seek bar of the shared element', () => {
    const { video } = renderPlayer();
    expect(screen.getByTitle('Play (space)')).toBeInTheDocument();
    expect(screen.getByText('0:00 / 2:05')).toBeInTheDocument();
    const seek = screen.getByLabelText('Seek') as HTMLInputElement;
    expect(seek.max).toBe('125');

    fireEvent.click(screen.getByTitle('Play (space)'));
    expect(video.play).toHaveBeenCalledTimes(1);
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent(video, new Event('play'));
    expect(screen.getByTitle('Pause (space)')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Pause (space)'));
    expect(video.pause).toHaveBeenCalledTimes(1);
    fireEvent(video, new Event('pause'));
    expect(screen.getByTitle('Play (space)')).toBeInTheDocument();

    video.currentTime = 65;
    fireEvent(video, new Event('timeupdate'));
    expect(screen.getByText('1:05 / 2:05')).toBeInTheDocument();
    expect(seek.value).toBe('65');
    fireEvent.change(seek, { target: { value: '30' } });
    expect(video.currentTime).toBe(30);
  });

  it('starts in the playing state when the element already plays, and shows hours when there are any', () => {
    const video = makeVideo(3661);
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    video.currentTime = 3600;
    renderPlayer({ video });
    expect(screen.getByTitle('Pause (space)')).toBeInTheDocument();
    expect(screen.getByText('1:00:00 / 1:01:01')).toBeInTheDocument();
  });

  it('a duration that arrives later updates the clock and the bar', () => {
    const video = makeVideo(NaN);
    renderPlayer({ video });
    expect(screen.getByText('0:00 / 0:00')).toBeInTheDocument();
    expect((screen.getByLabelText('Seek') as HTMLInputElement).max).toBe('0');
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 90 });
    fireEvent(video, new Event('loadedmetadata'));
    expect(screen.getByText('0:00 / 1:30')).toBeInTheDocument();
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 100 });
    fireEvent(video, new Event('durationchange'));
    expect(screen.getByText('0:00 / 1:40')).toBeInTheDocument();
  });

  it('double-clicking the picture toggles playback', () => {
    const { video, container } = renderPlayer();
    fireEvent.doubleClick(container.querySelector('.cursor-grab')!);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('space / k toggle, the arrows seek five seconds within the clip, and a form field keeps its keys', () => {
    const { video } = renderPlayer();
    video.currentTime = 3;
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(video.currentTime).toBe(0);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(video.currentTime).toBe(5);
    video.currentTime = 123;
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(video.currentTime).toBe(125);
    fireEvent.keyDown(window, { key: ' ' });
    expect(video.play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'k' });
    expect(video.play).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByLabelText('Seek'), { key: ' ' });
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('mute, the volume slider and M follow and drive the element', () => {
    const { video } = renderPlayer();
    expect(screen.getByTitle('Mute (M)')).toBeInTheDocument();
    const slider = screen.getByLabelText('Volume') as HTMLInputElement;
    expect(slider.value).toBe('1');
    fireEvent.click(screen.getByLabelText('Mute'));
    expect(video.muted).toBe(true);
    fireEvent(video, new Event('volumechange'));
    expect(screen.getByTitle('Unmute (M)')).toBeInTheDocument();
    expect(slider.value).toBe('0');
    // Dragging the slider up unmutes
    fireEvent.change(slider, { target: { value: '0.3' } });
    expect(video.volume).toBeCloseTo(0.3);
    expect(video.muted).toBe(false);
    fireEvent(video, new Event('volumechange'));
    expect(slider.value).toBe('0.3');
    expect(screen.getByTitle('Mute (M)').querySelector('svg')).toHaveClass('lucide-volume-1');
    fireEvent.keyDown(window, { key: 'm' });
    expect(video.muted).toBe(true);
    fireEvent.keyDown(window, { key: 'M' });
    expect(video.muted).toBe(false);
    fireEvent.change(slider, { target: { value: '0' } });
    fireEvent(video, new Event('volumechange'));
    expect(screen.getByTitle('Unmute (M)').querySelector('svg')).toHaveClass('lucide-volume-x');
  });

  it('the speed picker sets the rate, and shows an odd rate the element already has', () => {
    const { video } = renderPlayer();
    const select = screen.getByLabelText('Playback speed') as HTMLSelectElement;
    expect(select.value).toBe('1');
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×']);
    fireEvent.change(select, { target: { value: '1.5' } });
    expect(video.playbackRate).toBe(1.5);
    fireEvent(video, new Event('ratechange'));
    expect(select.value).toBe('1.5');
    video.playbackRate = 3;
    fireEvent(video, new Event('ratechange'));
    expect(select.value).toBe('3');
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×', '3×']);
    fireEvent.keyDown(select, { key: ' ' });
    expect(video.play).not.toHaveBeenCalled();
  });

  it('the fullscreen button only mirrors the parent player', () => {
    const { rerender, props } = renderPlayer();
    expect(screen.queryByTitle(/ullscreen/)).toBeNull();
    const onToggleFullscreen = vi.fn();
    rerender(<VRVideoPlayer {...props} onToggleFullscreen={onToggleFullscreen} />);
    fireEvent.click(screen.getByTitle('Fullscreen (F)'));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
    rerender(<VRVideoPlayer {...props} onToggleFullscreen={onToggleFullscreen} fullscreen />);
    expect(screen.getByTitle('Exit fullscreen (F)')).toBeInTheDocument();
  });
});

describe('VRVideoPlayer - the headset', () => {
  it('offers no headset button without WebXR, or when immersive VR is not supported', async () => {
    renderPlayer();
    expect(screen.queryByTitle('Watch in the headset')).toBeNull();
    const { xr } = stubXr(false);
    renderPlayer();
    await act(async () => { await Promise.resolve(); });
    expect(xr.isSessionSupported).toHaveBeenCalledWith('immersive-vr');
    expect(screen.queryByTitle('Watch in the headset')).toBeNull();
  });

  it('enters a session on the renderer, starts playback, and leaves it again', async () => {
    const { xr, session, listeners } = stubXr(true);
    const { video } = renderPlayer();
    const button = await screen.findByTitle('Watch in the headset');
    await act(async () => { fireEvent.click(button); });
    expect(xr.requestSession).toHaveBeenCalledWith('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    expect(renderer().xr.setSession).toHaveBeenCalledWith(session);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('Leave the headset')).toHaveClass('text-cyan-400');

    fireEvent.click(screen.getByTitle('Leave the headset'));
    expect(session.end).toHaveBeenCalledTimes(1);
    act(() => { listeners.end(); });
    expect(screen.getByTitle('Watch in the headset')).toBeInTheDocument();
  });

  it('a refused session is logged and leaves the button as it was', async () => {
    const { xr } = stubXr(true);
    xr.requestSession.mockRejectedValue(new Error('No headset'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPlayer();
    const button = await screen.findByTitle('Watch in the headset');
    await act(async () => { fireEvent.click(button); });
    expect(error).toHaveBeenCalledWith('Could not start the VR session:', expect.any(Error));
    expect(screen.getByTitle('Watch in the headset')).toBeInTheDocument();
    expect(renderer().xr.setSession).not.toHaveBeenCalled();
  });

  it('a support answer that lands after unmount is dropped', async () => {
    const { xr } = stubXr(true);
    let resolve!: (v: boolean) => void;
    xr.isSessionSupported.mockReturnValue(new Promise<boolean>(r => { resolve = r; }));
    const { unmount } = renderPlayer();
    unmount();
    await act(async () => { resolve(true); await Promise.resolve(); });
    expect(screen.queryByTitle('Watch in the headset')).toBeNull();
  });
});
