import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { stubReload } from '../test/http';
import { SettingsPage } from './SettingsPage';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()),
  fetchCookies: vi.fn(), saveCookies: vi.fn(), getYtdlpVersion: vi.fn(), upgradeYtdlp: vi.fn(), syncThumbnails: vi.fn(),
  checkFiles: vi.fn(), fetchJobSchedules: vi.fn(), updatePassword: vi.fn(), clearToken: vi.fn(),
}));

const layout = vi.hoisted(() => ({ refreshDownloads: vi.fn() }));
vi.mock('../components/Layout', () => ({ useLayoutContext: () => layout }));

// Every tab's panel is its own component with its own tests; here each is a
// stub, so what is under test is the page: which tab the URL opens, the
// panels it owns (password, cookies, jobs), and what it hands the children.
vi.mock('../components/VpsSettings', () => ({ VpsSettings: () => <div data-testid="panel-vps" /> }));
vi.mock('../components/SourcesSettings', () => ({
  SourcesSettings: ({ onChange }: { onChange?: () => void }) => <button data-testid="panel-sources" onClick={onChange}>sources</button>,
}));
vi.mock('../components/TelegramSettings', () => ({ TelegramSettings: () => <div data-testid="panel-telegram" /> }));
vi.mock('../components/QueriesSettings', () => ({ QueriesSettings: () => <div data-testid="panel-queries" /> }));
vi.mock('../components/UsersSettings', () => ({ UsersSettings: () => <div data-testid="panel-users" /> }));
vi.mock('../components/RenameRulesSettings', () => ({ RenameRulesSettings: () => <div data-testid="panel-renaming" /> }));
vi.mock('../components/SpeedTestSettings', () => ({ SpeedTestSettings: () => <div data-testid="panel-network" /> }));
vi.mock('../components/VrSettings', () => ({ VrSettings: () => <div data-testid="panel-vr" /> }));
vi.mock('../components/SessionsSettings', () => ({
  SessionsSettings: ({ onSignedOut }: { onSignedOut: () => void }) => <button data-testid="panel-sessions" onClick={onSignedOut}>sign out everywhere</button>,
}));
vi.mock('../components/JobSchedule', () => ({
  JobSchedule: ({ jobId, schedule, tz }: { jobId: string; schedule?: api.JobSchedule; tz: string | null }) => (
    <div data-testid={`job-${jobId}`}>{schedule?.time ?? 'none'}|{tz ?? 'no-tz'}</div>
  ),
}));

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}</output>;
}
const renderAt = (path: string) => renderWithClient(
  <>
    <Routes>
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/settings/:tab" element={<SettingsPage />} />
    </Routes>
    <LocationProbe />
  </>,
  { router: true, initialEntries: [path] },
);
const nav = () => within(screen.getByRole('navigation'));
const current = () => nav().getAllByRole('button').find(b => b.getAttribute('aria-current') === 'page')?.textContent;
const passwordFields = () => document.querySelectorAll<HTMLInputElement>('form input[type="password"]');

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchCookies).mockResolvedValue('# cookies');
  vi.mocked(api.getYtdlpVersion).mockResolvedValue({ version: '2026.01.01' });
  vi.mocked(api.fetchJobSchedules).mockResolvedValue({ tz: 'Europe/Berlin', schedules: {
    ytdlp_upgrade: { enabled: true, time: '04:00', days: [0], last_run: null, last_status: null, last_summary: null, next_run: null },
  } } as unknown as api.JobSchedulesResponse);
});

