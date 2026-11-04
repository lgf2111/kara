/**
 * What happened, in a ring, so that a report can be copied out of a tab
 * nobody was watching.
 *
 * Everything that goes wrong with this extension goes wrong once, in the
 * middle of a song, on somebody else's machine: a reset nobody asked for,
 * three seconds of buffering, a window that took a second longer than the
 * others, an output that fell behind and stayed there. A console a person has
 * to be told to open, filtered to the right context, is not evidence anybody
 * ever actually sends. So the facts are kept here instead, bounded, and the
 * popup has a button that copies them.
 *
 * The bound is the point of a ring: a four-minute run can log a few hundred
 * events and a four-hour one must not grow. The oldest go, which is the right
 * end to lose — the interesting part of a starvation is how it started, but
 * the interesting part of a log somebody is copying now is the last minute.
 *
 * Nothing in here carries audio, a page address, a video title or anything a
 * person typed. `debug-report.ts` is where that is stated and enforced; this
 * file only holds what it is handed.
 */

export type EventKind =
  /** A timeline thrown away, with the reason. */
  | 'reset'
  /** The song standing still while the capture kept running. */
  | 'stall'
  /** The output asking for audio nothing had written. */
  | 'underrun'
  /** The delay being chosen, or growing. */
  | 'delay'
  /** Where the clocks and the mapping have got to, sampled. */
  | 'drift'
  | 'error'
  | 'note';

/** Numbers and words only: a log entry that holds an object holds a leak. */
export type EventData = Readonly<Record<string, number | string | boolean>>;

export interface LoggedEvent {
  /** Milliseconds on the shared wall clock. */
  readonly atMs: number;
  readonly kind: EventKind;
  readonly what: string;
  readonly data: EventData | null;
  readonly stack: string | null;
}

/** Events kept. A few hundred covers a long song at a few an minute. */
export const DEFAULT_LIMIT = 400;

export interface EventLog {
  /** Events added since the last clear, including the ones since dropped. */
  readonly count: number;
  readonly dropped: number;
  add(kind: EventKind, what: string, data?: EventData | null, stack?: string | null): void;
  events(): readonly LoggedEvent[];
  clear(): void;
}

export interface EventLogOptions {
  readonly limit?: number;
  /** The clock, so a test does not have to wait for one. */
  readonly now?: () => number;
}

export function createEventLog(options: EventLogOptions = {}): EventLog {
  const asked = options.limit;
  const limit =
    asked !== undefined && Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : DEFAULT_LIMIT;
  const clock = options.now ?? ((): number => Date.now());

  let held: LoggedEvent[] = [];
  let count = 0;
  let dropped = 0;

  return {
    get count() {
      return count;
    },
    get dropped() {
      return dropped;
    },

    add(kind, what, data = null, stack = null) {
      count += 1;
      held.push({ atMs: clock(), kind, what, data, stack });
      if (held.length > limit) {
        dropped += held.length - limit;
        held = held.slice(held.length - limit);
      }
    },

    events() {
      return held;
    },

    clear() {
      held = [];
      count = 0;
      dropped = 0;
    },
  };
}

/**
 * A cause as a line and a stack, for the log. Separate from `reason.ts`, which
 * is what a person is shown: a stack belongs in a report and never on a panel.
 */
export function stackOf(cause: unknown): string | null {
  if (cause instanceof Error && typeof cause.stack === 'string') {
    return cause.stack;
  }
  return null;
}
