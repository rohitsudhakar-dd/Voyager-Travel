import type { Scenario } from '@voyager/shared-schemas';
import { AlertOctagon } from 'lucide-react';
import {
  useApplyScenario,
  useResetChaos,
  useRevertScenario,
  useScenarios,
} from '@/api/hooks/admin';
import { errorMessage } from '@/api/errors';
import { Alert, Badge, Button, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { toast } from '@/store/toasts';

/** 04-STYLING.md § 5.2. */
export function ScenarioPanel() {
  const scenarios = useScenarios(true);
  const apply = useApplyScenario();
  const revert = useRevertScenario();
  const reset = useResetChaos();

  return (
    <div className="space-y-4">
      <h1 className="text-heading-lg">Scenarios</h1>

      {/* Reached for mid-sentence, without looking. Hence the size. */}
      <button
        type="button"
        disabled={reset.isPending}
        data-testid="reset-all-chaos"
        onClick={() =>
          reset.mutate(undefined, {
            onSuccess: () => toast.success('All chaos cleared'),
            onError: (error) => toast.danger('Reset failed', errorMessage(error)),
          })
        }
        className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-danger-500 text-heading-sm font-bold uppercase tracking-wide text-white hover:bg-danger-700 disabled:opacity-60"
      >
        <AlertOctagon aria-hidden className="h-5 w-5" />
        Reset all chaos
      </button>

      {scenarios.isError ? (
        <Alert intent="danger" title="Could not load scenarios">
          {errorMessage(scenarios.error)}
        </Alert>
      ) : null}

      {scenarios.isPending ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {Array.from({ length: 10 }, (_, index) => (
            <Skeleton key={index} shape="rect" className="h-48" />
          ))}
        </div>
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {(scenarios.data?.scenarios ?? []).map((scenario) => (
            <ScenarioCard
              key={scenario.id}
              scenario={scenario}
              busy={apply.isPending || revert.isPending}
              onApply={() =>
                apply.mutate(scenario.id, {
                  onSuccess: () => toast.warning(`${scenario.id} applied`, scenario.blastRadius),
                  onError: (error) => toast.danger('Apply failed', errorMessage(error)),
                })
              }
              onRevert={() =>
                revert.mutate(scenario.id, {
                  onSuccess: () => toast.success(`${scenario.id} reverted`),
                  onError: (error) => toast.danger('Revert failed', errorMessage(error)),
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScenarioCard({
  scenario,
  busy,
  onApply,
  onRevert,
}: {
  scenario: Scenario;
  busy: boolean;
  onApply: () => void;
  onRevert: () => void;
}) {
  return (
    <li
      data-testid={`scenario-${scenario.id}`}
      data-active={scenario.active}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-bg-elevated p-4',
        scenario.active ? 'border-danger-500' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3">
        <Badge intent={scenario.active ? 'danger' : 'brand'} className="font-mono">
          {scenario.id}
        </Badge>
        <h2 className="text-heading-sm">{scenario.title}</h2>
      </div>

      <p className="text-body-sm text-fg-muted">{scenario.story}</p>

      <dl className="space-y-1 font-mono text-mono-sm text-fg-muted">
        {Object.entries(scenario.flags).map(([name, value]) => (
          <div key={name} className="flex gap-2">
            <dt className="truncate">{name}</dt>
            <dd className="ml-auto shrink-0 text-fg">{JSON.stringify(value)}</dd>
          </div>
        ))}
      </dl>

      <p className="text-body-sm">
        <span className="text-fg-muted">Blast radius: </span>
        {scenario.blastRadius}
      </p>

      {scenario.active && scenario.requiresRestartToRevert ? (
        <Alert intent="warning">
          Reverting this one needs a single-service restart; the flag alone will not undo it.
        </Alert>
      ) : null}

      <Button
        variant={scenario.active ? 'secondary' : 'primary'}
        loading={busy}
        fullWidth
        data-testid={`scenario-${scenario.id}-action`}
        onClick={scenario.active ? onRevert : onApply}
      >
        {scenario.active ? 'Revert' : 'Apply'}
      </Button>
    </li>
  );
}
