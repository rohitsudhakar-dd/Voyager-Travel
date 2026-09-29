import { format, parseISO } from 'date-fns';

/** Display formatting. Amounts are cents everywhere on the wire. */

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, decimals: boolean) {
  const key = `${currency}:${decimals}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals ? 2 : 0,
      maximumFractionDigits: decimals ? 2 : 0,
    });
    moneyFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatMoney(cents: number, currency = 'GBP'): string {
  const decimals = cents % 100 !== 0;
  return moneyFormatter(currency, decimals).format(cents / 100);
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}m` : `${hours}h ${String(rest).padStart(2, '0')}m`;
}

/** Times are rendered in the traveller's locale, 24h, matching an airline itinerary. */
export function formatTime(iso: string): string {
  return format(parseISO(iso), 'HH:mm');
}

export function formatDateShort(iso: string): string {
  return format(parseISO(iso), 'd MMM');
}

export function formatDateWithDay(iso: string): string {
  return format(parseISO(iso), 'EEE d MMM');
}

export function formatDateLong(iso: string): string {
  return format(parseISO(iso), 'd MMMM yyyy');
}

export function formatDateTime(iso: string): string {
  return format(parseISO(iso), 'd MMM yyyy, HH:mm');
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-GB').format(value);
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Bucketed price, for anywhere a price would otherwise become an unbounded
 * dimension (06-USER-FLOWS.md § 7).
 */
export function priceBand(cents: number): '0-200' | '200-500' | '500-1000' | '1000+' {
  const major = cents / 100;
  if (major < 200) return '0-200';
  if (major < 500) return '200-500';
  if (major < 1000) return '500-1000';
  return '1000+';
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function stopsLabel(stops: number): string {
  if (stops === 0) return 'Nonstop';
  return stops === 1 ? '1 stop' : `${stops} stops`;
}

export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}
