import type { PracticeOverlayView } from './practice-view.ts';

/**
 * The practice picture: a dark wash, a scrolling note lane, a playhead, the
 * singer's marker, a small scoreboard, and the end card.
 *
 * It lives inside the player element, which is what makes fullscreen work
 * without a second document. The host is `pointer-events: none`, so every
 * click, drag and hover still reaches YouTube's own controls; only the end
 * card's two buttons take a pointer. The panel above it is at z-index 60, so
 * the wash never covers the karaoke controls.
 *
 * The drawing is deliberately plain: notes are positioned from fractions the
 * pure view model worked out, and the only motion is the lane scrolling with
 * `video.currentTime`. `prefers-reduced-motion` removes the short transitions.
 */

const STYLE = `
:host {
  --kara-ground: #1b1116;
  --kara-surface: #24171d;
  --kara-border: #3b2a30;
  --kara-text: #f7efe6;
  --kara-muted: #c3b0a6;
  --kara-faint: #9a877e;
  --kara-accent: #e8b86d;
  --kara-perfect: #7bd88f;
  --kara-good: #e8b86d;
  --kara-off: #e58b8b;
  --kara-danger: #e58b8b;
  --kara-ink: #21140b;
  --kara-radius: 12px;
  color: var(--kara-text);
  font: 500 13px/1.4 "Avenir Next", "Segoe UI", system-ui, sans-serif;
}
[hidden] {
  display: none !important;
}
.dark {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 90% at 30% 20%, rgba(27, 17, 22, 0.38), rgba(9, 5, 7, 0.76)),
    rgba(9, 5, 7, 0.28);
  pointer-events: none;
}
.lane {
  position: absolute;
  top: 7%;
  right: 3.5%;
  left: 3.5%;
  height: 44%;
  overflow: hidden;
  border: 1px solid rgba(59, 42, 48, 0.9);
  border-radius: var(--kara-radius);
  background: linear-gradient(180deg, rgba(27, 17, 22, 0.82), rgba(27, 17, 22, 0.62));
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.38); /* taste-skill-ignore: video overlay */
  pointer-events: none;
}
.notes {
  position: absolute;
  inset: 0;
}
.note {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 2px;
  padding: 0 4px;
  overflow: hidden;
  border: 1px solid rgba(195, 176, 166, 0.36);
  border-radius: 5px;
  background: rgba(195, 176, 166, 0.14);
  color: var(--kara-muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.note[data-past='true'] {
  opacity: 0.42;
}
.note[data-current='true'] {
  border-color: var(--kara-accent);
  background: rgba(232, 184, 109, 0.26);
  color: var(--kara-text);
  box-shadow: 0 0 18px rgba(232, 184, 109, 0.22);
}
.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--kara-accent);
  box-shadow: 0 0 12px rgba(232, 184, 109, 0.6);
  pointer-events: none;
}
.marker {
  position: absolute;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border: 2px solid rgba(27, 17, 22, 0.94);
  border-radius: 50%;
  background: var(--kara-faint);
  transition: top 70ms linear;
  pointer-events: none;
}
.marker[data-tone='perfect'] {
  background: var(--kara-perfect);
  box-shadow: 0 0 16px rgba(123, 216, 143, 0.8);
}
.marker[data-tone='good'] {
  background: var(--kara-good);
  box-shadow: 0 0 16px rgba(232, 184, 109, 0.75);
}
.marker[data-tone='off'] {
  background: var(--kara-off);
  box-shadow: 0 0 16px rgba(229, 139, 139, 0.75);
}
.marker[data-tone='idle'] {
  background: var(--kara-faint);
}
.now {
  position: absolute;
  top: 8px;
  left: 11px;
  z-index: 1;
  color: var(--kara-muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  pointer-events: none;
}
.hud {
  position: absolute;
  right: 3.5%;
  bottom: 76px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  width: 174px;
  padding: 10px 12px;
  border: 1px solid var(--kara-border);
  border-radius: var(--kara-radius);
  background: rgba(27, 17, 22, 0.84);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35); /* taste-skill-ignore: video overlay */
  pointer-events: none;
}
.score-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.score {
  color: var(--kara-text);
  font-size: 30px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
  line-height: 1;
}
.score-label {
  color: var(--kara-faint);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.combo {
  color: var(--kara-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--kara-muted);
  font-size: 11px;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--kara-faint);
}
.status[data-listening='true'] .status-dot {
  background: var(--kara-perfect);
  box-shadow: 0 0 8px rgba(123, 216, 143, 0.7);
}
.hint {
  margin: 2px 0 0;
  color: var(--kara-faint);
  font-size: 10px;
  line-height: 1.35;
}
.card {
  position: absolute;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  width: min(320px, calc(100% - 48px));
  padding: 18px;
  border: 1px solid var(--kara-border);
  border-radius: 16px;
  background: rgba(27, 17, 22, 0.95);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5); /* taste-skill-ignore: video overlay */
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.card[data-interactive='true'] {
  pointer-events: auto;
}
.card-title {
  margin: 0;
  color: var(--kara-text);
  font-size: 15px;
  font-weight: 650;
}
.card-detail {
  margin: 7px 0 0;
  color: var(--kara-muted);
  font-size: 12px;
  line-height: 1.45;
}
.card-detail[data-tone='error'] {
  color: var(--kara-danger, #e58b8b);
}
.meter {
  height: 5px;
  margin-top: 12px;
  overflow: hidden;
  border-radius: 999px;
  background: #3a2730;
}
.meter-fill {
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--kara-accent);
  transition: width 180ms linear;
}
.summary-score {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.summary-number {
  color: var(--kara-accent);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 46px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
  line-height: 1;
}
.summary-of {
  color: var(--kara-faint);
  font-size: 12px;
}
.summary-title {
  margin: 6px 0 0;
  color: var(--kara-muted);
  font-size: 12px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 14px 0 0;
}
.stats div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stats dt {
  color: var(--kara-faint);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.stats dd {
  margin: 0;
  color: var(--kara-text);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.actions button {
  flex: 1;
  box-sizing: border-box;
  height: 32px;
  margin: 0;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  color: var(--kara-text);
  cursor: pointer;
  border: 1px solid var(--kara-border);
  border-radius: 8px;
  background: transparent;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}
.actions button:hover {
  border-color: var(--kara-faint);
  background: var(--kara-surface);
}
.actions button:focus-visible {
  outline: 2px solid var(--kara-accent);
  outline-offset: 2px;
}
.actions .primary {
  border-color: var(--kara-accent);
  background: var(--kara-accent);
  color: var(--kara-ink);
}
.actions .primary:hover {
  background: #f0c47f;
}
@media (prefers-reduced-motion: reduce) {
  .marker,
  .meter-fill,
  .actions button {
    transition: none;
  }
}
`;

