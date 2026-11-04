/**
 * The only file in this extension that knows what YouTube's DOM looks like.
 *
 * Everything in here is a guess about somebody else's page, and all of it will
 * be wrong one day. Keeping the guesses in one small file is the whole point:
 * when the page changes, this is the file that changes, and nothing that reads
 * it has to be touched. The audio half reads none of it at all — it listens
 * for media events on the document, which are a web platform contract rather
 * than a YouTube one — so a broken selector here costs the picture and the
 * panel, and never the sound.
 *
 * Four things are wanted from the page and no more. The video that is playing,
 * the element to hang an overlay on, whether an ad is on screen, and whether
 * the player has hidden its own controls. Each one fails to null or false
 * rather than throwing, and each failure is logged once: a selector that
 * stopped matching would otherwise fill the console at sixty lines a second.
 *
 * There is nothing here that reads a stream, a URL, a player response or any
 * other part of how the page gets its media, and nothing copied from the
 * page's own code. What this file does is find an element to draw over.
 */

/** The player: the box the video, the controls and the ads all live in. */
const PLAYER = '#movie_player';

/** The main video inside it, as opposed to a preview or a miniplayer. */
const MAIN_VIDEO = 'video.html5-main-video';

/** The player wears these while an ad is on screen. */
const AD_CLASSES = ['ad-showing', 'ad-interrupting'];

/** And this when it has hidden its own controls. */
const AUTOHIDE_CLASS = 'ytp-autohide';

/** Smaller than this is a thumbnail preview, not the thing being watched. */
const BIG_ENOUGH = { width: 200, height: 120 };

const told = new Set<string>();

function logOnce(message: string): void {
  if (told.has(message)) {
    return;
  }
  told.add(message);
  console.warn(`kara: ${message}`);
}

export interface PlayerParts {
  /** What an overlay is appended to, so fullscreen takes it along. */
  readonly player: HTMLElement;
  readonly video: HTMLVideoElement;
}

/** The biggest video on the page that is big enough to be the one watched. */
function biggestVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const video of document.querySelectorAll('video')) {
    const box = video.getBoundingClientRect();
    if (box.width < BIG_ENOUGH.width || box.height < BIG_ENOUGH.height) {
      continue;
    }
    const area = box.width * box.height;
    if (area > bestArea) {
      best = video;
      bestArea = area;
    }
  }
  return best;
}

/**
 * The video to delay and the element to draw over, or null.
 *
 * Cheap enough to call again whenever the answer is wanted, which is how this
 * survives the page replacing its player: there is no cache here and no
 * listener for the site's own navigation events, both of which are promises
 * about internals this file would rather not make.
 */
export function findPlayer(): PlayerParts | null {
  const player = document.querySelector<HTMLElement>(PLAYER);
  const inside = player?.querySelector<HTMLVideoElement>(MAIN_VIDEO) ?? null;
  if (player !== null && inside !== null) {
    return { player, video: inside };
  }

  const video = biggestVideo();
  if (video === null) {
    return null;
  }
  // No player, but a video worth delaying: its own parent will hold a canvas
  // over it perfectly well, and the panel can live there too.
  const around = video.parentElement;
  if (around === null) {
    return null;
  }
  logOnce(`no ${PLAYER} with a ${MAIN_VIDEO} in it, so the largest video is being used`);
  return { player: around, video };
}

/**
 * Whether an ad is on screen. The classes are the player's own and are what
 * it styles itself by, which makes them the most stable thing about it; an ad
 * has no reliable media event of its own.
 */
export function isAdShowing(player: HTMLElement): boolean {
  return AD_CLASSES.some((name) => player.classList.contains(name));
}

/** Whether the player has hidden its controls, so the panel can too. */
export function isAutohidden(player: HTMLElement): boolean {
  return player.classList.contains(AUTOHIDE_CLASS);
}

/**
 * Calls back whenever the player's class list changes, which is how both of
 * the questions above are answered: the page does not announce an ad and does
 * not announce hiding its controls, but it restyles itself for each.
 */
export function watchPlayer(player: HTMLElement, onChange: () => void): () => void {
  const watcher = new MutationObserver(() => {
    onChange();
  });
  watcher.observe(player, { attributes: true, attributeFilter: ['class'] });
  return () => {
    watcher.disconnect();
  };
}
