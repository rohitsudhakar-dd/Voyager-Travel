import {
  CHAOS_GROUPS,
  type ChaosFlag,
  type ChaosGroup,
  type ChaosValue,
} from '@voyager/shared-schemas';
import { Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useChaosCatalog, useResetChaos, useUpdateChaos } from '@/api/hooks/admin';
import { errorMessage } from '@/api/errors';
import { Alert, Badge, Input, Skeleton, Slider, Toggle, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { toast } from '@/store/toasts';

/**
 * 04-STYLING.md § 5.1. Every flag, its type, bounds, description and scenarios
 * come from `GET /admin/chaos`; nothing about the catalogue is hardcoded here
 * beyond the group ordering, which is the documented order.
 */
export function ChaosPanel() {
  const catalog = useChaosCatalog(true);
  const update = useUpdateChaos();
  const reset = useResetChaos();

  const grouped = useMemo(() => {
    const map = new Map<ChaosGroup, ChaosFlag[]>();
    for (const flag of catalog.data?.flags ?? []) {
      const existing = map.get(flag.group);
      if (existing) existing.push(flag);
      else map.set(flag.group, [flag]);
    }
    return map;
  }, [catalog.data]);

  const active = new Set(catalog.data?.activeFlags ?? []);

  const apply = (name: string, value: ChaosValue) => {
    update.mutate(
      { [name]: value },
      { onError: (error) => toast.danger('That flag did not change', errorMessage(error)) },
    );
  };

  if (catalog.isError) {
    return (
      <Alert intent="danger" title="The admin API is not answering">
        {errorMessage(catalog.error)}
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-heading-lg">Chaos flags</h1>
        <button
          type="button"
          disabled={reset.isPending}
          data-testid="reset-all-chaos-inline"
          onClick={() => reset.mutate()}
          className="text-body-sm text-danger-500 hover:underline disabled:opacity-50"
        >
          Reset everything
        </button>
      </div>

      {catalog.isPending
        ? Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} shape="rect" className="h-40" />
          ))
        : CHAOS_GROUPS.filter((group) => grouped.has(group)).map((group) => (
            <section key={group} aria-labelledby={`chaos-group-${group}`}>
              <h2
                id={`chaos-group-${group}`}
                className="mb-2 font-mono text-mono-sm uppercase tracking-wide text-fg-muted"
              >
                {group}
              </h2>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-elevated">
                {grouped.get(group)!.map((flag) => (
                  <FlagRow
                    key={flag.name}
                    flag={flag}
                    active={active.has(flag.name)}
                    pending={update.isPending}
                    onApply={apply}
                  />
                ))}
              </ul>
            </section>
          ))}
    </div>
  );
}

/** The value a flag takes when its toggle is switched on. */
function enabledValue(flag: ChaosFlag): ChaosValue {
  switch (flag.type) {
    case 'bool':
      return true;
    case 'int':
    case 'float': {
      const max = flag.max ?? 1;
      const min = flag.min ?? 0;
      const midpoint = min + (max - min) / 4;
      return flag.type === 'int' ? Math.round(midpoint) : Number(midpoint.toFixed(2));
    }
    case 'enum':
      return flag.enumValues?.find((value) => value !== flag.default) ?? flag.enumValues?.[0] ?? '';
    case 'string':
      return typeof flag.value === 'string' && flag.value ? flag.value : '';
    case 'map':
      return flag.value;
  }
}

