import { Activity, Database, FlaskConical, Gauge, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { adminSecret, clearAdminSecret, setAdminSecret } from '@/api/tokens';
import { useAdminStatus, useChaosCatalog } from '@/api/hooks/admin';
import { Badge, Button, Card, CardBody, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ChaosPanel } from './ChaosPanel';
import { DataPanel } from './DataPanel';
import { LoadPanel } from './LoadPanel';
import { ScenarioPanel } from './ScenarioPanel';
import { StatusPanel } from './StatusPanel';

const SECTIONS = [
  { id: 'chaos', label: 'Chaos', icon: FlaskConical },
  { id: 'scenarios', label: 'Scenarios', icon: Layers },
  { id: 'load', label: 'Load', icon: Gauge },
  { id: 'status', label: 'Status', icon: Activity },
  { id: 'data', label: 'Data', icon: Database },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * The Ops console (04-STYLING.md § 5). Sections are a query parameter rather
 * than nested routes, so the RUM view name stays `/admin` -- the view-naming
 * rule in 06-USER-FLOWS.md § 2.
 */
export default function AdminPage() {
  const [authorised, setAuthorised] = useState(() => Boolean(adminSecret()));

  // The ops theme is applied to the document, not a wrapper, so portalled
  // modals and toasts inherit it too.
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'ops';
    return () => {
      document.documentElement.dataset.theme = previous ?? 'light';
    };
  }, []);

  if (!authorised) return <SecretGate onAuthorised={() => setAuthorised(true)} />;
  return <Console onSignOut={() => setAuthorised(false)} />;
}

function SecretGate({ onAuthorised }: { onAuthorised: () => void }) {
  const [secret, setSecret] = useState('');

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Card variant="elevated" className="w-full max-w-sm">
        <CardBody>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!secret.trim()) return;
              setAdminSecret(secret.trim());
              onAuthorised();
            }}
          >
            <div>
              <h1 className="text-heading-lg">Voyager Ops</h1>
              <p className="mt-1 text-body-sm text-fg-muted">
                This console changes how the platform behaves. It is kept behind a shared secret,
                held only for this browser session.
              </p>
            </div>
            <Input
              label="Admin secret"
              type="password"
              autoComplete="off"
              value={secret}
              data-testid="admin-secret"
              data-dd-privacy="mask"
              onChange={(event) => setSecret(event.target.value)}
            />
            <Button type="submit" fullWidth data-testid="admin-secret-submit">
              Unlock
            </Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}

function Console({ onSignOut }: { onSignOut: () => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const section = (searchParams.get('section') ?? 'chaos') as SectionId;

  const status = useAdminStatus(true);
  const chaos = useChaosCatalog(true);

  const activeCount = status.data?.activeFlagCount ?? chaos.data?.activeFlags.length ?? 0;

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg-elevated px-4 sm:gap-4">
        <span className="font-mono text-mono-sm font-semibold tracking-tight">voyager ops</span>

        {/* Environment and build are reference detail, not the point of the
            header, so they are the first thing to go on a narrow screen. */}
        <span className="hidden items-center gap-2 font-mono text-mono-sm text-fg-muted sm:flex">
          <span data-testid="admin-env">{status.data?.env ?? '—'}</span>
          <span aria-hidden>·</span>
          <span data-testid="admin-version">{status.data?.version ?? '—'}</span>
        </span>

        <Badge
          intent={activeCount > 0 ? 'danger' : 'neutral'}
          dot
          data-testid="active-chaos-count"
          className={cn(
            'whitespace-nowrap',
            activeCount > 0 && 'shadow-[0_0_12px_var(--v-danger-500)]',
          )}
        >
          {activeCount} chaos {activeCount === 1 ? 'flag' : 'flags'} on
        </Badge>

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto shrink-0"
          data-testid="admin-lock"
          onClick={() => {
            clearAdminSecret();
            onSignOut();
          }}
        >
          Lock console
        </Button>
      </header>

      <div className="flex flex-col md:flex-row">
        {/* A rail on a real operator's screen; a scrolling strip on a phone,
            which is only ever used to flip a flag mid-demo. */}
        <nav
          aria-label="Ops sections"
          className="sticky top-14 z-20 shrink-0 border-b border-border bg-bg p-2 md:h-[calc(100vh-3.5rem)] md:w-48 md:border-b-0 md:border-r"
        >
          <ul className="flex gap-1 overflow-x-auto md:block md:space-y-0.5">
            {SECTIONS.map((item) => {
              const Icon = item.icon;
              const current = section === item.id;
              return (
                <li key={item.id} className="shrink-0">
                  <button
                    type="button"
                    aria-current={current ? 'page' : undefined}
                    data-testid={`admin-nav-${item.id}`}
                    onClick={() => setSearchParams({ section: item.id }, { replace: true })}
                    className={cn(
                      'flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-body-sm',
                      current
                        ? 'bg-bg-sunken font-semibold text-fg'
                        : 'text-fg-muted hover:bg-bg-sunken hover:text-fg',
                    )}
                  >
                    <Icon aria-hidden className="h-4 w-4" />
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 p-4">
          {section === 'chaos' ? <ChaosPanel /> : null}
          {section === 'scenarios' ? <ScenarioPanel /> : null}
          {section === 'load' ? <LoadPanel /> : null}
          {section === 'status' ? <StatusPanel /> : null}
          {section === 'data' ? <DataPanel /> : null}
        </main>
      </div>
    </div>
  );
}
