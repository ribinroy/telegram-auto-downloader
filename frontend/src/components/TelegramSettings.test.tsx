import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { TelegramSettings } from './TelegramSettings';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()),
  fetchTelegramStatus: vi.fn(), fetchTelegramApiConfig: vi.fn(), fetchTelegramDialogs: vi.fn(), fetchTorrentConfig: vi.fn(),
  saveTelegramApiConfig: vi.fn(), sendTelegramCode: vi.fn(), verifyTelegramCode: vi.fn(), verifyTelegramPassword: vi.fn(),
  telegramBotLogin: vi.fn(), telegramLogout: vi.fn(), addTelegramChannel: vi.fn(), removeTelegramChannel: vi.fn(),
  setChannelTorrentClient: vi.fn(),
}));

const status = (over: Partial<api.TelegramStatus> = {}): api.TelegramStatus => ({
  api_configured: true, connected: true, authorized: false, awaiting_code: false, user: null, channels: [], ...over,
});
const apiConfig = (over: Partial<api.TelegramApiConfig> = {}): api.TelegramApiConfig => ({
  configured: true, api_id: 123456, has_hash: true, source: 'database', ...over,
});
const clientConfig = (configured: boolean): api.TorrentClientConfig => ({
  configured, url: '', username: '', has_password: false, download_dir: '', incomplete_dir: '', local_dir: '',
  stop_on_complete: true, hidden: false,
});
const torrentConfig = (transmission = false, qbittorrent = false): api.TorrentConfig => ({
  transmission: clientConfig(transmission), qbittorrent: clientConfig(qbittorrent), telegram_default: null,
});

const user: api.TelegramUser = { id: 1, username: 'ribin', first_name: 'Ribin', last_name: 'Roy', phone: '491234' };
const channel: api.TelegramChannel = { id: -100123, title: 'Movies', torrent_client: null };
const signedIn = (over: Partial<api.TelegramStatus> = {}) => status({ authorized: true, user, channels: [channel], ...over });

const dialog = (heading: string) =>
  within(screen.getByRole('heading', { name: heading }).closest('.bg-slate-800') as HTMLElement);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchTelegramApiConfig).mockResolvedValue(apiConfig());
  vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig());
});

describe('TelegramSettings - connection state', () => {
  it('spins while the status loads', () => {
    vi.mocked(api.fetchTelegramStatus).mockReturnValue(new Promise(() => {}));
    const { container } = renderWithClient(<TelegramSettings />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('with no API credentials: not connected, the form is open and there is no login wizard', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status({ api_configured: false, connected: false }));
    vi.mocked(api.fetchTelegramApiConfig).mockResolvedValue(apiConfig({ configured: false, api_id: null, has_hash: false, source: null }));
    renderWithClient(<TelegramSettings />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText('Add your API credentials below to get started')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('1234567')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('abcdef0123456789...')).toBeRequired();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();   // nothing to go back to
    expect(screen.queryByText('Sign in to Telegram')).toBeNull();
  });

  it('a client that is not running says so', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status({ connected: false }));
    renderWithClient(<TelegramSettings />);
    expect(await screen.findByText('The Telegram client is not running')).toBeInTheDocument();
  });

  it('a status error is a toast', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status({ error: 'session file locked' }));
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('session file locked'));
    capture.stop();
  });

  it('signed in: the account, its handle and phone, and a log out that asks first', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn());
    vi.mocked(api.telegramLogout).mockResolvedValue({ status: 'ok' });
    const { client } = renderWithClient(<TelegramSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    expect(await screen.findByText('Ribin Roy')).toBeInTheDocument();
    expect(screen.getByText('@ribin · +491234')).toBeInTheDocument();
    expect(screen.queryByText('Bot')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    fireEvent.click(dialog('Log out of Telegram?').getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(api.telegramLogout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['telegram'] }));
  });

  it('a refused log out is a toast', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn({ user: { ...user, first_name: null, last_name: null, phone: null } }));
    vi.mocked(api.telegramLogout).mockResolvedValue({ error: 'cannot' });
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    // No name: the handle stands in, and the phone line only carries the handle
    expect(await screen.findByText('ribin')).toBeInTheDocument();
    expect(screen.getByText('@ribin')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    fireEvent.click(dialog('Log out of Telegram?').getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('cannot'));
    capture.stop();
  });
});