function FlagRow({
  flag,
  active,
  pending,
  onApply,
}: {
  flag: ChaosFlag;
  active: boolean;
  pending: boolean;
  onApply: (name: string, value: ChaosValue) => void;
}) {
  return (
    <li
      data-testid={`chaos-flag-${flag.name}`}
      data-active={active}
      className={cn(
        'flex flex-col gap-2 px-3 py-2.5',
        active && 'border-l-2 border-l-danger-500 bg-danger-500/[0.06]',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Toggle
          label={flag.name}
          labelHidden
          checked={active}
          disabled={pending}
          testId={`chaos-toggle-${flag.name}`}
          onChange={(checked) => onApply(flag.name, checked ? enabledValue(flag) : flag.default)}
        />

        <span className="font-mono text-mono-sm text-fg">{flag.name}</span>

        <div className="flex min-w-0 max-w-full items-center gap-2 sm:ml-auto">
          <FlagControl flag={flag} disabled={pending} onApply={onApply} />
          <Tooltip content={`${flag.type}, default ${JSON.stringify(flag.default)}`}>
            <span
              tabIndex={0}
              aria-label={`${flag.name} type and default`}
              className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle"
            >
              <Info aria-hidden className="h-3.5 w-3.5" />
            </span>
          </Tooltip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-12">
        <p className="text-body-sm text-fg-muted">{flag.description}</p>
        {flag.scenarios.length > 0 ? (
          <span className="flex gap-1">
            {flag.scenarios.map((scenario) => (
              <Badge key={scenario} intent="neutral" size="sm" className="font-mono">
                {scenario}
              </Badge>
            ))}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function FlagControl({
  flag,
  disabled,
  onApply,
}: {
  flag: ChaosFlag;
  disabled: boolean;
  onApply: (name: string, value: ChaosValue) => void;
}) {
  if (flag.type === 'int' || flag.type === 'float') {
    return <NumericControl flag={flag} disabled={disabled} onApply={onApply} />;
  }

  if (flag.type === 'enum' && flag.enumValues) {
    return (
      <div
        role="group"
        aria-label={flag.name}
        className="flex overflow-hidden rounded-md border border-border"
      >
        {flag.enumValues.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={flag.value === option}
            data-testid={`chaos-enum-${flag.name}-${option}`}
            onClick={() => onApply(flag.name, option)}
            className={cn(
              'px-2.5 py-1 font-mono text-mono-sm',
              flag.value === option
                ? 'bg-brand-600 text-white'
                : 'text-fg-muted hover:bg-bg-sunken',
            )}
          >
            {option}
          </button>
        ))}
      </div>
    );
  }

  if (flag.type === 'string') {
    return <StringControl flag={flag} disabled={disabled} onApply={onApply} />;
  }

  if (flag.type === 'map') {
    return <MapControl flag={flag} disabled={disabled} onApply={onApply} />;
  }

  return null;
}

function NumericControl({
  flag,
  disabled,
  onApply,
}: {
  flag: ChaosFlag;
  disabled: boolean;
  onApply: (name: string, value: ChaosValue) => void;
}) {
  const min = flag.min ?? 0;
  const max = flag.max ?? 100;
  const step = flag.step ?? (flag.type === 'int' ? 1 : 0.01);
  const current = typeof flag.value === 'number' ? flag.value : min;
  const [draft, setDraft] = useState(current);

  // The slider is the demo control, so it commits on release rather than on
  // every pixel of drag -- one PUT per gesture, not two hundred.
  return (
    <div className="flex items-center gap-2">
      <Slider
        label={flag.name}
        labelHidden
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        testId={`chaos-slider-${flag.name}`}
        className="w-24 sm:w-40"
        onChange={setDraft}
        onCommit={(value) => onApply(flag.name, value)}
      />
      <Input
        label={flag.name}
        labelHidden
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        suffix={flag.unit ? <span className="text-caption">{flag.unit}</span> : undefined}
        containerClassName="w-28"
        className="tabular"
        data-testid={`chaos-number-${flag.name}`}
        onChange={(event) => setDraft(Number(event.target.value))}
        onBlur={() => onApply(flag.name, draft)}
      />
    </div>
  );
}

function StringControl({
  flag,
  disabled,
  onApply,
}: {
  flag: ChaosFlag;
  disabled: boolean;
  onApply: (name: string, value: ChaosValue) => void;
}) {
  const [draft, setDraft] = useState(typeof flag.value === 'string' ? flag.value : '');

  return (
    <Input
      label={flag.name}
      labelHidden
      value={draft}
      disabled={disabled}
      containerClassName="w-full sm:w-56"
      className="font-mono text-mono-sm"
      data-testid={`chaos-string-${flag.name}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onApply(flag.name, draft)}
    />
  );
}

/** `service_error_rate` and `service_latency_ms` are the map-valued flags. */
function MapControl({
  flag,
  disabled,
  onApply,
}: {
  flag: ChaosFlag;
  disabled: boolean;
  onApply: (name: string, value: ChaosValue) => void;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(flag.value));
  const [invalid, setInvalid] = useState(false);

  return (
    <Input
      label={flag.name}
      labelHidden
      value={draft}
      disabled={disabled}
      error={invalid ? 'Not valid JSON' : undefined}
      containerClassName="w-80"
      className="font-mono text-mono-sm"
      data-testid={`chaos-map-${flag.name}`}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => {
        try {
          onApply(flag.name, JSON.parse(draft) as ChaosValue);
        } catch {
          setInvalid(true);
        }
      }}
    />
  );
}
