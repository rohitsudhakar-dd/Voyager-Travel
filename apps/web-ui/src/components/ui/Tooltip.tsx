import { cloneElement, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface TooltipProps {
  content: React.ReactNode;
  side?: 'top' | 'bottom';
  /** 300 ms, per 04-STYLING.md § 6. */
  delayMs?: number;
  children: React.ReactElement;
}

/** Opens on hover *and* focus, so it is reachable from the keyboard. */
export function Tooltip({ content, side = 'top', delayMs = 300, children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number>();

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delayMs);
  };

  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  } as React.HTMLAttributes<HTMLElement>);

  return (
    <span className="relative inline-flex">
      {trigger}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'absolute left-1/2 z-40 w-max max-w-[16rem] -translate-x-1/2 rounded-sm bg-neutral-900 px-2 py-1',
            'text-caption text-white shadow-md animate-fade-in',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
