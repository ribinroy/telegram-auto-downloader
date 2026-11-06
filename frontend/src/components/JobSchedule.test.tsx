import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { JobSchedule } from './JobSchedule';

vi.mock('../api', () => ({ saveJobSchedule: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.saveJobSchedule).mockResolvedValue({} as Awaited<ReturnType<typeof api.saveJobSchedule>>);
});

const schedule = (over: Partial<api.JobSchedule> = {}): api.JobSchedule => ({
  enabled: true, time: '04:30', days: [0, 1, 2, 3, 4], last_run: null, last_status: null, last_summary: null, next_run: null, ...over,
});

const dayButton = (name: string) => screen.getByTitle(name);

describe('JobSchedule', () => {
  it('with no schedule yet: off, 03:00, every day, time input disabled', () => {
    renderWithClient(<JobSchedule jobId="check_files" schedule={undefined} tz="Europe/Berlin" />);
    expect(screen.getByRole('checkbox', { name: /run automatically/i })).not.toBeChecked();
    const time = document.querySelector('input[type="time"]') as HTMLInputElement;
    expect(time.value).toBe('03:00');
    expect(time).toBeDisabled();
    expect(screen.getByText('Every day')).toBeInTheDocument();
    expect(screen.getByText('Europe/Berlin')).toBeInTheDocument();
    expect(screen.queryByText(/next run/i)).toBeNull();
  });

  it('every control saves on change, as a patch for that one field', async () => {
    renderWithClient(<JobSchedule jobId="check_files" schedule={schedule({ enabled: false })} tz={null} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /run automatically/i }));
    await waitFor(() => expect(api.saveJobSchedule).toHaveBeenCalledWith('check_files', { enabled: true }));
  });

  it('changes the time and toggles weekdays', async () => {
    renderWithClient(<JobSchedule jobId="sync_thumbs" schedule={schedule()} tz={null} />);
    expect(screen.getByText('5 days a week')).toBeInTheDocument();
    fireEvent.change(document.querySelector('input[type="time"]')!, { target: { value: '22:15' } });
    await waitFor(() => expect(api.saveJobSchedule).toHaveBeenCalledWith('sync_thumbs', { time: '22:15' }));

    fireEvent.click(dayButton('Saturday'));
    await waitFor(() => expect(api.saveJobSchedule).toHaveBeenCalledWith('sync_thumbs', { days: [0, 1, 2, 3, 4, 5] }));
    fireEvent.click(dayButton('Monday'));
    await waitFor(() => expect(api.saveJobSchedule).toHaveBeenCalledWith('sync_thumbs', { days: [1, 2, 3, 4] }));
  });

  it('never saves an empty set of days - the server would reject it', async () => {
    renderWithClient(<JobSchedule jobId="j" schedule={schedule({ days: [6] })} tz={null} />);
    expect(screen.getByText('1 day a week')).toBeInTheDocument();
    expect(dayButton('Sunday')).toHaveClass('text-cyan-300');
    expect(dayButton('Monday')).not.toHaveClass('text-cyan-300');
    fireEvent.click(dayButton('Sunday'));
    await new Promise(r => setTimeout(r, 20));
    expect(api.saveJobSchedule).not.toHaveBeenCalled();
  });

  it('shows the next run only while enabled, and the last run with its outcome', () => {
    const { rerender } = renderWithClient(
      <JobSchedule jobId="j" schedule={schedule({ next_run: '2026-11-07T03:00:00', last_run: '2026-11-06T03:00:00', last_status: 'ok', last_summary: '12 checked' })} tz={null} />,
    );
    expect(screen.getByText(/next run:/i)).toBeInTheDocument();
    expect(screen.getByText(/last run:/i)).toHaveTextContent('— 12 checked');
    expect(screen.getByText('— 12 checked')).not.toHaveClass('text-red-400');

    rerender(<JobSchedule jobId="j" schedule={schedule({ enabled: false, next_run: '2026-11-07T03:00:00', last_run: '2026-11-06T03:00:00', last_status: 'error', last_summary: 'disk gone' })} tz={null} />);
    expect(screen.queryByText(/next run:/i)).toBeNull();
    expect(screen.getByText('— disk gone')).toHaveClass('text-red-400');
  });

  it('a failed save becomes a toast, not a row', async () => {
    vi.mocked(api.saveJobSchedule).mockRejectedValue(new Error('500'));
    const capture = captureToasts();
    renderWithClient(<JobSchedule jobId="j" schedule={schedule()} tz={null} />);
    fireEvent.click(dayButton('Friday'));
    await waitFor(() => expect(capture.titles()).toContain("Couldn't save the schedule"));
    expect(capture.toasts[0]).toMatchObject({ type: 'error', message: '500' });
    capture.stop();
  });
});
