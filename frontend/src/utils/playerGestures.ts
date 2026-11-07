// Touch (and mouse) gestures on the video picture, as pure decisions so the
// renderer only has to wire pointer events to them:
//
// - a double tap on the left third seeks back, on the right third forward,
//   in the middle toggles playback;
// - a vertical swipe that starts on the right third sets the volume (the
//   drag controls are switched off for its duration so it doesn't also tilt
//   a sphere; a horizontal one there still rotates);
// - the wheel, or a two-finger pinch, zooms a VR video by narrowing the
//   camera's field of view - the camera sits at the sphere's centre, so
//   moving it (what OrbitControls' dolly does) would be wrong.

export const SEEK_STEP = 5;

export type TapZone = 'back' | 'toggle' | 'forward';

/** Which third of the picture a point is in. */
export function tapZone(x: number, width: number): TapZone {
  if (width <= 0) return 'toggle';
  if (x < width / 3) return 'back';
  if (x > (width * 2) / 3) return 'forward';
  return 'toggle';
}

/** Where a volume swipe may start: the right third. */
export const inVolumeZone = (x: number, width: number) => tapZone(x, width) === 'forward';

export const SWIPE_THRESHOLD = 10;

/** The direction of a drag once it has moved far enough to be one; null until then. */
export function swipeDirection(dx: number, dy: number, threshold = SWIPE_THRESHOLD): 'vertical' | 'horizontal' | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < threshold) return null;
  return ay > ax ? 'vertical' : 'horizontal';
}

/**
 * Volume after dragging `dy` pixels (down is positive) from `start`: a swipe
 * over `range` pixels (half the picture's height) sweeps the whole 0..1.
 */
export function swipeVolume(start: number, dy: number, range: number): number {
  const span = range > 0 ? range : 1;
  return Math.min(1, Math.max(0, start - dy / span));
}

export const MIN_FOV = 30;
export const MAX_FOV = 110;
const clampFov = (fov: number) => Math.min(MAX_FOV, Math.max(MIN_FOV, fov));

/** Wheel: scrolling up (negative deltaY) narrows the view - zooms in. */
export function wheelFov(fov: number, deltaY: number): number {
  return clampFov(fov + deltaY * 0.05);
}

/** Pinch: fingers moving apart (dist > startDist) zoom in. */
export function pinchFov(startFov: number, startDist: number, dist: number): number {
  if (!(startDist > 0) || !(dist > 0)) return clampFov(startFov);
  return clampFov((startFov * startDist) / dist);
}

/** Zoom factor to show for a field of view, relative to the normal one. */
export const zoomFactor = (fov: number, base: number) => base / fov;

export interface TapOptions {
  /** A press longer than this is a hold, not a tap. */
  maxPress?: number;
  /** Fingers wander; a tap may move this far. */
  maxMove?: number;
  /** Two taps closer in time than this - and in place - are a double tap. */
  maxDelay?: number;
  maxGap?: number;
}

/**
 * Double taps from raw pointer downs/ups, pointer-type agnostic: the browser's
 * `dblclick` is unreliable on a touch screen (and never fires on some), and a
 * double tap must not also count as two single ones.
 */
export class TapDetector {
  private down: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;
  private lastTap: { x: number; y: number; t: number } | null = null;
  private readonly maxPress: number;
  private readonly maxMove: number;
  private readonly maxDelay: number;
  private readonly maxGap: number;

  constructor({ maxPress = 300, maxMove = 12, maxDelay = 350, maxGap = 40 }: TapOptions = {}) {
    this.maxPress = maxPress;
    this.maxMove = maxMove;
    this.maxDelay = maxDelay;
    this.maxGap = maxGap;
  }

  start(id: number, x: number, y: number, t: number) {
    // A second finger down is never a tap.
    if (this.down) { this.down = null; this.lastTap = null; return; }
    this.down = { id, x, y, t, moved: false };
  }

  move(id: number, x: number, y: number) {
    const d = this.down;
    if (!d || d.id !== id || d.moved) return;
    if (Math.hypot(x - d.x, y - d.y) > this.maxMove) d.moved = true;
  }

  /** Returns 'double' on the second tap of a pair, 'tap' on a lone one, null for anything else. */
  end(id: number, x: number, y: number, t: number): 'tap' | 'double' | null {
    const d = this.down;
    this.down = null;
    if (!d || d.id !== id) return null;
    if (d.moved || t - d.t > this.maxPress) { this.lastTap = null; return null; }
    const prev = this.lastTap;
    if (prev && t - prev.t <= this.maxDelay && Math.hypot(x - prev.x, y - prev.y) <= this.maxGap) {
      this.lastTap = null;
      return 'double';
    }
    this.lastTap = { x, y, t };
    return 'tap';
  }

  cancel() {
    this.down = null;
    this.lastTap = null;
  }
}
