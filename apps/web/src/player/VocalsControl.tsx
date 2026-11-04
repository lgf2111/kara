import type { VocalToggle } from './analysis.ts';
import type { VocalChoice } from './stem-mix.ts';

interface VocalsControlProps {
  /** Whether the voice can come out yet, and what to say while it cannot. */
  readonly toggle: VocalToggle;
  readonly choice: VocalChoice;
  readonly onChoice: (choice: VocalChoice) => void;
}

/**
 * Whether the voice is in, and how much of it.
 *
 * Two things rather than one slider from nothing to everything: a room wants
 * the original for listening and the instrumental for singing, and the fader
 * is for the verse nobody is sure of.
 *
 * It is on the stage from the first second of the song, greyed, saying how
 * far analysis has got. A control that appears halfway through a song is a
 * control nobody finds.
 */
export function VocalsControl({ toggle, choice, onChoice }: VocalsControlProps) {
  const instrumental = choice.mode === 'instrumental';

  return (
    <div className="vocals" title={toggle.label} aria-busy={!toggle.enabled}>
      <span className="label">vocals</span>
      <div className="pair">
        <button
          type="button"
          aria-pressed={!instrumental}
          disabled={!toggle.enabled}
          onClick={() => {
            onChoice({ ...choice, mode: 'original' });
          }}
        >
          original
        </button>
        <button
          type="button"
          aria-pressed={instrumental}
          disabled={!toggle.enabled}
          onClick={() => {
            onChoice({ ...choice, mode: 'instrumental' });
          }}
        >
          instrumental
        </button>
      </div>

      <label className="guide">
        guide
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={choice.guidePercent}
          disabled={!toggle.enabled || !instrumental}
          aria-label="guide vocal"
          onChange={(event) => {
            onChoice({ ...choice, guidePercent: event.currentTarget.valueAsNumber });
          }}
        />
      </label>
      <span className="percent">{String(Math.round(choice.guidePercent))}%</span>

      {!toggle.enabled && <p className="why">{toggle.label}</p>}
    </div>
  );
}
