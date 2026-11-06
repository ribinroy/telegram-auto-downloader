import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as vr from '../api/vr';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { VrSettings } from './VrSettings';

vi.mock('../api/vr', () => ({
  fetchVrSettings: vi.fn(), regenerateVrKey: vi.fn(), disableVrKey: vi.fn(), setVrIncludeSecured: vi.fn(),
}));

const off: vr.VrFeedSettings = { enabled: false, key: null, include_secured: false, created_at: null, urls: null };

// The confirm dialog's button shares its label with the card's own, so look inside the dialog
const dialog = (heading: string) =>
  within(screen.getByRole('heading', { name: heading }).closest('.bg-slate-800') as HTMLElement);
const on: vr.VrFeedSettings = {
  enabled: true, key: 'k1', include_secured: false, created_at: '2026-11-01T10:00:00Z',
  urls: { heresphere: 'http://box/vr/k1/heresphere', deovr: 'http://box/vr/k1/deovr' },
};

beforeEach(() => { vi.resetAllMocks(); });

describe('VrSettings', () => {
  it('with no key: says the feed is off and offers to enable it in one click', async () => {
    vi.mocked(vr.fetchVrSettings).mockResolvedValue(off);
    vi.mocked(vr.regenerateVrKey).mockResolvedValue(on);
    renderWithClient(<VrSettings />);
    // The same line shows while loading, so wait for the button to come alive
    const enable = screen.getByRole('button', { name: /enable the feed/i });
    expect(enable).toBeDisabled();
    await waitFor(() => expect(enable).toBeEnabled());
    expect(screen.getByText('No key yet - the feed is off.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull();
    expect(screen.queryByText(on.urls!.heresphere)).toBeNull();

    fireEvent.click(enable);
    // No confirmation needed - there is nothing to invalidate yet
    await waitFor(() => expect(vr.regenerateVrKey).toHaveBeenCalledWith(undefined));
    expect(await screen.findByText(on.urls!.heresphere)).toBeInTheDocument();
    expect(screen.getByText(on.urls!.deovr)).toBeInTheDocument();
    expect(screen.getByText(/^Created /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new key/i })).toBeInTheDocument();
  });

  it('a new key for a live feed asks first; cancelling changes nothing', async () => {
    vi.mocked(vr.fetchVrSettings).mockResolvedValue(on);
    vi.mocked(vr.regenerateVrKey).mockResolvedValue({ ...on, key: 'k2' });
    renderWithClient(<VrSettings />);
    await screen.findByText(on.urls!.heresphere);

    fireEvent.click(screen.getByRole('button', { name: /new key/i }));
    expect(screen.getByRole('heading', { name: 'Create a new key?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Create a new key?' })).toBeNull();
    expect(vr.regenerateVrKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /new key/i }));
    fireEvent.click(dialog('Create a new key?').getByRole('button', { name: 'New key' }));
    await waitFor(() => expect(vr.regenerateVrKey).toHaveBeenCalledTimes(1));
  });

  it('disabling asks, then drops the URLs', async () => {
    vi.mocked(vr.fetchVrSettings).mockResolvedValue(on);
    vi.mocked(vr.disableVrKey).mockResolvedValue(off);
    renderWithClient(<VrSettings />);
    await screen.findByText(on.urls!.heresphere);
    fireEvent.click(screen.getByRole('button', { name: /disable/i }));
    fireEvent.click(dialog('Disable the feed?').getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(vr.disableVrKey).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No key yet - the feed is off.')).toBeInTheDocument();
    expect(screen.queryByText(on.urls!.heresphere)).toBeNull();
  });

  it('the secured-sources box saves straight away', async () => {
    vi.mocked(vr.fetchVrSettings).mockResolvedValue(on);
    vi.mocked(vr.setVrIncludeSecured).mockResolvedValue({ ...on, include_secured: true });
    renderWithClient(<VrSettings />);
    const box = await screen.findByRole('checkbox', { name: /include secured sources/i });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(vr.setVrIncludeSecured).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /include secured sources/i })).toBeChecked());
  });

  it('copies a URL to the clipboard, and toasts when the clipboard refuses', async () => {
    vi.mocked(vr.fetchVrSettings).mockResolvedValue(on);
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const capture = captureToasts();
    renderWithClient(<VrSettings />);
    await screen.findByText(on.urls!.heresphere);
    const [copyHere, copyDeo] = screen.getAllByTitle('Copy');
    fireEvent.click(copyHere);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(on.urls!.heresphere));
    fireEvent.click(copyDeo);
    await waitFor(() => expect(capture.titles()).toContain('Copy failed'));
    capture.stop();
  });

  it('a failed load is a toast, not a row', async () => {
    vi.mocked(vr.fetchVrSettings).mockRejectedValue(new Error('boom'));
    const capture = captureToasts();
    renderWithClient(<VrSettings />);
    await waitFor(() => expect(capture.titles()).toContain('Could not load the VR settings'));
    expect(screen.queryByText('boom')).toBeNull();
    capture.stop();
  });
});
