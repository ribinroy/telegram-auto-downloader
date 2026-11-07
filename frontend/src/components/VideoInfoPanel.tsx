import { useEffect, useRef } from 'react';
import { X, Film, AudioLines, Captions, FileText, ListOrdered, Loader2 } from 'lucide-react';
import { useMediaInfo } from '../hooks/useMisc';
import { useErrorToast } from '../lib/notify';
import type { MediaSource, MediaStream } from '../api/mediaInfo';
import { fileRows, streamRows, streamHeading, summaryLine, formatClock, type Row } from '../utils/mediaInfo';

interface VideoInfoPanelProps {
  source: MediaSource;
  name: string;
  onClose: () => void;
}

const ICONS: Record<string, typeof Film> = { video: Film, audio: AudioLines, subtitle: Captions };

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-400">{k}</dt>
          <dd className="text-slate-100 break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Film; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-slate-800/60 rounded-lg p-3">
      <h4 className="flex items-center gap-2 text-sm font-medium text-white mb-2">
        <Icon className="w-4 h-4 text-cyan-400" />
        {title}
      </h4>
      {children}
    </section>
  );
}

/**
 * The player's info (i) panel: every stream and the container, probed live.
 * Drawn over the player itself (not a second modal) so it works in
 * fullscreen too; the video keeps playing underneath.
 */
export function VideoInfoPanel({ source, name, onClose }: VideoInfoPanelProps) {
  const { data: info, isLoading, error } = useMediaInfo(source);
  useErrorToast(error, 'Couldn’t load video details');
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes this before the surrounding modal: capture on window runs
  // ahead of the modal's document listener.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const streams = info?.streams.filter(s => s.type !== 'attachment') ?? [];
  const attachments = (info?.streams.length ?? 0) - streams.length;

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center p-3 sm:p-6 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Video details"
        className="relative w-full max-w-2xl max-h-full flex flex-col bg-slate-900/95 border border-slate-700 rounded-xl shadow-2xl"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-4 border-b border-slate-700/70 shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-white font-medium break-all">{info?.file.name ?? name}</h3>
            {info && <p className="text-xs text-cyan-300 mt-1">{summaryLine(info)}</p>}
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 shrink-0"
            title="Close (Esc)"
            aria-label="Close details"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Reading the file…
            </div>
          )}
          {!isLoading && !info && (
            <p className="py-10 text-center text-slate-400 text-sm">Couldn’t read this file’s details.</p>
          )}
          {info && (
            <>
              <Section icon={FileText} title="File">
                <Rows rows={attachments > 0 ? [...fileRows(info), ['Attachments', `${attachments} (fonts, cover art)`]] : fileRows(info)} />
              </Section>
              {streams.map((s: MediaStream) => (
                <Section key={s.index} icon={ICONS[s.type] ?? FileText} title={streamHeading(s, streams)}>
                  <Rows rows={streamRows(s)} />
                </Section>
              ))}
              {info.chapters.length > 0 && (
                <Section icon={ListOrdered} title={`Chapters (${info.chapters.length})`}>
                  <ol className="text-xs space-y-0.5">
                    {info.chapters.map((c, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="text-slate-400 tabular-nums w-16 shrink-0">{formatClock(c.start)}</span>
                        <span className="text-slate-100 break-all">{c.title || `Chapter ${i + 1}`}</span>
                      </li>
                    ))}
                  </ol>
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
