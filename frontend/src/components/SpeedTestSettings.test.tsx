import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as speed from '../api/internetSpeed';
import * as browser from '../api/speedtest';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { deferred } from '../test/fixtures';
import { SpeedTestSettings } from './SpeedTestSettings';

vi.mock('../api/speedtest', () => ({ measurePing: vi.fn(), measureDownload: vi.fn(), measureUpload: vi.fn() }));
vi.mock('../api/internetSpeed', async (orig) => ({
  ...(await orig<typeof speed>()),
  fetchInternetSpeed: vi.fn(), startInternetSpeed: vi.fn(), cancelInternetSpeed: vi.fn(),
  fetchSpeedResults: vi.fn(), recordBrowserResult: vi.fn(), deleteSpeedResult: vi.fn(),
}));

const status = (over: Partial<speed.InternetStatus> = {}): speed.InternetStatus =>
  ({ phase: 'idle', live_mbps: 0, progress: 0, result: null, error: null, meta: null, ...over });

const row = (over: Partial<speed.SpeedTestRow> = {}): speed.SpeedTestRow => ({
  id: 1, kind: 'browser', at: '2026-11-05T12:00:00Z', ping: { min: 1, avg: 2.5, max: 4, jitter: 0.5 },
  download_mbps: 940, upload_mbps: 12.34, download_bytes: 1e9, upload_bytes: 1e7,
  client: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120 Safari/537.36', ip: '10.0.0.2', meta: null, ...over,
});

// The two cards, by heading
const card = (title: RegExp) => within(screen.getByRole('heading', { name: title }).closest('.rounded-lg') as HTMLElement);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(speed.fetchInternetSpeed).mockResolvedValue(status());
  vi.mocked(speed.fetchSpeedResults).mockResolvedValue([]);
});

