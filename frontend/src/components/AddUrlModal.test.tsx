import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { deferred } from '../test/fixtures';
import { AddUrlModal } from './AddUrlModal';
import type { UrlCheckResult, VideoFormat, SourceMapping } from '../types';

vi.mock('../api', () => ({
  fetchTorrentConfig: vi.fn(), fetchVpsFolders: vi.fn(), fetchMappings: vi.fn(),
  addTorrent: vi.fn(), addTorrentFile: vi.fn(), checkUrl: vi.fn(), downloadUrl: vi.fn(),
}));

const clientConfig = (over: Partial<api.TorrentClientConfig> = {}): api.TorrentClientConfig => ({
  configured: true, url: 'http://x', username: '', has_password: false, download_dir: '/dl', incomplete_dir: '', local_dir: '',
  stop_on_complete: true, hidden: false, ...over,
});
const torrentConfig = (over: Partial<api.TorrentConfig> = {}): api.TorrentConfig => ({
  transmission: clientConfig(), qbittorrent: clientConfig(), telegram_default: 'qbittorrent', ...over,
});
const folder = (id: number, path: string, over: Partial<api.VpsWatchFolder> = {}): api.VpsWatchFolder => ({
  id, path, host: 'h', port: 22, username: 'u', auto_sync: false, folder: null, is_secured: false, active: true, created_at: null, ...over,
});
const format = (format_id: string, resolution: string, over: Partial<VideoFormat> = {}): VideoFormat => ({
  format_id, ext: 'mp4', resolution, height: parseInt(resolution) || null, filesize: 1024 ** 2, has_audio: true, label: `${resolution} mp4`, ...over,
});
const checkResult = (over: Partial<UrlCheckResult> = {}): UrlCheckResult => ({
  supported: true, title: 'A video', duration: 65, uploader: 'someone', ext: 'mp4', filesize: 3 * 1024 ** 2,
  formats: [format('f1080', '1080p'), format('f720', '720p', { filesize: null }), format('best', 'best', { filesize: null })],
  ...over,
});
const mapping = (over: Partial<SourceMapping> = {}): SourceMapping => ({
  id: 1, downloaded_from: 'youtube', is_secured: false, folder: '/dl/YouTube', quality: '720p', created_at: null, updated_at: null, ...over,
});
const torrentFile = (name: string) => new File(['d8:announce'], name, { type: 'application/x-bittorrent' });

const urlInput = () => screen.getByPlaceholderText('https://youtube.com/watch?v=...') as HTMLInputElement;
const typeUrl = (value: string) => fireEvent.change(urlInput(), { target: { value } });

const renderModal = (props: Partial<React.ComponentProps<typeof AddUrlModal>> = {}) => {
  const onClose = vi.fn();
  const utils = renderWithClient(<AddUrlModal isOpen onClose={onClose} {...props} />);
  return { ...utils, onClose };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig());
  vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder(1, '/home/u/watched', { auto_sync: true }), folder(2, '/home/u/other'), folder(3, '/home/u/gone', { active: false })]);
  vi.mocked(api.fetchMappings).mockResolvedValue([mapping()]);
});

