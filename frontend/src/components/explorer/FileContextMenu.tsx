import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** Renders the row as "on" - for toggles living in a menu. */
  active?: boolean;
  disabled?: boolean;
  separated?: boolean;
}

/** Right-click menu, positioned at the pointer and clamped to the viewport. */
export function FileContextMenu({
  x, y, items, onClose,
}: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - width - 8),
      y: Math.min(y, window.innerHeight - height - 8),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Capture phase: a click anywhere (including on a row) dismisses first.
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
      className="fixed z-[110] min-w-[190px] max-h-[80vh] overflow-y-auto py-1 rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl"
    >
      {items.map((item, i) => (
        <div key={item.label}>
          {item.separated && i > 0 && <div className="my-1 border-t border-slate-800" />}
          <button
            disabled={item.disabled}
            onClick={() => { onClose(); item.onClick(); }}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              item.danger
                ? 'text-red-400 hover:bg-red-500/15'
                : item.active
                  ? 'text-cyan-400 hover:bg-slate-700/60'
                  : 'text-slate-200 hover:bg-slate-700/60'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
