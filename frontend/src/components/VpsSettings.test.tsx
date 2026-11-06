import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { deferred } from '../test/fixtures';
import { qk } from '../api/queryKeys';
import { VpsSettings } from './VpsSettings';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()),
  fetchVpsConfig: vi.fn(), saveVpsConfig: vi.fn(), testVpsConnection: vi.fn(), deleteVpsConfig: vi.fn(),
  fetchVpsFolders: vi.fn(), addVpsFolders: vi.fn(), deleteVpsFolder: vi.fn(), updateVpsFolder: vi.fn(),
  fetchVpsFolderDeleteImpact: vi.fn(),
  fetchTorrentConfig: vi.fn(), saveTorrentConfig: vi.fn(), testTorrentConnection: vi.fn(), deleteTorrentConfig: vi.fn(),
  setTelegramDefault: vi.fn(), setStopOnComplete: vi.fn(), setTorrentHidden: vi.fn(),
}));

// The folder picker has its own tests; a stub that hands back a path keeps
// these about which field it fills and what gets saved.
vi.mock('./FolderBrowser', () => ({
  FolderBrowser: ({ isOpen, onConfirm, onClose, title, initialPath, alreadyAdded, singleSelect }: {
    isOpen: boolean; onConfirm: (p: string[]) => void; onClose: () => void; title?: string;
    initialPath?: string | null; alreadyAdded?: string[]; singleSelect?: boolean;
  }) => isOpen ? (
    <div data-testid="browser" data-initial={initialPath ?? ''} data-added={(alreadyAdded ?? []).join(',')} data-single={String(!!singleSelect)}>
      <span>{title ?? 'Browse'}</span>
      <button onClick={() => onConfirm(['/remote/picked'])}>pick</button>
      <button onClick={() => onConfirm([])}>pick nothing</button>
      <button onClick={onClose}>close browser</button>
    </div>
  ) : null,
}));

const vpsConfig = (over: Partial<api.VpsConfig> = {}): api.VpsConfig => ({
  configured: true, host: 'box.seedhost.eu', port: 2222, username: 'hs', remote_path: '', has_password: true, ...over,
});
const unconfigured = vpsConfig({ configured: false, host: '', port: 22, username: '', has_password: false });

const folder = (over: Partial<api.VpsWatchFolder> = {}): api.VpsWatchFolder => ({
  id: 1, path: '/home/hs/downloads', host: 'box.seedhost.eu', port: 2222, username: 'hs',
  auto_sync: false, folder: null, is_secured: false, active: true, created_at: null, ...over,
});

const clientConfig = (over: Partial<api.TorrentClientConfig> = {}): api.TorrentClientConfig => ({
  configured: false, url: '', username: '', has_password: false, download_dir: '', incomplete_dir: '', local_dir: '',
  stop_on_complete: true, hidden: false, ...over,
});
const torrentConfig = (over: Partial<api.TorrentConfig> = {}): api.TorrentConfig => ({
  transmission: clientConfig(), qbittorrent: clientConfig(), telegram_default: null, ...over,
});
const transmissionOn = clientConfig({
  configured: true, url: 'https://box/transmission/rpc', username: 'hs', has_password: true,
  download_dir: '/home/hs/tr', incomplete_dir: '/home/hs/tr/.inc', local_dir: '/mnt/tr',
});

const field = (label: string) => {
  const el = screen.getByText(label, { selector: 'label' }).parentElement!.querySelector('input') as HTMLInputElement;
  return el;
};
const dialog = (heading: string) =>
  within(screen.getByRole('heading', { name: heading }).closest('.bg-slate-800') as HTMLElement);
/** A torrent client card, by its heading; `open()` expands it. */
const card = (label: string) => {
  const root = screen.getByRole('heading', { name: label }).closest('.rounded-xl') as HTMLElement;
  return { root, q: within(root), open: () => fireEvent.click(within(root).getByRole('button', { name: new RegExp(`^${label}`) })) };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchVpsConfig).mockResolvedValue(vpsConfig());
  vi.mocked(api.fetchVpsFolders).mockResolvedValue([]);
  vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig());
  vi.mocked(api.fetchVpsFolderDeleteImpact).mockResolvedValue({ count: 0, sample: [] });
  vi.mocked(api.deleteVpsFolder).mockResolvedValue([]);
  vi.mocked(api.updateVpsFolder).mockResolvedValue([]);
  vi.mocked(api.addVpsFolders).mockResolvedValue([]);
});

