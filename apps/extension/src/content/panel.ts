import { canNudge, KEY_DEFAULT, keyLabel, nudgeKey } from '../audio/key.ts';
import { progressPercent } from '../audio/progress.ts';
import type { PlayMode } from '../protocol.ts';
import { guideFromPercent, type PanelView } from './panel-view.ts';

/**
 * The control panel, inside the player and inside a shadow root.
 *
 * Shadow because this is somebody else's page. A panel built out of the
 * page's own styles would inherit whatever the page did to buttons this week,
 * and a panel with its own class names would be one accidental collision away
 * from restyling the player. A closed shadow root is the only arrangement
 * where neither of those can happen: nothing of the page's CSS reaches in, and
 * nothing of this reaches out.
 *
 * It is careful in three ways, all of which are about not being in the way.
 *
 * **Clicks stop here.** The player treats a click anywhere in itself as play
 * or pause, and this panel is inside the player, so every pointer event it
 * handles has its propagation stopped. Without that, nudging the guide slider
 * would pause the video.
 *
 * **Keys stop here too, and are never taken.** There is no document-level key
 * listener anywhere in this extension: the page keeps every shortcut it had.
 * What does happen is the reverse — an arrow key pressed on the guide slider
 * is stopped before it reaches the page, so adjusting the guide does not also
 * seek the video. The two shortcuts there are, `[` and `]` for the key, are
 * read only while the focus is already inside this shadow root, so they are
 * the panel's own rather than the page's.
 *
 * **It hides when the player's controls hide.** The player has already decided
 * when a person is watching rather than fiddling, and it says so by restyling
 * itself; `youtube.ts` reads that and passes it here. The one exception is a
 * pointer resting on the panel, which keeps it up regardless, because a
 * control that vanishes under the cursor is a control nobody can use.
 *
 * Icons are inline SVG built with `createElementNS`, both because the
 * repository holds no binaries and because assembling elements rather than
 * assigning markup keeps this clear of the page's HTML sinks.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Hand-drawn, 24 × 24, stroked: a microphone, a clock, a warning. */
const ICONS: Readonly<Record<string, readonly string[]>> = {
  mic: [
    'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3',
    'M5 11a7 7 0 0 0 14 0',
    'M12 18v3',
  ],
  clock: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18', 'M12 7.5V12l3 2'],
  pause: ['M9.5 5v14', 'M14.5 5v14'],
  warn: ['M12 4 2.5 20h19Z', 'M12 10v4', 'M12 17h.01'],
};

const ICON_FOR: Readonly<Record<PanelView['state'], string>> = {
  off: 'mic',
  preparing: 'clock',
  live: 'mic',
  paused: 'pause',
  unsupported: 'warn',
  error: 'warn',
};

const STYLE = `
/* Where it sits is set inline on the host instead, so that a page rule
   matching its own children cannot move it. What is left here is what only
   matters inside. */
:host {
  transition: opacity 160ms ease;
  font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #fff;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  min-width: 180px;
  border-radius: 10px;
  background: rgba(18, 18, 20, 0.86);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
}
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  padding: 6px 10px;
}
button:hover {
  background: rgba(255, 255, 255, 0.16);
}
button:focus-visible {
  outline: 2px solid #8ab4ff;
  outline-offset: 1px;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}
.toggle[data-state='live'] {
  border-color: rgba(120, 220, 160, 0.5);
  background: rgba(120, 220, 160, 0.18);
}
.toggle[data-state='preparing'],
.toggle[data-state='paused'] {
  border-color: rgba(255, 214, 130, 0.5);
  background: rgba(255, 214, 130, 0.14);
}
/* A bar rather than a countdown: there are four waits in getting ready and
   none of them is the length of the delay. audio/progress.ts says why. */
.bar {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  overflow: hidden;
}
.bar .fill {
  height: 100%;
  width: 0;
  border-radius: 2px;
  background: #ffd682;
  transition: width 240ms linear;
}
.note {
  max-width: 220px;
  color: rgba(255, 255, 255, 0.92);
  font-size: 11px;
}
.toggle[data-state='unsupported'],
.toggle[data-state='error'] {
  border-color: rgba(255, 140, 140, 0.5);
  background: rgba(255, 140, 140, 0.14);
}
.detail {
  max-width: 220px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 11px;
}
.segmented {
  display: flex;
}
.segmented button {
  border-radius: 0;
  flex: 1;
}
.segmented button:first-child {
  border-radius: 8px 0 0 8px;
}
.segmented button:last-child {
  border-radius: 0 8px 8px 0;
  border-left-width: 0;
}
.segmented button[aria-pressed='true'] {
  background: rgba(255, 255, 255, 0.28);
}
.guide {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.72);
}
.guide input {
  flex: 1;
  min-width: 80px;
  accent-color: #8ab4ff;
}
.guide .value {
  min-width: 2.2em;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* Two steppers around the words, because a key is a step rather than a
   position: a slider would invite a half semitone nobody wants. */
.key {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.key button {
  padding: 2px 8px;
  line-height: 1.2;
}
.key .value {
  flex: 1;
  text-align: center;
  color: rgba(255, 255, 255, 0.92);
  font-variant-numeric: tabular-nums;
}
.key .clear {
  font-size: 10px;
  padding: 2px 6px;
  color: rgba(255, 255, 255, 0.72);
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
button:disabled:hover {
  background: rgba(255, 255, 255, 0.08);
}
[hidden] {
  display: none !important;
}
`;