describe('TelegramSettings - API credentials', () => {
  it('shows the saved id and where it came from; Edit opens the form, Cancel closes it', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status());
    vi.mocked(api.fetchTelegramApiConfig).mockResolvedValue(apiConfig({ source: 'env' }));
    renderWithClient(<TelegramSettings />);
    expect(await screen.findByText('123456')).toBeInTheDocument();
    expect(screen.getByText(/hash saved · from .env file/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByPlaceholderText('1234567')).toHaveValue('123456');
    // A saved hash can stay as it is
    expect(screen.getByPlaceholderText('(unchanged)')).not.toBeRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('1234567')).toBeNull();
    expect(screen.getByText(/stored in database|from .env file/)).toBeInTheDocument();
  });

  it('saves trimmed credentials and clears the hash field', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status());
    vi.mocked(api.saveTelegramApiConfig).mockResolvedValue({ ...apiConfig({ api_id: 999 }), status: 'ok' });
    const capture = captureToasts();
    const { client } = renderWithClient(<TelegramSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByPlaceholderText('1234567'), { target: { value: ' 999 ' } });
    fireEvent.change(screen.getByPlaceholderText('(unchanged)'), { target: { value: ' abc ' } });
    fireEvent.click(screen.getByRole('button', { name: /save credentials/i }));
    await waitFor(() => expect(api.saveTelegramApiConfig).toHaveBeenCalledWith('999', 'abc'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('API credentials saved — the client reconnected with them'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['telegram'] });
    capture.stop();
  });

  it('a refused save is a toast', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status());
    vi.mocked(api.saveTelegramApiConfig).mockResolvedValue({ ...apiConfig(), error: 'api_id must be a number' });
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByPlaceholderText('1234567'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save credentials/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('api_id must be a number'));
    capture.stop();
  });
});

