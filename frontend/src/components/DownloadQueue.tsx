import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ListOrdered, GripVertical, Zap, X, Minus, Plus, SlidersHorizontal, Loader2, EyeOff,
  Square, Play, Pause,
} from 'lucide-react';
import {
  useQueue, useSetQueueLimits, useReorderQueue, useStartQueuedNow, queueSourceOf,
  useStopAllDownloads, useResumeAllDownloads,
} from '../hooks/useQueue';
import { formatBytes, formatSpeed } from '../utils/format';
import { notify } from '../lib/notify';
import type { Download, QueueSource, QueueState } from '../types';

const SOURCE_LABEL: Record<QueueSource, string> = {
  telegram: 'Telegram',
  ytdlp: 'URL downloads',
  vps: 'VPS',
};

function sourceChip(d: Download) {
  const source = queueSourceOf(d);
  return source === 'ytdlp' ? d.downloaded_from : SOURCE_LABEL[source];
}

function SourceChip({ download }: { download: Download }) {
  return (
    <span className="hidden sm:inline shrink-0 max-w-[9rem] truncate text-[11px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400">
      {sourceChip(download)}
    </span>
  );
}

function Stepper({ value, min, max, onChange, label }: {
  value: number; min: number; max: number; onChange: (v: number) => void; label: string;
}) {
  return (
    <div className="flex items-center rounded-lg border border-slate-700 bg-slate-900/60" aria-label={label}>
      <button
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label={`Fewer ${label.toLowerCase()}`}
        className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
      >
        <Minus className="w-3.5 h-3.5" />
      </button>
      <span className="w-6 text-center text-sm tabular-nums text-white">{value}</span>
      <button
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={`More ${label.toLowerCase()}`}
        className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-4 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
      {children}
    </h3>
  );
}

function HiddenNote({ count, verb }: { count: number; verb: string }) {
  if (count <= 0) return null;
  return (
    <p className="flex items-center gap-1.5 px-4 py-2 text-xs text-slate-500">
      <EyeOff className="w-3.5 h-3.5" /> {count} hidden download{count === 1 ? '' : 's'} also {verb}
    </p>
  );
}

/**
 * One row of the queue - running and waiting downloads share one sortable
 * list, so a row can be dragged across the line: a waiting one moved above a
 * running one takes its slot. `running` is the zone the row sits in, which
 * after an optimistic reorder can be ahead of the row's own status.
 */
