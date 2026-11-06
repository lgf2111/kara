/**
 * The small cache readout that travels with a session and the panel draws.
 *
 * It is deliberately separate from the store: the store owns bytes and
 * records, while this is the one sentence a person sees. The states are the
 * lifecycle of a session's encounter with the cache, not of the cache itself:
 *
 * - `checking`: a start is asking whether this video is already here.
 * - `hit`: the whole track came from disk; no fetch, model or separation.
 * - `miss`: nothing matched, so the normal session runs.
 * - `writing`: the separated blocks are being copied into a new entry.
 * - `ready`: the entry is complete and the session can use it next time.
 * - `error`: the cache could not be used, which never stops the session.
 *
 * Pure, so the normalisation and the words are the tests.
 */

export type CacheState = 'checking' | 'hit' | 'miss' | 'writing' | 'ready' | 'error';

export interface CacheStatus {
  readonly state: CacheState;
  /** The entry's size when one is known, otherwise null. */
  readonly bytes: number | null;
  /** One short line for a tooltip or a diagnostics row. */
  readonly detail: string | null;
}

const STATES: readonly CacheState[] = [
  'checking',
  'hit',
  'miss',
  'writing',
  'ready',
  'error',
];

/** A finite, non-negative byte count, or null. */
function bytesOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** A single-line, bounded detail string, or null. */
function detailOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.replace(/\s+/gu, ' ').trim().slice(0, 120).trim();
  return text === '' ? null : text;
}

/** One status out of a report or storage, or null when it is not one. */
export function normaliseCacheStatus(raw: unknown): CacheStatus | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const stored = raw as Record<string, unknown>;
  const state = stored['state'];
  if (typeof state !== 'string' || !STATES.includes(state as CacheState)) {
    return null;
  }
  return {
    state: state as CacheState,
    bytes: bytesOrNull(stored['bytes']),
    detail: detailOrNull(stored['detail']),
  };
}

/** Decimal megabytes, the same units the popup's diagnostics use. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${String(Math.round(bytes / 1_000))} KB`;
  }
  return `${String(Math.round(bytes))} B`;
}

/**
 * The one compact line the panel shows, or null when there is nothing to say.
 *
 * `miss` is not hidden: a person who has used the cache for other songs is
 * owed the reason this one is slower. It is one quiet row, not a card.
 */
export function cacheStatusLabel(raw: unknown): string | null {
  const status = normaliseCacheStatus(raw);
  if (status === null) {
    return null;
  }
  switch (status.state) {
    case 'checking':
      return 'Checking cache…';
    case 'hit':
      return status.bytes === null ? 'Cached' : `Cached: ${formatBytes(status.bytes)}`;
    case 'miss':
      return 'Not cached';
    case 'writing':
      return 'Saving cache…';
    case 'ready':
      return status.bytes === null ? 'Cached' : `Cached: ${formatBytes(status.bytes)}`;
    case 'error':
      return 'Cache unavailable';
  }
}
