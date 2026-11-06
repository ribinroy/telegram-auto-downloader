import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import * as api from '../api';
import type { AnalyticsData } from '../types';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { AnalyticsPage } from './AnalyticsPage';

vi.mock('../api', async (orig) => ({ ...(await orig<typeof api>()), fetchAnalytics: vi.fn() }));

// Recharts measures its container, which jsdom cannot size, so the charts are
// stand-ins that print what they were given: the rows of a pie, and an axis's
// ticks through the page's own formatter.
vi.mock('recharts', async () => {
  const { createContext, useContext } = await import('react');
  type Row = Record<string, unknown>;
  const Data = createContext<Row[]>([]);
  const Chart = ({ data, children }: { data?: Row[]; children?: ReactNode }) =>
    <Data.Provider value={data ?? []}><div data-testid="chart">{children}</div></Data.Provider>;
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Pass, PieChart: Pass, AreaChart: Chart, BarChart: Chart,
    YAxis: Nothing, CartesianGrid: Nothing, Area: Nothing, Bar: Nothing, Cell: Nothing,
    XAxis: ({ dataKey, tickFormatter }: { dataKey: string; tickFormatter?: (v: never, i: number) => string }) => {
      const data = useContext(Data);
      return <div data-testid={`axis-${dataKey}`}>{data.map((d, i) => (tickFormatter ? tickFormatter(d[dataKey] as never, i) : String(d[dataKey]))).join('|')}</div>;
    },
    Tooltip: ({ formatter }: { formatter?: (v: number, n: string) => [unknown, string] }) =>
      <div data-testid="tooltip">{formatter ? `${formatter(2048, 'count').join(',')};${formatter(2048, 'size').join(',')}` : ''}</div>,
    Legend: ({ formatter }: { formatter?: (v: string) => ReactNode }) => <div data-testid="legend">{formatter?.('legend')}</div>,
    Pie: ({ data, children }: { data: { name: string; value: number }[]; children?: ReactNode }) =>
      <ul data-testid="pie">{data.map(d => <li key={d.name}>{d.name}:{d.value}</li>)}{children}</ul>,
  };
});

const data = (over: Partial<AnalyticsData> = {}): AnalyticsData => ({
  time_series: [{ label: '2024-01-15', count: 3, size: 1024 }, { label: '2024-01-16', count: 1, size: 512 }],
  by_source: Array.from({ length: 8 }, (_, i) => ({ source: `s${i + 1}.com`, count: 8 - i, size: (8 - i) * 100 })),
  by_author: [{ author: 'Alice:123', count: 2, size: 100 }, { author: 'Bob', count: 1, size: 50 }, { author: 'trail:', count: 1, size: 1 }],
  by_status: { done: 5, failed: 1 },
  hourly_distribution: [{ hour: 0, count: 1 }, { hour: 13, count: 2 }],
  summary: { total_downloads: 6, total_size: 4096, completed: 5, failed: 1, success_rate: 83.3 },
  period_days: 30, group_by: 'day', ...over,
});

const pies = () => screen.getAllByTestId('pie').map(ul => within(ul).getAllByRole('listitem').map(li => li.textContent));
const card = (label: string) => screen.getByText(label, { selector: 'span' }).closest('.rounded-xl')!.querySelector('.font-bold')!;
let toasts: ReturnType<typeof captureToasts>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchAnalytics).mockResolvedValue(data());
  toasts = captureToasts();
});
afterEach(() => { toasts.stop(); });

