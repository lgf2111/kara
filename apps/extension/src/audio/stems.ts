/**
 * The four stems, and the desk that mixes them.
 *
 * htdemucs returns drums, bass, other and vocals, in that order. Until now the
 * extension added the first three together and called it the instrumental,
 * because that was the only choice the player had. A mixer needs them apart:
 * turning the drums down is not the same request as turning the whole backing
 * down, and a person learning a bass line wants exactly that difference.
 *
 * The order here is the model's order, and `test/stems.test.ts` holds it to
 * `SOURCES` so the two cannot drift. It is also the order the channels arrive
 * in and the order the gains are sent in, which is the one thing that has to
 * stay true from the model to the worklet.
 *
 * **A level is not the whole picture.** Each stem has a slider position, a
 * mute switch and a solo switch. They are kept apart on purpose: muting a
 * stem and then unmuting it must give the slider back where it was, and
 * soloing another stem must not erase the balance somebody built. The player
 * is told only the effective gain — level, then solo, then mute — because that
 * is all it needs to turn into sound.
 *
 * A level is a gain between nought and one, never a boost. At one each stem
 * adds up to the mixture the video played — htdemucs applies no mask, so the
 * four sum back to the input — which means a mix can never clip a track that
 * did not already clip. The default is the honest one: every slider at one,
 * with the vocal muted. That sounds like karaoke, but the guide's slider is
 * already where the person will want it when they press M.
 *
 * Pure: the panel reads percentages, the engine reads levels, and nothing here
 * touches an audio buffer.
 */

/** The model's stem order, which is the wire order and the worklet's order. */
export const STEMS = ['drums', 'bass', 'other', 'vocals'] as const;

export type Stem = (typeof STEMS)[number];

/** One slider position per stem, between nought and one. */
export type StemLevels = Readonly<Record<Stem, number>>;

/** One switch per stem. */
export type StemFlags = Readonly<Record<Stem, boolean>>;

/**
 * The whole desk: where each slider sits, and which switches are pressed.
 *
 * Levels are independent of the switches, so a report can tell the panel to
 * draw a slider at 40% while the row is muted, and the person can move that
 * slider without unmuting it. The player never sees this shape: `mixGains`
 * resolves it to four gains.
 */
export interface StemMix {
  readonly levels: StemLevels;
  readonly muted: StemFlags;
  readonly soloed: StemFlags;
}

/**
 * The starting desk: every slider full, and the vocal muted.
 *
 * The obvious default for a karaoke button is the vocal at zero, but that
 * makes the first move awkward: the guide is the one stem people came for,
 * and having to raise a slider before pressing M is a step nobody asked for.
 * Leaving the vocal at full and muting it keeps the audible default identical
 * — backing only — while one press of M brings the whole guide in.
 */
export const DEFAULT_LEVELS: StemLevels = {
  drums: 1,
  bass: 1,
  other: 1,
  vocals: 1,
};

/** Backing switches start off; the vocal starts muted. */
const DEFAULT_MUTED: StemFlags = {
  drums: false,
  bass: false,
  other: false,
  vocals: true,
};

const NOT_SOLOED: StemFlags = {
  drums: false,
  bass: false,
  other: false,
  vocals: false,
};

/** Karaoke: all four at full, the vocal muted, nothing soloed. */
export const DEFAULT_MIX: StemMix = {
  levels: DEFAULT_LEVELS,
  muted: DEFAULT_MUTED,
  soloed: NOT_SOLOED,
};

/** What each stem is called on screen. */
export const STEM_LABEL: Readonly<Record<Stem, string>> = {
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other',
  vocals: 'Vocals',
};

/**
 * The words on the row itself, and the words its mute switch wears.
 *
 * The vocal row is the guide, and Kara starts with it muted, so "Vocals · 100"
 * read as a bug: a full slider that made no sound, with the only clue a single
 * letter. The row says what it is and the switch says which way it is thrown.
 */
export function stemRowLabel(stem: Stem, muted: boolean): string {
  if (stem !== 'vocals') {
    return STEM_LABEL[stem];
  }
  return muted ? 'Guide vocal: off' : 'Guide vocal: on';
}

