import { describe, it, expect } from 'vitest';
import {
  isRemotePath, transferPercent, transferTitle, sortTransferFiles, type FileTransfer, type TransferFile,
} from './files';

describe('isRemotePath', () => {
  it('only matches the vps: scheme', () => {
    expect(isRemotePath('vps:/home6/user')).toBe(true);
    expect(isRemotePath('vps:~')).toBe(true);
    expect(isRemotePath('/mnt/newhdd')).toBe(false);
    expect(isRemotePath('')).toBe(false);
    expect(isRemotePath(null)).toBe(false);
    expect(isRemotePath(undefined)).toBe(false);
  });

  it('does not match a local path that merely contains vps', () => {
    expect(isRemotePath('/mnt/vps:backup')).toBe(false);
  });
});

const job = (over: Partial<FileTransfer> = {}): FileTransfer => ({
  id: 'j', move: false, paths: ['/a/Movies'], dest: '/mnt/hdd/Films', status: 'running',
  total_bytes: 200, done_bytes: 50, total_files: 2, done_files: 0, items_total: 1, items_done: 0,
  current_item: null, current_file: null, current_file_size: 0, current_file_done: 0,
  speed: 0, eta: null, started_at: 0, finished_at: null, results: [], errors: [], error: null,
  acknowledged: false, ...over,
});

describe('transferPercent', () => {
  it('goes by bytes while copying', () => {
    expect(transferPercent(job())).toBe(25);
  });
  it('goes by items when nothing is copied (a same-disk move)', () => {
    expect(transferPercent(job({ total_bytes: 0, done_bytes: 0, items_total: 4, items_done: 1 }))).toBe(25);
  });
  it('is full once finished, whatever the counters say', () => {
    expect(transferPercent(job({ status: 'failed' }))).toBe(100);
  });
});

describe('transferTitle', () => {
  it('names one item, counts several, and follows the tense', () => {
    expect(transferTitle(job())).toBe('Copying Movies to Films');
    expect(transferTitle(job({ move: true, status: 'done', paths: ['/x', '/y'] }))).toBe('Moved 2 items to Films');
  });
});

describe('sortTransferFiles', () => {
  const f = (rel: string, state: TransferFile['state']): TransferFile => ({ path: `/s/${rel}`, rel, size: 1, state, rename: false });
  it('puts the file being written first, then failures, what is left, and what is settled', () => {
    const files = [f('a', 'done'), f('b', 'pending'), f('c', 'failed'), f('d', 'copying'), f('e', 'pending'), f('g', 'skipped')];
    expect(sortTransferFiles(files).map(x => x.rel)).toEqual(['d', 'c', 'b', 'e', 'a', 'g']);
  });
});
