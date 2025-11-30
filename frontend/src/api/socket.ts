import { io, Socket } from 'socket.io-client';
import type { DownloadsResponse } from '../types';

const API_BASE = 'http://192.168.0.135:4444';

let socket: Socket | null = null;

export function connectSocket(onUpdate: (data: DownloadsResponse) => void): Socket {
  if (socket?.connected) {
    return socket;
  }

  socket = io(API_BASE, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('WebSocket connected');
  });

  socket.on('disconnect', () => {
    console.log('WebSocket disconnected');
  });

  // Listen for real-time updates only
  socket.on('downloads_update', (data: DownloadsResponse) => {
    onUpdate(data);
  });

  socket.on('connect_error', (error) => {
    console.error('WebSocket connection error:', error);
  });

  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
