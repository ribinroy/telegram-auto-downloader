import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { qk } from '../api/queryKeys';
import { RenameRulesSettings } from './RenameRulesSettings';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()),
  fetchRenameRules: vi.fn(), createRenameRule: vi.fn(), updateRenameRule: vi.fn(), deleteRenameRule: vi.fn(),
  reorderRenameRules: vi.fn(), testRenameRules: vi.fn(), applyRenameRules: vi.fn(),
}));

const rule = (over: Partial<api.RenameRule> = {}): api.RenameRule => ({
  id: 1, name: 'Dots to spaces', pattern: '(?<=\\w)[._](?=\\w)', replacement: ' ', enabled: true, position: 0,
  source: null, stop_on_match: false, ...over,
});
const dots = rule();
const tags = rule({ id: 2, name: null, pattern: '\\.1080p', replacement: '', position: 1, source: 'telegram', stop_on_match: true, enabled: false });

const previewOf = (changed: number, total: number, rows: { original: string; new: string }[] = []) => ({
  total, changed,
  results: rows.map(r => ({ ...r, changed: r.original !== r.new, applied: ['x'] })),
});

const planItem = (over: Partial<api.RenameApplyItem> = {}): api.RenameApplyItem => ({
  id: 1, from: 'A.Movie.mkv', to: 'A Movie.mkv', applied: ['Dots to spaces'], source: null, status: 'would_rename', ...over,
});
const applyResult = (over: Partial<api.RenameApplyResult> = {}): api.RenameApplyResult => ({
  dry_run: true, total: 2, renamed: 0, skipped: 0, failed: 0,
  items: [planItem(), planItem({ id: 2, from: 'gone.mkv', to: 'gone.mkv', status: 'missing' })], ...over,
});

const pattern = () => screen.getByPlaceholderText('\\.(1080p|720p)');
const replacement = () => screen.getByPlaceholderText('(empty to remove)');
const ruleName = () => screen.getByPlaceholderText('Rule name (optional)');
const dialog = (heading: string) =>
  within(screen.getByRole('heading', { name: heading }).closest('.bg-slate-800') as HTMLElement);

beforeEach(() => {
  vi.resetAllMocks();
  // The saved-chain preview is `testRenameRules()`; the editor's is `testRenameRules(draft)`
  vi.mocked(api.testRenameRules).mockImplementation(async (draft) =>
    draft ? previewOf(1, 3, [{ original: 'A.Movie.mkv', new: 'A Movie.mkv' }])
      : previewOf(2, 10, [{ original: 'A.Movie.mkv', new: 'A Movie.mkv' }, { original: 'same.mkv', new: 'same.mkv' }, { original: 'B.Show.mkv', new: 'B Show.mkv' }]));
  vi.mocked(api.createRenameRule).mockResolvedValue({ rules: [dots] });
  vi.mocked(api.updateRenameRule).mockResolvedValue({ rules: [dots] });
  vi.mocked(api.deleteRenameRule).mockResolvedValue({ rules: [] });
  vi.mocked(api.reorderRenameRules).mockResolvedValue({ rules: [tags, dots] });
});

describe('RenameRulesSettings - listing', () => {
  it('loads, then lists the rules with their badges and the effect on the library', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [dots, tags] });
    renderWithClient(<RenameRulesSettings />);
    expect(screen.getByText('Loading rules...')).toBeInTheDocument();
    expect(await screen.findByText('Dots to spaces')).toBeInTheDocument();
    // A nameless rule is listed by its pattern; source and stop badges
    expect(screen.getAllByText('\\.1080p').length).toBeGreaterThan(0);
    expect(screen.getByText('telegram')).toBeInTheDocument();
    expect(screen.getByText('stops')).toBeInTheDocument();
    expect(screen.getByText('(removed)')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    // The saved chain's preview, over real filenames
    expect(await screen.findByText('2 of 10 filenames in your library would be rewritten by these rules.')).toBeInTheDocument();
    expect(screen.getByText('A Movie.mkv')).toBeInTheDocument();
    expect(screen.getByText('B Show.mkv')).toBeInTheDocument();
    expect(screen.queryByText('same.mkv')).toBeNull();
    expect(api.testRenameRules).toHaveBeenCalledWith();
  });

  it('with no rules: says so, offers the presets, and never runs the preview', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [] });
    renderWithClient(<RenameRulesSettings />);
    expect(await screen.findByText(/No rules yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument();
    // Presets in chain order
    const presets = screen.getAllByRole('button').filter(b => b.className.includes('bg-slate-700/50')).map(b => b.textContent);
    expect(presets).toEqual(['Drop leading tag / site', 'Strip quality tags', 'Dots to spaces', 'Drop release group', 'Year in brackets']);
    expect(screen.queryByText('Effect on new downloads')).toBeNull();
    expect(api.testRenameRules).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /preview changes/i })).toBeDisabled();
  });
});

