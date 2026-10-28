import { useEffect, useState } from 'react';
import type { ToastData } from '../components/Toast';

// One app-wide notification stack. A module-level store rather than React
// context, so anything can raise one - a page, a modal rendered in a portal,
// a mutation callback - without threading a callback down to it. Layout
// mounts the single ToastContainer that renders the stack.

type Listener = (toasts: ToastData[]) => void;

let toasts: ToastData[] = [];
const listeners = new Set<Listener>();

const publish = () => listeners.forEach(l => l(toasts));

/** Show a floating notification. Returns its id. */
export function notify(toast: Omit<ToastData, 'id'>): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  toasts = [...toasts, { ...toast, id }];
  publish();
  return id;
}

export function dismissNotification(id: string) {
  toasts = toasts.filter(t => t.id !== id);
  publish();
}

export function subscribeNotifications(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => { listeners.delete(listener); };
}

/** The stack, for the one ToastContainer (Layout). Anything else just calls
 *  notify(). */
export function useToast() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  useEffect(() => subscribeNotifications(setToasts), []);
  return { toasts, addToast: notify, dismissToast: dismissNotification };
}
