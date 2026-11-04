import { describeAnalysis, type AnalysisView } from './analysis.ts';

interface ProgressChipProps {
  readonly view: AnalysisView;
  /** The overlays have gone; the chip stays but gets out of the way. */
  readonly dim: boolean;
  readonly onCancel: (() => void) | null;
  /** Offered for a job this tab still holds the file for. */
  readonly onResume: (() => void) | null;
}

/**
 * What analysis is doing, in one corner, while the song plays over the top of
 * it.
 *
 * It outlives the rest of the furniture. The bars go when the room settles,
 * but a separation runs for minutes and somebody will want to know whether it
 * is still going without waving at the screen, so this only dims.
 */
export function ProgressChip({ view, dim, onCancel, onResume }: ProgressChipProps) {
  if (view.phase === 'none' || view.phase === 'ready') {
    return null;
  }

  const share = view.share;

  return (
    <div className={dim ? 'chip dim' : 'chip'} aria-live="polite">
      <span className={`dot ${view.phase}`} aria-hidden="true" />
      <span className="said">{describeAnalysis(view)}</span>
      {share !== null && (
        <span className="meter" aria-hidden="true">
          <span className="fill" style={{ width: `${String(Math.round(share * 100))}%` }} />
        </span>
      )}
      {onCancel !== null && (
        <button type="button" onClick={onCancel}>
          stop
        </button>
      )}
      {onResume !== null && (
        <button type="button" onClick={onResume}>
          resume
        </button>
      )}
    </div>
  );
}