describe('AnalyticsPage - loading and summary', () => {
  it('spins while loading, then shows the summary cards and the top-sources table', async () => {
    renderWithClient(<AnalyticsPage />);
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(api.fetchAnalytics).toHaveBeenCalledWith(30, 'day', false);
    await screen.findByText('Downloads Over Time');
    expect(card('Downloads')).toHaveTextContent('6');
    expect(card('Total Size')).toHaveTextContent('4.00 KB');
    expect(card('Completed')).toHaveTextContent('5');
    expect(card('Failed')).toHaveTextContent('1');
    expect(card('Success Rate')).toHaveTextContent('83.3%');
    expect(screen.getByText('Hourly Distribution (1 month)')).toBeInTheDocument();
  });

  it('the table lists at most ten sources with their average size', async () => {
    vi.mocked(api.fetchAnalytics).mockResolvedValue(data({
      by_source: [...Array.from({ length: 11 }, (_, i) => ({ source: `s${i}`, count: 2, size: 3000 })), { source: 'empty', count: 0, size: 0 }],
    }));
    renderWithClient(<AnalyticsPage />);
    await screen.findByText('Top Sources');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveTextContent('s0');
    expect(within(rows[0]).getAllByRole('cell').map(c => c.textContent)).toEqual(['s0', '2', '2.93 KB', '1.46 KB']);
    expect(screen.queryByText('empty')).toBeNull();
  });

  it('a source with no downloads averages to zero rather than dividing by it', async () => {
    vi.mocked(api.fetchAnalytics).mockResolvedValue(data({ by_source: [{ source: 'empty', count: 0, size: 0 }] }));
    renderWithClient(<AnalyticsPage />);
    const row = (await screen.findByText('empty')).closest('tr')!;
    expect(within(row).getAllByRole('cell').map(c => c.textContent)).toEqual(['empty', '0', '0 B', '0 B']);
  });

  it('a failed load says so in place and as a toast', async () => {
    vi.mocked(api.fetchAnalytics).mockRejectedValue(new Error('500'));
    renderWithClient(<AnalyticsPage />);
    expect(await screen.findByText('Failed to load analytics')).toBeInTheDocument();
    await waitFor(() => expect(toasts.titles()).toEqual(["Couldn't load analytics"]));
    expect(toasts.toasts[0].message).toBe('500');
    expect(screen.queryByText('Top Sources')).toBeNull();
  });
});

describe('AnalyticsPage - controls', () => {
  it('the period, grouping and deleted toggle feed the query and the hourly title', async () => {
    renderWithClient(<AnalyticsPage />);
    await screen.findByText('Top Sources');
    const [days, groupBy] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const titles: [string, string][] = [['7', '(1 week)'], ['1', '(1 day)'], ['90', '(90 days)'], ['0', '(All Time)'], ['30', '(1 month)']];
    for (const [value, title] of titles) {
      fireEvent.change(days, { target: { value } });
      await waitFor(() => expect(api.fetchAnalytics).toHaveBeenLastCalledWith(Number(value), 'day', false));
      expect(await screen.findByText(`Hourly Distribution ${title}`)).toBeInTheDocument();
    }
    fireEvent.change(groupBy, { target: { value: 'hour' } });
    await waitFor(() => expect(api.fetchAnalytics).toHaveBeenLastCalledWith(30, 'hour', false));
    fireEvent.click(screen.getByLabelText('Deleted'));
    await waitFor(() => expect(api.fetchAnalytics).toHaveBeenLastCalledWith(30, 'hour', true));
    expect(screen.getByLabelText('Deleted')).toBeChecked();
  });
});

describe('AnalyticsPage - what the charts are given', () => {
  it('the pies: top five sources plus Others, statuses capitalised, authors without their id', async () => {
    renderWithClient(<AnalyticsPage />);
    await screen.findByText('Top Sources');
    expect(pies()).toEqual([
      ['s1.com:8', 's2.com:7', 's3.com:6', 's4.com:5', 's5.com:4', 'Others:6'],
      ['Done:5', 'Failed:1'],
      ['Alice:2', 'Bob:1', 'trail::1'],
    ]);
    expect(screen.getAllByTestId('legend')[0]).toHaveTextContent('legend');
  });

  it('six sources or fewer are all listed, with no Others slice', async () => {
    vi.mocked(api.fetchAnalytics).mockResolvedValue(data({ by_source: data().by_source.slice(0, 6) }));
    renderWithClient(<AnalyticsPage />);
    await screen.findByText('Top Sources');
    expect(pies()[0]).toEqual(['s1.com:8', 's2.com:7', 's3.com:6', 's4.com:5', 's5.com:4', 's6.com:3']);
  });

  it('axis ticks go through the day / hour formatters, and the tooltip names count and size', async () => {
    renderWithClient(<AnalyticsPage />);
    await screen.findByText('Top Sources');
    // A bare date parses as UTC midnight, so the local day may be the one before
    expect(screen.getByTestId('axis-label')).toHaveTextContent(/^Jan 1[45]\|Jan 1[56]$/);
    expect(screen.getByTestId('axis-hour')).toHaveTextContent('00:00|13:00');
    expect(screen.getAllByTestId('tooltip')[0]).toHaveTextContent('2048,Downloads;2.00 KB,Size');
    expect(screen.getAllByTestId('tooltip').at(-1)).toHaveTextContent('2048,Downloads;2048,Downloads');

    vi.mocked(api.fetchAnalytics).mockResolvedValue(data({ time_series: [{ label: '2024-01-15 14:05', count: 1, size: 1 }] }));
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'hour' } });
    await waitFor(() => expect(screen.getByTestId('axis-label')).toHaveTextContent('Jan 15 14:05'));
  });
});