describe('SpeedTestSettings - layout and history', () => {
  it('renders both cards and an empty history', async () => {
    renderWithClient(<SpeedTestSettings />);
    expect(screen.getByRole('heading', { name: /this device ↔ server/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /server → internet/i })).toBeInTheDocument();
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
    expect(card(/this device/i).getByText('Ready')).toBeInTheDocument();
  });

  it('lists previous runs with a readable client name, and filters by kind', async () => {
    vi.mocked(speed.fetchSpeedResults).mockResolvedValue([
      row(),
      row({ id: 2, kind: 'internet', client: 'Deutsche Telekom', ip: '1.2.3.4', download_mbps: 250, upload_mbps: 40, ping: { min: 5, avg: 6.5, max: 8, jitter: 1 } }),
    ]);
    renderWithClient(<SpeedTestSettings />);
    expect(await screen.findByText('Chrome · macOS')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.2')).toBeInTheDocument();
    expect(screen.getByText('Deutsche Telekom')).toBeInTheDocument();
    expect(screen.getByText('940 Mbit/s')).toBeInTheDocument();
    expect(screen.getByText('12.3 Mbit/s')).toBeInTheDocument();
    expect(screen.getByText('2.5 ms')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Which runs' }), { target: { value: 'internet' } });
    await waitFor(() => expect(speed.fetchSpeedResults).toHaveBeenLastCalledWith('internet', 20));
  });

  it('deleting a run asks first, then removes it', async () => {
    vi.mocked(speed.fetchSpeedResults).mockResolvedValue([row()]);
    vi.mocked(speed.deleteSpeedResult).mockResolvedValue({ deleted: true });
    renderWithClient(<SpeedTestSettings />);
    fireEvent.click(await screen.findByTitle('Delete this run'));
    expect(screen.getByRole('heading', { name: 'Delete this run?' })).toBeInTheDocument();
    expect(screen.getByText(/940 Mbit\/s down, 12.3 Mbit\/s up/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(speed.deleteSpeedResult).toHaveBeenCalledWith(1, expect.anything()));
    expect(screen.queryByRole('heading', { name: 'Delete this run?' })).toBeNull();
  });
});

describe('this device <-> server', () => {
  it('runs ping, download and upload in turn, shows the figures and records the result', async () => {
    vi.mocked(browser.measurePing).mockResolvedValue([10, 12, 11]);
    // 8 MB in 1.3s past a 0.3s warm-up => (8e6-1e6)*8 / 1.0s = 56 Mbit/s
    vi.mocked(browser.measureDownload).mockImplementation(async (_s, onProgress) => {
      const samples = [{ t: 0, bytes: 0 }, { t: 0.3, bytes: 1e6 }, { t: 1.3, bytes: 8e6 }];
      onProgress?.(samples);
      return samples;
    });
    vi.mocked(browser.measureUpload).mockResolvedValue([{ t: 0, bytes: 0 }, { t: 0.3, bytes: 5e5 }, { t: 1.3, bytes: 3e6 }]);
    vi.mocked(speed.recordBrowserResult).mockResolvedValue(row());
    renderWithClient(<SpeedTestSettings />);

    const c = card(/this device/i);
    fireEvent.click(c.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(c.getByText('Done')).toBeInTheDocument());
    expect(c.getByText('11.0 ms')).toBeInTheDocument();
    expect(c.getByText('56.0 Mbit/s')).toBeInTheDocument();
    expect(c.getByText('20.0 Mbit/s')).toBeInTheDocument();
    expect(c.getByRole('button', { name: /run again/i })).toBeInTheDocument();
    expect(speed.recordBrowserResult).toHaveBeenCalledWith(expect.objectContaining({
      ping: expect.objectContaining({ avg: 11, min: 10, max: 12 }),
      download_mbps: 56, upload_mbps: 20, download_bytes: 8e6, upload_bytes: 3e6,
    }), expect.anything());
    expect(browser.measurePing).toHaveBeenCalledWith(8, expect.any(AbortSignal));
  });

  it('Stop aborts the run quietly; a real failure is a toast', async () => {
    const pending = deferred<number[]>();
    vi.mocked(browser.measurePing).mockReturnValue(pending.promise);
    const capture = captureToasts();
    renderWithClient(<SpeedTestSettings />);
    const c = card(/this device/i);
    fireEvent.click(c.getByRole('button', { name: /run test/i }));
    expect(c.getByText('Measuring latency…')).toBeInTheDocument();
    fireEvent.click(c.getByRole('button', { name: /stop/i }));
    pending.reject(new DOMException('Aborted', 'AbortError'));
    await waitFor(() => expect(c.getByText('Ready')).toBeInTheDocument());
    expect(capture.toasts).toHaveLength(0);

    vi.mocked(browser.measurePing).mockRejectedValue(new Error('Ping failed (502)'));
    fireEvent.click(c.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(capture.titles()).toContain('Speed test failed'));
    expect(capture.toasts[0].message).toBe('Ping failed (502)');
    capture.stop();
  });
});

describe('server -> internet', () => {
  it('starts the backend run, and shows Stop while it is on', async () => {
    vi.mocked(speed.startInternetSpeed).mockResolvedValue(status({ phase: 'servers' }));
    vi.mocked(speed.cancelInternetSpeed).mockResolvedValue({ cancelled: true });
    renderWithClient(<SpeedTestSettings />);
    const c = card(/server → internet/i);
    const run = await c.findByRole('button', { name: /run test/i });
    // Starting refetches the status; from now on the server reports a run in progress
    vi.mocked(speed.fetchInternetSpeed).mockResolvedValue(status({ phase: 'download', live_mbps: 123.4, progress: 0.5 }));
    fireEvent.click(run);
    await waitFor(() => expect(speed.startInternetSpeed).toHaveBeenCalled());
    await waitFor(() => expect(c.getByText('Downloading…')).toBeInTheDocument());
    expect(c.getByText('123 Mbit/s')).toBeInTheDocument();
    fireEvent.click(c.getByRole('button', { name: /stop/i }));
    await waitFor(() => expect(speed.cancelInternetSpeed).toHaveBeenCalled());
  });

  it('shows a finished run with where it was measured from, and a failure with its reason', async () => {
    const meta = { ip: '1.2.3.4', isp: 'Telekom', location: 'Berlin', server: 'de.libre', server_url: null };
    vi.mocked(speed.fetchInternetSpeed).mockResolvedValue(status({
      phase: 'done', meta,
      result: row({ kind: 'internet', download_mbps: 250, upload_mbps: 40, ping: { min: 5, avg: 6.5, max: 8, jitter: 1 }, meta }),
    }));
    const { unmount } = renderWithClient(<SpeedTestSettings />);
    const c = card(/server → internet/i);
    expect(await c.findByText('250 Mbit/s')).toBeInTheDocument();
    expect(c.getByText('40.0 Mbit/s')).toBeInTheDocument();
    expect(c.getByText('6.5 ms')).toBeInTheDocument();
    expect(c.getByText(/Connection: Telekom · Berlin\. Test server: de\.libre\./)).toBeInTheDocument();
    expect(c.getByRole('button', { name: /run again/i })).toBeInTheDocument();
    unmount();

    vi.mocked(speed.fetchInternetSpeed).mockResolvedValue(status({ phase: 'error', error: 'no route' }));
    renderWithClient(<SpeedTestSettings />);
    expect(await card(/server → internet/i).findByText('Failed: no route')).toBeInTheDocument();
  });

  it('a refused start is a toast', async () => {
    vi.mocked(speed.startInternetSpeed).mockRejectedValue(new Error('already running'));
    const capture = captureToasts();
    renderWithClient(<SpeedTestSettings />);
    fireEvent.click(await card(/server → internet/i).findByRole('button', { name: /run test/i }));
    await waitFor(() => expect(capture.titles()).toContain('Could not start'));
    capture.stop();
  });
});
