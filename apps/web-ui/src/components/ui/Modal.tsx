import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { useFocusTrap, useScrollLock } from '@/lib/hooks';
import { IconButton } from './IconButton';

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: keyof typeof SIZES;
  footer?: React.ReactNode;
  /** Set false for a confirmation the user must answer explicitly. */
  dismissible?: boolean;
  testId?: string;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  dismissible = true,
  testId = 'modal',
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  useFocusTrap(panelRef, open);
  useScrollLock(open);

  useEffect(() => {
    if (!open || !dismissible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, dismissible, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        aria-hidden
        className="absolute inset-0 bg-neutral-900/50 animate-fade-in"
        onClick={dismissible ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        aria-describedby={description ? `${baseId}-description` : undefined}
        data-testid={testId}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full rounded-t-xl bg-bg-elevated shadow-xl animate-slide-up sm:rounded-xl',
          SIZES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={`${baseId}-title`} className="text-heading-md">
              {title}
            </h2>
            {description ? (
              <p id={`${baseId}-description`} className="mt-1 text-body-sm text-fg-muted">
                {description}
              </p>
            ) : null}
          </div>
          {dismissible ? (
            <IconButton
              aria-label="Close"
              size="sm"
              data-testid={`${testId}-close`}
              onClick={onClose}
            >
              <X aria-hidden className="h-4 w-4" />
            </IconButton>
          ) : null}
        </div>

        <div className="max-h-[70vh] overflow-auto px-5 py-4">{children}</div>

        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
