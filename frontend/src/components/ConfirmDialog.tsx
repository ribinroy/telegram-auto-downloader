import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // Focus confirm button when dialog opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => confirmButtonRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      icon: 'text-red-400',
      button: 'bg-red-600 hover:bg-red-500',
    },
    warning: {
      icon: 'text-yellow-400',
      button: 'bg-yellow-600 hover:bg-yellow-500',
    },
    info: {
      icon: 'text-cyan-400',
      button: 'bg-cyan-600 hover:bg-cyan-500',
    },
  };

  const styles = variantStyles[variant];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl w-full max-w-sm border border-slate-700 shadow-xl">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`p-2 rounded-full bg-slate-700/50 ${styles.icon}`}>
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-white mb-1">{title}</h3>
              <p className="text-slate-400 text-sm">{message}</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3 p-4 border-t border-slate-700">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
          >
            {cancelText}
          </button>
          <button
            ref={confirmButtonRef}
            onClick={onConfirm}
            className={`flex-1 py-2.5 px-4 ${styles.button} text-white rounded-lg transition-colors`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
