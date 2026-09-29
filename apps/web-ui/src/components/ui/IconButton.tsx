import { forwardRef } from 'react';
import { cn } from '@/lib/cn';
import type { ButtonVariant } from './Button';

const SIZES = {
  sm: 'h-8 w-8 rounded-sm',
  md: 'h-10 w-10 rounded-md',
  lg: 'h-12 w-12 rounded-md',
} as const;

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'bg-bg-elevated text-fg border border-border-strong hover:bg-bg-sunken',
  ghost: 'bg-transparent text-fg-muted hover:bg-bg-sunken hover:text-fg',
  danger: 'bg-danger-500 text-white hover:bg-danger-700',
  link: 'bg-transparent text-brand-600 hover:underline',
};

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control is unusable to a screen reader without it. */
  'aria-label': string;
  variant?: ButtonVariant;
  size?: keyof typeof SIZES;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center transition-colors duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
