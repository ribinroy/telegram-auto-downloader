import { useState } from 'react';
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
} from 'lucide-react';
import { useQueue, useSetQueueLimits, useReorderQueue, useStartQueuedNow, queueSourceOf } from '../hooks/useQueue';
import { formatBytes } from '../utils/format';
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

function WaitingRow({ download, place, onStop }: {
  download: Download; place: number; onStop: (messageId: string) => void;
}) {
  const id = download.message_id as string;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const startNow = useStartQueuedNow();

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-2 sm:px-3 py-2 ${
        isDragging
          ? 'relative z-10 rounded-lg bg-slate-700 shadow-xl shadow-black/40 ring-1 ring-cyan-500/40'
          : 'bg-transparent'
      }`}
    >
      {/* Only the grip starts a drag, so the row's buttons and a page scroll
          on a phone still work normally. */}
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${download.file}`}
        className="touch-none cursor-grab active:cursor-grabbing p-1 -ml-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <span className="w-7 shrink-0 text-xs tabular-nums text-slate-500">#{place}</span>
      <span className="flex-1 min-w-0 truncate text-sm text-slate-200" title={download.file}>
        {download.file}
      </span>
      <span className="hidden sm:inline shrink-0 max-w-[10rem] truncate text-[11px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400">
        {sourceChip(download)}
      </span>
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
    </li>
  );
}

/**
 * The download queue, above the downloads list: how many run at once (and
 * per source), and the waiting downloads in start order, drag to reorder.
 * Only shown while something is downloading or waiting.
 */
export function DownloadQueue({ showSecured, onStop }: {
  showSecured: boolean;
  onStop: (messageId: string) => void;
}) {
  const { data } = useQueue();
  const setLimits = useSetQueueLimits();
  const reorder = useReorderQueue();
  const [perSourceOpen, setPerSourceOpen] = useState(false);

  const sensors = useSensors(
    // A few pixels of travel before it counts as a drag, so a tap on the
    // grip doesn't jiggle the list
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!data || (data.active.total === 0 && data.waiting.length === 0)) return null;

  const { limits, active, waiting, max_limit: maxLimit } = data;
  // A secured source's queued names stay out of view like everywhere else;
  // they still hold their places, so the numbering stays the real order.
  const visible = waiting
    .map((d, i) => ({ d, place: i + 1 }))
    .filter(({ d }) => showSecured || !d.hidden);
  const hiddenCount = waiting.length - visible.length;

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id) return;
    const ids = waiting.map(d => d.message_id as string);
    const from = ids.indexOf(String(dragged.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    reorder.mutate(arrayMove(ids, from, to));
  };

  const setCap = (source: QueueSource, value: string) =>
    setLimits.mutate({ [source]: value === '' ? null : Number(value) } as Partial<QueueState['limits']>);

  return (
    <section className="mb-4 rounded-xl border border-slate-700/60 bg-slate-800/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2.5">
        <ListOrdered className="w-4 h-4 text-cyan-400 shrink-0" />
        <p className="text-sm text-slate-300">
          <span className="text-white font-medium tabular-nums">{active.total}</span> downloading
          {waiting.length > 0 && (
            <> · <span className="text-white font-medium tabular-nums">{waiting.length}</span> waiting</>
          )}
        </p>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 px-3 sm:px-4 pb-3">
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

      {waiting.length > 0 && (
        <div className="border-t border-slate-700/60">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={visible.map(({ d }) => d.message_id as string)} strategy={verticalListSortingStrategy}>
              <ol className="divide-y divide-slate-700/40 max-h-72 overflow-y-auto overscroll-contain">
                {visible.map(({ d, place }) => (
                  <WaitingRow key={d.message_id} download={d} place={place} onStop={onStop} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          {hiddenCount > 0 && (
            <p className="flex items-center gap-1.5 px-3 sm:px-4 py-2 text-xs text-slate-500 border-t border-slate-700/40">
              <EyeOff className="w-3.5 h-3.5" /> {hiddenCount} hidden download{hiddenCount === 1 ? '' : 's'} also waiting
            </p>
          )}
        </div>
      )}
    </section>
  );
}
