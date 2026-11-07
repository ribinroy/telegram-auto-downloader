import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { notify, dismissNotification, subscribeNotifications, useToast, useErrorToast, useSuccessToast } from './notify';
import type { ToastData } from '../components/Toast';

/** The stack as the store holds it right now. */
function currentToasts(): ToastData[] {
  let seen: ToastData[] = [];
  subscribeNotifications(t => { seen = t; })();
  return seen;
}

afterEach(() => {
  // The store is module-level; leave it empty for the next test.
  currentToasts().forEach(t => dismissNotification(t.id));
});

describe('the notification store', () => {
  it('hands a new subscriber the current stack at once', () => {
    notify({ type: 'info', title: 'Hello' });
    const listener = vi.fn();
    subscribeNotifications(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject([{ type: 'info', title: 'Hello' }]);
  });

  it('gives every toast its own id and publishes each change', () => {
    const listener = vi.fn();
    subscribeNotifications(listener);
    const a = notify({ type: 'success', title: 'Moved to trash', message: '3 items' });
    const b = notify({ type: 'error', title: 'Delete failed' });
    expect(a).not.toBe(b);
    expect(currentToasts().map(t => t.id)).toEqual([a, b]);
    expect(currentToasts()[0]).toEqual({ id: a, type: 'success', title: 'Moved to trash', message: '3 items' });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('dismisses one toast and leaves the rest', () => {
    const a = notify({ type: 'info', title: 'A' });
    const b = notify({ type: 'info', title: 'B' });
    dismissNotification(a);
    expect(currentToasts().map(t => t.id)).toEqual([b]);
    dismissNotification('never-existed');
    expect(currentToasts().map(t => t.id)).toEqual([b]);
  });

  it('stops telling a listener that unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotifications(listener);
    unsubscribe();
    notify({ type: 'info', title: 'late' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('useToast', () => {
  it('mirrors the stack for the one container and exposes add/dismiss', () => {
    const { result } = renderHook(() => useToast());
    expect(result.current.toasts).toEqual([]);
    let id = '';
    act(() => { id = result.current.addToast({ type: 'warning', title: 'Careful' }); });
    expect(result.current.toasts).toMatchObject([{ id, title: 'Careful' }]);
    act(() => result.current.dismissToast(id));
    expect(result.current.toasts).toEqual([]);
  });

  it('unsubscribes on unmount', () => {
    const { result, unmount } = renderHook(() => useToast());
    unmount();
    act(() => { notify({ type: 'info', title: 'after' }); });
    expect(result.current.toasts).toEqual([]);
  });
});

describe('useErrorToast', () => {
  const render = (initial: unknown) =>
    renderHook(({ error }: { error: unknown }) => useErrorToast(error, 'Load failed'), { initialProps: { error: initial } });

  it('does nothing while there is no error', () => {
    const { rerender } = render(null);
    rerender({ error: undefined });
    rerender({ error: '' });
    expect(currentToasts()).toEqual([]);
  });

  it('toasts once when the error appears, not again on every render', () => {
    const { rerender } = render(null);
    rerender({ error: 'Failed to fetch' });
    rerender({ error: 'Failed to fetch' });
    rerender({ error: new Error('Failed to fetch') });
    expect(currentToasts()).toMatchObject([{ type: 'error', title: 'Load failed', message: 'Failed to fetch', duration: 7000 }]);
  });

  it('toasts again when the message changes', () => {
    const { rerender } = render('first');
    rerender({ error: 'second' });
    expect(currentToasts().map(t => t.message)).toEqual(['first', 'second']);
  });

  it('toasts again after a reset to the same error', () => {
    const { rerender } = render('boom');
    rerender({ error: null });
    rerender({ error: 'boom' });
    expect(currentToasts().map(t => t.message)).toEqual(['boom', 'boom']);
  });

  it('reads the message of an Error and stringifies anything else', () => {
    const { rerender } = render(new Error('disk full'));
    rerender({ error: 404 });
    expect(currentToasts().map(t => t.message)).toEqual(['disk full', '404']);
  });
});

describe('useSuccessToast', () => {
  it('shows a shorter success toast, title-only for `true`', () => {
    const { rerender } = renderHook(
      ({ ok }: { ok: unknown }) => useSuccessToast(ok, 'Saved'),
      { initialProps: { ok: false as unknown } },
    );
    rerender({ ok: true });
    expect(currentToasts()).toEqual([expect.objectContaining({ type: 'success', title: 'Saved', duration: 4000 })]);
    expect(currentToasts()[0]).not.toHaveProperty('message', expect.anything());
    rerender({ ok: 'Settings written' });
    expect(currentToasts()[1]).toMatchObject({ type: 'success', title: 'Saved', message: 'Settings written' });
  });
});
