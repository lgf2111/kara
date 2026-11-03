import type { SongStatus } from './songs.ts';

/** Numbers and worker stage names, as something a person reads. */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${String(minutes)}:${pad(seconds)}`;
}

/** An estimate, rounded to something honest about how rough it is. */
export function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return 'an unknown time';
  }
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${String(seconds)} s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

export function formatPercent(share: number): string {
  return `${(share * 100).toFixed(0)}%`;
}

/**
 * What the browser says it is holding for this site, and how much of what it
 * will allow that is. Either figure can be missing: `estimate` is permitted to
 * say nothing, and a private window often does.
 */
export function describeStorage(usageBytes: number | null, quotaBytes: number | null): string {
  if (usageBytes === null) {
    return 'This browser will not say how much it has stored for this site.';
  }
  const used = `${formatBytes(usageBytes)} stored for this site`;
  if (quotaBytes === null || quotaBytes <= 0) {
    return `${used}.`;
  }
  const share = formatPercent(usageBytes / quotaBytes);
  return `${used}, ${share} of the ${formatBytes(quotaBytes)} it will allow.`;
}

export function describeStage(stage: string): string {
  if (stage.startsWith('plan:')) {
    return 'checking for earlier progress';
  }
  if (stage === 'loading model') {
    return 'loading the separation model';
  }
  return stage;
}

export function describeStatus(status: SongStatus): string {
  switch (status) {
    case 'separating':
      return 'separating';
    case 'ready':
      return 'ready';
    case 'cancelled':
      return 'paused, drop the same file again to carry on';
    case 'failed':
      return 'failed';
  }
}