export interface PracticeOverlayHandlers {
  /** Start another run from the beginning with the same guide melody. */
  readonly onSingAgain: () => void;
  /** Release the microphone and take the overlay away. */
  readonly onClose: () => void;
}

export interface PracticeOverlay {
  /** The element in the player, so the caller can tell if it was torn out. */
  readonly host: HTMLElement;
  update: (view: PracticeOverlayView) => void;
  destroy: () => void;
}

function div(className: string): HTMLDivElement {
  const made = document.createElement('div');
  made.className = className;
  return made;
}

function span(className: string): HTMLSpanElement {
  const made = document.createElement('span');
  made.className = className;
  return made;
}

function paragraph(className: string): HTMLParagraphElement {
  const made = document.createElement('p');
  made.className = className;
  return made;
}

function button(text: string, className: string): HTMLButtonElement {
  const made = document.createElement('button');
  made.type = 'button';
  made.className = className;
  made.textContent = text;
  return made;
}

/** `0.314` as `31.4%`, which is the only unit the lane is drawn in. */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}

export function mountPracticeOverlay(
  container: HTMLElement,
  handlers: PracticeOverlayHandlers,
): PracticeOverlay {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:none',
    'pointer-events:none',
    'z-index:55',
    'overflow:hidden',
  ].join(';');
  const root = host.attachShadow({ mode: 'closed' }); // taste-skill-ignore: attachShadow is the DOM API
  const style = document.createElement('style');
  style.textContent = STYLE;

  const dark = div('dark');

  const lane = div('lane');
  const now = span('now');
  const notesLayer = div('notes');
  const playhead = div('playhead');
  const marker = div('marker');
  lane.append(notesLayer, playhead, marker, now);

  const hud = div('hud');
  const scoreRow = div('score-row');
  const scoreValue = span('score');
  const scoreLabel = span('score-label');
  scoreLabel.textContent = 'score';
  scoreRow.append(scoreValue, scoreLabel);
  const combo = div('combo');
  const status = div('status');
  const statusDot = span('status-dot');
  const statusText = span('status-text');
  status.append(statusDot, statusText);
  const hint = paragraph('hint');
  hint.textContent = 'Headphones make the pitch read truer.';
  hud.append(scoreRow, combo, status, hint);

  const learning = div('card');
  const learningTitle = paragraph('card-title');
  learningTitle.textContent = 'Learning the melody';
  const learningDetail = paragraph('card-detail');
  const meter = div('meter');
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-label', 'Learning the guide melody');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  const meterFill = div('meter-fill');
  meter.append(meterFill);
  learning.append(learningTitle, learningDetail, meter);

  const summary = div('card');
  summary.dataset['interactive'] = 'true';
  summary.setAttribute('role', 'dialog');
  summary.setAttribute('aria-label', 'Practice result');
  const summaryScore = div('summary-score');
  const summaryNumber = span('summary-number');
  const summaryOf = span('summary-of');
  summaryOf.textContent = '/ 100';
  summaryScore.append(summaryNumber, summaryOf);
  const summaryTitle = paragraph('summary-title');
  const stats = document.createElement('dl');
  stats.className = 'stats';
  const stat = (label: string, className: string): HTMLSpanElement => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const value = document.createElement('dd');
    value.className = className;
    row.append(term, value);
    stats.append(row);
    return value;
  };
  const statNotes = stat('Notes hit', 'stat-notes');
  const statAccuracy = stat('Accuracy', 'stat-accuracy');
  const statStreak = stat('Longest streak', 'stat-streak');
  const summaryActions = div('actions');
  const again = button('Sing again', 'primary');
  const close = button('Close', 'secondary');
  summaryActions.append(again, close);
  summary.append(summaryScore, summaryTitle, stats, summaryActions);

  const error = div('card');
  error.dataset['interactive'] = 'true';
  error.setAttribute('role', 'alert');
  const errorTitle = paragraph('card-title');
  errorTitle.textContent = 'Practice stopped';
  const errorDetail = paragraph('card-detail');
  errorDetail.dataset['tone'] = 'error';
  const errorActions = div('actions');
  const errorClose = button('Close', 'secondary');
  errorActions.append(errorClose);
  error.append(errorTitle, errorDetail, errorActions);

  root.append(style, dark, lane, hud, learning, summary, error);

  let noteKey = '';
  const noteEls = new Map<number, HTMLDivElement>();

  const drawNotes = (view: PracticeOverlayView): void => {
    const key = view.notes.map((note) => note.index).join(',');
    if (key !== noteKey) {
      noteKey = key;
      noteEls.clear();
      notesLayer.replaceChildren();
      for (const note of view.notes) {
        const element = div('note');
        notesLayer.append(element);
        noteEls.set(note.index, element);
      }
    }
    for (const note of view.notes) {
      const element = noteEls.get(note.index);
      if (element === undefined) {
        continue;
      }
      element.style.left = percent(note.left);
      element.style.width = percent(note.width);
      element.style.top = percent(note.top);
      element.style.height = percent(note.height);
      element.dataset['past'] = String(note.past);
      element.dataset['current'] = String(note.current);
      if (element.textContent !== note.name) {
        element.textContent = note.name;
      }
    }
  };

  const update = (view: PracticeOverlayView): void => {
    host.style.display = view.mode === 'hidden' ? 'none' : 'block';
    if (view.mode === 'hidden') {
      return;
    }
    // The lane and the scoreboard are decoration; the end card's buttons are
    // real controls, so only then does the host step out of the accessibility
    // tree's way.
    if (view.mode === 'ended' || view.mode === 'error') {
      host.removeAttribute('aria-hidden');
    } else {
      host.setAttribute('aria-hidden', 'true');
    }
    const listening = view.mode === 'listening';
    lane.hidden = !listening;
    hud.hidden = !listening;
    learning.hidden = view.mode !== 'learning';
    summary.hidden = view.mode !== 'ended';
    error.hidden = view.mode !== 'error';

    if (view.mode === 'learning' && view.learning !== null) {
      learningDetail.textContent = view.learning.detail;
      const progress = view.learning.progress ?? 0;
      meterFill.style.width = percent(progress);
      meter.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    }
    if (view.mode === 'ended' && view.summary !== null) {
      summaryNumber.textContent = String(Math.round(view.summary.score));
      summaryTitle.textContent =
        view.summary.notesTotal === 0
          ? 'No guide notes were scored.'
          : `${String(view.summary.notesHit)} of ${String(view.summary.notesTotal)} guide notes hit.`;
      statNotes.textContent = `${String(view.summary.notesHit)} / ${String(view.summary.notesTotal)}`;
      statAccuracy.textContent = `${String(Math.round(view.summary.accuracy))}%`;
      statStreak.textContent = String(view.summary.longestStreak);
    }
    if (view.mode === 'error') {
      errorDetail.textContent = view.error ?? 'Practice stopped.';
    }

    if (!listening) {
      return;
    }
    drawNotes(view);
    playhead.style.left = percent(view.playhead);
    now.textContent = view.currentName === null ? 'Rest' : `Now ${view.currentName}`;
    scoreValue.textContent = String(Math.round(view.score.score));
    combo.textContent =
      view.score.combo > 0
        ? `${String(view.score.combo)} in a row`
        : `${String(view.score.notesHit)} notes hit`;
    status.dataset['listening'] = String(view.listening);
    statusText.textContent = view.listening ? 'Listening' : 'Not scoring';

    if (view.marker === null) {
      marker.hidden = true;
    } else {
      marker.hidden = false;
      marker.dataset['tone'] = view.marker.tone;
      marker.style.left = percent(view.marker.x);
      marker.style.top = percent(view.marker.y);
    }
  };

  again.addEventListener('click', () => {
    handlers.onSingAgain();
  });
  close.addEventListener('click', () => {
    handlers.onClose();
  });
  errorClose.addEventListener('click', () => {
    handlers.onClose();
  });

  // The card is the only part with pointer events, but its clicks must not
  // also reach the player underneath and toggle playback.
  for (const kind of ['click', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']) {
    host.addEventListener(kind, (event) => {
      event.stopPropagation();
    });
  }

  container.append(host);

  return {
    host,
    update,
    destroy() {
      host.remove();
      noteEls.clear();
    },
  };
}