export function isStem(value: unknown): value is Stem {
  return typeof value === 'string' && (STEMS as readonly string[]).includes(value);
}

/** One level, kept where adding the stems back up cannot clip. */
export function stemLevel(level: unknown): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    return 0;
  }
  return Math.min(1, Math.max(0, level));
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A mix out of anything storage or another context handed over.
 *
 * The nested shape is this version's; a flat `{ drums, bass, ... }` is the
 * shape from before the switches existed and is still read, because a status
 * report can sit in `chrome.storage.session` across an extension reload. In
 * both shapes a missing or unreadable stem falls back to the default for that
 * stem, one stem at a time, so a message that lost a field does not change the
 * rest of the song. A readable but out-of-range number is clamped rather than
 * replaced: a slider that arrived at 140 asked for as much as there is.
 *
 * A switch that is not a boolean also falls back to that stem's default, not
 * to off. The direction matters: the vocal defaults to muted, so a malformed
 * message must not unmute it and put the guide into the backing by accident.
 * An explicit `false` is honoured, which is how the panel asks for the guide.
 */
export function normaliseMix(raw: unknown): StemMix {
  const stored = recordOf(raw);
  const nested = recordOf(stored['levels']);
  // Old flat levels have no `levels` property; their stem names live at the
  // top. An empty nested object means the same thing as missing fields.
  const source = Object.keys(nested).length > 0 ? nested : stored;
  const rawMuted = recordOf(stored['muted']);
  const rawSoloed = recordOf(stored['soloed']);
  const levels = {} as Record<Stem, number>;
  const muted = {} as Record<Stem, boolean>;
  const soloed = {} as Record<Stem, boolean>;
  for (const stem of STEMS) {
    const value = source[stem];
    levels[stem] =
      typeof value === 'number' && Number.isFinite(value)
        ? stemLevel(value)
        : DEFAULT_MIX.levels[stem];
    const mute = rawMuted[stem];
    muted[stem] = typeof mute === 'boolean' ? mute : DEFAULT_MIX.muted[stem];
    const solo = rawSoloed[stem];
    soloed[stem] = typeof solo === 'boolean' ? solo : DEFAULT_MIX.soloed[stem];
  }
  return { levels, muted, soloed };
}

/** The mix with one slider moved, as a new object. */
export function withStem(mix: StemMix, stem: Stem, level: unknown): StemMix {
  const tidy = normaliseMix(mix);
  return {
    ...tidy,
    levels: { ...tidy.levels, [stem]: stemLevel(level) },
  };
}

/** The mix with one mute switch set, leaving its slider and solo alone. */
export function withMute(mix: StemMix, stem: Stem, muted: unknown): StemMix {
  const tidy = normaliseMix(mix);
  return {
    ...tidy,
    muted: { ...tidy.muted, [stem]: muted === true },
  };
}

/** The mix with one solo switch set, leaving its slider and mute alone. */
export function withSolo(mix: StemMix, stem: Stem, soloed: unknown): StemMix {
  const tidy = normaliseMix(mix);
  return {
    ...tidy,
    soloed: { ...tidy.soloed, [stem]: soloed === true },
  };
}

/**
 * The four gains the player needs, in wire order.
 *
 * Solo narrows the desk: if any stem is soloed, the others are silent. Mute is
 * a switch on the stem itself and wins over solo, so a muted stem that is also
 * soloed stays silent — the same thing a hardware desk does. With no switch
 * pressed this is exactly the four slider positions, which is why the default
 * mix adds back up to the recording.
 */
export function mixGains(mix: StemMix): readonly number[] {
  const tidy = normaliseMix(mix);
  const soloing = STEMS.some((stem) => tidy.soloed[stem]);
  return STEMS.map((stem) => {
    if (tidy.muted[stem]) {
      return 0;
    }
    if (soloing && !tidy.soloed[stem]) {
      return 0;
    }
    return tidy.levels[stem];
  });
}

/** Where a slider sits for a gain, and the gain for a slider position. */
export function stemPercent(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(level * 100)));
}

export function stemFromPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.min(1, Math.max(0, percent / 100));
}
