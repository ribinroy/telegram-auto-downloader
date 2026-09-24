import { describe, it, expect } from 'vitest';
import { formatBytes, formatTime, formatSpeed } from './format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512.00 B'],
    [1024, '1.00 KB'],
    [1024 ** 2, '1.00 MB'],
    [1024 ** 3, '1.00 GB'],
    [1024 ** 4, '1.00 TB'],
  ])('%i -> %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe('formatTime', () => {
  it.each([
    [null, '-'],
    [0, '-'],
    [45, '45s'],
    [90, '1m 30s'],
    [3725, '1h 2m 5s'],
  ])('%s -> %s', (input, expected) => {
    expect(formatTime(input as number | null)).toBe(expected);
  });
});

describe('formatSpeed', () => {
  it('reports KB/s below a megabyte and MB/s above', () => {
    expect(formatSpeed(0)).toBe('-');
    expect(formatSpeed(500)).toBe('500.0 KB/s');
    expect(formatSpeed(2048)).toBe('2.0 MB/s');
  });
});
