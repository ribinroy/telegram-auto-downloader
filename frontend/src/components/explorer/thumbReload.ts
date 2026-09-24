import type { ThumbState } from '../../api/files';

/** Which previews to reload after a status poll.
 *
 *  A path is bumped when it moves into a servable state from anything else:
 *  'quick' -> 'ready' is the sheet replacing the first pass, and
 *  'pending'/'waiting' -> 'quick'/'ready' rescues a cell that gave up and fell
 *  back to its icon while the server was still busy. The first poll bumps
 *  nothing - the <img> tags are already loading whatever is there. */
export function thumbsToReload(
  prev: Record<string, ThumbState> | null,
  next: Record<string, ThumbState>,
): string[] {
  if (!prev) return [];
  return Object.keys(next).filter(path => {
    const before = prev[path];
    const after = next[path];
    if (!before || before === after) return false;
    return after === 'ready' || (after === 'quick' && before !== 'ready');
  });
}
