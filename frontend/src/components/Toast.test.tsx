import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastContainer, type ToastData } from './Toast';

const toast = (over: Partial<ToastData> = {}): ToastData =>
  ({ id: 't1', type: 'success', title: 'Download Complete', message: 'clip.mkv', ...over });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ToastContainer', () => {
  it('renders each toast as an alert with its title and message', () => {
    render(<ToastContainer toasts={[toast(), toast({ id: 't2', type: 'error', title: 'Delete failed', message: undefined })]} onDismiss={() => {}} />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Download Complete');
    expect(alerts[0]).toHaveTextContent('clip.mkv');
    expect(alerts[1]).toHaveTextContent('Delete failed');
  });

  it('auto-dismisses after its duration (default 4s) plus the exit animation', () => {
    const onDismiss = vi.fn();
    render(<ToastContainer toasts={[toast()]} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(3_999); });
    expect(screen.getByRole('alert')).toHaveClass('opacity-100');
    act(() => { vi.advanceTimersByTime(1); });
    // Fading out, not yet gone
    expect(screen.getByRole('alert')).toHaveClass('opacity-0');
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('honours a custom duration', () => {
    const onDismiss = vi.fn();
    render(<ToastContainer toasts={[toast({ duration: 7_000 })]} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(4_300); });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('the X button dismisses at once (after the fade)', () => {
    const onDismiss = vi.fn();
    render(<ToastContainer toasts={[toast()]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('Dismiss notification'));
    expect(screen.getByRole('alert')).toHaveClass('opacity-0');
    act(() => { vi.advanceTimersByTime(300); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('a clickable toast runs its action and dismisses; a plain one ignores body clicks', () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(<ToastContainer toasts={[toast({ onClick }), toast({ id: 't2', title: 'Plain' })]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText('Download Complete'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Download Complete').closest('div.cursor-pointer')).not.toBeNull();
    fireEvent.click(screen.getByText('Plain'));
    act(() => { vi.advanceTimersByTime(300); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('cancels its timer when unmounted early', () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<ToastContainer toasts={[toast()]} onDismiss={onDismiss} />);
    unmount();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