describe('RenameRulesSettings - editor', () => {
  it('a new rule: save waits for a pattern, previews the draft alone, then saves and refreshes', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [] });
    const { client } = renderWithClient(<RenameRulesSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: /add rule/i }));
    expect(screen.queryByText(/No rules yet/)).toBeNull();
    const save = screen.getByRole('button', { name: /save rule/i });
    const preview = screen.getByRole('button', { name: /^preview$/i });
    expect(save).toBeDisabled();
    expect(preview).toBeDisabled();

    fireEvent.change(ruleName(), { target: { value: 'Spaces' } });
    fireEvent.change(pattern(), { target: { value: '_' } });
    fireEvent.change(replacement(), { target: { value: ' ' } });
    fireEvent.click(screen.getByLabelText('Stop after this rule'));
    fireEvent.change(screen.getByPlaceholderText('all sources'), { target: { value: 'vps' } });
    expect(save).toBeEnabled();

    fireEvent.click(preview);
    const draft: api.RenameRuleInput = { name: 'Spaces', pattern: '_', replacement: ' ', enabled: true, source: 'vps', stop_on_match: true };
    await waitFor(() => expect(api.testRenameRules).toHaveBeenCalledWith(draft));
    expect(await screen.findByText('Matches 1 file — showing the first 1:')).toBeInTheDocument();
    expect(screen.getByText('A Movie.mkv')).toBeInTheDocument();

    fireEvent.click(save);
    await waitFor(() => expect(api.createRenameRule).toHaveBeenCalledWith(draft));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.renameRules() }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rename-preview'] });
    await waitFor(() => expect(screen.queryByPlaceholderText('Rule name (optional)')).toBeNull());
  });

  it('a preview with no match says so; a bad regex shows the server error', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [] });
    vi.mocked(api.testRenameRules)
      .mockResolvedValueOnce(previewOf(0, 42))
      .mockRejectedValueOnce(new Error('unterminated character set'));
    renderWithClient(<RenameRulesSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /add rule/i }));
    fireEvent.change(pattern(), { target: { value: 'zzz' } });
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(await screen.findByText('No match in any of your 42 filenames')).toBeInTheDocument();
    fireEvent.change(pattern(), { target: { value: '[' } });
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(await screen.findByText('unterminated character set')).toBeInTheDocument();
  });

  it('a refused save stays inline next to the fields', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [] });
    vi.mocked(api.createRenameRule).mockRejectedValue(new Error('invalid backreference \\3'));
    renderWithClient(<RenameRulesSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /add rule/i }));
    fireEvent.change(pattern(), { target: { value: '(a)' } });
    fireEvent.change(replacement(), { target: { value: '\\3' } });
    fireEvent.click(screen.getByRole('button', { name: /save rule/i }));
    expect(await screen.findByText('invalid backreference \\3')).toBeInTheDocument();
    expect(pattern()).toHaveValue('(a)');
  });

  it('a preset seeds the draft; cancel drops it', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [] });
    renderWithClient(<RenameRulesSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Year in brackets' }));
    expect(ruleName()).toHaveValue('Year in brackets');
    expect(pattern()).toHaveValue('[.\\s](19|20)(\\d{2})\\b');
    expect(replacement()).toHaveValue(' (\\1\\2)');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Rule name (optional)')).toBeNull();
    expect(api.createRenameRule).not.toHaveBeenCalled();
  });

  it('editing an existing rule prefills and updates it in place', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [dots, tags] });
    renderWithClient(<RenameRulesSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Dots to spaces/ }));
    expect(ruleName()).toHaveValue('Dots to spaces');
    expect(pattern()).toHaveValue('(?<=\\w)[._](?=\\w)');
    // The other row is still listed as a row, not an editor
    expect(screen.getByText('stops')).toBeInTheDocument();
    fireEvent.change(replacement(), { target: { value: '-' } });
    fireEvent.click(screen.getByRole('button', { name: /save rule/i }));
    await waitFor(() => expect(api.updateRenameRule).toHaveBeenCalledWith(1, {
      name: 'Dots to spaces', pattern: '(?<=\\w)[._](?=\\w)', replacement: '-', enabled: true, source: null, stop_on_match: false,
    }));
  });
});

