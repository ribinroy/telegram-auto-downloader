import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { qk } from '../api/queryKeys';
import { QueriesSettings } from './QueriesSettings';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()),
  fetchBotQueries: vi.fn(), saveBotQuery: vi.fn(), deleteBotQuery: vi.fn(), testBotQuery: vi.fn(),
}));

const health: api.BotQuery = { key: 'health', command: 'uptime' };
const disk: api.BotQuery = { key: 'disk', command: 'df -h "$DOWNLOAD_DIR"' };

const keyInput = () => screen.getByPlaceholderText('health');
const commandInput = () => screen.getByPlaceholderText('df -h "$DOWNLOAD_DIR" | tail -1');
const saveButton = () => screen.getByRole('button', { name: /save query/i });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.saveBotQuery).mockResolvedValue({ queries: [health] });
  vi.mocked(api.deleteBotQuery).mockResolvedValue({ queries: [] });
});

describe('QueriesSettings - listing', () => {
  it('spins, then shows the help, the queries and their commands', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [health, disk] });
    const { container } = renderWithClient(<QueriesSettings />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(await screen.findByText('health', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('uptime')).toBeInTheDocument();
    expect(screen.getByText('disk')).toBeInTheDocument();
    expect(screen.getByText('How to create a query snippet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add query/i })).toBeInTheDocument();
    expect(screen.queryByText('No queries configured yet.')).toBeNull();
  });

  it('with none: says so, until the editor opens', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [] });
    renderWithClient(<QueriesSettings />);
    expect(await screen.findByText('No queries configured yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add query/i }));
    expect(screen.queryByText('No queries configured yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: /add query/i })).toBeNull();
  });
});

describe('QueriesSettings - add / edit', () => {
  it('adds a query: the key is trimmed, the button waits for both fields, the list is refreshed', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [] });
    const { client } = renderWithClient(<QueriesSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: /add query/i }));
    expect(saveButton()).toBeDisabled();
    fireEvent.change(keyInput(), { target: { value: ' health ' } });
    expect(saveButton()).toBeDisabled();
    fireEvent.change(commandInput(), { target: { value: 'uptime' } });
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.saveBotQuery).toHaveBeenCalledWith('health', 'uptime', undefined));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.botQueries() }));
    // The editor closes on success
    await waitFor(() => expect(screen.queryByPlaceholderText('health')).toBeNull());
    expect(screen.getByRole('button', { name: /add query/i })).toBeInTheDocument();
  });

  it('a refused save is a toast and keeps the editor open', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [] });
    vi.mocked(api.saveBotQuery).mockResolvedValue({ error: '"help" is reserved' });
    const capture = captureToasts();
    renderWithClient(<QueriesSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /add query/i }));
    fireEvent.change(keyInput(), { target: { value: 'help' } });
    fireEvent.change(commandInput(), { target: { value: 'ls' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('"help" is reserved'));
    expect(keyInput()).toHaveValue('help');
    capture.stop();
  });

  it('a save that throws is a generic toast', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [] });
    vi.mocked(api.saveBotQuery).mockRejectedValue(new Error('boom'));
    const capture = captureToasts();
    renderWithClient(<QueriesSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /add query/i }));
    fireEvent.change(keyInput(), { target: { value: 'x' } });
    fireEvent.change(commandInput(), { target: { value: 'y' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to save query'));
    capture.stop();
  });

  it('editing prefills the form and sends the original key so a rename replaces the old row', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [health] });
    renderWithClient(<QueriesSettings />);
    await screen.findByText('health', { selector: 'span' });
    fireEvent.click(screen.getByTitle('Edit'));
    expect(keyInput()).toHaveValue('health');
    expect(commandInput()).toHaveValue('uptime');
    // While a row is being edited there is no second "add" entry point
    expect(screen.queryByRole('button', { name: /add query/i })).toBeNull();
    fireEvent.change(keyInput(), { target: { value: 'up' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.saveBotQuery).toHaveBeenCalledWith('up', 'uptime', 'health'));
  });

  it('cancel closes the editor without saving', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [health] });
    renderWithClient(<QueriesSettings />);
    await screen.findByText('health', { selector: 'span' });
    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('health')).toBeNull();
    expect(api.saveBotQuery).not.toHaveBeenCalled();
    expect(screen.getByText('uptime')).toBeInTheDocument();
  });
});

describe('QueriesSettings - run and delete', () => {
  it('runs the snippet and shows its output, which can be dismissed', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [health, disk] });
    vi.mocked(api.testBotQuery).mockResolvedValue({ output: 'up 3 days' });
    renderWithClient(<QueriesSettings />);
    await screen.findByText('health', { selector: 'span' });
    const [run] = screen.getAllByTitle('Run now');
    fireEvent.click(run);
    await waitFor(() => expect(api.testBotQuery).toHaveBeenCalledWith('uptime'));
    expect(await screen.findByText('up 3 days')).toBeInTheDocument();
    expect(screen.getByText('Output')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(screen.queryByText('up 3 days')).toBeNull();
  });

  it('shows the error, "(no output)", or a failure line in the output box', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [health] });
    vi.mocked(api.testBotQuery)
      .mockResolvedValueOnce({ error: 'exit 1' })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'));
    renderWithClient(<QueriesSettings />);
    await screen.findByText('health', { selector: 'span' });
    fireEvent.click(screen.getByTitle('Run now'));
    expect(await screen.findByText('exit 1')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Run now'));
    expect(await screen.findByText('(no output)')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Run now'));
    expect(await screen.findByText('Failed to run command')).toBeInTheDocument();
  });

  it('deleting asks first, names the key, then removes it', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [health] });
    const { client } = renderWithClient(<QueriesSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByText('health', { selector: 'span' });
    fireEvent.click(screen.getByTitle('Delete'));
    const heading = screen.getByRole('heading', { name: 'Delete query?' });
    expect(screen.getByText('The bot will stop responding to "health".')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(heading).not.toBeInTheDocument();
    expect(api.deleteBotQuery).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Delete'));
    const dialog = screen.getByRole('heading', { name: 'Delete query?' }).closest('.bg-slate-800') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteBotQuery).toHaveBeenCalledWith('health'));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.botQueries() }));
  });

  it('a refused delete is a toast', async () => {
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [health] });
    vi.mocked(api.deleteBotQuery).mockResolvedValue({ error: 'no such key' });
    const capture = captureToasts();
    renderWithClient(<QueriesSettings />);
    await screen.findByText('health', { selector: 'span' });
    fireEvent.click(screen.getByTitle('Delete'));
    const dialog = screen.getByRole('heading', { name: 'Delete query?' }).closest('.bg-slate-800') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('no such key'));
    capture.stop();
  });
});
