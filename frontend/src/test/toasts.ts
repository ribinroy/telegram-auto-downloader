import { subscribeNotifications, dismissNotification } from '../lib/notify';
import type { ToastData } from '../components/Toast';

// The notification store is module-level and shared by every test in a file,
// so a test records only what is raised after it subscribes, and clears its
// own toasts when it is done. (A component's useErrorToast calls notify()
// through the module's own binding, which a vi.mock of lib/notify would not
// intercept - hence listening to the real store.)
export function captureToasts() {
  const toasts: ToastData[] = [];
  const known = new Set<string>();
  let first = true;
  const unsubscribe = subscribeNotifications(list => {
    for (const t of list) {
      if (known.has(t.id)) continue;
      known.add(t.id);
      if (!first) toasts.push(t);
    }
    first = false;
  });
  return {
    toasts,
    titles: () => toasts.map(t => t.title),
    stop: () => { unsubscribe(); toasts.forEach(t => dismissNotification(t.id)); },
  };
}
