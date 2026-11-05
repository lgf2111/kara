import type { PrepareProgress } from '../src/audio/progress.ts';
import { IDLE_REPORT, type StatusReport } from '../src/protocol.ts';

/**
 * A status report with only the fields a test cares about changed.
 *
 * `IDLE_REPORT` is the real default — the one a stopped tab is told — so a
 * test that changes one field is a test of what that field does to a report
 * that is otherwise exactly what the extension sends.
 */
export function report(patch: Partial<StatusReport> = {}): StatusReport {
  return { ...IDLE_REPORT, ...patch };
}

/** Progress in the separating stage, with every measured field under control. */
export function separating(done: number, total: number, aboutSeconds: number | null = null): PrepareProgress {
  return {
    stage: 'separating',
    fraction: total === 0 ? 0 : done / total,
    pieces: null,
    aboutSeconds,
  };
}
