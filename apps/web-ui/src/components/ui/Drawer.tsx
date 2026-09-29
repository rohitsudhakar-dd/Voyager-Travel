import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { useFocusTrap, useScrollLock } from '@/lib/hooks';
import { IconButton } from './IconButton';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}

/** Right on desktop, bottom sheet on mobile -- the filter drawer and nothing else. */
export function Drawer({ open, onClose, title, footer, testId = 'drawer', children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  useFocusTrap(panelRef, open);
  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden
        className="absolute inset-0 bg-neutral-900/50 animate-fade-in"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        data-testid={testId}
        tabIndex={-1}
        className={cn(
          'absolute flex flex-col bg-bg-elevated shadow-xl',
          'inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl animate-slide-in-bottom',
          'sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[min(420px,100vw)] sm:max-h-none sm:rounded-none sm:animate-slide-in-right',
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <h2 id={`${baseId}-title`} className="text-heading-md">
            {title}
          </h2>
          <IconButton
            aria-label="Close"
            size="sm"
            data-testid={`${testId}-close`}
            onClick={onClose}
          >
            <X aria-hidden className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>

        {footer ? <div className="border-t border-border px-5 py-4">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
