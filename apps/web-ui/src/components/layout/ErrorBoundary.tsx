import { AlertOctagon } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Reads the RUM session id off the global the browser SDK publishes, if the SDK
 * is there. This is deliberately a duck-typed global lookup and not an import:
 * RUM is Phase 9, and this file must not depend on it.
 */
function rumSessionId(): string | null {
  const rum = (window as unknown as { DD_RUM?: { getInternalContext?: () => unknown } }).DD_RUM;
  const context = rum?.getInternalContext?.() as { session_id?: string } | undefined;
  return context?.session_id ?? null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept as a console error on purpose: Phase 9 forwards console errors to
    // Datadog, so this becomes a RUM error with no extra wiring.
    // eslint-disable-next-line no-console
    console.error('Unhandled error in the Voyager UI', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const sessionId = rumSessionId();

    return (
      <div
        role="alert"
        data-testid="error-boundary"
        className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-20 text-center"
      >
        <span
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-50 text-danger-700"
        >
          <AlertOctagon className="h-6 w-6" />
        </span>
        <h1 className="text-heading-lg">Something went wrong on this page</h1>
        <p className="text-body-lg text-fg-muted">
          Your booking is safe. Reloading usually fixes it — if it does not, the reference below
          will tell us exactly what happened.
        </p>
        <Button
          size="lg"
          data-testid="error-boundary-reload"
          onClick={() => window.location.reload()}
        >
          Reload the page
        </Button>
        {sessionId ? (
          <p className="font-mono text-mono-sm text-fg-muted">
            session <span data-dd-privacy="allow">{sessionId}</span>
          </p>
        ) : null}
      </div>
    );
  }
}
