import { describe, it, expect } from 'vitest';
import {
  tapZone, inVolumeZone, swipeDirection, swipeVolume, wheelFov, pinchFov, zoomFactor, TapDetector,
  MIN_FOV, MAX_FOV,
} from './playerGestures';

describe('tap zones', () => {
  it('splits the picture into thirds: back, toggle, forward', () => {
    expect(tapZone(10, 300)).toBe('back');
    expect(tapZone(150, 300)).toBe('toggle');
    expect(tapZone(290, 300)).toBe('forward');
    expect(tapZone(100, 300)).toBe('toggle');   // the boundaries belong to the middle
    expect(tapZone(200, 300)).toBe('toggle');
    expect(tapZone(5, 0)).toBe('toggle');       // no width yet: never seek by accident
  });

  it('a volume swipe may only start on the right third', () => {
    expect(inVolumeZone(290, 300)).toBe(true);
    expect(inVolumeZone(150, 300)).toBe(false);
  });
});

describe('swipes', () => {
  it('is nothing until it has moved, then the dominant axis', () => {
    expect(swipeDirection(3, 4)).toBeNull();
    expect(swipeDirection(0, -20)).toBe('vertical');
    expect(swipeDirection(20, 5)).toBe('horizontal');
    expect(swipeDirection(10, 10)).toBe('horizontal');   // a tie is a rotate, not a volume change
  });

  it('a swipe up raises the volume, down lowers it, over half the picture for the full range', () => {
    expect(swipeVolume(0.5, -50, 100)).toBeCloseTo(1);
    expect(swipeVolume(0.5, 25, 100)).toBeCloseTo(0.25);
    expect(swipeVolume(0.9, -80, 100)).toBe(1);
    expect(swipeVolume(0.1, 80, 100)).toBe(0);
    expect(swipeVolume(0.5, -10, 0)).toBeCloseTo(1);     // a zero range never divides by zero
  });
});

describe('zoom', () => {
  it('the wheel narrows the view scrolling up and widens it scrolling down, within limits', () => {
    expect(wheelFov(75, -100)).toBe(70);
    expect(wheelFov(75, 100)).toBe(80);
    expect(wheelFov(32, -100)).toBe(MIN_FOV);
    expect(wheelFov(108, 100)).toBe(MAX_FOV);
  });

  it('a pinch scales the view by the finger distance, clamped, and ignores a degenerate pinch', () => {
    expect(pinchFov(75, 100, 200)).toBe(37.5);
    expect(pinchFov(75, 100, 50)).toBe(MAX_FOV);
    expect(pinchFov(75, 0, 50)).toBe(75);
    expect(pinchFov(75, 100, 0)).toBe(75);
  });

  it('reports the zoom as a factor of the normal view', () => {
    expect(zoomFactor(37.5, 75)).toBe(2);
    expect(zoomFactor(75, 75)).toBe(1);
  });
});

describe('TapDetector', () => {
  it('two quick taps in place are a double; the first reports as a tap', () => {
    const d = new TapDetector();
    d.start(1, 10, 10, 0);
    expect(d.end(1, 10, 10, 100)).toBe('tap');
    d.start(1, 15, 12, 250);
    expect(d.end(1, 15, 12, 330)).toBe('double');
    // The pair is consumed: a third tap starts over
    d.start(1, 15, 12, 400);
    expect(d.end(1, 15, 12, 450)).toBe('tap');
  });

  it('a slow second tap, or one somewhere else, is a new first tap', () => {
    const d = new TapDetector();
    d.start(1, 10, 10, 0); d.end(1, 10, 10, 50);
    d.start(1, 10, 10, 600);
    expect(d.end(1, 10, 10, 650)).toBe('tap');
    d.start(1, 200, 10, 700);
    expect(d.end(1, 200, 10, 750)).toBe('tap');
  });

  it('a drag, a long press or a second finger is not a tap and breaks a pair', () => {
    const d = new TapDetector();
    d.start(1, 10, 10, 0);
    d.move(1, 40, 10);
    expect(d.end(1, 40, 10, 100)).toBeNull();
    d.start(1, 10, 10, 200);
    expect(d.end(1, 10, 10, 700)).toBeNull();
    d.start(1, 10, 10, 800); d.end(1, 10, 10, 850);
    d.start(1, 10, 10, 900);
    d.start(2, 50, 50, 910);
    expect(d.end(1, 10, 10, 950)).toBeNull();
    expect(d.end(2, 50, 50, 960)).toBeNull();
  });

  it('ignores an up for a pointer it never saw go down, and cancel clears everything', () => {
    const d = new TapDetector();
    expect(d.end(7, 0, 0, 10)).toBeNull();
    d.start(1, 10, 10, 0); d.end(1, 10, 10, 50);
    d.cancel();
    d.start(1, 10, 10, 100);
    expect(d.end(1, 10, 10, 150)).toBe('tap');
  });
});
