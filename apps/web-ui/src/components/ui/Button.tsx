import { Loader2 } from 'lucide-react';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-xs',
  secondary:
    'bg-bg-elevated text-fg border border-border-strong hover:bg-bg-sunken active:bg-bg-sunken shadow-xs',
  ghost: 'bg-transparent text-fg hover:bg-bg-sunken',
  danger: 'bg-danger-500 text-white hover:bg-danger-700 active:bg-danger-700 shadow-xs',
  link: 'bg-transparent text-brand-600 hover:underline underline-offset-2 px-0',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-body-sm gap-1.5 rounded-sm',
  md: 'h-10 px-4 text-body-md gap-2 rounded-md',
  lg: 'h-12 px-6 text-body-lg gap-2 rounded-md',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leadingIcon,
    trailingIcon,
    fullWidth,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-semibold',
        'transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
      ) : (
        leadingIcon && (
          <span aria-hidden className="shrink-0">
            {leadingIcon}
          </span>
        )
      )}
      {children}
      {trailingIcon && !loading && (
        <span aria-hidden className="shrink-0">
          {trailingIcon}
        </span>
      )}
    </button>
  );
});
