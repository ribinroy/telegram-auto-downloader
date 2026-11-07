import { describe, it, expect } from 'vitest';
import type { MediaInfo, MediaStream } from '../api/mediaInfo';
import {
  formatClock, formatBitrate, resolutionLabel, channelsLabel, streamRows, summaryLine, fileRows, streamHeading,
} from './mediaInfo';

const stream = (over: Partial<MediaStream>): MediaStream => ({
  index: 0, type: 'video', codec: null, codec_long: null, profile: null, language: null, title: null,
  default: false, forced: false, bitrate: null, ...over,
});

const info = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  file: { name: 'a.mkv', path: '/m/a.mkv', size: 2 * 1024 ** 3, modified: 1_700_000_000 },
  container: { format: 'matroska,webm', format_long: 'Matroska / WebM', duration: 7451, bitrate: 25_000_000, tags: { title: 'Film', creation_time: '2026' } },
  streams: [stream({ codec: 'hevc', width: 3840, height: 2160, bit_depth: 10, hdr: 'HDR10 (PQ)' })],
  chapters: [],
  ...over,
});

describe('formatters', () => {
  it('formatClock reads like a clock', () => {
    expect(formatClock(7451)).toBe('2:04:11');
    expect(formatClock(247.9)).toBe('4:07');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(null)).toBe('-');
    expect(formatClock(-1)).toBe('-');
    expect(formatClock(Infinity)).toBe('-');
  });

  it('formatBitrate picks kb/s or Mb/s', () => {
    expect(formatBitrate(640_000)).toBe('640 kb/s');
    expect(formatBitrate(4_500_000)).toBe('4.5 Mb/s');
    expect(formatBitrate(25_000_000)).toBe('25 Mb/s');
    expect(formatBitrate(0)).toBeNull();
    expect(formatBitrate(null)).toBeNull();
  });

  it('resolutionLabel goes by the long side, so an SBS VR frame reads right', () => {
    expect(resolutionLabel(7680, 3840)).toBe('8K');
    expect(resolutionLabel(5760, 2880)).toBe('6K');
    expect(resolutionLabel(3840, 2160)).toBe('4K');
    expect(resolutionLabel(2560, 1440)).toBe('1440p');
    expect(resolutionLabel(1080, 1920)).toBe('1080p');     // portrait
    expect(resolutionLabel(1280, 720)).toBe('720p');
    expect(resolutionLabel(854, 480)).toBe('480p');
    expect(resolutionLabel(320, 240)).toBe('240p');
    expect(resolutionLabel(0, 240)).toBeNull();
  });

  it('channelsLabel names common layouts and falls back to the layout or a count', () => {
    expect(channelsLabel({ channels: 2 })).toBe('Stereo');
    expect(channelsLabel({ channels: 6, channel_layout: '5.1(side)' })).toBe('5.1');
    expect(channelsLabel({ channels: 3, channel_layout: '2.1' })).toBe('2.1');
    expect(channelsLabel({ channels: 4 })).toBe('4 ch');
    expect(channelsLabel({})).toBeNull();
  });
});

describe('rows', () => {
  it('a video stream lists only what it has', () => {
    const rows = streamRows(stream({
      codec: 'hevc', profile: 'Main 10', width: 3840, height: 2160, aspect: '16:9', fps: 23.976, bit_depth: 10,
      hdr: 'HDR10 (PQ)', pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'smpte2084', bitrate: 22_000_000,
    }));
    expect(Object.fromEntries(rows)).toEqual({
      Codec: 'HEVC · Main 10', Resolution: '3840 × 2160 (4K)', Aspect: '16:9', 'Frame rate': '23.976 fps',
      'Bit depth': '10-bit', HDR: 'HDR10 (PQ)', 'Pixel format': 'yuv420p10le', Color: 'bt2020 / smpte2084', Bitrate: '22 Mb/s',
    });
    expect(streamRows(stream({}))).toEqual([]);
  });

  it('audio and subtitle streams', () => {
    expect(Object.fromEntries(streamRows(stream({ type: 'audio', codec: 'eac3', channels: 6, sample_rate: 48000, language: 'eng' })))).toEqual({
      Codec: 'EAC3', Channels: '5.1', 'Sample rate': '48.0 kHz', Language: 'eng',
    });
    expect(streamRows(stream({ type: 'subtitle', codec: 'subrip', title: 'SDH' }))).toEqual([['Codec', 'SUBRIP'], ['Title', 'SDH']]);
  });

  it('summaryLine is the headline', () => {
    expect(summaryLine(info())).toBe('4K · HEVC 10-bit HDR10 (PQ) · 2:04:11 · 2.00 GB');
    // Cover art isn't the video; 8-bit isn't worth saying; missing bits drop out
    expect(summaryLine(info({
      file: { name: 'a', path: '/a', size: null, modified: null },
      container: { format: null, format_long: null, duration: null, bitrate: null, tags: {} },
      streams: [stream({ codec: 'mjpeg', width: 600, height: 600, attached_pic: true }), stream({ codec: 'h264', width: 1920, height: 1080, bit_depth: 8 })],
    }))).toBe('1080p · H264');
  });

  it('fileRows carries the container and its tags', () => {
    const rows = Object.fromEntries(fileRows(info()));
    expect(rows.Path).toBe('/m/a.mkv');
    expect(rows.Size).toMatch(/^2\.00 GB \(2,147,483,648 bytes\)$/);
    expect(rows.Container).toBe('Matroska / WebM');
    expect(rows.Duration).toBe('2:04:11');
    expect(rows['Overall bitrate']).toBe('25 Mb/s');
    expect(rows.Title).toBe('Film');
    expect(rows['Creation time']).toBe('2026');
    expect(rows.Modified).toBeTruthy();
  });

  it('streamHeading numbers within a type and adds the flags', () => {
    const a1 = stream({ index: 1, type: 'audio', default: true });
    const a2 = stream({ index: 2, type: 'audio', forced: true });
    const v = stream({ index: 0, attached_pic: true });
    const all = [v, a1, a2];
    expect(streamHeading(v, all)).toBe('Video · Cover art');
    expect(streamHeading(a1, all)).toBe('Audio 1 · Default');
    expect(streamHeading(a2, all)).toBe('Audio 2 · Forced');
    expect(streamHeading(stream({ type: 'weird' }), [])).toBe('weird');
  });
});
