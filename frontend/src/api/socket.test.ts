import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A stand-in for a socket.io-client Socket: records listeners and lets a test
// fire server events. Hoisted so the mock factory below can construct it.
const { FakeSocket, sockets } = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class FakeSocket {
    connected = false;
    handlers = new Map<string, Handler>();
    disconnect = vi.fn(() => { this.connected = false; });
    on(event: string, handler: Handler) { this.handlers.set(event, handler); return this; }
    fire(event: string, ...args: unknown[]) { this.handlers.get(event)?.(...args); }
  }
  return { FakeSocket, sockets: [] as InstanceType<typeof FakeSocket>[] };
});

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => { const s = new FakeSocket(); sockets.push(s); return s; }),
}));

import { io } from 'socket.io-client';
import { connectSocket, disconnectSocket, type SocketHandlers } from './socket';

const handlers = (): SocketHandlers => ({
  onProgress: vi.fn(), onStatus: vi.fn(), onNew: vi.fn(), onDeleted: vi.fn(), onMeta: vi.fn(),
  onStats: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(),
});
const last = () => sockets[sockets.length - 1];

beforeEach(() => {
  sockets.length = 0;
  vi.mocked(io).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => disconnectSocket());

describe('connectSocket', () => {
  it('opens one socket to the API with reconnection on', () => {
    connectSocket(handlers());
    expect(io).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(io).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toMatch(/^https?:\/\//);
    expect(options).toMatchObject({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1000 });
  });

  it('routes each server event to its handler', () => {
    const h = handlers();
    connectSocket(h);
    const s = last();
    const progress = { message_id: '1', progress: 50, downloaded_bytes: 5, total_bytes: 10, speed: 1, pending_time: null };
    s.fire('download:progress', progress);
    expect(h.onProgress).toHaveBeenCalledWith(progress);
    s.fire('download:status', { message_id: '1', status: 'done' });
    expect(h.onStatus).toHaveBeenCalledWith({ message_id: '1', status: 'done' });
    s.fire('download:new', { id: 1 });
    expect(h.onNew).toHaveBeenCalledWith({ id: 1 });
    s.fire('download:deleted', { message_id: '1' });
    expect(h.onDeleted).toHaveBeenCalledWith({ message_id: '1' });
    s.fire('download:meta', { message_id: '1', file_meta: null });
    expect(h.onMeta).toHaveBeenCalledWith({ message_id: '1', file_meta: null });
    s.fire('stats', { total: 1 });
    expect(h.onStats).toHaveBeenCalledWith({ total: 1 });
    s.fire('connect');
    expect(h.onConnect).toHaveBeenCalledTimes(1);
    s.fire('disconnect');
    expect(h.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('listens for file counts and queue changes only when asked to', () => {
    connectSocket(handlers());
    expect(last().handlers.has('download:files')).toBe(false);
    expect(last().handlers.has('queue:changed')).toBe(false);
    disconnectSocket();

    const h = { ...handlers(), onFileCount: vi.fn(), onQueueChanged: vi.fn() };
    connectSocket(h);
    last().fire('download:files', { message_id: '1', file_count: 3 });
    expect(h.onFileCount).toHaveBeenCalledWith({ message_id: '1', file_count: 3 });
    last().fire('queue:changed');
    expect(h.onQueueChanged).toHaveBeenCalledTimes(1);
  });

  it('logs a connection error instead of throwing', () => {
    connectSocket(handlers());
    expect(() => last().fire('connect_error', new Error('refused'))).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('WebSocket connection error:', expect.any(Error));
  });

  it('reuses a connected socket rather than opening a second one', () => {
    const first = connectSocket(handlers());
    last().connected = true;
    const second = connectSocket(handlers());
    expect(second).toBe(first);
    expect(io).toHaveBeenCalledTimes(1);
  });

  it('opens a new socket when the previous one is not connected', () => {
    connectSocket(handlers());
    connectSocket(handlers());
    expect(io).toHaveBeenCalledTimes(2);
  });
});

describe('disconnectSocket', () => {
  it('closes the socket and lets the next connect open a fresh one', () => {
    connectSocket(handlers());
    const s = last();
    s.connected = true;
    disconnectSocket();
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    connectSocket(handlers());
    expect(io).toHaveBeenCalledTimes(2);
  });

  it('is harmless with nothing open', () => {
    expect(() => disconnectSocket()).not.toThrow();
  });
});
