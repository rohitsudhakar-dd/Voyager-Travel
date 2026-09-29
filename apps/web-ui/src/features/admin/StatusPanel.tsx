import type { AdminStatus, ServiceStatus } from '@voyager/shared-schemas';
import { useAdminStatus } from '@/api/hooks/admin';
import { errorMessage } from '@/api/errors';
import { Alert, Card, CardBody, Skeleton, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatPercent } from '@/lib/format';

/** 04-STYLING.md § 5.3 -- service cards plus the infrastructure strip. */
export function StatusPanel() {
  const status = useAdminStatus(true);

  if (status.isError) {
    return (
      <Alert intent="danger" title="The admin API is not answering">
        {errorMessage(status.error)}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-heading-lg">Status</h1>
        <p className="font-mono text-mono-sm text-fg-subtle">polling every 5s</p>
      </div>

      {status.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 9 }, (_, index) => (
            <Skeleton key={index} shape="rect" className="h-28" />
          ))}
        </div>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {status.data!.services.map((service) => (
              <ServiceCard key={service.name} service={service} />
            ))}
          </ul>
          <InfraStrip status={status.data!} />
        </>
      )}
    </div>
  );
}

function ServiceCard({ service }: { service: ServiceStatus }) {
  const unhealthy = service.health === 'down' || service.health === 'degraded';

  return (
    <li
      data-testid={`service-${service.name}`}
      data-health={service.health}
      className={cn(
        'rounded-lg border bg-bg-elevated p-3',
        unhealthy ? 'border-danger-500' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={service.health} pulse={service.health === 'down'} />
        <span className="font-mono text-mono-sm text-fg">{service.name}</span>
        <span className="ml-auto font-mono text-mono-sm text-fg-subtle">
          {service.version ?? '—'}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-3 gap-2">
        <Metric
          label="p95"
          value={service.p95Ms === null ? '—' : `${Math.round(service.p95Ms)}ms`}
        />
        <Metric
          label="errors"
          value={service.errorRate === null ? '—' : formatPercent(service.errorRate)}
          intent={service.errorRate !== null && service.errorRate > 0.05 ? 'danger' : undefined}
        />
        <Metric
          label="req/s"
          value={service.requestRate === null ? '—' : service.requestRate.toFixed(1)}
        />
      </dl>
    </li>
  );
}

function Metric({ label, value, intent }: { label: string; value: string; intent?: 'danger' }) {
  return (
    <div>
      <dt className="text-caption text-fg-subtle">{label}</dt>
      <dd
        className={cn('tabular text-body-sm', intent === 'danger' ? 'text-danger-500' : 'text-fg')}
      >
        {value}
      </dd>
    </div>
  );
}

function InfraStrip({ status }: { status: AdminStatus }) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card variant="flat" data-testid="infra-postgres">
        <CardBody className="space-y-1.5">
          <div className="flex items-center gap-2">
            <StatusDot status={status.postgres.health} />
            <span className="font-mono text-mono-sm">postgres</span>
          </div>
          <p className="tabular text-body-sm text-fg-muted">
            {status.postgres.connections} / {status.postgres.maxConnections} connections
          </p>
          <div
            role="progressbar"
            aria-label="Postgres connection usage"
            aria-valuemin={0}
            aria-valuemax={status.postgres.maxConnections}
            aria-valuenow={status.postgres.connections}
            className="h-1.5 overflow-hidden rounded-full bg-bg-sunken"
          >
            <span
              className={cn(
                'block h-full rounded-full',
                status.postgres.connections / status.postgres.maxConnections > 0.85
                  ? 'bg-danger-500'
                  : 'bg-brand-500',
              )}
              style={{
                width: `${Math.min(100, (status.postgres.connections / status.postgres.maxConnections) * 100)}%`,
              }}
            />
          </div>
        </CardBody>
      </Card>

      <Card variant="flat" data-testid="infra-redis">
        <CardBody className="space-y-1.5">
          <div className="flex items-center gap-2">
            <StatusDot status={status.redis.health} />
            <span className="font-mono text-mono-sm">redis</span>
          </div>
          <p className="tabular text-body-sm text-fg-muted">
            hit ratio {formatPercent(status.redis.hitRatio)} ·{' '}
            {formatBytes(status.redis.usedMemoryBytes)} of{' '}
            {formatBytes(status.redis.maxMemoryBytes)}
          </p>
          <p className="tabular text-body-sm text-fg-muted">
            {status.redis.evictedKeys.toLocaleString('en-GB')} keys evicted
          </p>
        </CardBody>
      </Card>

      <Card variant="flat" data-testid="infra-kafka">
        <CardBody className="space-y-1.5">
          <div className="flex items-center gap-2">
            <StatusDot status={status.kafka.health} />
            <span className="font-mono text-mono-sm">kafka</span>
          </div>
          <ul className="space-y-0.5">
            {status.kafka.consumerGroups.map((group) => (
              <li key={group.group} className="flex justify-between gap-3 font-mono text-mono-sm">
                <span className="truncate text-fg-muted">{group.group}</span>
                <span className={cn('tabular', group.lag > 1_000 ? 'text-danger-500' : 'text-fg')}>
                  {group.lag.toLocaleString('en-GB')}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