export interface PanelHandlers {
  /** The Karaoke button. Starting and stopping is the caller's problem. */
  readonly onToggle: () => void;
  readonly onMode: (mode: PlayMode) => void;
  /** The guide, as a gain between 0 and 1. */
  readonly onGuide: (level: number) => void;
  /** The key the person has landed on, in whole semitones. */
  readonly onKey: (semitones: number) => void;
}

export interface Panel {
  /** The element in the page, so the caller can tell if it was torn out. */
  readonly host: HTMLElement;
  update: (view: PanelView) => void;
  /** The player has hidden its controls, so hide with them. */
  setAutohidden: (hidden: boolean) => void;
  destroy: () => void;
}

function icon(name: string): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', '0 0 24 24');
  root.setAttribute('width', '15');
  root.setAttribute('height', '15');
  root.setAttribute('fill', 'none');
  root.setAttribute('stroke', 'currentColor');
  root.setAttribute('stroke-width', '1.8');
  root.setAttribute('stroke-linecap', 'round');
  root.setAttribute('stroke-linejoin', 'round');
  root.setAttribute('aria-hidden', 'true');
  for (const drawn of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', drawn);
    root.append(path);
  }
  return root;
}

function button(text: string, className: string): HTMLButtonElement {
  const made = document.createElement('button');
  made.type = 'button';
  made.className = className;
  made.textContent = text;
  return made;
}

