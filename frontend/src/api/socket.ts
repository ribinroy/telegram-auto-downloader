import { io, Socket } from 'socket.io-client';
import type { Download } from '../types';

const API_BASE = window.location.origin;

let socket: Socket | null = null;

export interface ProgressUpdate {
  message_id: string;  // String to avoid JS precision loss
  progress: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed: number;
  pending_time: number | null;
}

export interface StatusUpdate {
  message_id: string;  // String to avoid JS precision loss
  status: Download['status'];
  error?: string;
}

export interface DeletedUpdate {
  message_id: string;  // String to avoid JS precision loss
}

export interface SocketHandlers {
  onProgress: (data: ProgressUpdate) => void;
  onStatus: (data: StatusUpdate) => void;
  onNew: (data: Download) => void;
  onDeleted: (data: DeletedUpdate) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function connectSocket(handlers: SocketHandlers): Socket {
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
    handlers.onConnect();
  });

  socket.on('disconnect', () => {
    console.log('WebSocket disconnected');
    handlers.onDisconnect();
  });

  // Listen for specific events
  socket.on('download:progress', handlers.onProgress);
  socket.on('download:status', handlers.onStatus);
  socket.on('download:new', handlers.onNew);
  socket.on('download:deleted', handlers.onDeleted);

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
