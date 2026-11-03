import type { SongStatus } from '../library/songs.ts';
import { vocalsUnavailableNote, type StemReadiness, type VocalChoice } from './stem-mix.ts';

interface VocalsControlProps {
  readonly songStatus: SongStatus;
  readonly mix: StemReadiness;
  readonly choice: VocalChoice;
  /** The stems are the only sound: this song kept no picture of its own. */
  readonly stemsOnly?: boolean;
  readonly onChoice: (choice: VocalChoice) => void;
}

/** What the mix is doing, which is not the same thing for the two stages. */
function describeMix(loading: boolean, instrumental: boolean, stemsOnly: boolean): string {
  if (loading) {
    return stemsOnly
      ? 'Reading the stems off this device. They are the whole song here, so it starts once they are in.'
      : 'Reading the stems off this device. The file plays as it is until they are in.';
  }
  if (instrumental) {
    return 'The voice is out. The guide brings it back as quietly as you like.';
  }
  return stemsOnly
    ? 'Both stems together, which is the song as it arrived, voice and all.'
    : "Playing the file's own sound, voice and all.";
}

/**
 * Whether the voice is in, and how much of it.
 *
 * Two things rather than one slider from nothing to everything: a room wants
 * the original for listening and the instrumental for singing, and the fader
 * is for the verse nobody is sure of.
 */
export function VocalsControl({
  songStatus,
  mix,
  choice,
  stemsOnly = false,
  onChoice,
}: VocalsControlProps) {
  const unavailable = vocalsUnavailableNote(songStatus);
  if (unavailable !== null) {
    return (
      <div className="vocals">
        <p className="note">{unavailable}</p>
      </div>
    );
  }

  const instrumental = choice.mode === 'instrumental';
  // 'absent' is the moment before the load starts, which reads as loading to
  // anyone watching.
  const loading = mix.state === 'loading' || mix.state === 'absent';

  return (
    <div className="vocals" aria-busy={loading}>
      <div className="row">
        <span className="label">vocals</span>
        <button
          type="button"
          aria-pressed={!instrumental}
          onClick={() => {
            onChoice({ ...choice, mode: 'original' });
          }}
        >
          original
        </button>
        <button
          type="button"
          aria-pressed={instrumental}
          onClick={() => {
            onChoice({ ...choice, mode: 'instrumental' });
          }}
        >
          instrumental
        </button>

        <span className="spacer" />

        <label className="guide">
          guide
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={choice.guidePercent}
            disabled={!instrumental}
            aria-label="guide vocal"
            onChange={(event) => {
              onChoice({ ...choice, guidePercent: event.currentTarget.valueAsNumber });
            }}
          />
        </label>
        <span className="percent">{String(Math.round(choice.guidePercent))}%</span>
      </div>

      {mix.state === 'failed' ? (
        <p className="error">{mix.error ?? 'the stems for this song could not be played'}</p>
      ) : (
        <p className="note">{describeMix(loading, instrumental, stemsOnly)}</p>
      )}
    </div>
  );
}
