import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { qk } from '../api/queryKeys';
import type { SourceMapping } from '../types';
import { SourcesSettings } from './SourcesSettings';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()),
  fetchMappings: vi.fn(), createMapping: vi.fn(), updateMapping: vi.fn(), deleteMapping: vi.fn(),
}));

// The folder picker is its own component with its own tests; here it is a
// stub that hands back a path, so the wiring (which field gets filled) is
// what gets tested.
vi.mock('./FolderBrowser', () => ({
  FolderBrowser: ({ isOpen, onConfirm, onClose, title, initialPath }: {
    isOpen: boolean; onConfirm: (p: string[]) => void; onClose: () => void; title?: string; initialPath?: string | null;
  }) => isOpen ? (
    <div data-testid="browser" data-initial={initialPath ?? ''}>
      <span>{title}</span>
      <button onClick={() => onConfirm(['/mnt/picked'])}>pick</button>
      <button onClick={onClose}>close browser</button>
    </div>
  ) : null,
}));

const mapping = (over: Partial<SourceMapping> = {}): SourceMapping => ({
  id: 1, downloaded_from: 'youtube.com', is_secured: false, folder: '/data/yt', quality: '1080p',
  created_at: null, updated_at: null, ...over,
});
const yt = mapping();
const tg = mapping({ id: 2, downloaded_from: 'telegram', folder: null, quality: null, is_secured: true });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.createMapping).mockResolvedValue(yt);
  vi.mocked(api.updateMapping).mockResolvedValue(yt);
  vi.mocked(api.deleteMapping).mockResolvedValue(undefined);
});

describe('SourcesSettings - listing', () => {
  it('spins, then lists each source with its quality, folder and hidden state', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([yt, tg]);
    const { container } = renderWithClient(<SourcesSettings />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(await screen.findByText('youtube.com')).toBeInTheDocument();
    expect(screen.getByText('1080p')).toBeInTheDocument();
    expect(screen.getByText('/data/yt')).toBeInTheDocument();
    expect(screen.getByText('telegram')).toBeInTheDocument();
    expect(screen.getByText('default folder')).toBeInTheDocument();
    expect(screen.getByTitle('Visible (click to hide)')).toBeInTheDocument();
    expect(screen.getByTitle('Hidden from the default view (click to show)')).toBeInTheDocument();
  });

  it('with none: says downloads use the defaults', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([]);
    renderWithClient(<SourcesSettings />);
    expect(await screen.findByText(/No sources configured/)).toBeInTheDocument();
  });
});