describe('SettingsPage - tab routing', () => {
  it('opens the tab named in the URL and marks it current', () => {
    renderAt('/settings/vps');
    expect(screen.getByTestId('panel-vps')).toBeInTheDocument();
    expect(current()).toContain('VPS Connection');
    // The VPS panel draws its own title row
    expect(screen.queryByRole('heading', { level: 2, name: 'VPS Connection' })).toBeNull();
    expect(passwordFields()).toHaveLength(0);
  });

  it('falls back to the password tab with no tab, or an unknown one', () => {
    const { unmount } = renderAt('/settings');
    expect(passwordFields()).toHaveLength(3);
    expect(current()).toContain('Password');
    expect(screen.getByRole('heading', { level: 2, name: 'Password' })).toBeInTheDocument();
    unmount();
    renderAt('/settings/bogus');
    expect(passwordFields()).toHaveLength(3);
    expect(current()).toContain('Password');
  });

  it('every sidebar entry navigates to its own URL and swaps the panel', async () => {
    renderAt('/settings');
    const expectTab = (label: string, tab: string, testId: string) => {
      fireEvent.click(nav().getByRole('button', { name: new RegExp(`^${label}`) }));
      expect(screen.getByTestId('location')).toHaveTextContent(`/settings/${tab}`);
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      expect(current()).toContain(label);
    };
    expectTab('Sources', 'sources', 'panel-sources');
    expectTab('Renaming', 'renaming', 'panel-renaming');
    expectTab('Telegram', 'telegram', 'panel-telegram');
    expectTab('Queries', 'queries', 'panel-queries');
    expectTab('Users', 'users', 'panel-users');
    expectTab('VR headset', 'vr', 'panel-vr');
    expectTab('Network', 'network', 'panel-network');
    fireEvent.click(nav().getByRole('button', { name: /^Cookies/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/cookies');
    expect(await screen.findByRole('button', { name: 'Save Cookies' })).toBeInTheDocument();
  });

  it('hands the Sources panel the shared downloads refresh', () => {
    renderAt('/settings/sources');
    fireEvent.click(screen.getByTestId('panel-sources'));
    expect(layout.refreshDownloads).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsPage - password', () => {
  const fill = (current: string, next: string, confirm: string) => {
    const [c, n, k] = passwordFields();
    fireEvent.change(c, { target: { value: current } });
    fireEvent.change(n, { target: { value: next } });
    fireEvent.change(k, { target: { value: confirm } });
  };

  it('refuses a mismatch or a short password before asking the server', async () => {
    const capture = captureToasts();
    renderAt('/settings/password');
    fill('old', 'longenough1', 'different');
    fireEvent.click(screen.getByRole('button', { name: 'Update Password' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('New passwords do not match'));
    fill('old', 'short', 'short');
    fireEvent.click(screen.getByRole('button', { name: 'Update Password' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Password must be at least 8 characters'));
    expect(api.updatePassword).not.toHaveBeenCalled();
    expect(capture.titles().every(t => t === "Couldn't change the password")).toBe(true);
    capture.stop();
  });

  it('changes the password, clears the form and toasts', async () => {
    vi.mocked(api.updatePassword).mockResolvedValue(undefined);
    const capture = captureToasts();
    renderAt('/settings/password');
    fill('old', 'longenough1', 'longenough1');
    fireEvent.click(screen.getByRole('button', { name: 'Update Password' }));
    await waitFor(() => expect(api.updatePassword).toHaveBeenCalledWith('old', 'longenough1'));
    await waitFor(() => expect(capture.titles()).toContain('Password updated'));
    expect([...passwordFields()].map(f => f.value)).toEqual(['', '', '']);
    capture.stop();
  });

  it('a refused change reports the server\'s reason', async () => {
    vi.mocked(api.updatePassword).mockRejectedValue(new Error('Current password is wrong'));
    const capture = captureToasts();
    renderAt('/settings/password');
    fill('old', 'longenough1', 'longenough1');
    fireEvent.click(screen.getByRole('button', { name: 'Update Password' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Current password is wrong'));
    capture.stop();
  });

  it('signing out everywhere clears the token and reloads', () => {
    const { reload, restore } = stubReload();
    renderAt('/settings/password');
    fireEvent.click(screen.getByTestId('panel-sessions'));
    expect(api.clearToken).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    restore();
  });
});

describe('SettingsPage - cookies', () => {
  it('loads the cookies only on its tab, into an editable box, and saves them', async () => {
    vi.mocked(api.saveCookies).mockResolvedValue({ status: 'ok' });
    const capture = captureToasts();
    renderAt('/settings/password');
    expect(api.fetchCookies).not.toHaveBeenCalled();
    fireEvent.click(nav().getByRole('button', { name: /^Cookies/ }));
    const box = await screen.findByRole('textbox');
    await waitFor(() => expect(box).toHaveValue('# cookies'));
    fireEvent.change(box, { target: { value: '# edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Cookies' }));
    await waitFor(() => expect(api.saveCookies).toHaveBeenCalledWith('# edited'));
    await waitFor(() => expect(capture.titles()).toContain('Cookies saved'));
    capture.stop();
  });

  it('a refused save, or one that throws, is a toast', async () => {
    vi.mocked(api.saveCookies).mockResolvedValueOnce({ error: 'not a cookie file' }).mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    renderAt('/settings/cookies');
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'Save Cookies' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('not a cookie file'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Cookies' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to save cookies'));
    capture.stop();
  });
});

describe('SettingsPage - jobs', () => {
  it('shows the yt-dlp version and each job\'s schedule with the server\'s timezone', async () => {
    renderAt('/settings/jobs');
    expect(screen.getByText('Checking version...')).toBeInTheDocument();
    expect(await screen.findByText('Current version: 2026.01.01')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('job-ytdlp_upgrade')).toHaveTextContent('04:00|Europe/Berlin'));
    expect(screen.getByTestId('job-sync_thumbnails')).toHaveTextContent('none|Europe/Berlin');
    expect(screen.getByTestId('job-check_files')).toHaveTextContent('none|Europe/Berlin');
  });

  it('upgrading yt-dlp toasts the version change, "up to date", or the error', async () => {
    vi.mocked(api.upgradeYtdlp)
      .mockResolvedValueOnce({ upgraded: true, old_version: '2026.01.01', new_version: '2026.02.01' })
      .mockResolvedValueOnce({ upgraded: false, new_version: '2026.02.01' })
      .mockResolvedValueOnce({ error: 'pip failed' })
      .mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    renderAt('/settings/jobs');
    const button = await screen.findByRole('button', { name: 'Upgrade yt-dlp' });
    fireEvent.click(button);
    await waitFor(() => expect(capture.titles()).toContain('yt-dlp upgraded'));
    expect(capture.toasts.at(-1)?.message).toBe('2026.01.01 → 2026.02.01');
    expect(await screen.findByText('Current version: 2026.02.01')).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(capture.toasts.at(-1)?.message).toBe('Already up to date (2026.02.01)'));
    expect(capture.toasts.at(-1)?.title).toBe('yt-dlp');
    fireEvent.click(button);
    await waitFor(() => expect(capture.toasts.at(-1)?.message).toBe('pip failed'));
    fireEvent.click(button);
    await waitFor(() => expect(capture.toasts.at(-1)?.message).toBe('Failed to upgrade yt-dlp'));
    capture.stop();
  });

  it('the thumbnail sync reports its stats inline, or that everything was in sync', async () => {
    const result = (over: Partial<api.SyncThumbnailsResult>): api.SyncThumbnailsResult => ({
      generated: 0, skipped: 0, orphan_deleted: 0, db_count_fixed: 0, meta_extracted: 0, failed: 0, no_duration: 0, not_video: 0,
      explorer_pruned: 0, explorer_kept: 0, explorer_freed: 0, ...over,
    } as api.SyncThumbnailsResult);
    vi.mocked(api.syncThumbnails)
      .mockResolvedValueOnce(result({ generated: 3, skipped: 10, orphan_deleted: 1, db_count_fixed: 2, meta_extracted: 4, failed: 1, no_duration: 1, not_video: 2, explorer_pruned: 5, explorer_freed: 2 * 1024 ** 2 }))
      .mockResolvedValueOnce(result({ skipped: 10 }))
      .mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    renderAt('/settings/jobs');
    const run = await screen.findByRole('button', { name: 'Run Sync' });
    fireEvent.click(run);
    expect(await screen.findByText('Sync complete')).toBeInTheDocument();
    expect(screen.getByText('Generated: 3')).toBeInTheDocument();
    expect(screen.getByText('Already had thumbs: 10')).toBeInTheDocument();
    expect(screen.getByText('Orphans deleted: 1')).toBeInTheDocument();
    expect(screen.getByText('DB counts fixed: 2')).toBeInTheDocument();
    expect(screen.getByText('Meta extracted: 4')).toBeInTheDocument();
    expect(screen.getByText('Failed: 1')).toBeInTheDocument();
    expect(screen.getByText('No duration: 1')).toBeInTheDocument();
    expect(screen.getByText('Not video: 2')).toBeInTheDocument();
    expect(screen.getByText('Explorer thumbs pruned: 5 (2.00 MB)')).toBeInTheDocument();
    fireEvent.click(run);
    expect(await screen.findByText('Everything is already in sync.')).toBeInTheDocument();
    fireEvent.click(run);
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to run thumbnail sync'));
    capture.stop();
  });

  it('the file check toasts a summary and refreshes the downloads', async () => {
    vi.mocked(api.checkFiles)
      .mockResolvedValueOnce({ checked: 10, present: 8, missing: 2, marked_missing: 2, restored: 1 })
      .mockResolvedValueOnce({ checked: 10, present: 10, missing: 0, marked_missing: 0, restored: 0 })
      .mockRejectedValueOnce(new Error('disk unreadable'));
    const capture = captureToasts();
    const { client } = renderAt('/settings/jobs');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const run = await screen.findByRole('button', { name: 'Run Check' });
    fireEvent.click(run);
    await waitFor(() => expect(capture.titles()).toContain('Files checked'));
    expect(capture.toasts.at(-1)?.message).toBe('8 of 10 on disk · 2 marked missing, 1 found again');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] }));
    fireEvent.click(run);
    await waitFor(() => expect(capture.toasts.at(-1)?.message).toBe('10 of 10 on disk · no changes'));
    fireEvent.click(run);
    await waitFor(() => expect(capture.titles()).toContain('File check failed'));
    expect(capture.toasts.at(-1)?.message).toBe('disk unreadable');
    capture.stop();
  });
});
