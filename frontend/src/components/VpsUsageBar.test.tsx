import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { deferred } from '../test/fixtures';
import { qk } from '../api/queryKeys';
import { VpsUsageBar } from './VpsUsageBar';

vi.mock('../api', async (orig) => ({ ...(await orig<typeof api>()), fetchVpsUsage: vi.fn() }));

const GB = 1024 ** 3;

const usage = (over: Partial<api.VpsUsage> = {}): api.VpsUsage => ({
  host: 'box.seedhost.eu',
  disk: { used: 60 * GB, limit: 100 * GB, percent: 60, filesystem: '/home6', source: 'quota' },
  clients: [],
  traffic: { downloaded: 5 * GB, uploaded: 2 * GB },
  server: null,
  cached_at: 0,
  ...over,
});

const server: api.VpsServerStats = {
  volume: { filesystem: '/dev/sda', mount: '/home6', total: 1000 * GB, used: 900 * GB, avail: 100 * GB, percent: 90 },
  load: { load1: 1.5, load5: 1.2, load15: 1, cores: 8, percent: 19 },
  net: { iface: 'eth0', rx_bytes: 10 * GB, tx_bytes: 20 * GB, rx_rate: 2 * 1024 * 1024, tx_rate: 1024 * 1024, window: 60 },
};

beforeEach(() => { vi.resetAllMocks(); });