describe('VpsSettings - the connection', () => {
  it('hydrates the form from the saved config and shows it as configured', async () => {
    renderWithClient(<VpsSettings />);
    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.getByTitle('hs@box.seedhost.eu:2222 (password saved)')).toBeInTheDocument();
    expect(screen.getByText('hs@box.seedhost.eu:2222')).toBeInTheDocument();
    expect(field('Host')).toHaveValue('box.seedhost.eu');
    expect(field('Port')).toHaveValue(2222);
    expect(field('Username')).toHaveValue('hs');
    expect(field('Password')).toHaveValue('');
    expect(field('Password')).toHaveAttribute('placeholder', expect.stringContaining('leave blank'));
    expect(screen.getByTitle('Remove the saved VPS connection')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /browse/i })).toBeEnabled();
  });

  it('not configured: empty form, no remove button, browsing disabled with a hint', async () => {
    vi.mocked(api.fetchVpsConfig).mockResolvedValue(unconfigured);
    renderWithClient(<VpsSettings />);
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText('Remote SSH/SFTP server')).toBeInTheDocument();
    expect(field('Port')).toHaveValue(22);
    expect(screen.queryByTitle('Remove the saved VPS connection')).toBeNull();
    expect(screen.getByRole('button', { name: /browse/i })).toBeDisabled();
    expect(screen.getByText(/Save the connection with a password above/)).toBeInTheDocument();
    // Test and Done wait for a host and a username
    expect(screen.getByRole('button', { name: /test/i })).toBeDisabled();
    fireEvent.change(field('Host'), { target: { value: 'h' } });
    expect(screen.getByRole('button', { name: /test/i })).toBeDisabled();
    fireEvent.change(field('Username'), { target: { value: 'u' } });
    expect(screen.getByRole('button', { name: /test/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /done/i })).toBeEnabled();
  });

  it('is "Unavailable" when the config cannot be read', async () => {
    vi.mocked(api.fetchVpsConfig).mockRejectedValue(new Error('500'));
    renderWithClient(<VpsSettings />);
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
  });

  it('Test sends the form (password only when typed) and shows the result next to the button', async () => {
    vi.mocked(api.testVpsConnection)
      .mockResolvedValueOnce({ success: true, message: 'Connected as hs' })
      .mockResolvedValueOnce({ success: false, error: 'Authentication failed' })
      .mockRejectedValueOnce(new Error('net'));
    renderWithClient(<VpsSettings />);
    await screen.findByText('Configured');
    fireEvent.click(screen.getByRole('button', { name: /test/i }));
    await waitFor(() => expect(api.testVpsConnection).toHaveBeenCalledWith({ host: 'box.seedhost.eu', port: 2222, username: 'hs', remote_path: '' }));
    expect(await screen.findByText('Connected as hs')).toBeInTheDocument();

    fireEvent.change(field('Password'), { target: { value: 'pw' } });
    fireEvent.change(field('Port'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /test/i }));
    await waitFor(() => expect(api.testVpsConnection).toHaveBeenLastCalledWith({ host: 'box.seedhost.eu', port: 22, username: 'hs', remote_path: '', password: 'pw' }));
    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /test/i }));
    expect(await screen.findByText('Failed to run connection test')).toBeInTheDocument();
  });

  it('Done saves, toasts, clears the password and refreshes everything VPS', async () => {
    vi.mocked(api.saveVpsConfig).mockResolvedValue({ status: 'ok', configured: true, has_password: true });
    const capture = captureToasts();
    const { client } = renderWithClient(<VpsSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByText('Configured');
    fireEvent.change(field('Host'), { target: { value: ' new.host ' } });
    fireEvent.change(field('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(api.saveVpsConfig).toHaveBeenCalledWith({ host: 'new.host', port: 2222, username: 'hs', remote_path: '', password: 'secret' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('VPS connection saved'));
    expect(field('Password')).toHaveValue('');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vps'] });
    capture.stop();
  });

  it('a refused save, or one that throws, is a toast', async () => {
    vi.mocked(api.saveVpsConfig).mockResolvedValueOnce({ error: 'Could not connect' }).mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    renderWithClient(<VpsSettings />);
    await screen.findByText('Configured');
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Could not connect'));
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to save VPS configuration'));
    capture.stop();
  });

  it('removing the connection asks first, then deletes it', async () => {
    vi.mocked(api.deleteVpsConfig).mockResolvedValue({ status: 'ok', configured: false });
    const capture = captureToasts();
    renderWithClient(<VpsSettings />);
    await screen.findByText('Configured');
    fireEvent.click(screen.getByTitle('Remove the saved VPS connection'));
    expect(screen.getByText(/Your watched folders are kept/)).toBeInTheDocument();
    fireEvent.click(dialog('Remove VPS connection?').getByRole('button', { name: 'Cancel' }));
    expect(api.deleteVpsConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Remove the saved VPS connection'));
    fireEvent.click(dialog('Remove VPS connection?').getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteVpsConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('VPS connection removed'));
    capture.stop();
  });

  it('a refused removal is a toast', async () => {
    vi.mocked(api.deleteVpsConfig).mockResolvedValue({ error: 'locked' });
    const capture = captureToasts();
    renderWithClient(<VpsSettings />);
    await screen.findByText('Configured');
    fireEvent.click(screen.getByTitle('Remove the saved VPS connection'));
    fireEvent.click(dialog('Remove VPS connection?').getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('locked'));
    capture.stop();
  });
});

describe('VpsSettings - watched folders', () => {
  it('lists folders with their destination, and marks ones on another connection inactive', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([
      folder({ folder: '/mnt/media' }),
      folder({ id: 2, path: '/old/box', host: 'old.host', username: 'me', active: false, auto_sync: true }),
    ]);
    renderWithClient(<VpsSettings />);
    expect(await screen.findByText('/home/hs/downloads')).toBeInTheDocument();
    expect(screen.getByText('→ /mnt/media')).toBeInTheDocument();
    expect(screen.getByText(/me@old.host — connect to this VPS/)).toBeInTheDocument();
    const inactive = screen.getByText('/old/box').closest('.rounded-lg') as HTMLElement;
    expect(within(inactive).getByTitle('Connect to this VPS to change autoSync')).toBeDisabled();
    expect(within(inactive).getByTitle('Pick a destination folder')).toBeDisabled();
    // Removal never needs the connection
    expect(within(inactive).getByTitle('Remove folder (no connection needed)')).toBeEnabled();
    expect(screen.queryByText('No folders watched yet')).toBeNull();
  });

  it('with none: says so', async () => {
    renderWithClient(<VpsSettings />);
    expect(await screen.findByText('No folders watched yet')).toBeInTheDocument();
  });

  it('autoSync and hidden toggle with a PATCH; hidden also tells the parent', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder()]);
    vi.mocked(api.updateVpsFolder).mockResolvedValue([folder({ auto_sync: true })]);
    const onChange = vi.fn();
    const { client } = renderWithClient(<VpsSettings onChange={onChange} />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByTitle('autoSync off'));
    await waitFor(() => expect(api.updateVpsFolder).toHaveBeenCalledWith(1, { auto_sync: true }));
    // The answer is the new list, written straight into the cache
    await waitFor(() => expect(client.getQueryData<api.VpsWatchFolder[]>(qk.vpsFolders())?.[0].auto_sync).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vps', 'files'] });
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByTitle('autoSync on — checks hourly for new files')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Visible (click to hide)'));
    await waitFor(() => expect(api.updateVpsFolder).toHaveBeenCalledWith(1, { is_secured: true }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it('a failed toggle is a toast', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder({ is_secured: true })]);
    vi.mocked(api.updateVpsFolder).mockRejectedValue(new Error('x'));
    const capture = captureToasts();
    renderWithClient(<VpsSettings />);
    fireEvent.click(await screen.findByTitle('Hidden from the default view (click to show)'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to update hidden flag'));
    fireEvent.click(screen.getByTitle('autoSync off'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to update autoSync'));
    capture.stop();
  });

  it('the destination picker is a local browser seeded with the current folder', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder({ folder: '/mnt/media' })]);
    const onChange = vi.fn();
    renderWithClient(<VpsSettings onChange={onChange} />);
    fireEvent.click(await screen.findByTitle('Destination: /mnt/media (click to change)'));
    const browser = screen.getByTestId('browser');
    expect(browser).toHaveAttribute('data-initial', '/mnt/media');
    expect(browser).toHaveAttribute('data-single', 'true');
    expect(screen.getByText('Destination folder for this watched folder')).toBeInTheDocument();
    fireEvent.click(screen.getByText('pick'));
    await waitFor(() => expect(api.updateVpsFolder).toHaveBeenCalledWith(1, { folder: '/remote/picked' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(screen.queryByTestId('browser')).toBeNull();
  });

  it('picking nothing clears the destination', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder({ folder: '/mnt/media' })]);
    renderWithClient(<VpsSettings />);
    fireEvent.click(await screen.findByTitle('Destination: /mnt/media (click to change)'));
    fireEvent.click(screen.getByText('pick nothing'));
    await waitFor(() => expect(api.updateVpsFolder).toHaveBeenCalledWith(1, { folder: null }));
  });

  it('Browse adds the picked remote folders, telling the browser what is already watched', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder()]);
    vi.mocked(api.addVpsFolders).mockResolvedValue([folder(), folder({ id: 2, path: '/remote/picked' })]);
    const { client } = renderWithClient(<VpsSettings />);
    await screen.findByText('Configured');   // Browse is disabled until the config says there is a password
    fireEvent.click(screen.getByRole('button', { name: /browse/i }));
    expect(screen.getByTestId('browser')).toHaveAttribute('data-added', '/home/hs/downloads');
    expect(screen.getByTestId('browser')).toHaveAttribute('data-single', 'false');
    fireEvent.click(screen.getByText('pick'));
    await waitFor(() => expect(api.addVpsFolders).toHaveBeenCalledWith(['/remote/picked']));
    expect(await screen.findByText('/remote/picked')).toBeInTheDocument();
    expect(client.getQueryData<api.VpsWatchFolder[]>(qk.vpsFolders())).toHaveLength(2);
  });

  it('closing the browser with nothing picked adds nothing; a failed add is a toast', async () => {
    vi.mocked(api.addVpsFolders).mockRejectedValue(new Error('x'));
    const capture = captureToasts();
    renderWithClient(<VpsSettings />);
    await screen.findByText('Configured');
    fireEvent.click(screen.getByRole('button', { name: /browse/i }));
    fireEvent.click(screen.getByText('pick nothing'));
    expect(api.addVpsFolders).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /browse/i }));
    fireEvent.click(screen.getByText('pick'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to add folders'));
    capture.stop();
  });
});

