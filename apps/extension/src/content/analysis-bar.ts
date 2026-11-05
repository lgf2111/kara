/**
 * The gold line on YouTube's own progress bar.
 *
 * Separation arrives from the start of the song outwards, so the part that is
 * ready is always one prefix: from nought to the separated frontier. Drawing
 * that prefix on the progress bar answers the question a person actually has
 * while they wait — "can I jump there yet, or will I hear the original?" —
 * without adding a second transport.
 *
 * The overlay is deliberately passive. `pointer-events: none` means every
 * click, drag and hover still reaches YouTube's own seek bar, so the band is a
 * fact rather than a control. The full height marker at the frontier is the
 * part to watch: it moves right while the rest is still being separated, and
 * the whole overlay disappears once the prefix reaches the end.
 *
 * It lives inside `.ytp-progress-bar` rather than the player because that
 * element owns the full seek track, including the case where YouTube splits a
 * chaptered video into several progress lists; appending to one chapter's list
 * would draw the line over that chapter only. YouTube replaces the element on
 * some navigations, and `ensure` reattaches if it was torn out.
 */

/** The full-width seek track, chapter-splitting or not. */
const PROGRESS_HOST = '.ytp-progress-bar';

/** The KTV gold, matching the panel and the popup. */
const READY_COLOR = '#e8b86d';

export interface AnalysisBar {
  /** Show the ready prefix, or hide the overlay with null. */
  update: (fraction: number | null) => void;
  destroy: () => void;
}

export function mountAnalysisBar(player: HTMLElement): AnalysisBar {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:none',
    'pointer-events:none',
    'z-index:40',
  ].join(';');

  const band = document.createElement('div');
  band.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    'height:2px',
    'border-radius:0 2px 2px 0',
    `background:${READY_COLOR}`,
    'transition:width 320ms linear',
  ].join(';');

  const marker = document.createElement('div');
  marker.style.cssText = [
    'position:absolute',
    'top:0',
    'bottom:0',
    'width:2px',
    'margin-left:-1px',
    `background:${READY_COLOR}`,
  ].join(';');

  host.append(band, marker);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    band.style.transition = 'none';
  }

  let attached: HTMLElement | null = null;
  let fraction: number | null = null;

  const ensure = (): boolean => {
    const list = player.querySelector<HTMLElement>(PROGRESS_HOST);
    if (list === null) {
      return false;
    }
    if (attached !== list || !host.isConnected) {
      list.append(host);
      attached = list;
    }
    return true;
  };

  const paint = (): void => {
    if (fraction === null || !ensure()) {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'block';
    const percent = `${(fraction * 100).toFixed(3)}%`;
    band.style.width = percent;
    marker.style.left = percent;
  };

  return {
    update(next) {
      fraction = next;
      paint();
    },
    destroy() {
      host.remove();
      attached = null;
    },
  };
}