describe('RenameRulesSettings - order, toggle, delete', () => {
  it('the arrows swap neighbours and send the new id order', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [dots, tags] });
    renderWithClient(<RenameRulesSettings />);
    await screen.findByText('Dots to spaces');
    const ups = screen.getAllByRole('button', { name: 'Move up' });
    const downs = screen.getAllByRole('button', { name: 'Move down' });
    expect(ups[0]).toBeDisabled();
    expect(downs[1]).toBeDisabled();
    fireEvent.click(downs[0]);
    await waitFor(() => expect(api.reorderRenameRules).toHaveBeenCalledWith([2, 1]));
    fireEvent.click(ups[1]);
    await waitFor(() => expect(api.reorderRenameRules).toHaveBeenCalledTimes(2));
  });

  it('the checkbox flips enabled and sends the whole rule back', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [tags] });
    renderWithClient(<RenameRulesSettings />);
    fireEvent.click(await screen.findByTitle('Enable'));
    await waitFor(() => expect(api.updateRenameRule).toHaveBeenCalledWith(2, {
      name: '', pattern: '\\.1080p', replacement: '', enabled: true, source: 'telegram', stop_on_match: true,
    }));
  });

  it('delete asks, names the rule, and removes it', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [dots] });
    renderWithClient(<RenameRulesSettings />);
    await screen.findByText('Dots to spaces');
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }));
    expect(screen.getByText(/"Dots to spaces" will no longer be applied/)).toBeInTheDocument();
    fireEvent.click(dialog('Delete this rule?').getByRole('button', { name: 'Cancel' }));
    expect(api.deleteRenameRule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }));
    fireEvent.click(dialog('Delete this rule?').getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteRenameRule).toHaveBeenCalledWith(1));
  });
});

describe('RenameRulesSettings - apply to existing files', () => {
  it('a dry run is required: the rename button only appears with a plan, and the plan is listed', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [dots] });
    vi.mocked(api.applyRenameRules).mockResolvedValue(applyResult());
    const { client } = renderWithClient(<RenameRulesSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByText('Dots to spaces');
    expect(screen.queryByRole('button', { name: /rename \d+ file/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    await waitFor(() => expect(api.applyRenameRules).toHaveBeenCalledWith(true));
    expect(await screen.findByRole('button', { name: 'Rename 2 files' })).toBeInTheDocument();
    expect(screen.getByText('file not found on disk')).toBeInTheDocument();
    expect(screen.getByText('gone.mkv')).toBeInTheDocument();
    // A dry run changes nothing, so nothing is refreshed
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['downloads'] });

    vi.mocked(api.applyRenameRules).mockResolvedValue(applyResult({ dry_run: false, renamed: 1, skipped: 1, failed: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename 2 files' }));
    expect(screen.getByText(/2 files will be renamed on disk/)).toBeInTheDocument();
    fireEvent.click(dialog('Rename existing files?').getByRole('button', { name: 'Rename them' }));
    await waitFor(() => expect(api.applyRenameRules).toHaveBeenCalledWith(false));
    expect(await screen.findByText('Renamed 1 file, skipped 1 (not found on disk).')).toBeInTheDocument();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] }));
    // The plan is spent
    expect(screen.queryByRole('button', { name: 'Rename 2 files' })).toBeNull();
  });

  it('reports failures after a run, and an empty plan says there is nothing to do', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [dots] });
    vi.mocked(api.applyRenameRules)
      .mockResolvedValueOnce(applyResult({ total: 1, items: [planItem()] }))
      .mockResolvedValueOnce(applyResult({ dry_run: false, total: 1, renamed: 0, failed: 1, items: [] }))
      .mockResolvedValueOnce(applyResult({ total: 0, items: [] }));
    renderWithClient(<RenameRulesSettings />);
    await screen.findByText('Dots to spaces');
    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename 1 file' }));
    fireEvent.click(dialog('Rename existing files?').getByRole('button', { name: 'Rename them' }));
    expect(await screen.findByText('Renamed 0 files, 1 failed.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    expect(await screen.findByText(/Nothing to rename/)).toBeInTheDocument();
    expect(screen.queryByText('Renamed 0 files, 1 failed.')).toBeNull();
    expect(screen.queryByRole('button', { name: /rename \d+ file/i })).toBeNull();
  });

  it('editing a rule drops a stale plan', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [dots] });
    vi.mocked(api.applyRenameRules).mockResolvedValue(applyResult());
    renderWithClient(<RenameRulesSettings />);
    await screen.findByText('Dots to spaces');
    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    await screen.findByRole('button', { name: 'Rename 2 files' });
    fireEvent.click(screen.getByTitle('Disable'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rename 2 files' })).toBeNull());
  });
});