describe('VpsSettings - removing a watched folder (delete impact)', () => {
  it('asks the server what it would unhide; with nothing hidden it is a plain removal', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder({ auto_sync: true })]);
    const impact = deferred<api.VpsFolderUnhideImpact>();
    vi.mocked(api.fetchVpsFolderDeleteImpact).mockReturnValue(impact.promise);
    const { client } = renderWithClient(<VpsSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByTitle('Remove folder'));
    expect(api.fetchVpsFolderDeleteImpact).toHaveBeenCalledWith(1);
    const d = dialog('Stop watching this folder?');
    expect(d.getByText(/and its hourly autoSync stops/)).toBeInTheDocument();
    expect(d.getByText(/Checking for hidden downloads…/)).toBeInTheDocument();
    // Still checking: the confirm does nothing yet
    fireEvent.click(d.getByRole('button', { name: 'Checking…' }));
    expect(api.deleteVpsFolder).not.toHaveBeenCalled();

    impact.resolve({ count: 0, sample: [] });
    fireEvent.click(await d.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteVpsFolder).toHaveBeenCalledWith(1, false));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vps', 'files'] });
  });

  it('with hidden downloads: warns, lists a sample, and sends confirm_unhide on confirm', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder()]);
    vi.mocked(api.fetchVpsFolderDeleteImpact).mockResolvedValue({ count: 5, sample: ['a.mkv', 'b.mkv', 'c.mkv'] });
    renderWithClient(<VpsSettings />);
    fireEvent.click(await screen.findByTitle('Remove folder'));
    await screen.findByRole('heading', { name: 'Hidden downloads will become visible' });
    const d = dialog('Hidden downloads will become visible');
    expect(await d.findByText(/5 downloads are hidden only because of this folder/)).toBeInTheDocument();
    expect(d.getByText(/• a.mkv/)).toBeInTheDocument();
    expect(d.getByText(/…and 2 more/)).toBeInTheDocument();
    fireEvent.click(d.getByRole('button', { name: 'Remove and show them' }));
    await waitFor(() => expect(api.deleteVpsFolder).toHaveBeenCalledWith(1, true));
  });

  it('one hidden download reads in the singular, and cancel leaves it watched', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder()]);
    vi.mocked(api.fetchVpsFolderDeleteImpact).mockResolvedValue({ count: 1, sample: ['a.mkv'] });
    renderWithClient(<VpsSettings />);
    fireEvent.click(await screen.findByTitle('Remove folder'));
    expect(await screen.findByText(/1 download is hidden only because of this folder/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Hidden downloads will become visible' })).toBeNull();
    expect(api.deleteVpsFolder).not.toHaveBeenCalled();
  });

  it('if the impact check fails the removal still goes ahead, without the unhide flag', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder()]);
    vi.mocked(api.fetchVpsFolderDeleteImpact).mockRejectedValue(new Error('500'));
    renderWithClient(<VpsSettings />);
    fireEvent.click(await screen.findByTitle('Remove folder'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteVpsFolder).toHaveBeenCalledWith(1, false));
  });

  it('the server\'s 409 reason comes back as a toast', async () => {
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder()]);
    vi.mocked(api.deleteVpsFolder).mockRejectedValue(new Error('Removing this folder would unhide 3 downloads'));
    const capture = captureToasts();
    renderWithClient(<VpsSettings />);
    fireEvent.click(await screen.findByTitle('Remove folder'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Removing this folder would unhide 3 downloads'));
    capture.stop();
  });
});

