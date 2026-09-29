import type { LoadgenState } from '@voyager/shared-schemas';
import { useEffect, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAdminStatus, useSetLoadgen } from '@/api/hooks/admin';
import { errorMessage } from '@/api/errors';
import {
  Alert,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  QuantityStepper,
  Toggle,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { toast } from '@/store/toasts';

const INTENSITIES = ['off', '1x', '2x', '5x'] as const;
type Intensity = (typeof INTENSITIES)[number];

/** 15 minutes of the 5 s status poll. */
const SPARKLINE_POINTS = (15 * 60) / 5;

interface Sample {
  t: number;
  rate: number;
}

/**
 * 04-STYLING.md § 5.4. The sparkline is assembled from the status poll the
 * console is already making rather than a second time-series call, which the
 * admin API does not offer.
 */
export function LoadPanel() {
  const status = useAdminStatus(true);
  const setLoadgen = useSetLoadgen();
  const [samples, setSamples] = useState<Sample[]>([]);
  const lastSeen = useRef(0);

  useEffect(() => {
    if (!status.data || status.dataUpdatedAt === lastSeen.current) return;
    lastSeen.current = status.dataUpdatedAt;
    const rate = status.data.services.reduce(
      (total, service) => total + (service.requestRate ?? 0),
      0,
    );
    setSamples((current) =>
      [...current, { t: status.dataUpdatedAt, rate: Number(rate.toFixed(1)) }].slice(
        -SPARKLINE_POINTS,
      ),
    );
  }, [status.data, status.dataUpdatedAt]);

  const loadgen: LoadgenState | undefined = status.data?.loadgen;

  const push = (next: {
    intensity: Intensity;
    apiEnabled: boolean;
    concurrency: number;
    browserEnabled: boolean;
  }) => {
    setLoadgen.mutate(
      {
        api: { enabled: next.apiEnabled, intensity: next.intensity },
        browser: { enabled: next.browserEnabled, concurrency: next.concurrency },
      },
      { onError: (error) => toast.danger('Load generator did not change', errorMessage(error)) },
    );
  };

  const current = {
    intensity: loadgen?.api.intensity ?? ('off' as Intensity),
    apiEnabled: loadgen?.api.enabled ?? false,
    browserEnabled: loadgen?.browser.enabled ?? false,
    concurrency: loadgen?.browser.concurrency ?? 0,
  };

  return (
    <div className="space-y-4">
      <h1 className="text-heading-lg">Load</h1>

      {status.isError ? (
        <Alert intent="danger" title="Could not read load generator state">
          {errorMessage(status.error)}
        </Alert>
      ) : null}

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>API traffic</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div
            role="group"
            aria-label="Load intensity"
            className="flex overflow-hidden rounded-md border border-border"
          >
            {INTENSITIES.map((intensity) => (
              <button
                key={intensity}
                type="button"
                aria-pressed={current.intensity === intensity}
                disabled={setLoadgen.isPending}
                data-testid={`loadgen-intensity-${intensity}`}
                onClick={() => push({ ...current, intensity, apiEnabled: intensity !== 'off' })}
                className={cn(
                  'flex-1 px-4 py-2 font-mono text-mono-sm uppercase',
                  current.intensity === intensity
                    ? 'bg-brand-600 text-white'
                    : 'text-fg-muted hover:bg-bg-sunken',
                )}
              >
                {intensity}
              </button>
            ))}
          </div>

          <Toggle
            label="API load generator"
            description={`${loadgen?.api.vus ?? 0} virtual users`}
            checked={current.apiEnabled}
            testId="loadgen-api"
            onChange={(enabled) => push({ ...current, apiEnabled: enabled })}
          />
        </CardBody>
      </Card>

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Browser traffic</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <Toggle
            label="Browser sessions"
            description="Real page loads, so RUM and Core Web Vitals have data"
            checked={current.browserEnabled}
            testId="loadgen-browser"
            onChange={(enabled) => push({ ...current, browserEnabled: enabled })}
          />
          <QuantityStepper
            label="Concurrent sessions"
            min={0}
            max={8}
            value={current.concurrency}
            testId="loadgen-concurrency"
            onChange={(concurrency) => push({ ...current, concurrency })}
          />
        </CardBody>
      </Card>

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Request rate, last 15 minutes</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="h-40" data-testid="loadgen-sparkline">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={samples} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="t" hide />
                <YAxis hide domain={[0, 'auto']} />
                <ChartTooltip
                  labelFormatter={(value: number) => new Date(value).toLocaleTimeString('en-GB')}
                  formatter={(value: number) => [`${value} req/s`, 'Rate']}
                />
                <Area
                  type="monotone"
                  dataKey="rate"
                  stroke="var(--v-brand-500)"
                  fill="var(--v-brand-500)"
                  fillOpacity={0.2}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {samples.length < 2 ? (
            <p className="mt-2 text-body-sm text-fg-muted">
              Collecting samples — the chart fills as the status poll runs.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
