import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchFileRoots, listFiles, createFolder, renamePath, deletePaths, transferPaths,
  searchFiles, dirSize, readTextFile, uploadFiles,
} from '../api/files';
import { qk } from '../api/queryKeys';

// The explorer is a live view of a disk: anything could have changed since the
// last look, so listings are always stale and every mutation drops the whole
// ['files'] tree rather than trying to patch a row.
const LIVE = { staleTime: 0, gcTime: 60_000, refetchOnWindowFocus: true } as const;

export function useFileRoots() {
  return useQuery({ queryKey: qk.fileRoots(), queryFn: fetchFileRoots, staleTime: 30_000 });
}

export function useFileList(path: string, showHidden: boolean, autoRefreshMs = 0) {
  return useQuery({
    queryKey: qk.fileList(path, showHidden),
    queryFn: () => listFiles(path, showHidden),
    ...LIVE,
    refetchInterval: autoRefreshMs || false,
    placeholderData: prev => prev,
  });
}

export function useFileSearch(path: string, query: string, showHidden: boolean, enabled: boolean) {
  return useQuery({
    queryKey: qk.fileSearch(path, query, showHidden),
    queryFn: () => searchFiles(path, query, showHidden),
    enabled: enabled && query.trim().length >= 2,
    ...LIVE,
  });
}

export function useDirSize(path: string | null) {
  return useQuery({
    queryKey: qk.fileSize(path ?? ''),
    queryFn: () => dirSize(path as string),
    enabled: !!path,
    staleTime: 60_000,
  });
}

export function useFileText(path: string | null) {
  return useQuery({
    queryKey: qk.fileText(path ?? ''),
    queryFn: () => readTextFile(path as string),
    enabled: !!path,
    ...LIVE,
  });
}

function useInvalidateFiles() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['files'] });
}

export function useCreateFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (vars: { path: string; name: string }) => createFolder(vars.path, vars.name),
    onSuccess: invalidate,
  });
}

export function useRenamePath() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (vars: { path: string; name: string }) => renamePath(vars.path, vars.name),
    onSuccess: invalidate,
  });
}

export function useDeletePaths() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (vars: { paths: string[]; permanent?: boolean }) =>
      deletePaths(vars.paths, vars.permanent),
    onSuccess: invalidate,
  });
}

export function useTransferPaths() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (vars: { paths: string[]; dest: string; move: boolean }) =>
      transferPaths(vars.paths, vars.dest, vars.move),
    onSuccess: invalidate,
  });
}

export function useUploadFiles() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (vars: { dest: string; files: File[] }) => uploadFiles(vars.dest, vars.files),
    onSuccess: invalidate,
  });
}
