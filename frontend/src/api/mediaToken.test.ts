import { describe, it, expect } from 'vitest';
import { jwtExpiryMs, mediaTokenStale } from './index';

const jwt = (payload: object) =>
  `h.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

describe('media token freshness', () => {
  it('reads exp from the payload', () => {
    expect(jwtExpiryMs(jwt({ exp: 1000 }))).toBe(1_000_000);
    expect(jwtExpiryMs('garbage')).toBeNull();
  });
  it('treats a missing, unreadable or expired token as stale', () => {
    const now = 2_000_000;
    expect(mediaTokenStale(null, now)).toBe(true);
    expect(mediaTokenStale('garbage', now)).toBe(true);
    expect(mediaTokenStale(jwt({ exp: 1000 }), now)).toBe(true);
    expect(mediaTokenStale(jwt({ exp: 3000 }), now)).toBe(false);
  });
  it('re-mints inside the margin before expiry', () => {
    expect(mediaTokenStale(jwt({ exp: 2100 }), 2_000_000, 200_000)).toBe(true);
  });
});
