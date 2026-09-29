import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export type CardVariant = 'flat' | 'elevated' | 'interactive';

const VARIANTS: Record<CardVariant, string> = {
  flat: 'border border-border',
  elevated: 'border border-border shadow-sm',
  interactive:
    'border border-border shadow-xs transition-[border-color,box-shadow] duration-fast hover:border-border-strong hover:shadow-sm',
};

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  as?: 'div' | 'article' | 'section' | 'li';
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { variant = 'flat', as = 'div', className, ...rest },
  ref,
) {
  // The element varies but the handler types do not, so the union is collapsed here.
  const Tag = as as 'div';
  return (
    <Tag
      ref={ref}
      className={cn('rounded-lg bg-bg-elevated', VARIANTS[variant], className)}
      {...rest}
    />
  );
});

export function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-border px-5 py-4', className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-heading-md', className)} {...rest} />;
}

export function CardBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-t border-border px-5 py-4', className)} {...rest} />;
}
