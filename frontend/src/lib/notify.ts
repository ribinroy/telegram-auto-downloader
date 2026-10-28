import { useEffect, useRef, useState } from 'react';
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

function messageOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  return value === true ? '' : String(value);
}

/** Raise a toast when `value` turns truthy or changes to a different message
 *  - not on every render, and not on every failed poll repeating the same
 *  error. A later failure after a reset (value back to null) toasts again. */
function useToastWhenSet(value: unknown, type: ToastData['type'], title: string) {
  const last = useRef<string | null>(null);
  const message = messageOf(value);
  useEffect(() => {
    if (message !== null && message !== last.current) {
      notify({ type, title, message: message || undefined, duration: type === 'error' ? 7000 : 4000 });
    }
    last.current = message;
  }, [message, type, title]);
}

/** Show an error (string, Error or null) as a toast instead of a row. The
 *  component keeps its error state - logic may read it - and drops the row. */
export function useErrorToast(error: unknown, title: string) {
  useToastWhenSet(error, 'error', title);
}

/** Same for a success message, or `true` for a title-only toast. */
export function useSuccessToast(success: unknown, title: string) {
  useToastWhenSet(success, 'success', title);
}
