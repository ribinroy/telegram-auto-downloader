import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, renderHook, type RenderOptions, type RenderHookOptions } from '@testing-library/react';

// A QueryClient for one test: no retries (a failing fetcher should fail the
// first time, not after three backoffs). Garbage collection is off - a test
// seeds the cache with setQueryData and reads it back without an observer,
// which gcTime: 0 would drop on the next tick - and every test gets its own
// client, so nothing leaks between them anyway.
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

interface WrapperOptions {
  client?: QueryClient;
  /** Wrap in a MemoryRouter too (for components that call useNavigate/Link). */
  router?: boolean;
  initialEntries?: string[];
}

export function createWrapper({ client, router = false, initialEntries = ['/'] }: WrapperOptions = {}) {
  const qc = client ?? makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    const tree = <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    return router ? <MemoryRouter initialEntries={initialEntries}>{tree}</MemoryRouter> : tree;
  }
  return { Wrapper, client: qc };
}

/** renderHook with a fresh QueryClient; returns the client so a test can read
 *  or spy on the cache. */
export function renderHookWithClient<R, P = undefined>(
  hook: (props: P) => R,
  options: WrapperOptions & Omit<RenderHookOptions<P>, 'wrapper'> = {},
) {
  const { client, router, initialEntries, ...rest } = options;
  const { Wrapper, client: qc } = createWrapper({ client, router, initialEntries });
  const result = renderHook(hook, { wrapper: Wrapper, ...rest });
  return { ...result, client: qc };
}

/** render() with a fresh QueryClient (and optionally a MemoryRouter). */
export function renderWithClient(
  ui: ReactNode,
  options: WrapperOptions & Omit<RenderOptions, 'wrapper'> = {},
) {
  const { client, router, initialEntries, ...rest } = options;
  const { Wrapper, client: qc } = createWrapper({ client, router, initialEntries });
  const result = render(ui, { wrapper: Wrapper, ...rest });
  return { ...result, client: qc };
}