describe('VpsUsageBar - the account row', () => {
  it('shows a skeleton while loading, then the quota bar and the traffic totals', async () => {
    const pending = deferred<api.VpsUsage>();
    vi.mocked(api.fetchVpsUsage).mockReturnValue(pending.promise);
    const { container } = renderWithClient(<VpsUsageBar />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();

    pending.resolve(usage());
    expect(await screen.findByText('box.seedhost.eu')).toBeInTheDocument();
    expect(screen.getByText('60.00 GB')).toBeInTheDocument();
    expect(screen.getByText('/ 100.00 GB')).toBeInTheDocument();
    expect(screen.getByText('60% of quota · 40.00 GB free')).toBeInTheDocument();
    expect(screen.getByText('5.00 GB')).toBeInTheDocument();      // downloaded
    expect(screen.getByText('2.00 GB')).toBeInTheDocument();      // uploaded
    expect(screen.queryByText(/no quota set/)).toBeNull();
    // Nothing to expand: no clients, no server
    expect(screen.queryByTitle('Per-client split and server health')).toBeNull();
    expect(screen.getByTitle('Refresh usage')).toBeInTheDocument();
  });

  it('says so when the figure is the shared volume rather than a quota', async () => {
    vi.mocked(api.fetchVpsUsage).mockResolvedValue(usage({
      host: null, disk: { used: 90 * GB, limit: 100 * GB, percent: 90, filesystem: '/', source: 'df' },
    }));
    const { container } = renderWithClient(<VpsUsageBar />);
    expect(await screen.findByText('VPS')).toBeInTheDocument();
    expect(screen.getByText('· no quota set')).toBeInTheDocument();
    // Red past 90%
    expect(container.querySelector('.bg-red-500')).not.toBeNull();
  });

  it('with no usable disk figure: the error (or a generic line), no bar', async () => {
    vi.mocked(api.fetchVpsUsage).mockResolvedValue(usage({ disk: null, disk_error: 'quota: command not found', server }));
    renderWithClient(<VpsUsageBar />);
    expect(await screen.findByText('quota: command not found')).toBeInTheDocument();
    expect(screen.queryByText(/of quota/)).toBeNull();
  });

  it('a zero limit reads as unavailable', async () => {
    vi.mocked(api.fetchVpsUsage).mockResolvedValue(usage({
      disk: { used: 1, limit: 0, percent: null, filesystem: '/', source: 'quota' }, server,
    }));
    renderWithClient(<VpsUsageBar />);
    expect(await screen.findByText('Disk usage unavailable')).toBeInTheDocument();
  });

  it('a failed load is one quiet line', async () => {
    vi.mocked(api.fetchVpsUsage).mockRejectedValue(new Error('ssh down'));
    renderWithClient(<VpsUsageBar />);
    expect(await screen.findByText('Could not read VPS usage.')).toBeInTheDocument();
  });

  it('renders nothing at all when there is no VPS to report on', async () => {
    vi.mocked(api.fetchVpsUsage).mockResolvedValue(usage({ disk: null, server: null, clients: [] }));
    const { container } = renderWithClient(<VpsUsageBar />);
    await waitFor(() => expect(api.fetchVpsUsage).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeNull());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('VpsUsageBar - the details behind the chevron', () => {
  it('splits traffic per client, names a failing client, and keeps the shared server apart', async () => {
    vi.mocked(api.fetchVpsUsage).mockResolvedValue(usage({
      clients: [
        { client: 'transmission', downloaded: 3 * GB, uploaded: 1 * GB, ratio: 0.33 },
        { client: 'qbittorrent', error: 'login failed' },
      ],
      server,
    }));
    renderWithClient(<VpsUsageBar />);
    const chevron = await screen.findByTitle('Per-client split and server health');
    expect(screen.queryByText(/Shared server/)).toBeNull();

    fireEvent.click(chevron);
    expect(screen.getByTitle('Hide details')).toBeInTheDocument();
    // Account side: the clients' own counters, labelled as such
    expect(screen.getByText('transmission')).toBeInTheDocument();
    expect(screen.getByText('ratio 0.33')).toBeInTheDocument();
    expect(screen.getByText('qbittorrent')).toBeInTheDocument();
    expect(screen.getByText('login failed')).toBeInTheDocument();
    expect(screen.getByText(/not seedhost's metered figure/)).toBeInTheDocument();
    // The machine, captioned as not yours
    expect(screen.getByText('Shared server — all tenants, not your usage')).toBeInTheDocument();
    expect(screen.getByText('/home6')).toBeInTheDocument();
    expect(screen.getByText('(90%)')).toBeInTheDocument();
    expect(screen.getByText(/load 1.5 \/ 1.2 \/ 1/)).toBeInTheDocument();
    expect(screen.getByText(/on 8 cores/)).toBeInTheDocument();
    expect(screen.getByText('(19%)', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('eth0')).toBeInTheDocument();
    expect(screen.getByText(/2.0 MB\/s ↓ \/ 1.0 MB\/s ↑/)).toBeInTheDocument();
    expect(screen.getByText(/10.00 GB ↓ \/ 20.00 GB ↑ since boot/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Hide details'));
    expect(screen.queryByText(/Shared server/)).toBeNull();
  });

  it('has no rate on the first poll and says so', async () => {
    vi.mocked(api.fetchVpsUsage).mockResolvedValue(usage({
      server: { ...server, net: { iface: 'eth0', rx_bytes: GB, tx_bytes: GB }, load: { ...server.load!, cores: 0, percent: null } },
    }));
    renderWithClient(<VpsUsageBar />);
    fireEvent.click(await screen.findByTitle('Per-client split and server health'));
    expect(screen.getByText('rate on next refresh')).toBeInTheDocument();
    expect(screen.queryByText(/on 0 cores/)).toBeNull();
  });

  it('refresh bypasses the cache and writes the fresh snapshot into the query', async () => {
    vi.mocked(api.fetchVpsUsage)
      .mockResolvedValueOnce(usage())
      .mockResolvedValueOnce(usage({ disk: { used: 70 * GB, limit: 100 * GB, percent: 70, filesystem: '/home6', source: 'quota' } }));
    const { client } = renderWithClient(<VpsUsageBar />);
    await screen.findByText('60.00 GB');
    fireEvent.click(screen.getByTitle('Refresh usage'));
    await waitFor(() => expect(api.fetchVpsUsage).toHaveBeenLastCalledWith(true));
    expect(await screen.findByText('70.00 GB')).toBeInTheDocument();
    expect(client.getQueryData<api.VpsUsage>(qk.vpsUsage())?.disk?.used).toBe(70 * GB);
  });

  it('a failed refresh turns the button amber and keeps the old figures', async () => {
    vi.mocked(api.fetchVpsUsage).mockResolvedValueOnce(usage()).mockRejectedValueOnce(new Error('timeout'));
    renderWithClient(<VpsUsageBar />);
    await screen.findByText('60.00 GB');
    fireEvent.click(screen.getByTitle('Refresh usage'));
    expect(await screen.findByTitle('Refresh failed - click to retry')).toBeInTheDocument();
    expect(screen.getByText('60.00 GB')).toBeInTheDocument();
  });
});
