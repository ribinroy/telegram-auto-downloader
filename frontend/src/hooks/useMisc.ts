import { useMutation, useQuery } from '@tanstack/react-query';
import { login, updatePassword, checkUrl, fetchAnalytics } from '../api';
import { qk } from '../api/queryKeys';

// --- Auth (imperative) ---
export function useLogin() {
  return useMutation({ mutationFn: (vars: { username: string; password: string }) => login(vars.username, vars.password) });
}

export function useUpdatePassword() {
  return useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      updatePassword(vars.currentPassword, vars.newPassword),
  });
}

// --- URL check (imperative) ---
export function useCheckUrl() {
  return useMutation({ mutationFn: (url: string) => checkUrl(url) });
}

// --- Analytics ---
export function useAnalytics(days: number, groupBy: 'day' | 'hour', includeDeleted: boolean) {
  return useQuery({
    queryKey: qk.analytics(days, groupBy, includeDeleted),
    queryFn: () => fetchAnalytics(days, groupBy, includeDeleted),
  });
}
