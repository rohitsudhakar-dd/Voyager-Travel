import { useState } from 'react';
import { useAdminStatus, useReseed, useResetChaos, useSetVersion } from '@/api/hooks/admin';
import { errorMessage } from '@/api/errors';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CopyChip,
  Input,
  Modal,
} from '@/components/ui';
import { toast } from '@/store/toasts';

/**
 * The route table in 06-USER-FLOWS.md § 2 names a Data section but does not say
 * what is in it. It holds the two destructive admin operations that exist in
 * 05-FUNCTIONALITY.md § 2.8 -- re-seed and the version override that fakes a
 * deploy for S6 -- plus the chaos reset, because this is where you look when
 * the demo data has drifted.
 */
export function DataPanel() {
  const status = useAdminStatus(true);
  const reseed = useReseed();
  const reset = useResetChaos();
  const setVersion = useSetVersion();

  const [confirming, setConfirming] = useState(false);
  const [version, setVersionInput] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <h1 className="text-heading-lg">Data</h1>

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Re-seed the database</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-body-sm text-fg-muted">
            Restores the demo dataset. Bookings made during a demo are destroyed. Runs as a
            background job.
          </p>
          {jobId ? (
            <Alert intent="info" title="Re-seed started">
              <span className="inline-flex items-center gap-2">
                job <CopyChip value={jobId} testId="reseed-job" />
              </span>
            </Alert>
          ) : null}
          <Button
            variant="danger"
            loading={reseed.isPending}
            data-testid="reseed"
            onClick={() => setConfirming(true)}
          >
            Re-seed now
          </Button>
        </CardBody>
      </Card>

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Reported version</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-body-sm text-fg-muted">
            Overrides <code className="font-mono text-mono-sm">DD_VERSION</code> at runtime, which
            is how scenario S6 fakes a bad deploy without one.
          </p>
          <p className="font-mono text-mono-sm text-fg-muted">
            currently {status.data?.version ?? '—'}
          </p>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!version.trim()) return;
              setVersion.mutate(version.trim(), {
                onSuccess: () => toast.success(`Now reporting ${version.trim()}`),
                onError: (error) => toast.danger('Version not changed', errorMessage(error)),
              });
            }}
          >
            <Input
              label="New version"
              placeholder="2.1.0"
              value={version}
              containerClassName="w-48"
              className="font-mono text-mono-sm"
              data-testid="version-input"
              onChange={(event) => setVersionInput(event.target.value)}
            />
            <Button type="submit" loading={setVersion.isPending} data-testid="version-submit">
              Apply
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Chaos state</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-body-sm text-fg-muted">
            Clears every flag and runs the compensating actions — recreating dropped indexes,
            resizing pools, resuming consumers.
          </p>
          <Button
            variant="secondary"
            loading={reset.isPending}
            data-testid="data-reset-chaos"
            onClick={() =>
              reset.mutate(undefined, {
                onSuccess: () => toast.success('All chaos cleared'),
                onError: (error) => toast.danger('Reset failed', errorMessage(error)),
              })
            }
          >
            Reset all chaos
          </Button>
        </CardBody>
      </Card>

      {confirming ? (
        <Modal
          open
          dismissible={false}
          onClose={() => setConfirming(false)}
          title="Re-seed the database?"
          description="Every booking made since the last seed will be deleted."
          testId="reseed-modal"
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={reseed.isPending}
                data-testid="reseed-confirm"
                onClick={() =>
                  reseed.mutate(undefined, {
                    onSuccess: (result) => {
                      setJobId(result.jobId);
                      setConfirming(false);
                    },
                    onError: (error) => toast.danger('Re-seed failed', errorMessage(error)),
                  })
                }
              >
                Re-seed
              </Button>
            </>
          }
        >
          <p className="text-body-md text-fg-muted">Do this between demos, not during one.</p>
        </Modal>
      ) : null}
    </div>
  );
}
