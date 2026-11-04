import { useEffect, useRef, useState } from 'react';

import { Controls } from './Controls.tsx';
import { ProgressChip } from './ProgressChip.tsx';
import { VocalsControl } from './VocalsControl.tsx';
import type { AnalysisView, VocalToggle } from './analysis.ts';
import type { VocalChoice } from './stem-mix.ts';
import type { Transport } from './transport.ts';

/** How long the instrumental announces itself for. Long enough to read once. */
const TOAST_MS = 3200;

interface StageOverlaysProps {
  readonly title: string;
  /** Hidden when the room has settled and something is playing. */
  readonly shown: boolean;
  readonly transport: Transport;
  readonly vocals: VocalChoice;
  readonly onVocals: (choice: VocalChoice) => void;
  readonly toggle: VocalToggle;
  readonly analysis: AnalysisView;
  readonly onOpenDrawer: () => void;
  readonly onCancelAnalysis: (() => void) | null;
  readonly onResumeAnalysis: (() => void) | null;
  readonly error: string | null;
}

/**
 * Everything laid over the song: the title and the way back to the songs at
 * the top, the transport and the vocals at the bottom, and the analysis chip
 * in the corner.
 *
 * All of it sits on the picture rather than beside it. A KTV room is the
 * picture; the controls are something you reach through when you need them
 * and should not be there when you do not.
 */
export function StageOverlays({
  title,
  shown,
  transport,
  vocals,
  onVocals,
  toggle,
  analysis,
  onOpenDrawer,
  onCancelAnalysis,
  onResumeAnalysis,
  error,
}: StageOverlaysProps) {
  const [announcing, setAnnouncing] = useState(false);
  const announced = useRef(toggle.enabled);

  useEffect(() => {
    // Only the moment it turns on, and only once: a song that was already
    // separated when it went on has nothing to announce.
    const fresh = toggle.enabled && !announced.current;
    announced.current = toggle.enabled;
    if (!fresh) {
      return;
    }
    setAnnouncing(true);
    const timer = setTimeout(() => {
      setAnnouncing(false);
    }, TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toggle.enabled]);

  return (
    <>
      <div className="overlay top">
        <button type="button" className="songs-open" onClick={onOpenDrawer}>
          songs
        </button>
        <p className="now">{title}</p>
      </div>

      <div className="overlay bottom">
        {error !== null && <p className="error">{error}</p>}
        <VocalsControl toggle={toggle} choice={vocals} onChoice={onVocals} />
        <Controls transport={transport} />
      </div>

      <ProgressChip
        view={analysis}
        dim={!shown}
        onCancel={onCancelAnalysis}
        onResume={onResumeAnalysis}
      />

      {announcing && (
        <p className="toast" role="status">
          Instrumental ready
        </p>
      )}
    </>
  );
}
