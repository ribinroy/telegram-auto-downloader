import { Clock, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import type { JobSchedule as Schedule } from '../api';
import { useSaveJobSchedule } from '../hooks/useSettings';

// Monday-first, matching the backend's datetime.weekday() (Monday = 0).
const DAYS = [
  { value: 0, short: 'M', label: 'Monday' },
  { value: 1, short: 'T', label: 'Tuesday' },
  { value: 2, short: 'W', label: 'Wednesday' },
  { value: 3, short: 'T', label: 'Thursday' },
  { value: 4, short: 'F', label: 'Friday' },
  { value: 5, short: 'S', label: 'Saturday' },
  { value: 6, short: 'S', label: 'Sunday' },
];

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

function when(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    day: 'numeric', month: 'short',
  });
}

/**
 * Per-job schedule: a time of day plus the weekdays it applies to.
 *
 * Every control saves on change - there is no Save button to forget, and the
 * server echoes back the recomputed next run.
 */
export function JobSchedule({
  jobId, schedule, tz,
}: { jobId: string; schedule: Schedule | undefined; tz: string | null }) {
  const save = useSaveJobSchedule();
  const days = schedule?.days ?? WEEKDAYS;
  const enabled = !!schedule?.enabled;
  const time = schedule?.time ?? '03:00';

  const patch = (update: { enabled?: boolean; time?: string; days?: number[] }) =>
    save.mutate({ jobId, update });

  const toggleDay = (value: number) => {
    const next = days.includes(value) ? days.filter(d => d !== value) : [...days, value].sort();
    // The server rejects an empty set; don't let the UI create one.
    if (!next.length) return;
    patch({ days: next });
  };

  return (
    <div className="mt-3 pt-3 border-t border-slate-600/50">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => patch({ enabled: e.target.checked })}
            className="w-4 h-4 rounded border-slate-500 bg-slate-800 text-cyan-500 focus:ring-cyan-500 cursor-pointer"
          />
          <span className="text-xs text-slate-300 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" /> Run automatically
          </span>
        </label>

        <div className="flex items-center gap-2">
          {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />}
          <input
            type="time"
            value={time}
            disabled={!enabled}
            onChange={e => e.target.value && patch({ time: e.target.value })}
            className="bg-slate-800 border border-slate-600 rounded-lg py-1 px-2 text-xs text-white focus:outline-none focus:border-cyan-500 disabled:opacity-40 cursor-pointer"
          />
          {tz && <span className="text-[11px] text-slate-500">{tz}</span>}
        </div>
      </div>

      <div className={`flex items-center gap-1.5 mt-2.5 ${enabled ? '' : 'opacity-40 pointer-events-none'}`}>
        {DAYS.map(day => (
          <button
            key={day.value}
            onClick={() => toggleDay(day.value)}
            title={day.label}
            className={`w-7 h-7 rounded-full text-[11px] font-medium transition-colors ${
              days.includes(day.value)
                ? 'bg-cyan-500/25 text-cyan-300 border border-cyan-500/50'
                : 'bg-slate-800 text-slate-500 border border-slate-700 hover:text-slate-300'
            }`}
          >
            {day.short}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-500">
          {days.length === 7 ? 'Every day' : `${days.length} day${days.length === 1 ? '' : 's'} a week`}
        </span>
      </div>

      {save.isError && (
        <p className="mt-2 text-[11px] text-red-400">{(save.error as Error).message}</p>
      )}

      <div className="mt-2 space-y-0.5">
        {enabled && schedule?.next_run && (
          <p className="text-[11px] text-slate-500">Next run: {when(schedule.next_run)}</p>
        )}
        {schedule?.last_run && (
          <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
            {schedule.last_status === 'error'
              ? <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
              : <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />}
            Last run: {when(schedule.last_run)}
            {schedule.last_summary && (
              <span className={schedule.last_status === 'error' ? 'text-red-400' : ''}>
                — {schedule.last_summary}
              </span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
