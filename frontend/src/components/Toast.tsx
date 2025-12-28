import { useEffect, useState, useCallback } from 'react';
import { CheckCircle, XCircle, AlertCircle, X, Download } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastData {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

function Toast({ toast, onDismiss }: ToastProps) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const duration = toast.duration || 4000;
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(() => onDismiss(toast.id), 300);
    }, duration);

    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(() => onDismiss(toast.id), 300);
  };

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0" />,
    error: <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />,
    warning: <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0" />,
    info: <Download className="w-5 h-5 text-cyan-400 flex-shrink-0" />,
  };

  const bgColors = {
    success: 'bg-slate-900/95 border-green-500/50',
    error: 'bg-slate-900/95 border-red-500/50',
    warning: 'bg-slate-900/95 border-yellow-500/50',
    info: 'bg-slate-900/95 border-cyan-500/50',
  };

  const titleColors = {
    success: 'text-green-300',
    error: 'text-red-300',
    warning: 'text-yellow-300',
    info: 'text-cyan-300',
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`flex items-start gap-3 p-4 rounded-xl border-2 shadow-xl transition-all duration-300 ${
        bgColors[toast.type]
      } ${isExiting ? 'opacity-0 translate-x-full' : 'opacity-100 translate-x-0'}`}
    >
      {icons[toast.type]}
      <div className="flex-1 min-w-0">
        <p className={`font-semibold text-sm ${titleColors[toast.type]}`}>{toast.title}</p>
        {toast.message && (
          <p className="text-slate-300 text-sm mt-1 line-clamp-2">{toast.message}</p>
        )}
      </div>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss notification"
        className="p-1.5 hover:bg-slate-700/70 rounded-lg transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4 text-slate-400 hover:text-white" />
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast toast={toast} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}

// Hook for managing toasts
export function useToast() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const addToast = useCallback((toast: Omit<ToastData, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}