function QueueRow({ download, running, place, firstWaiting, onStop }: {
  download: Download;
  running: boolean;
  /** 1-based place in the waiting line (waiting rows only). */
  place: number | null;
  /** Draws the line between the downloading and waiting zones. */
  firstWaiting: boolean;
  onStop: (messageId: string) => void;
}) {
  const id = download.message_id as string;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const startNow = useStartQueuedNow();
  const percent = Math.min(100, Math.max(0, download.progress || 0));
  const starting = running && download.status !== 'downloading';

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`px-3 py-2 ${
        isDragging
          ? 'relative z-10 rounded-lg bg-slate-700 shadow-xl shadow-black/40 ring-1 ring-cyan-500/40'
          : 'bg-transparent'
      } ${firstWaiting && !isDragging ? 'border-t-2 border-dashed border-slate-600/70' : ''}`}
    >
      <div className="flex items-center gap-2">
        {/* Only the grip starts a drag, so the row's buttons and scrolling the
            list on a phone still work normally. */}
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${download.file}`}
          className="touch-none cursor-grab active:cursor-grabbing p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
        >
          <GripVertical className="w-4 h-4" />
        </button>
        {running ? (
          <span className="w-9 shrink-0 text-xs tabular-nums text-cyan-400">
            {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : `${percent.toFixed(0)}%`}
          </span>
        ) : (
          <span className="w-9 shrink-0 text-xs tabular-nums text-slate-500">#{place}</span>
        )}
        <span className={`flex-1 min-w-0 truncate text-sm ${running ? 'text-white' : 'text-slate-300'}`} title={download.file}>
          {download.file}
        </span>
        <SourceChip download={download} />
        {running ? (
          <span className="hidden sm:inline shrink-0 w-20 whitespace-nowrap text-right text-[11px] tabular-nums text-slate-500">
            {starting ? 'starting' : download.speed ? formatSpeed(download.speed) : '—'}
          </span>
        ) : (
          <>
            {download.total_bytes > 0 && (
              <span className="hidden md:inline shrink-0 w-20 whitespace-nowrap text-right text-xs tabular-nums text-slate-500">
                {formatBytes(download.total_bytes)}
              </span>
            )}
            <button
              onClick={() => startNow.mutate(id)}
              disabled={startNow.isPending}
              title="Start now (past the limit)"
              aria-label={`Start ${download.file} now`}
              className="p-1.5 rounded-lg text-sky-300 hover:bg-sky-500/20 disabled:opacity-50 transition-colors"
            >
              {startNow.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            </button>
            <button
              onClick={() => onStop(id)}
              title="Leave the queue"
              aria-label={`Remove ${download.file} from the queue`}
              className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-700/60 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
      {running && (
        <div className="mt-1.5 ml-9 h-1.5 rounded-full bg-slate-700 overflow-hidden">
          <div className="h-full progress-shimmer transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      )}
    </li>
  );
}

function QueueModal({ data, showSecured, onStop, onClose }: {
  data: QueueState;
  showSecured: boolean;
  onStop: (messageId: string) => void;
  onClose: () => void;
}) {
  const setLimits = useSetQueueLimits();
  const reorder = useReorderQueue();
  const stopAll = useStopAllDownloads();
  const resumeAll = useResumeAllDownloads();
  const [perSourceOpen, setPerSourceOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const sensors = useSensors(
    // A few pixels of travel before it counts as a drag, so a tap on the
    // grip doesn't jiggle the list
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Escape closes; the page behind doesn't scroll while the modal is up
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const { limits, active, running, waiting, resumable, max_limit: maxLimit } = data;
  const total = active.total + waiting.length;

  // One line, running first: the top of it runs, the rest waits. A secured
  // source's names stay out of view like everywhere else; they still hold
  // their places, so the numbering stays the real order.
  const line = [
    ...running.map(d => ({ d, running: true, place: null as number | null })),
    ...waiting.map((d, i) => ({ d, running: false, place: i + 1 as number | null })),
  ];
  const visibleLine = line.filter(({ d }) => showSecured || !d.hidden);
  const firstWaitingId = visibleLine.find(r => !r.running)?.d.message_id;
  const hiddenCount = line.length - visibleLine.length;

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id) return;
    const ids = line.map(({ d }) => d.message_id as string);
    const from = ids.indexOf(String(dragged.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    reorder.mutate(arrayMove(ids, from, to), {
      onSuccess: (res) => {
        if (res.errors.length) notify({ type: 'error', title: `Couldn't send ${res.errors[0].file} back to wait`, message: res.errors[0].error });
      },
      onError: (e) => notify({ type: 'error', title: 'Reorder failed', message: (e as Error).message }),
    });
  };

  const setCap = (source: QueueSource, value: string) =>
    setLimits.mutate({ [source]: value === '' ? null : Number(value) } as Partial<QueueState['limits']>);

  const runStopAll = () => {
    setConfirmStop(false);
    stopAll.mutate(undefined, {
      onSuccess: (res) => notify(res.errors.length
        ? { type: 'warning', title: `Stopped ${res.stopped}; ${res.errors.length} didn't stop`, message: res.errors[0].error }
        : { type: 'success', title: `Stopped ${res.stopped} download${res.stopped === 1 ? '' : 's'}` }),
      onError: (e) => notify({ type: 'error', title: 'Stop all failed', message: (e as Error).message }),
    });
  };

  const runResumeAll = () => {
    resumeAll.mutate(undefined, {
      onSuccess: (res) => notify({
        type: 'success',
        title: `Queued ${res.queued} download${res.queued === 1 ? '' : 's'}`,
        message: `Up to ${res.limits.global} run at once.`,
      }),
      onError: (e) => notify({ type: 'error', title: 'Resume all failed', message: (e as Error).message }),
    });
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="queue-title"
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-xl max-h-[88dvh] flex flex-col bg-slate-800 border border-slate-700 rounded-t-2xl sm:rounded-2xl shadow-2xl pb-[env(safe-area-inset-bottom)]"
      >
        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 px-4 pt-4 pb-3 border-b border-slate-700/60">
          <ListOrdered className="w-5 h-5 text-cyan-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 id="queue-title" className="text-base font-semibold text-white">Downloads</h2>
            <p className="text-xs text-slate-400">
              {active.total} downloading · {waiting.length} waiting
              {resumable > 0 && <> · {resumable} stopped</>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Controls */}
        <div className="shrink-0 px-4 py-3 space-y-3 border-b border-slate-700/60">
          <div className="flex flex-wrap items-center gap-2">
            {confirmStop ? (
              <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/30 pl-3 pr-1 py-1">
                <span className="text-sm text-red-300">Stop all {total}?</span>
                <button onClick={runStopAll} className="text-xs px-2.5 py-1 rounded-md bg-red-600 hover:bg-red-500 text-white">Stop all</button>
                <button onClick={() => setConfirmStop(false)} className="text-xs px-2 py-1 rounded-md text-slate-300 hover:text-white">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmStop(true)}
                disabled={total === 0 || stopAll.isPending}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-40 disabled:hover:bg-red-500/15 transition-colors"
              >
                {stopAll.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                Stop all
              </button>
            )}
            <button
              onClick={runResumeAll}
              disabled={resumable === 0 || resumeAll.isPending}
              title="Queue every stopped or paused download again - the limits decide how many start"
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-green-500/15 text-green-400 hover:bg-green-500/25 disabled:opacity-40 disabled:hover:bg-green-500/15 transition-colors"
            >
              {resumeAll.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Resume all{resumable > 0 && ` (${resumable})`}
            </button>

            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-slate-400">At once</span>
              <Stepper
                label="Downloads at once"
                value={limits.global}
                min={1}
                max={maxLimit}
                onChange={v => setLimits.mutate({ global: v })}
              />
              <button
                onClick={() => setPerSourceOpen(o => !o)}
                aria-expanded={perSourceOpen}
                title="Limits per source"
                className={`p-1.5 rounded-lg transition-colors ${
                  perSourceOpen ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-700/60'
                }`}
              >
                <SlidersHorizontal className="w-4 h-4" />
              </button>
            </div>
          </div>

          {perSourceOpen && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(Object.keys(SOURCE_LABEL) as QueueSource[]).map(source => (
                <label key={source} className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/50 border border-slate-700/60 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-200">{SOURCE_LABEL[source]}</span>
                    <span className="block text-xs text-slate-500 tabular-nums">{active[source]} running</span>
                  </span>
                  <select
                    value={limits[source] ?? ''}
                    onChange={e => setCap(source, e.target.value)}
                    className="bg-slate-800 border border-slate-700 rounded-lg py-1 px-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                  >
                    <option value="">No cap</option>
                    {Array.from({ length: maxLimit }, (_, i) => i + 1).map(n => (
                      <option key={n} value={n}>Max {n}</option>
                    ))}
                  </select>
                </label>
              ))}
              <p className="sm:col-span-3 text-xs text-slate-500">
                A source at its cap is skipped, not waited on - the next download in line that fits starts instead.
              </p>
            </div>
          )}

        </div>

        {/* Lists */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-2">
          {total === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-slate-400">
              <Pause className="w-8 h-8 opacity-40" />
              <p className="text-sm">Nothing downloading</p>
              {resumable > 0 && <p className="text-xs text-slate-500">Resume all to pick the stopped ones back up.</p>}
            </div>
          )}

          {total > 0 && (
            <section>
              <SectionTitle>
                Downloading{waiting.length > 0 && ' · then waiting'} · drag across the line to swap
              </SectionTitle>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={visibleLine.map(({ d }) => d.message_id as string)} strategy={verticalListSortingStrategy}>
                  <ol className="px-1">
                    {visibleLine.map(({ d, running: isRunning, place }) => (
                      <QueueRow
                        key={d.message_id}
                        download={d}
                        running={isRunning}
                        place={place}
                        firstWaiting={d.message_id === firstWaitingId}
                        onStop={onStop}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
              <HiddenNote count={hiddenCount} verb="in the queue" />
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Floating button showing running/total, stacked with the add and VPS
 * buttons; it opens the queue modal. Shown while anything is downloading or
 * waiting - or while something is stopped, so "resume all" stays reachable
 * after "stop all".
 */
export function DownloadQueueButton({ showSecured, onStop, className = '' }: {
  showSecured: boolean;
  onStop: (messageId: string) => void;
  /** Positioning (the page knows which buttons sit below it). */
  className?: string;
}) {
  const { data } = useQueue();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!data) return null;
  const total = data.active.total + data.waiting.length;
  if (total === 0 && data.resumable === 0 && !open) return null;

  const label = total > 0
    ? `${data.active.total} of ${total} downloading`
    : `${data.resumable} stopped`;

  return (
    <>
      <div className={`group fixed right-4 sm:right-6 z-40 ${className}`}>
        <button
          onClick={() => setOpen(true)}
          aria-label={`Download queue: ${label}`}
          className="relative flex items-center justify-center w-11 h-11 sm:w-14 sm:h-14 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white shadow-lg shadow-emerald-500/25 transition-all hover:scale-105"
        >
          {total > 0 ? (
            <span className="text-xs sm:text-sm font-semibold tabular-nums leading-none">
              {data.active.total}<span className="opacity-60">/</span>{total}
            </span>
          ) : (
            <Pause className="w-5 h-5 sm:w-6 sm:h-6" />
          )}
          {total === 0 && data.resumable > 0 && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-slate-900 border border-emerald-400/60 text-[10px] font-semibold tabular-nums flex items-center justify-center">
              {data.resumable}
            </span>
          )}
        </button>
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
          {label}
        </div>
      </div>
      {open && (
        <QueueModal data={data} showSecured={showSecured} onStop={onStop} onClose={close} />
      )}
    </>
  );
}