describe('SourcesSettings - add', () => {
  it('adds a source lowercased, blanks as null, and tells the parent', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([]);
    const onChange = vi.fn();
    const { client } = renderWithClient(<SourcesSettings onChange={onChange} />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByText(/No sources configured/);
    expect(screen.queryByPlaceholderText(/Source \(e.g./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    const add = screen.getByRole('button', { name: /^add$/i });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Source \(e.g./), { target: { value: ' Vimeo.COM ' } });
    expect(add).toBeEnabled();
    fireEvent.change(screen.getByPlaceholderText(/Default quality/), { target: { value: ' 720p ' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(add);
    await waitFor(() => expect(api.createMapping).toHaveBeenCalledWith({
      downloaded_from: 'vimeo.com', folder: null, quality: '720p', is_secured: true,
    }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.mappings() }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // The form closes and resets
    expect(screen.queryByPlaceholderText(/Source \(e.g./)).toBeNull();
  });

  it('the picker fills the folder field of the add form', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([]);
    renderWithClient(<SourcesSettings />);
    await screen.findByText(/No sources configured/);
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse folders' }));
    expect(screen.getByText('Select a destination folder for this source')).toBeInTheDocument();
    fireEvent.click(screen.getByText('pick'));
    expect(screen.getByPlaceholderText(/Folder \(e.g./)).toHaveValue('/mnt/picked');
    expect(screen.queryByTestId('browser')).toBeNull();
  });

  it('a refused add is a toast and the form stays', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([]);
    vi.mocked(api.createMapping).mockResolvedValue({ error: 'already exists' });
    const capture = captureToasts();
    renderWithClient(<SourcesSettings />);
    await screen.findByText(/No sources configured/);
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    fireEvent.change(screen.getByPlaceholderText(/Source \(e.g./), { target: { value: 'youtube.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(capture.titles()).toContain('Sources'));
    expect(capture.toasts[0].message).toBe('already exists');
    expect(screen.getByPlaceholderText(/Source \(e.g./)).toHaveValue('youtube.com');
    capture.stop();
  });

  it('an add that throws is a generic toast', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([]);
    vi.mocked(api.createMapping).mockRejectedValue(new Error('boom'));
    const capture = captureToasts();
    renderWithClient(<SourcesSettings />);
    await screen.findByText(/No sources configured/);
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    fireEvent.change(screen.getByPlaceholderText(/Source \(e.g./), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to add source'));
    capture.stop();
  });
});

describe('SourcesSettings - edit, hide, delete', () => {
  it('the eye toggles is_secured and tells the parent', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([yt]);
    const onChange = vi.fn();
    renderWithClient(<SourcesSettings onChange={onChange} />);
    fireEvent.click(await screen.findByTitle('Visible (click to hide)'));
    await waitFor(() => expect(api.updateMapping).toHaveBeenCalledWith(1, { is_secured: true }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('a refused hide is a toast', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([yt]);
    vi.mocked(api.updateMapping).mockResolvedValue({ error: 'nope' });
    const capture = captureToasts();
    renderWithClient(<SourcesSettings />);
    fireEvent.click(await screen.findByTitle('Visible (click to hide)'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('nope'));
    capture.stop();
  });

  it('inline edit: prefilled, the picker fills the folder, save sends folder + quality', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([yt]);
    const onChange = vi.fn();
    renderWithClient(<SourcesSettings onChange={onChange} />);
    fireEvent.click(await screen.findByTitle('Edit source'));
    expect(screen.getByPlaceholderText('Folder')).toHaveValue('/data/yt');
    expect(screen.getByPlaceholderText('Quality')).toHaveValue('1080p');
    expect(screen.queryByTitle('Edit source')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Browse folders' }));
    expect(screen.getByTestId('browser')).toHaveAttribute('data-initial', '/data/yt');
    fireEvent.click(screen.getByText('pick'));
    expect(screen.getByPlaceholderText('Folder')).toHaveValue('/mnt/picked');
    fireEvent.change(screen.getByPlaceholderText('Quality'), { target: { value: '  ' } });
    // The save button is the check icon next to the cancel cross
    const row = screen.getByPlaceholderText('Folder').parentElement as HTMLElement;
    const buttons = within(row).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 2]);
    await waitFor(() => expect(api.updateMapping).toHaveBeenCalledWith(1, { folder: '/mnt/picked', quality: null }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByPlaceholderText('Folder')).toBeNull());
  });

  it('cancel leaves the edit without saving', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([yt]);
    renderWithClient(<SourcesSettings />);
    fireEvent.click(await screen.findByTitle('Edit source'));
    const row = screen.getByPlaceholderText('Folder').parentElement as HTMLElement;
    const buttons = within(row).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);
    expect(screen.queryByPlaceholderText('Folder')).toBeNull();
    expect(api.updateMapping).not.toHaveBeenCalled();
  });

  it('a refused edit is a toast and the row stays in edit mode', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([yt]);
    vi.mocked(api.updateMapping).mockResolvedValue({ error: 'folder not writable' });
    const capture = captureToasts();
    renderWithClient(<SourcesSettings />);
    fireEvent.click(await screen.findByTitle('Edit source'));
    const row = screen.getByPlaceholderText('Folder').parentElement as HTMLElement;
    const buttons = within(row).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 2]);
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('folder not writable'));
    expect(screen.getByPlaceholderText('Folder')).toBeInTheDocument();
    capture.stop();
  });

  it('deleting asks first, then removes the spec and tells the parent', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([yt]);
    const onChange = vi.fn();
    const { client } = renderWithClient(<SourcesSettings onChange={onChange} />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByTitle('Delete source'));
    expect(screen.getByRole('heading', { name: 'Delete source settings?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.deleteMapping).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Delete source'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteMapping).toHaveBeenCalledWith(1));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.mappings() }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('a delete that throws reports the reason', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([yt]);
    vi.mocked(api.deleteMapping).mockRejectedValue(new Error('in use by 3 downloads'));
    const capture = captureToasts();
    renderWithClient(<SourcesSettings />);
    fireEvent.click(await screen.findByTitle('Delete source'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('in use by 3 downloads'));
    capture.stop();
  });
});