describe('TelegramSettings - sign-in wizard', () => {
  it('phone -> code -> 2FA password, each step calling its own endpoint', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status());
    vi.mocked(api.sendTelegramCode).mockResolvedValue({ status: 'code_sent' });
    vi.mocked(api.verifyTelegramCode).mockResolvedValue({ status: 'password_required' });
    vi.mocked(api.verifyTelegramPassword).mockResolvedValue({ status: 'ok' });
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    expect(screen.getByText('Sign in to Telegram')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('+49123456789'), { target: { value: '+491234' } });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await waitFor(() => expect(api.sendTelegramCode).toHaveBeenCalledWith('+491234'));
    expect(await screen.findByText('Login code sent to +491234')).toBeInTheDocument();
    expect(capture.toasts.map(t => t.message)).toContain('Code sent — check your Telegram app (or SMS)');

    fireEvent.change(screen.getByPlaceholderText('12345'), { target: { value: '54321' } });
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));
    await waitFor(() => expect(api.verifyTelegramCode).toHaveBeenCalledWith('54321'));
    expect(await screen.findByText(/Two-factor password/)).toBeInTheDocument();

    const pw = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => expect(api.verifyTelegramPassword).toHaveBeenCalledWith('hunter2'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Connected to Telegram'));
    // Back at the phone step for next time
    expect(screen.getByPlaceholderText('+49123456789')).toBeInTheDocument();
    capture.stop();
  });

  it('a code that signs you straight in, and Back from the code step', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status());
    vi.mocked(api.sendTelegramCode).mockResolvedValue({ status: 'code_sent' });
    vi.mocked(api.verifyTelegramCode).mockResolvedValue({ status: 'ok' });
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    fireEvent.change(await screen.findByPlaceholderText('+49123456789'), { target: { value: '+1' } });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await screen.findByPlaceholderText('12345');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByPlaceholderText('+49123456789')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    fireEvent.change(await screen.findByPlaceholderText('12345'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Connected to Telegram'));
    capture.stop();
  });

  it('errors from each step are toasts and keep you on that step', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status());
    vi.mocked(api.sendTelegramCode).mockResolvedValueOnce({ error: 'PHONE_NUMBER_INVALID' }).mockResolvedValueOnce({ status: 'ok' });
    vi.mocked(api.verifyTelegramCode).mockResolvedValueOnce({ error: 'PHONE_CODE_INVALID' }).mockRejectedValueOnce(new Error('net'));
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    fireEvent.change(await screen.findByPlaceholderText('+49123456789'), { target: { value: '+1' } });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('PHONE_NUMBER_INVALID'));
    expect(screen.getByPlaceholderText('+49123456789')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    fireEvent.change(await screen.findByPlaceholderText('12345'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('PHONE_CODE_INVALID'));
    fireEvent.click(screen.getByRole('button', { name: /verify code/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to verify code'));
    capture.stop();
  });

  it('a bot token signs in through its own endpoint', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(status());
    vi.mocked(api.telegramBotLogin).mockResolvedValueOnce({ error: 'bad token' }).mockResolvedValueOnce({ status: 'ok' });
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bot token' }));
    const token = screen.getByPlaceholderText('123456789:AbCdEf...');
    fireEvent.change(token, { target: { value: '1:abc' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in as bot/i }));
    await waitFor(() => expect(api.telegramBotLogin).toHaveBeenCalledWith('1:abc'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('bad token'));
    fireEvent.click(screen.getByRole('button', { name: /sign in as bot/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Connected as bot'));
    expect(token).toHaveValue('');
    capture.stop();
  });
});

describe('TelegramSettings - monitored channels', () => {
  it('lists the channels; the client picker only appears once a torrent client exists', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn());
    renderWithClient(<TelegramSettings />);
    expect(await screen.findByText('Movies')).toBeInTheDocument();
    expect(screen.getByText('-100123')).toBeInTheDocument();
    expect(screen.queryByTitle('Torrent client for magnets posted in this channel')).toBeNull();
  });

  it('routes a channel\'s magnets to one client; only configured clients are offered', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn());
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig(false, true));
    vi.mocked(api.setChannelTorrentClient).mockResolvedValue({ channels: [{ ...channel, torrent_client: 'qbittorrent' }] });
    const { client } = renderWithClient(<TelegramSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const select = await screen.findByTitle('Torrent client for magnets posted in this channel');
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Default magnet client', 'qBittorrent']);
    fireEvent.change(select, { target: { value: 'qbittorrent' } });
    await waitFor(() => expect(api.setChannelTorrentClient).toHaveBeenCalledWith(-100123, 'qbittorrent'));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['telegram'] }));
  });

  it('a refused client change is a toast', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn({ channels: [{ ...channel, torrent_client: 'transmission' }] }));
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig(true, true));
    vi.mocked(api.setChannelTorrentClient).mockResolvedValue({ error: 'unknown chat' });
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    const select = await screen.findByTitle('Torrent client for magnets posted in this channel');
    expect(select).toHaveValue('transmission');
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(api.setChannelTorrentClient).toHaveBeenCalledWith(-100123, null));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('unknown chat'));
    capture.stop();
  });

  it('adds a channel by handle and clears the field', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn({ channels: [] }));
    vi.mocked(api.addTelegramChannel).mockResolvedValue({ channels: [channel] });
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    expect(await screen.findByText('No channels are being monitored yet.')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('@channelname, t.me link, or chat ID');
    const add = screen.getByRole('button', { name: /^add$/i });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: ' @movies ' } });
    fireEvent.click(add);
    await waitFor(() => expect(api.addTelegramChannel).toHaveBeenCalledWith('@movies'));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(capture.toasts.map(t => t.message)).toContain('Channel added — new files will be downloaded automatically');
    capture.stop();
  });

  it('a refused add is a toast and keeps the text', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn());
    vi.mocked(api.addTelegramChannel).mockResolvedValue({ error: 'No such chat' });
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    const input = await screen.findByPlaceholderText('@channelname, t.me link, or chat ID');
    fireEvent.change(input, { target: { value: '@nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('No such chat'));
    expect(input).toHaveValue('@nope');
    capture.stop();
  });

  it('removing a channel asks first', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn());
    vi.mocked(api.removeTelegramChannel).mockResolvedValue({ channels: [] });
    renderWithClient(<TelegramSettings />);
    fireEvent.click(await screen.findByTitle('Stop monitoring'));
    expect(screen.getByText(/New files posted in "Movies" will no longer be downloaded/)).toBeInTheDocument();
    fireEvent.click(dialog('Stop monitoring channel?').getByRole('button', { name: 'Cancel' }));
    expect(api.removeTelegramChannel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Stop monitoring'));
    fireEvent.click(dialog('Stop monitoring channel?').getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeTelegramChannel).toHaveBeenCalledWith(-100123));
  });

  it('browses the account\'s chats: users are left out, the filter narrows, Monitor adds by id', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn());
    vi.mocked(api.fetchTelegramDialogs).mockResolvedValue({ dialogs: [
      { id: -100123, title: 'Movies', type: 'channel', username: 'movies', monitored: true },
      { id: -200, title: 'Friends', type: 'group', username: null, monitored: false },
      { id: 7, title: 'Bob', type: 'user', username: 'bob', monitored: false },
    ] });
    vi.mocked(api.addTelegramChannel).mockResolvedValue({ channels: [channel, { id: -200, title: 'Friends' }] });
    vi.mocked(api.removeTelegramChannel).mockResolvedValue({ channels: [channel] });
    renderWithClient(<TelegramSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /browse my channels/i }));
    await waitFor(() => expect(api.fetchTelegramDialogs).toHaveBeenCalled());
    expect(await screen.findByText('Friends')).toBeInTheDocument();
    expect(screen.getByText('channel · @movies')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).toBeNull();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Filter chats...'), { target: { value: 'zzz' } });
    expect(screen.getByText('No channels or groups found.')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Filter chats...'), { target: { value: 'fri' } });
    fireEvent.click(screen.getByRole('button', { name: 'Monitor' }));
    await waitFor(() => expect(api.addTelegramChannel).toHaveBeenCalledWith('-200'));
    // Marked monitored in place, without reloading the dialogs
    await waitFor(() => expect(screen.getAllByText('Monitoring')).toHaveLength(1));
    expect(api.fetchTelegramDialogs).toHaveBeenCalledTimes(1);

    // Removing a channel flips it back in the picker too
    fireEvent.change(screen.getByPlaceholderText('Filter chats...'), { target: { value: '' } });
    fireEvent.click(screen.getAllByTitle('Stop monitoring')[0]);
    fireEvent.click(dialog('Stop monitoring channel?').getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeTelegramChannel).toHaveBeenCalledWith(-100123));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Monitor' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(api.fetchTelegramDialogs).toHaveBeenCalledTimes(2));
  });

  it('a failed chat listing is a toast', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn());
    vi.mocked(api.fetchTelegramDialogs).mockResolvedValueOnce({ error: 'FLOOD_WAIT' }).mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    renderWithClient(<TelegramSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /browse my channels/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('FLOOD_WAIT'));
    fireEvent.click(screen.getByRole('button', { name: /browse my channels/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to load your chats'));
    capture.stop();
  });

  it('a bot account gets the privacy warning and no chat browser', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue(signedIn({ user: { ...user, is_bot: true, phone: null } }));
    renderWithClient(<TelegramSettings />);
    expect(await screen.findByText('Bot')).toBeInTheDocument();
    expect(screen.getByText(/You are signed in as a bot/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /browse my channels/i })).toBeNull();
  });
});