export function mountPanel(container: HTMLElement, handlers: PanelHandlers): Panel {
  const host = document.createElement('div');
  // Inline, because inline beats any stylesheet the page has: clear of the
  // control bar at the bottom, and above the player's gradients but level
  // with its own furniture.
  host.style.position = 'absolute';
  host.style.left = '12px';
  host.style.bottom = '72px';
  host.style.zIndex = '60';
  host.style.opacity = '1';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;

  const panel = document.createElement('div');
  panel.className = 'panel';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle';
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.append(icon('mic'));
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Karaoke';
  toggle.append(glyph, label);

  const note = document.createElement('div');
  note.className = 'note';
  note.hidden = true;

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.hidden = true;
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Getting ready');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'fill';
  bar.append(fill);

  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.hidden = true;

  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.hidden = true;

  const segmented = document.createElement('div');
  segmented.className = 'segmented';
  segmented.setAttribute('role', 'group');
  segmented.setAttribute('aria-label', 'What to play');
  const original = button('Original', 'mode');
  const instrumental = button('Instrumental', 'mode');
  segmented.append(original, instrumental);

  const guide = document.createElement('label');
  guide.className = 'guide';
  const guideName = document.createElement('span');
  guideName.textContent = 'Guide';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = '0';
  const guideValue = document.createElement('span');
  guideValue.className = 'value';
  guideValue.textContent = '0';
  guide.append(guideName, slider, guideValue);

  const key = document.createElement('div');
  key.className = 'key';
  key.setAttribute('role', 'group');
  key.setAttribute('aria-label', 'Key');
  const keyDown = button('−', 'step');
  keyDown.title = 'Down a semitone ([)';
  const keyValue = document.createElement('span');
  keyValue.className = 'value';
  // Polite rather than assertive: the words change under the person's own
  // button press, so they do not need interrupting to hear about it.
  keyValue.setAttribute('role', 'status');
  keyValue.setAttribute('aria-live', 'polite');
  keyValue.textContent = keyLabel(KEY_DEFAULT);
  const keyUp = button('+', 'step');
  keyUp.title = 'Up a semitone (])';
  const keyClear = button('Reset', 'clear');
  keyClear.title = 'Back to the original key';
  key.append(keyDown, keyValue, keyUp, keyClear);

  controls.append(segmented, guide, key);
  panel.append(toggle, note, bar, detail, controls);
  root.append(style, panel);

  let autohidden = false;
  let hovering = false;
  /** The last key drawn, which is what a step or a shortcut moves from. */
  let semitones = KEY_DEFAULT;

  const apply = (): void => {
    const away = autohidden && !hovering;
    host.style.opacity = away ? '0' : '1';
    // Invisible and still clickable would swallow clicks meant for the video.
    host.style.pointerEvents = away ? 'none' : 'auto';
  };

  /**
   * Hover by rect rather than by `pointerenter`, because a hidden panel has
   * no pointer events to enter with and that is exactly when the answer
   * matters.
   */
  const onPointerMove = (event: PointerEvent): void => {
    const box = host.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (inside !== hovering) {
      hovering = inside;
      apply();
    }
  };

  const keepToSelf = (event: Event): void => {
    event.stopPropagation();
  };

  /**
   * The two shortcuts this extension has, and they are the panel's rather than
   * the page's.
   *
   * There is no document-level key listener anywhere in here: every key the
   * page handled before, it still handles. `[` and `]` only mean anything
   * while the focus is already inside the panel, which is what
   * `root.activeElement` says and the only thing that can say it for a closed
   * shadow root. So they cost the page nothing, and somebody who has just
   * pressed a key button can press the next one without aiming.
   */
  const onKeydown = (event: KeyboardEvent): void => {
    keepToSelf(event);
    if (root.activeElement === null || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const step = event.key === '[' ? -1 : event.key === ']' ? 1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    handlers.onKey(nudgeKey(semitones, step));
  };

  for (const kind of ['click', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']) {
    // The player makes a click anywhere in itself mean play or pause.
    host.addEventListener(kind, keepToSelf);
  }
  // And it reads arrow keys as seeks, which the guide slider also wants.
  host.addEventListener('keydown', onKeydown);
  host.addEventListener('keyup', keepToSelf);
  container.addEventListener('pointermove', onPointerMove, { passive: true });

  toggle.addEventListener('click', () => {
    handlers.onToggle();
  });
  original.addEventListener('click', () => {
    handlers.onMode('original');
  });
  instrumental.addEventListener('click', () => {
    handlers.onMode('instrumental');
  });
  slider.addEventListener('input', () => {
    guideValue.textContent = slider.value;
    handlers.onGuide(guideFromPercent(Number(slider.value)));
  });
  keyDown.addEventListener('click', () => {
    handlers.onKey(nudgeKey(semitones, -1));
  });
  keyUp.addEventListener('click', () => {
    handlers.onKey(nudgeKey(semitones, 1));
  });
  keyClear.addEventListener('click', () => {
    handlers.onKey(KEY_DEFAULT);
  });

  container.append(host);

  return {
    host,

    update(view) {
      toggle.dataset['state'] = view.state;
      toggle.setAttribute(
        'aria-label',
        view.detail === null ? view.label : `${view.label}. ${view.detail}`,
      );
      label.textContent = view.label;
      glyph.replaceChildren(icon(ICON_FOR[view.state]));
      note.textContent = view.note;
      note.hidden = view.note === null;
      bar.hidden = view.progress === null;
      if (view.progress !== null) {
        const percent = progressPercent(view.progress);
        fill.style.width = `${String(percent)}%`;
        bar.setAttribute('aria-valuenow', String(percent));
        bar.setAttribute('aria-valuetext', view.detail ?? `${String(percent)}%`);
      }
      detail.textContent = view.detail;
      detail.hidden = view.detail === null;
      controls.hidden = !view.controls;
      original.setAttribute('aria-pressed', String(view.mode === 'original'));
      instrumental.setAttribute('aria-pressed', String(view.mode === 'instrumental'));
      // Not while it is being dragged: the report it would be set from is an
      // echo of the drag, and arriving a frame late it would fight the thumb.
      if (root.activeElement !== slider && Number(slider.value) !== view.guide) {
        slider.value = String(view.guide);
        guideValue.textContent = slider.value;
      }
      semitones = view.semitones;
      keyValue.textContent = view.keyLabel;
      keyDown.disabled = !canNudge(semitones, -1);
      keyUp.disabled = !canNudge(semitones, 1);
      keyClear.hidden = semitones === KEY_DEFAULT;
    },

    setAutohidden(hidden) {
      autohidden = hidden;
      apply();
    },

    destroy() {
      container.removeEventListener('pointermove', onPointerMove);
      host.remove();
    },
  };
}
