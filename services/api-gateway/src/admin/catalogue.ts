/**
 * The chaos catalogue and the scenario definitions, loaded from
 * `tools/scenarios/`.
 *
 * They are data rather than code so that `GET /admin/chaos` is
 * self-describing: the admin UI renders whatever the catalogue says, and
 * adding a flag is one entry in one file instead of a change in two places
 * that eventually disagree.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FlagDefinition {
  name: string;
  group: string;
  type: 'bool' | 'int' | 'float' | 'string' | 'enum' | 'map';
  default: boolean | number | string | Record<string, unknown>;
  options?: string[];
  min?: number;
  max?: number;
  injection: string;
  scenarios: string[];
  compensating?: string;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  story: string;
  products: string[];
  loadMultiplier?: number;
  requiresRestartToRecover?: boolean;
  flags: Record<string, boolean | number | string>;
}

const CATALOGUE_DIR = process.env.SCENARIOS_DIR ?? '/app/scenarios';

function load<T>(file: string, key: string): T[] {
  const raw = readFileSync(join(CATALOGUE_DIR, file), 'utf8');
  return (JSON.parse(raw) as Record<string, T[]>)[key];
}

export const FLAGS: FlagDefinition[] = load<FlagDefinition>('flags.json', 'flags');
export const SCENARIOS: ScenarioDefinition[] = load<ScenarioDefinition>(
  'scenarios.json',
  'scenarios',
);

const BY_NAME = new Map(FLAGS.map((flag) => [flag.name, flag]));
const SCENARIO_BY_ID = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));

export function flag(name: string): FlagDefinition | undefined {
  return BY_NAME.get(name);
}

export function scenario(id: string): ScenarioDefinition | undefined {
  return SCENARIO_BY_ID.get(id.toUpperCase());
}

/**
 * Parse a value out of the Redis hash, which stores everything as a string.
 *
 * A flag whose stored value will not parse falls back to its default rather
 * than throwing: a typo in the admin UI should not make the whole catalogue
 * unreadable.
 */
export function coerce(definition: FlagDefinition, raw: string | undefined): unknown {
  if (raw === undefined) return definition.default;

  switch (definition.type) {
    case 'bool':
      return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
    case 'int': {
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : definition.default;
    }
    case 'float': {
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : definition.default;
    }
    case 'map':
      try {
        return JSON.parse(raw);
      } catch {
        return definition.default;
      }
    default:
      return raw;
  }
}

/** Turn an admin-supplied value into the string the Redis hash holds. */
export function encode(definition: FlagDefinition, value: unknown): string {
  if (definition.type === 'bool') return value ? 'true' : 'false';
  if (definition.type === 'map') return JSON.stringify(value ?? {});
  return String(value);
}

/**
 * Reject a value the flag cannot take.
 *
 * Returns a human-readable reason, or null when the value is fine. Refusing
 * `gds_error_rate=5` up front is much kinder than letting every search fail
 * and leaving the operator to work out why.
 */
export function validate(definition: FlagDefinition, value: unknown): string | null {
  switch (definition.type) {
    case 'bool':
      return typeof value === 'boolean' || ['true', 'false'].includes(String(value))
        ? null
        : 'must be true or false';

    case 'int':
    case 'float': {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 'must be a number';
      if (definition.type === 'int' && !Number.isInteger(parsed)) {
        return 'must be a whole number';
      }
      if (definition.min !== undefined && parsed < definition.min) {
        return `must be at least ${definition.min}`;
      }
      if (definition.max !== undefined && parsed > definition.max) {
        return `must be at most ${definition.max}`;
      }
      return null;
    }

    case 'enum':
    case 'string':
      if (definition.options && !definition.options.includes(String(value))) {
        return `must be one of ${definition.options.map((o) => o || '""').join(', ')}`;
      }
      return null;

    case 'map':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? null
        : 'must be an object mapping service names to numbers';

    default:
      return null;
  }
}