describe('AddUrlModal - basics', () => {
  it('renders nothing while closed', () => {
    renderWithClient(<AddUrlModal isOpen={false} onClose={() => {}} />);
    expect(screen.queryByText('Add URL Download')).toBeNull();
  });

  it('opens focused on the URL field with the check button disabled until something is typed', () => {
    renderModal();
    expect(screen.getByText('Add URL Download')).toBeInTheDocument();
    expect(urlInput()).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Check URL' })).toBeDisabled();
    typeUrl('youtube.com/watch?v=1');
    expect(screen.getByRole('button', { name: 'Check URL' })).toBeEnabled();
  });

  it('closes on Cancel, the X and Escape, resetting its state', () => {
    const { onClose } = renderModal();
    typeUrl('x');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(urlInput(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('Add URL Download').parentElement!.nextElementSibling!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('an address that is not a URL is refused inline', () => {
    renderModal();
    typeUrl('not a url');
    fireEvent.click(screen.getByRole('button', { name: 'Check URL' }));
    expect(screen.getByText('Not a valid URL')).toBeInTheDocument();
    expect(api.checkUrl).not.toHaveBeenCalled();
    // Typing again clears the error
    typeUrl('not a url either');
    expect(screen.queryByText('Not a valid URL')).toBeNull();
  });
});

describe('AddUrlModal - URL check and download', () => {
  it('normalises the URL, lists the formats, preselects the source\'s quality and downloads', async () => {
    vi.mocked(api.checkUrl).mockResolvedValue(checkResult());
    vi.mocked(api.downloadUrl).mockResolvedValue({ error: '' } as never);
    const { onClose } = renderModal();
    typeUrl('youtube.com/watch?v=1');
    fireEvent.click(screen.getByRole('button', { name: 'Check URL' }));
    await waitFor(() => expect(api.checkUrl).toHaveBeenCalledWith('https://youtube.com/watch?v=1'));
    expect(await screen.findByText('URL supported')).toBeInTheDocument();
    expect(urlInput().value).toBe('https://youtube.com/watch?v=1');
    expect(screen.getByText('A video')).toBeInTheDocument();
    expect(screen.getByText('By: someone')).toBeInTheDocument();
    expect(screen.getByText('Duration: 1:05')).toBeInTheDocument();
    expect(screen.getByText('/dl/YouTube')).toBeInTheDocument();   // the mapping's folder

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map(r => r.value)).toEqual(['f1080', 'f720', 'best']);
    expect(radios[1]).toBeChecked();   // the mapping says 720p
    expect(screen.getByText('1.00 MB')).toBeInTheDocument();   // only f1080 has a size
    expect(screen.getByRole('button', { name: /Download/ })).toHaveTextContent('(720p)');
    const filename = screen.getByPlaceholderText('A video');
    expect(filename).toHaveFocus();

    fireEvent.click(radios[0]);
    expect(screen.getByRole('button', { name: /Download/ })).toHaveTextContent('(1080p)');
    fireEvent.change(filename, { target: { value: 'My name' } });
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    expect(onClose).toHaveBeenCalledTimes(1);   // closes at once, the download runs on
    await waitFor(() => expect(api.downloadUrl).toHaveBeenCalledWith({
      url: 'https://youtube.com/watch?v=1', format_id: 'f1080', title: 'My name', ext: 'mp4', filesize: 1024 ** 2, resolution: '1080p',
    }));
  });

  it('with no mapping the first format is picked; "best" is not shown on the button; Enter submits', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([]);
    vi.mocked(api.checkUrl).mockResolvedValue(checkResult({ formats: [format('best', 'best', { filesize: null }), format('f720', '720p')] }));
    vi.mocked(api.downloadUrl).mockResolvedValue({ error: '' } as never);
    renderModal();
    typeUrl('https://vimeo.com/1');
    fireEvent.keyDown(urlInput(), { key: 'Enter' });
    expect(await screen.findByText('URL supported')).toBeInTheDocument();
    expect((screen.getAllByRole('radio')[0] as HTMLInputElement)).toBeChecked();
    expect(screen.getByRole('button', { name: /Download/ })).not.toHaveTextContent('(');
    fireEvent.keyDown(screen.getByPlaceholderText('A video'), { key: 'Enter' });
    await waitFor(() => expect(api.downloadUrl).toHaveBeenCalledWith(expect.objectContaining({ format_id: 'best', title: 'A video', filesize: 3 * 1024 ** 2 })));
  });

  it('a download failure is left to the list - nothing is shown here', async () => {
    vi.mocked(api.checkUrl).mockResolvedValue(checkResult({ formats: [] }));
    vi.mocked(api.downloadUrl).mockRejectedValue(new Error('nope'));
    const { onClose } = renderModal();
    typeUrl('https://vimeo.com/1');
    fireEvent.click(screen.getByRole('button', { name: 'Check URL' }));
    await screen.findByText('URL supported');
    expect(screen.queryByText('Quality:')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    await waitFor(() => expect(api.downloadUrl).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('an unsupported URL shows the server\'s reason, a failed check a generic one', async () => {
    vi.mocked(api.checkUrl).mockResolvedValueOnce({ supported: false, error: 'No extractor for this site' }).mockResolvedValueOnce({ supported: false }).mockRejectedValueOnce(new Error('down'));
    renderModal();
    typeUrl('https://example.com/a');
    fireEvent.click(screen.getByRole('button', { name: 'Check URL' }));
    expect(await screen.findByText('No extractor for this site')).toBeInTheDocument();
    expect(screen.queryByText('URL supported')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check URL' }));
    expect(await screen.findByText('URL not supported')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check URL' }));
    expect(await screen.findByText('Failed to check URL')).toBeInTheDocument();
  });

  it('shows a spinner while checking and ignores Enter meanwhile', async () => {
    const gate = deferred<UrlCheckResult>();
    vi.mocked(api.checkUrl).mockReturnValue(gate.promise);
    renderModal();
    typeUrl('https://example.com/a');
    fireEvent.click(screen.getByRole('button', { name: 'Check URL' }));
    expect(await screen.findByRole('button', { name: /Checking/ })).toBeDisabled();
    fireEvent.keyDown(urlInput(), { key: 'Enter' });
    gate.resolve(checkResult());
    await screen.findByText('URL supported');
    expect(api.checkUrl).toHaveBeenCalledTimes(1);
  });

  it('a pasted URL is checked on open, once; a pasted non-URL is refused', async () => {
    vi.mocked(api.checkUrl).mockResolvedValue(checkResult());
    const { rerender } = renderModal({ initialUrl: 'youtu.be/abc' });
    await waitFor(() => expect(api.checkUrl).toHaveBeenCalledWith('https://youtu.be/abc'));
    await screen.findByText('URL supported');
    rerender(<AddUrlModal isOpen onClose={() => {}} initialUrl="youtu.be/abc" />);
    expect(api.checkUrl).toHaveBeenCalledTimes(1);
    // Closing and reopening checks again
    rerender(<AddUrlModal isOpen={false} onClose={() => {}} initialUrl="youtu.be/abc" />);
    rerender(<AddUrlModal isOpen onClose={() => {}} initialUrl="youtu.be/abc" />);
    await waitFor(() => expect(api.checkUrl).toHaveBeenCalledTimes(2));
  });

  it('a pasted non-URL is refused on open', () => {
    renderModal({ initialUrl: 'just some words' });
    expect(screen.getByText('Not a valid URL')).toBeInTheDocument();
    expect(urlInput().value).toBe('just some words');
  });
});

describe('AddUrlModal - magnet links', () => {
  const magnet = 'magnet:?xt=urn:btih:abc123&dn=My+Film+%282024%29';

  it('a magnet switches to torrent mode with the client picker, the default client and the folder list', async () => {
    renderModal();
    typeUrl(magnet);
    fireEvent.click(screen.getByRole('button', { name: 'Check URL' }));
    expect(screen.getByText('Magnet link — sends to a VPS torrent client')).toBeInTheDocument();
    expect(screen.getByText('My Film (2024)')).toBeInTheDocument();
    expect(api.checkUrl).not.toHaveBeenCalled();
    expect(screen.queryByText(/upload \.torrent/)).toBeNull();
    const qbit = await screen.findByRole('button', { name: 'qbittorrent' });
    expect(qbit).toHaveClass('bg-purple-500/30');   // telegram_default wins
    expect(screen.getByRole('button', { name: 'transmission' })).not.toHaveClass('bg-purple-500/30');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Client default folder', '/home/u/watched (autoSync)', '/home/u/other']);
    fireEvent.change(select, { target: { value: '/home/u/watched' } });
    expect(screen.getByText(/autoSync will pull finished files/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: '/home/u/other' } });
    expect(screen.queryByText(/autoSync will pull finished files/)).toBeNull();
  });

  it('sends the magnet to the chosen client and folder, then offers Done', async () => {
    vi.mocked(api.addTorrent).mockResolvedValue({ status: 'added', name: 'My Film (2024)', hash: 'abc123' });
    const { onClose } = renderModal({ initialUrl: `  ${magnet}  ` });
    expect(screen.getByText('Magnet link — sends to a VPS torrent client')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'transmission' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/home/u/other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to torrent client' }));
    await waitFor(() => expect(api.addTorrent).toHaveBeenCalledWith(magnet, 'transmission', '/home/u/other'));
    expect(await screen.findByText('Sent to the torrent client: My Film (2024)')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter sends too, with no folder meaning the client default; a duplicate says so', async () => {
    vi.mocked(api.addTorrent).mockResolvedValue({ status: 'duplicate' });
    renderModal({ initialUrl: magnet });
    await screen.findByRole('button', { name: 'qbittorrent' });
    fireEvent.keyDown(urlInput(), { key: 'Enter' });
    await waitFor(() => expect(api.addTorrent).toHaveBeenCalledWith(magnet, 'qbittorrent', null));
    expect(await screen.findByText('Already in the torrent client')).toBeInTheDocument();
  });

  it('reports the client\'s error inline, and a transport failure generically', async () => {
    vi.mocked(api.addTorrent).mockResolvedValueOnce({ error: 'Tracker refused' }).mockRejectedValueOnce(new Error('down'));
    renderModal({ initialUrl: magnet });
    const send = await screen.findByRole('button', { name: 'Send to torrent client' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(await screen.findByText('Tracker refused')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send to torrent client' }));
    expect(await screen.findByText('Failed to send the magnet link')).toBeInTheDocument();
  });

  it('with no client configured it says so and cannot send', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({
      transmission: clientConfig({ configured: false }), qbittorrent: clientConfig({ configured: false }), telegram_default: null,
    }));
    renderModal({ initialUrl: magnet });
    expect(await screen.findByText(/No torrent client is configured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to torrent client' })).toBeDisabled();
    expect(screen.queryByText('Torrent client:')).toBeNull();
  });

  it('a hidden client is offered only when secured items are shown; the default falls back to the first', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig({ qbittorrent: clientConfig({ hidden: true }), telegram_default: 'qbittorrent' }));
    const { rerender } = renderModal({ initialUrl: magnet });
    const tr = await screen.findByRole('button', { name: 'transmission' });
    expect(screen.queryByRole('button', { name: 'qbittorrent' })).toBeNull();
    expect(tr).toHaveClass('bg-purple-500/30');
    rerender(<AddUrlModal isOpen onClose={() => {}} initialUrl={magnet} showSecured />);
    expect(await screen.findByRole('button', { name: 'qbittorrent' })).toBeInTheDocument();
  });

  it('typing a plain URL over the magnet leaves torrent mode', async () => {
    renderModal({ initialUrl: magnet });
    await screen.findByRole('button', { name: 'qbittorrent' });
    typeUrl('https://example.com/v');
    expect(screen.queryByText(/sends to a VPS torrent client/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Check URL' })).toBeEnabled();
  });
});

describe('AddUrlModal - .torrent files', () => {
  it('dropped files load a row each and are posted one at a time, in order', async () => {
    const first = deferred<{ status?: 'added' | 'duplicate'; name?: string; error?: string }>();
    vi.mocked(api.addTorrentFile)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ error: 'rejected by client' })
      .mockResolvedValueOnce({ status: 'duplicate', name: 'c' });
    const files = [torrentFile('a.torrent'), torrentFile('b.torrent'), torrentFile('c.torrent')];
    renderModal({ initialFiles: files });
    expect(screen.getByText('3 .torrent files — sends to a VPS torrent client')).toBeInTheDocument();
    expect(screen.getByText('a.torrent')).toBeInTheDocument();
    expect(screen.getByText('b.torrent')).toBeInTheDocument();
    const send = await screen.findByRole('button', { name: 'Send 3 to torrent client' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/home/u/other' } });
    fireEvent.click(send);

    await waitFor(() => expect(api.addTorrentFile).toHaveBeenCalledTimes(1));
    expect(api.addTorrentFile).toHaveBeenCalledWith(files[0], 'qbittorrent', '/home/u/other');
    expect(screen.getByText('Sending 1/3...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sending/ })).toBeDisabled();
    // Clicking again mid-batch must not start a parallel run
    fireEvent.click(screen.getByRole('button', { name: /Sending/ }));
    fireEvent.keyDown(urlInput(), { key: 'Enter' });
    expect(api.addTorrentFile).toHaveBeenCalledTimes(1);   // still waiting on the first

    first.resolve({ status: 'added', name: 'Ubuntu ISO' });
    await waitFor(() => expect(api.addTorrentFile).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('1 sent, 1 already there, 1 failed — send again to retry those')).toBeInTheDocument();
    expect(screen.getByText('Ubuntu ISO')).toBeInTheDocument();   // the client's name replaces the filename
    expect(screen.getByText('sent')).toBeInTheDocument();
    expect(screen.getByText('rejected by client')).toBeInTheDocument();
    expect(screen.getByText('already added')).toBeInTheDocument();
    expect(screen.queryByText('Torrent client:')).toBeNull();
  });

  it('sending again retries only the failed files', async () => {
    vi.mocked(api.addTorrentFile)
      .mockResolvedValueOnce({ status: 'added', name: 'A' })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ status: 'added', name: 'B' });
    const files = [torrentFile('a.torrent'), torrentFile('b.torrent')];
    const { onClose } = renderModal({ initialFiles: files });
    const send = await screen.findByRole('button', { name: 'Send 2 to torrent client' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(await screen.findByText('1 sent, 1 failed — send again to retry those')).toBeInTheDocument();
    expect(screen.getByText('Upload failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Send 2 to torrent client' }));
    await waitFor(() => expect(api.addTorrentFile).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.addTorrentFile).mock.calls[2][0]).toBe(files[1]);
    expect(await screen.findByText('2 sent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('one file: singular wording, and the upload button loads a picked file', async () => {
    vi.mocked(api.addTorrentFile).mockResolvedValue({ status: 'added', name: 'Solo' });
    renderModal();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    expect(input).toHaveAttribute('multiple');
    fireEvent.click(screen.getByText(/upload \.torrent files/));
    fireEvent.change(input, { target: { files: [torrentFile('solo.torrent')] } });
    expect(screen.getByText('1 .torrent file — sends to a VPS torrent client')).toBeInTheDocument();
    const send = await screen.findByRole('button', { name: 'Send to torrent client' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(api.addTorrentFile).toHaveBeenCalledWith(expect.any(File), 'qbittorrent', null));
    expect(await screen.findByText('1 sent')).toBeInTheDocument();
    expect(screen.getByText('Solo')).toBeInTheDocument();
  });

  it('an empty pick does nothing', () => {
    renderModal();
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [] } });
    expect(screen.queryByText(/sends to a VPS torrent client/)).toBeNull();
  });

  it('a second drop onto the open modal replaces the batch', () => {
    const { rerender } = renderModal({ initialFiles: [torrentFile('a.torrent')] });
    expect(screen.getByText('a.torrent')).toBeInTheDocument();
    rerender(<AddUrlModal isOpen onClose={() => {}} initialFiles={[torrentFile('b.torrent'), torrentFile('c.torrent')]} />);
    expect(screen.queryByText('a.torrent')).toBeNull();
    expect(screen.getByText('2 .torrent files — sends to a VPS torrent client')).toBeInTheDocument();
  });

  it('Enter sends the batch once a client is ready', async () => {
    vi.mocked(api.addTorrentFile).mockResolvedValue({ status: 'added' });
    renderModal({ initialFiles: [torrentFile('a.torrent')] });
    await screen.findByRole('button', { name: 'qbittorrent' });
    fireEvent.keyDown(urlInput(), { key: 'Enter' });
    await waitFor(() => expect(api.addTorrentFile).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('1 sent')).toBeInTheDocument();
    // Once done, Enter does nothing more
    fireEvent.keyDown(urlInput(), { key: 'Enter' });
    expect(api.addTorrentFile).toHaveBeenCalledTimes(1);
  });
});
