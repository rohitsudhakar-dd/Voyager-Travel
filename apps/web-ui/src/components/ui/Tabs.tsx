import { useRef } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  testId?: string;
  actionName?: string;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  variant?: 'underline' | 'pill';
  ariaLabel: string;
  className?: string;
}

/** Roving tabindex with arrow-key navigation, per the WAI-ARIA tabs pattern. */
export function Tabs({
  items,
  value,
  onChange,
  variant = 'underline',
  ariaLabel,
  className,
}: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = items.findIndex((item) => item.id === value);
    if (index === -1) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;

    event.preventDefault();
    onChange(items[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'flex items-center',
        variant === 'underline'
          ? 'gap-6 border-b border-border'
          : 'gap-1 rounded-md bg-bg-sunken p-1',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            role="tab"
            type="button"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            data-testid={item.testId}
            data-dd-action-name={item.actionName}
            onClick={() => onChange(item.id)}
            className={cn(
              'inline-flex items-center gap-2 whitespace-nowrap font-semibold transition-colors duration-fast',
              variant === 'underline'
                ? cn(
                    '-mb-px border-b-2 pb-3 pt-2 text-body-md',
                    selected
                      ? 'border-brand-600 text-brand-700'
                      : 'border-transparent text-fg-muted hover:text-fg',
                  )
                : cn(
                    'rounded-sm px-3 py-1.5 text-body-sm',
                    selected ? 'bg-bg-elevated text-fg shadow-xs' : 'text-fg-muted hover:text-fg',
                  ),
            )}
          >
            {item.icon ? <span aria-hidden>{item.icon}</span> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  className,
  children,
}: {
  id: string;
  active: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      tabIndex={0}
      className={className}
    >
      {active ? children : null}
    </div>
  );
}
