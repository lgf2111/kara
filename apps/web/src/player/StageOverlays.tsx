import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
import { useNotices } from '../notices/Notices.tsx';
import { Controls } from './Controls.tsx';
import { ProgressChip } from './ProgressChip.tsx';
import { SongsButton } from './SongsButton.tsx';
import { VocalsControl } from './VocalsControl.tsx';
import type { AnalysisView, VocalToggle } from './analysis.ts';
import type { VocalChoice } from './stem-mix.ts';
import type { Transport } from './transport.ts';

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
  const notices = useNotices();
  const announced = useRef(toggle.enabled);

  useEffect(() => {
    // Only the moment it turns on, and only once: a song that was already
    // separated when it went on has nothing to announce.
    const fresh = toggle.enabled && !announced.current;
    announced.current = toggle.enabled;
    if (fresh) {
      notices.show({ headline: 'Instrumental ready', detail: null });
    }
  }, [notices, toggle.enabled]);

  const bar = cn(
    'absolute inset-x-0 z-20 transition-opacity duration-200',
    shown ? 'opacity-100' : 'pointer-events-none opacity-0',
  );

  return (
    <>
      <div
        className={cn(
          bar,
          'top-0 flex items-center gap-2 bg-gradient-to-b from-black/75 to-transparent p-3 pb-10',
        )}
      >
        <SongsButton onClick={onOpenDrawer} />
        <p className="truncate font-heading font-medium tracking-tight text-white drop-shadow">
          {title}
        </p>
      </div>

      <div
        className={cn(
          bar,
          'bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/85 to-transparent px-3 pt-16 pb-3',
        )}
      >
        {error !== null && <p className="text-sm text-destructive">{error}</p>}
        <VocalsControl toggle={toggle} analysis={analysis} choice={vocals} onChoice={onVocals} />
        <Controls transport={transport} />
      </div>

      <ProgressChip
        view={analysis}
        dim={!shown}
        onCancel={onCancelAnalysis}
        onResume={onResumeAnalysis}
      />
    </>
  );
}
