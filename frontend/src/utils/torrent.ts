/** The top folder every file sits in, if they all share one - the torrent's
 *  own folder. Not the torrent's name: a client can rename the torrent while
 *  the folder on disk keeps its original name. */
export function commonRoot(paths: string[]): string | null {
  if (!paths.length || !paths.every(p => p.includes('/'))) return null;
  const first = paths[0].slice(0, paths[0].indexOf('/'));
  return paths.every(p => p.startsWith(`${first}/`)) ? first : null;
}