describe('VpsSettings - torrent clients', () => {
  it('one card per client, collapsed, with Configured / Hidden pills', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({ transmission: transmissionOn, qbittorrent: clientConfig({ configured: true, hidden: true, url: 'https://box/qbt/' }) }));
    renderWithClient(<VpsSettings />);
    await screen.findByText('hs@box.seedhost.eu:2222');
    await waitFor(() => expect(screen.getAllByText('Configured')).toHaveLength(3));   // VPS + two clients
    expect(screen.getByText('Hidden')).toBeInTheDocument();
    expect(screen.queryByText('Web/RPC URL')).toBeNull();
    expect(card('Transmission').q.getByRole('button', { name: /^Transmission/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands to a hydrated form; the URL label and hints differ per client', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({ transmission: transmissionOn }));
    renderWithClient(<VpsSettings />);
    await screen.findByText('hs@box.seedhost.eu:2222');
    await waitFor(() => expect(screen.getAllByText('Configured').length).toBe(2));
    card('Transmission').open();
    expect(screen.getByText('Web/RPC URL')).toBeInTheDocument();
    expect(screen.getByText(/normalized to the RPC endpoint/)).toBeInTheDocument();
    const tr = card('Transmission').q;
    expect(tr.getByDisplayValue('https://box/transmission/rpc')).toBeInTheDocument();
    expect(tr.getByDisplayValue('/home/hs/tr')).toBeInTheDocument();
    expect(tr.getByDisplayValue('/home/hs/tr/.inc')).toBeInTheDocument();
    expect(tr.getByDisplayValue('/mnt/tr')).toBeInTheDocument();
    expect(tr.getByPlaceholderText('•••••••• (leave blank to keep saved password)')).toBeInTheDocument();
    card('qBittorrent').open();
    expect(screen.getByText('WebUI URL')).toBeInTheDocument();
    expect(screen.getByText('The base qBittorrent WebUI URL.')).toBeInTheDocument();
    expect(card('qBittorrent').q.getByPlaceholderText('WebUI password')).toBeInTheDocument();
  });

  it('saves one client with its folders (password only when typed), toasts and refreshes torrent + telegram', async () => {
    vi.mocked(api.saveTorrentConfig).mockResolvedValue({ status: 'ok' });
    const capture = captureToasts();
    const { client } = renderWithClient(<VpsSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByText('hs@box.seedhost.eu:2222');
    card('qBittorrent').open();
    const q = card('qBittorrent').q;
    const save = q.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();   // no URL yet
    fireEvent.change(q.getByPlaceholderText(/qbittorrent\/$/), { target: { value: ' https://box/qbt/ ' } });
    fireEvent.change(q.getByPlaceholderText(/leave blank for the client default/), { target: { value: '/dl' } });
    fireEvent.change(q.getByPlaceholderText(/leave blank to disable/), { target: { value: '/dl/.inc' } });
    fireEvent.change(q.getByPlaceholderText(/VPS source default/), { target: { value: '/mnt/qbt' } });
    fireEvent.change(q.getByPlaceholderText('WebUI password'), { target: { value: 'pw' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.saveTorrentConfig).toHaveBeenCalledWith('qbittorrent', {
      url: 'https://box/qbt/', username: '', download_dir: '/dl', incomplete_dir: '/dl/.inc', local_dir: '/mnt/qbt', password: 'pw',
    }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('qBittorrent saved'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['torrent'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['telegram'] });
    capture.stop();
  });

  it('a warning or error on save is an error toast; a throw is generic', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({ transmission: transmissionOn }));
    vi.mocked(api.saveTorrentConfig)
      .mockResolvedValueOnce({ status: 'ok', warning: 'Saved, but the temp dir could not be applied' } as Awaited<ReturnType<typeof api.saveTorrentConfig>>)
      .mockResolvedValueOnce({ error: 'Bad URL' })
      .mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    renderWithClient(<VpsSettings />);
    await screen.findByText('hs@box.seedhost.eu:2222');
    await waitFor(() => expect(screen.getAllByText('Configured').length).toBe(2));
    card('Transmission').open();
    const save = card('Transmission').q.getByRole('button', { name: /^save$/i });
    fireEvent.click(save);
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Saved, but the temp dir could not be applied'));
    fireEvent.click(save);
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Bad URL'));
    fireEvent.click(save);
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to save Transmission'));
    expect(capture.toasts.every(t => t.type === 'error')).toBe(true);
    capture.stop();
  });

  it('Test checks the client and shows the answer inline', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({ transmission: transmissionOn }));
    vi.mocked(api.testTorrentConnection)
      .mockResolvedValueOnce({ success: true, message: 'Transmission 4.0.5' })
      .mockResolvedValueOnce({ success: false, error: '401' })
      .mockRejectedValueOnce(new Error('x'));
    renderWithClient(<VpsSettings />);
    await screen.findByText('hs@box.seedhost.eu:2222');
    await waitFor(() => expect(screen.getAllByText('Configured').length).toBe(2));
    card('Transmission').open();
    const test = card('Transmission').q.getByRole('button', { name: /test/i });
    fireEvent.click(test);
    await waitFor(() => expect(api.testTorrentConnection).toHaveBeenCalledWith('transmission', {
      url: 'https://box/transmission/rpc', username: 'hs', download_dir: '/home/hs/tr', incomplete_dir: '/home/hs/tr/.inc', local_dir: '/mnt/tr',
    }));
    expect(await screen.findByText('Transmission 4.0.5')).toBeInTheDocument();
    fireEvent.click(test);
    expect(await screen.findByText('401')).toBeInTheDocument();
    fireEvent.click(test);
    expect(await screen.findByText('Failed to run connection test')).toBeInTheDocument();
  });

  it('stop-on-complete and hidden save on their own, per client', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({ transmission: transmissionOn }));
    vi.mocked(api.setStopOnComplete).mockResolvedValue({ status: 'ok' } as Awaited<ReturnType<typeof api.setStopOnComplete>>);
    vi.mocked(api.setTorrentHidden).mockResolvedValue({ status: 'ok' } as Awaited<ReturnType<typeof api.setTorrentHidden>>);
    renderWithClient(<VpsSettings />);
    await screen.findByText('hs@box.seedhost.eu:2222');
    await waitFor(() => expect(screen.getAllByText('Configured').length).toBe(2));
    card('Transmission').open();
    const seed = screen.getByRole('checkbox', { name: /stop seeding when complete/i });
    expect(seed).toBeChecked();
    fireEvent.click(seed);
    await waitFor(() => expect(api.setStopOnComplete).toHaveBeenCalledWith('transmission', false));
    const hidden = screen.getByRole('checkbox', { name: /^hidden/i });
    expect(hidden).not.toBeChecked();
    fireEvent.click(hidden);
    await waitFor(() => expect(api.setTorrentHidden).toHaveBeenCalledWith('transmission', true));
    // An unconfigured client has no behaviour switches to flip
    card('qBittorrent').open();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('removing a client asks first, then deletes just that one', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({ transmission: transmissionOn }));
    vi.mocked(api.deleteTorrentConfig).mockResolvedValueOnce({ status: 'ok' }).mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    renderWithClient(<VpsSettings />);
    await screen.findByText('hs@box.seedhost.eu:2222');
    await waitFor(() => expect(screen.getAllByText('Configured').length).toBe(2));
    card('Transmission').open();
    fireEvent.click(screen.getByTitle('Remove the saved Transmission client'));
    expect(screen.getByText(/Torrents already on the VPS keep running/)).toBeInTheDocument();
    fireEvent.click(dialog('Remove Transmission?').getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteTorrentConfig).toHaveBeenCalledWith('transmission'));
    fireEvent.click(screen.getByTitle('Remove the saved Transmission client'));
    fireEvent.click(dialog('Remove Transmission?').getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to remove Transmission'));
    capture.stop();
  });

  it('folder pickers: the home-server one always works, the VPS ones need a saved connection', async () => {
    vi.mocked(api.fetchVpsConfig).mockResolvedValue(unconfigured);
    renderWithClient(<VpsSettings />);
    await screen.findByText('Not configured');
    card('Transmission').open();
    const q = card('Transmission').q;
    const remote = q.getAllByTitle('Save the VPS connection (with password) above to browse');
    expect(remote).toHaveLength(2);
    expect(remote[0]).toBeDisabled();
    fireEvent.click(q.getByTitle('Browse home-server folders'));
    expect(screen.getByText('Local folder on the home server')).toBeInTheDocument();
    fireEvent.click(screen.getByText('pick'));
    expect(q.getByPlaceholderText(/VPS source default/)).toHaveValue('/remote/picked');
  });

  it('the VPS-side pickers fill their own field', async () => {
    renderWithClient(<VpsSettings />);
    await screen.findByText('Configured');
    card('qBittorrent').open();
    const q = card('qBittorrent').q;
    const [downloadDir, incompleteDir] = q.getAllByTitle('Browse remote folders');
    fireEvent.click(downloadDir);
    expect(screen.getByText('Default download folder on the VPS')).toBeInTheDocument();
    fireEvent.click(screen.getByText('pick'));
    expect(q.getByPlaceholderText(/leave blank for the client default/)).toHaveValue('/remote/picked');
    fireEvent.click(incompleteDir);
    expect(screen.getByText('Temp folder on the VPS')).toBeInTheDocument();
    fireEvent.click(screen.getByText('close browser'));
    expect(q.getByPlaceholderText(/leave blank to disable/)).toHaveValue('');
  });

  it('the Telegram fallback picker lists only configured clients and saves on change', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({ transmission: transmissionOn, telegram_default: 'transmission' }));
    vi.mocked(api.setTelegramDefault).mockResolvedValue({ status: 'ok', telegram_default: null });
    renderWithClient(<VpsSettings />);
    const select = await screen.findByRole('combobox');
    expect(select).toHaveValue('transmission');
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['None', 'Transmission']);
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(api.setTelegramDefault).toHaveBeenCalledWith(null));
  });

  it('with no client configured there is no fallback picker', async () => {
    renderWithClient(<VpsSettings />);
    await screen.findByText('hs@box.seedhost.eu:2222');
    await waitFor(() => expect(api.fetchTorrentConfig).toHaveBeenCalled());
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
