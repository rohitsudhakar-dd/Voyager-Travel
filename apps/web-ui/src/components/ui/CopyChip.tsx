import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';

export interface CopyChipProps {
  value: string;
  label?: string;
  /** Names the RUM action; `Copy PNR` on confirmation and manage. */
  actionName?: string;
  testId?: string;
  className?: string;
}

/**
 * Mono text with a copy button -- PNRs, trace ids, session ids. Marked
 * `data-dd-privacy="allow"`: these are the values you *want* legible in a
 * session replay.
 */
export function CopyChip({
  value,
  label,
  actionName,
  testId = 'copy-chip',
  className,
}: CopyChipProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be denied; the value is still selectable.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-border bg-bg-sunken px-2.5 py-1.5',
        className,
      )}
    >
      {label ? <span className="text-caption text-fg-muted">{label}</span> : null}
      <code
        data-dd-privacy="allow"
        data-testid={`${testId}-value`}
        className="font-mono text-mono-sm text-fg"
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        data-testid={testId}
        data-dd-action-name={actionName}
        aria-label={`Copy ${label ?? value}`}
        className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-fg-muted hover:text-fg"
      >
        {copied ? (
          <Check aria-hidden className="h-3.5 w-3.5 text-success-700" />
        ) : (
          <Copy aria-hidden className="h-3.5 w-3.5" />
        )}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </span>
  );
}
