import {
  MAX_SCORE_HISTORY,
  SCORE_HISTORY_KEY,
  SCORE_SINGER_KEY,
  appendScoreRun,
  normaliseScoreHistory,
  normaliseSinger,
  pruneScoreHistory,
  type PracticeRun,
} from './history.ts';

/**
 * Where the score history lives: `chrome.storage.local`, one key, no network.
 *
 * Local rather than sync because a score belongs to the machine and the
 * microphone that produced it, and a few hundred of them have no business
 * crossing a sync quota. Every read and write fails quietly: a profile with
 * storage turned off, a quota that has been reached or a value from an older
 * version must never be the reason a practice run ends badly.
 */

export async function readScoreHistory(): Promise<PracticeRun[]> {
  try {
    const stored = await chrome.storage.local.get(SCORE_HISTORY_KEY);
    return normaliseScoreHistory(stored[SCORE_HISTORY_KEY]);
  } catch {
    return [];
  }
}

/**
 * Writes a history, shrinking it once if the browser says the quota is full.
 *
 * The second attempt keeps only a quarter of the allowed history, which is
 * still enough to be a leaderboard. A second failure is ignored: the run
 * happened whether or not the record was kept, and the end card must not turn
 * into an error because of it.
 */
async function writeScoreHistory(runs: readonly PracticeRun[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [SCORE_HISTORY_KEY]: runs });
    return;
  } catch {
    // Try a much smaller history before giving up.
  }
  try {
    await chrome.storage.local.set({
      [SCORE_HISTORY_KEY]: pruneScoreHistory(
        runs,
        Math.max(1, Math.floor(MAX_SCORE_HISTORY / 4)),
      ),
    });
  } catch {
    // Quietly: a score that could not be saved is not a failed practice run.
  }
}

/** Appends one completed run, pruning the oldest records as it goes. */
export async function saveScoreRun(run: PracticeRun): Promise<void> {
  try {
    const history = await readScoreHistory();
    await writeScoreHistory(appendScoreRun(history, run));
  } catch {
    // The same quiet failure as a write: the card can still be shared.
  }
}

/** The optional name that score cards wear, or an empty string for none. */
export async function readSingerName(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(SCORE_SINGER_KEY);
    return normaliseSinger(stored[SCORE_SINGER_KEY]);
  } catch {
    return '';
  }
}

/** Saves the singer name, removing the key when the field is cleared. */
export async function writeSingerName(raw: string): Promise<void> {
  const name = normaliseSinger(raw);
  try {
    if (name === '') {
      await chrome.storage.local.remove(SCORE_SINGER_KEY);
      return;
    }
    await chrome.storage.local.set({ [SCORE_SINGER_KEY]: name });
  } catch {
    // A name is a nicety; failing to remember it is not worth a message.
  }
}
