import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  extraActionText?: string;
  extraActionDisabled?: boolean;
  variant?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
  onExtraAction?: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  extraActionText,
  extraActionDisabled = false,
  variant = 'danger',
  onConfirm,
  onCancel,
  onExtraAction,
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

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
      <div className="bg-slate-800 rounded-xl w-full max-w-sm border border-slate-700 shadow-xl">
        <div className="p-4 sm:p-6">
          <div className="flex items-start gap-3 sm:gap-4">
            <div className={`p-2 rounded-full bg-slate-700/50 ${styles.icon}`}>
              <AlertTriangle className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base sm:text-lg font-semibold text-white mb-1">{title}</h3>
              <p className="text-slate-400 text-sm break-words">{message}</p>
            </div>
          </div>
        </div>

        <div className={`flex gap-2 sm:gap-3 p-3 sm:p-4 border-t border-slate-700 ${
          extraActionText && onExtraAction ? 'flex-col' : 'flex-col sm:flex-row'
        }`}>
          <button
            onClick={onCancel}
            className="w-full sm:flex-1 py-2.5 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
          >
            {cancelText}
          </button>
          <button
            ref={confirmButtonRef}
            onClick={onConfirm}
            className={`w-full sm:flex-1 py-2.5 px-4 ${styles.button} text-white rounded-lg transition-colors`}
          >
            {confirmText}
          </button>
          {extraActionText && onExtraAction && (
            <button
              onClick={onExtraAction}
              disabled={extraActionDisabled}
              className={`w-full sm:flex-1 py-2.5 px-4 text-white rounded-lg transition-colors ${
                extraActionDisabled
                  ? 'bg-slate-600 opacity-50 cursor-not-allowed'
                  : 'bg-red-800 hover:bg-red-700'
              }`}
            >
              {extraActionText}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
