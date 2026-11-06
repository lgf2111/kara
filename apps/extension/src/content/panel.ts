import { KEY_DEFAULT, KEY_MAX, KEY_MIN, keyLabel, nudgeKey } from '../audio/key.ts';
import {
  DEFAULT_MIC_FX,
  MONITOR_WARNING,
  normaliseMicFx,
  type MicFx,
} from '../audio/mic-fx.ts';
import { progressPercent } from '../audio/progress.ts';
import {
  DEFAULT_DUET_MIX,
  DUET_LABEL,
  duetPercent,
  withDuetLevel,
  withDuetMute,
  withDuetSolo,
  type DuetMix,
} from '../audio/duet.ts';
import {
  DEFAULT_LEVELS,
  DEFAULT_MIX,
  STEM_LABEL,
  STEMS,
  stemFromPercent,
  stemPercent,
  withMute,
  withSolo,
  withStem,
  type Stem,
  type StemMix,
} from '../audio/stems.ts';
import type { PlayMode } from '../protocol.ts';
import type { PanelView } from './panel-view.ts';

/**
 * The control panel, inside the player and inside a closed root.
 *
 * The panel is a small piece of furniture floating over somebody else's
 * video, so it has two jobs and no third: say what is happening now, and put
 * the next move where a thumb or a cursor already is. The arrangement is a
 * console, not a settings page — the vocal is the lead control, and the
 * original/instrumental switch is the one decision beside it.
 *
 * **One control size.** Every actionable control is thirty-two pixels tall:
 * the mode toggle, mute and solo, the disclosure headers, both resets, stop,
 * and the primary start button. The earlier panel mixed five heights, so the
 * rows never settled on a line; this one has one horizontal rhythm. The
 * popup owns the diagnostic view; the player stays a player.
 *
 * **The mode is one toggle, not a segmented switch.** Original and
 * Instrumental are the same song through two paths, so the control is a single
 * pressed button whose label names the path currently playing. It is filled
 * with the one accent while the stems are live.
 *
 * **Advanced is one door.** Backing, song facts, pitch practice, the
 * microphone, duet and key live inside it, but it is one parent surface with
 * inset rows rather than a stack of identical cards. Only the groups that
 * actually open and close — backing and microphone — keep a disclosure; song
 * facts, practice, duet and key are single compact rows. The master and every
 * disclosure remember whether they were open for the session, and only what is
 * already in use is offered inside them.
 *
 * **Nothing says paused.** A pause is visible in the video; the panel keeps
 * its controls and drops the status line instead of announcing a state the
 * person can already see.
 *
 * **Developer mode is a view, not a different product.** A terminal button at
 * the end of the header reveals the raw status: stage, progress, pieces,
 * coverage, video, length, mode, key and the switches. It is quiet enough to
 * ignore, and it is the first place to look when loading is slower than it
 * should be.
 *
 * The closed root is still deliberate: nothing of the page's CSS reaches in,
 * and nothing of this reaches out. Icons are inline SVG paths in the Lucide
 * vocabulary ShadCN builds on, because the repository holds no binaries and
 * the panel cannot fetch a font or an icon set over the network.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The three stems behind the disclosure; the vocal is always on screen. */
const BACKING = ['drums', 'bass', 'other'] as const;

/** One quiet glyph per backing stem, in the Lucide vocabulary. */
const BACKING_ICONS: Readonly<Record<(typeof BACKING)[number], string>> = {
  drums: 'drum',
  bass: 'guitar',
  other: 'audio',
};

/** Which disclosures were left open, remembered for this tab's session. */
const OPEN_DISCLOSURES = new Set<string>();

/** The microphone desk's five sliders, in the order they are drawn. */
type MicSlider = 'level' | 'reverb' | 'echo' | 'tone' | 'compression';

const MIC_SLIDERS: readonly { readonly key: MicSlider; readonly label: string }[] = [
  { key: 'level', label: 'Level' },
  { key: 'reverb', label: 'Reverb' },
  { key: 'echo', label: 'Echo' },
  { key: 'tone', label: 'Tone' },
  { key: 'compression', label: 'Compress' },
];

/** One 24 × 24 outline vocabulary, drawn in the panel's own colours. */
const ICONS: Readonly<Record<string, readonly string[]>> = {
  mic: [
    'M12 19v3',
    'M19 10v2a7 7 0 0 1-14 0v-2',
    'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3',
  ],
  audio: ['M2 10v3', 'M6 6v11', 'M10 3v18', 'M14 8v7', 'M18 5v13', 'M22 10v3'],
  volume: [
    'M11 5 6.5 8.5H3v7h3.5L11 19Z',
    'M15.5 8.5a5 5 0 0 1 0 7',
    'M18.5 5.5a9 9 0 0 1 0 13',
  ],
  power: ['M12 2v10', 'M18.4 6.6a9 9 0 1 1-12.8 0'],
  chevron: ['m9 18 6-6-6-6'],
  drum: [
    'm2 2 8 8',
    'm22 2-8 8',
    'M2 9v8a10 5 0 0 0 20 0V9',
    'M7 13.4v7.9',
    'M12 14v8',
    'M17 13.4v7.9',
  ],
  guitar: [
    'm11.9 12.1 4.514-4.514',
    'M20.1 2.3a1 1 0 0 0-1.4 0l-1.114 1.114A2 2 0 0 0 17 4.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 17.828 7h1.344a2 2 0 0 0 1.414-.586L21.7 5.3a1 1 0 0 0 0-1.4z',
    'm6 16 2 2',
    'M8.23 9.85A3 3 0 0 1 11 8a5 5 0 0 1 5 5 3 3 0 0 1-1.85 2.77l-.92.38A2 2 0 0 0 12 18a4 4 0 0 1-4 4 6 6 0 0 1-6-6 4 4 0 0 1 4-4 2 2 0 0 0 1.85-1.23z',
  ],
  reset: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  clock: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18', 'M12 7.5V12l3 2'],
  warn: ['M12 9v4', 'M12 17h.01', 'm10.3 3.9-8 13.9A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.2l-8-13.9a2 2 0 0 0-3.4 0Z'],
};

const STYLE = `
/* Tokens are ShadCN's roles with a KTV palette: one warm ground, one ink,
   one gold accent, and red only where a stem is actually silenced. */
:host {
  --kara-ground: #1b1116;
  --kara-surface: #24171d;
  --kara-raised: #2c1b22;
  --kara-border: #3b2a30;
  --kara-border-strong: #4b343b;
  --kara-text: #f7efe6;
  --kara-muted: #c3b0a6;
  --kara-faint: #9a877e;
  --kara-accent: #e8b86d;
  --kara-accent-ink: #21140b;
  --kara-danger: #e58b8b;
  --kara-danger-tint: rgba(229, 139, 139, 0.16);
  --kara-accent-tint: rgba(232, 184, 109, 0.18);
  --kara-track: #3a2730;
  --kara-control: 32px;
  --kara-radius: 8px;
  --kara-panel-radius: 12px;
  transition: opacity 160ms ease;
  color: var(--kara-text);
  font: 500 13px/1.4 "Avenir Next", "Segoe UI", system-ui, sans-serif;
}
.panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 14px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--kara-border-strong) transparent;
  border: 1px solid var(--kara-border);
  border-radius: var(--kara-panel-radius);
  background: var(--kara-ground);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.48); /* taste-skill-ignore: floating panel over video */
}
button {
  box-sizing: border-box;
  margin: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: var(--kara-radius);
  background: transparent;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
button:hover {
  background: var(--kara-surface);
}
button:active {
  background: var(--kara-raised);
}
button:focus-visible {
  outline: 2px solid var(--kara-accent);
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
button:disabled:hover {
  background: transparent;
}
button[hidden] {
  display: none !important;
}
[hidden] {
  display: none !important;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: var(--kara-control);
}
.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.brand-glyph {
  display: flex;
  color: var(--kara-accent);
}
.brand-name {
  color: var(--kara-text);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1;
}
.top-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.mode {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--kara-control);
  padding: 0 10px;
  border-color: var(--kara-border-strong);
  color: var(--kara-muted);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.mode:hover {
  border-color: var(--kara-faint);
  background: var(--kara-surface);
  color: var(--kara-text);
}
.mode[aria-pressed='true'] {
  border-color: var(--kara-accent);
  background: var(--kara-accent);
  color: var(--kara-accent-ink);
}
.mode[aria-pressed='true']:hover {
  background: #f0c47f;
}
.mode-glyph {
  display: flex;
}
.icon-button {
  display: grid;
  place-items: center;
  width: var(--kara-control);
  height: var(--kara-control);
  padding: 0;
  color: var(--kara-faint);
}
.icon-button:hover {
  color: var(--kara-text);
}
.stop:hover {
  color: var(--kara-danger);
  background: var(--kara-danger-tint);
}
.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  height: var(--kara-control);
  padding: 0 12px;
  border-color: var(--kara-accent);
  background: var(--kara-accent);
  color: var(--kara-accent-ink);
  font-size: 12px;
  font-weight: 650;
}
.primary:hover {
  background: #f0c47f;
}
.primary-glyph {
  display: flex;
}
.launch {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hint {
  margin: 0;
  color: var(--kara-faint);
  font-size: 11px;
  line-height: 1.45;
}
.loading {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.loading-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.loading-title {
  color: var(--kara-text);
  font-size: 13px;
  font-weight: 600;
}
.loading-percent {
  color: var(--kara-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bar {
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--kara-track);
}
.bar .fill {
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--kara-accent);
  transition: width 240ms linear;
}
.detail {
  margin: 0;
  color: var(--kara-muted);
  font-size: 11px;
  line-height: 1.45;
}
.mixer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stem {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.stem.featured {
  padding: 8px;
  border-radius: var(--kara-radius);
  background: var(--kara-surface);
}
.stem-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--kara-control);
}
.stem-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--kara-text);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stem-glyph {
  display: flex;
  flex: 0 0 auto;
  color: var(--kara-faint);
}
.stem-glyph svg {
  width: 14px;
  height: 14px;
}
.switches {
  display: flex;
  gap: 4px;
}
.switch {
  width: var(--kara-control);
  height: var(--kara-control);
  padding: 0;
  border-color: var(--kara-border);
  color: var(--kara-faint);
  font-size: 11px;
  font-weight: 650;
}
.switch:hover {
  border-color: var(--kara-faint);
  background: var(--kara-raised);
  color: var(--kara-text);
}
.switch.mute[aria-pressed='true'] {
  border-color: rgba(229, 139, 139, 0.55);
  background: var(--kara-danger-tint);
  color: var(--kara-danger);
}
.switch.solo[aria-pressed='true'] {
  border-color: rgba(232, 184, 109, 0.55);
  background: var(--kara-accent-tint);
  color: var(--kara-accent);
}
.level {
  width: 34px;
  color: var(--kara-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.slider {
  position: relative;
  display: flex;
  align-items: center;
  height: 18px;
}
.slider .track {
  position: absolute;
  right: 0;
  left: 0;
  height: 4px;
  border-radius: 999px;
  background: var(--kara-track);
}
.slider .slider-fill {
  position: absolute;
  left: 0;
  width: 0;
  height: 4px;
  border-radius: 999px;
  background: var(--kara-accent);
}
.slider input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 18px;
  margin: 0;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  cursor: pointer;
}
.slider input::-webkit-slider-runnable-track {
  height: 18px;
  background: transparent;
}
.slider input::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  margin: 2px 0 0;
  -webkit-appearance: none;
  appearance: none;
  border: 2px solid var(--kara-surface);
  border-radius: 50%;
  background: var(--kara-accent);
}
.slider input:focus-visible {
  outline: 2px solid var(--kara-accent);
  outline-offset: 2px;
  border-radius: 999px;
}
.stem[data-muted='true'] .stem-name,
.stem[data-muted='true'] .level {
  color: var(--kara-faint);
}
.stem[data-muted='true'] .slider-fill {
  background: var(--kara-faint);
}
.stem[data-muted='true'] .slider input::-webkit-slider-thumb {
  background: var(--kara-faint);
}
.duet-button {
  height: var(--kara-control);
  padding: 0 8px;
  border-color: var(--kara-accent);
  color: var(--kara-accent);
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}
.duet-button:hover {
  background: var(--kara-accent-tint);
}
.practice-panel {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.practice-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--kara-control);
}
.practice-action {
  position: relative;
  display: flex;
  border-radius: var(--kara-radius);
}
.practice-action:focus-visible {
  outline: 2px solid var(--kara-accent);
  outline-offset: 2px;
}
.practice-tooltip {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 1;
  width: max-content;
  max-width: 220px;
  padding: 6px 8px;
  border: 1px solid var(--kara-border-strong);
  border-radius: var(--kara-radius);
  background: var(--kara-raised);
  color: var(--kara-text);
  font-size: 11px;
  line-height: 1.4;
  text-align: left;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 120ms ease,
    visibility 120ms ease;
}
.practice-action:hover .practice-tooltip,
.practice-action:focus-within .practice-tooltip {
  opacity: 1;
  visibility: visible;
}
.practice-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--kara-text);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.practice-button {
  height: var(--kara-control);
  padding: 0 10px;
  border-color: var(--kara-border-strong);
  color: var(--kara-text);
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}
.practice-button:hover {
  border-color: var(--kara-accent);
  color: var(--kara-accent);
}
.practice-button[data-active='true'] {
  border-color: var(--kara-accent);
  background: var(--kara-accent-tint);
  color: var(--kara-accent);
}
.practice-detail,
.practice-hint {
  margin: 0;
  color: var(--kara-faint);
  font-size: 11px;
  line-height: 1.45;
}
.practice-detail[data-tone='error'] {
  color: var(--kara-danger);
}
.song-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.song-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  min-height: var(--kara-control);
}
.song-fact {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}
.song-label {
  color: var(--kara-faint);
  font-size: 11px;
  font-weight: 600;
}
.song-value {
  overflow: hidden;
  color: var(--kara-text);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.song-detail {
  margin: 0;
  color: var(--kara-faint);
  font-size: 11px;
  line-height: 1.4;
}
.mic-panel {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.mic-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--kara-control);
}
.mic-button {
  flex: 1;
  height: var(--kara-control);
  padding: 0 10px;
  border-color: var(--kara-border-strong);
  color: var(--kara-text);
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}
.mic-button:hover {
  border-color: var(--kara-accent);
  color: var(--kara-accent);
}
.mic-button[aria-pressed='true'] {
  border-color: var(--kara-accent);
  background: var(--kara-accent-tint);
  color: var(--kara-accent);
}
.mic-warning {
  margin: 0;
  color: var(--kara-faint);
  font-size: 11px;
  line-height: 1.45;
}
.mic-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mic-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mic-name {
  width: 66px;
  overflow: hidden;
  color: var(--kara-muted);
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mic-row .slider {
  flex: 1;
}
.mic-value {
  width: 28px;
  color: var(--kara-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.record-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.record-button {
  flex: 1;
  height: var(--kara-control);
  padding: 0 10px;
  border-color: var(--kara-border-strong);
  color: var(--kara-text);
  font-size: 11px;
  font-weight: 650;
}
.record-button:hover {
  border-color: var(--kara-accent);
  color: var(--kara-accent);
}
.record-button[data-active='true'] {
  border-color: rgba(229, 139, 139, 0.55);
  background: var(--kara-danger-tint);
  color: var(--kara-danger);
}
.record-time {
  width: 48px;
  color: var(--kara-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.mic-detail {
  margin: 0;
  color: var(--kara-faint);
  font-size: 11px;
  line-height: 1.45;
}
.mic-detail[data-tone='error'] {
  color: var(--kara-danger);
}
.duet-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.duet-ready,
.duet-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.duet-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: var(--kara-control);
}
.duet-title {
  flex: 1;
  color: var(--kara-text);
  font-size: 12px;
  font-weight: 600;
}
.duet-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.duet-action {
  height: var(--kara-control);
  padding: 0 6px;
  border-color: var(--kara-border);
  color: var(--kara-muted);
  font-size: 11px;
  font-weight: 650;
}
.duet-action:hover {
  border-color: var(--kara-faint);
  color: var(--kara-text);
  background: var(--kara-raised);
}
.duet-note {
  margin: 0;
  color: var(--kara-faint);
  font-size: 11px;
  line-height: 1.45;
}
.duet-fix {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 2px;
}
.duet-fix .hint {
  margin: 0;
}
.duet-fix-actions {
  display: flex;
  gap: 6px;
}
.duet-fix-actions .duet-action {
  flex: 1;
  height: var(--kara-control);
}
.duet-error {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.duet-error-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.duet-error-glyph {
  display: flex;
  color: var(--kara-danger);
}
.duet-error-title {
  color: var(--kara-text);
  font-size: 12px;
  font-weight: 600;
}
.duet-error .primary {
  height: var(--kara-control);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.disclosure {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 6px;
  height: var(--kara-control);
  padding: 0 8px;
  border-color: var(--kara-border);
  color: var(--kara-muted);
  text-align: left;
}
.disclosure:hover {
  border-color: var(--kara-border-strong);
  color: var(--kara-text);
}
.chevron {
  display: flex;
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--kara-faint);
  transition: transform 120ms ease;
}
.disclosure[aria-expanded='true'] .chevron {
  transform: rotate(90deg);
}
.section-label {
  color: var(--kara-text);
  font-size: 12px;
  font-weight: 600;
}
.section-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--kara-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.section[data-open='true'] > .section-head .section-meta {
  display: none;
}
.reset {
  height: var(--kara-control);
  padding: 0 10px;
  border-color: var(--kara-border);
  color: var(--kara-muted);
  font-size: 11px;
}
.reset:hover {
  border-color: var(--kara-border-strong);
  color: var(--kara-text);
}
.section-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* Advanced is the one parent surface: a bordered group whose children are
   quiet inset rows, not a stack of identical cards. */
.advanced {
  gap: 0;
  border: 1px solid var(--kara-border);
  border-radius: var(--kara-radius);
  background: var(--kara-surface);
}
.advanced > .section-head {
  gap: 0;
}
.advanced > .section-head .disclosure {
  padding: 0 10px;
  border-color: transparent;
}
.advanced > .section-head .disclosure:hover {
  border-color: transparent;
  background: var(--kara-raised);
}
.advanced[data-open='true'] > .section-head {
  border-bottom: 1px solid var(--kara-border);
}
.advanced-body {
  gap: 0;
  padding: 4px;
}
.advanced-body > .section:not([hidden]) ~ .section:not([hidden]) {
  border-top: 1px solid var(--kara-border);
}
.advanced-body .disclosure {
  padding: 0 8px;
  border-color: transparent;
}
.advanced-body .disclosure:hover {
  border-color: transparent;
  background: var(--kara-raised);
}
.advanced-body .section-body {
  padding: 0 8px 8px;
}
.advanced-body > .section.flat {
  padding: 6px 8px;
}
.cache-row {
  display: flex;
  align-items: center;
  min-height: var(--kara-control);
  padding: 0 8px;
  color: var(--kara-faint);
  font-size: 11px;
}
.cache-row[data-state='hit'],
.cache-row[data-state='ready'] {
  color: var(--kara-muted);
}
.cache-row[data-state='error'] {
  color: var(--kara-danger);
}
.duet-idle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: var(--kara-control);
}
.duet-idle .duet-button {
  margin-left: auto;
}
.key-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.key-row .slider {
  flex: 1;
}
.key-slider .track::after {
  position: absolute;
  top: -2px;
  left: 50%;
  width: 1px;
  height: 8px;
  background: var(--kara-border-strong);
  content: '';
}
.key-value {
  flex: 0 0 auto;
  min-width: 58px;
  color: var(--kara-text);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.key-reset-slot {
  display: flex;
  flex: 0 0 var(--kara-control);
  width: var(--kara-control);
  height: var(--kara-control);
}
.key-reset {
  flex: 0 0 auto;
  border-color: var(--kara-border);
}
.note {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 16px;
  color: var(--kara-faint);
  font-size: 11px;
}
.note-glyph {
  display: flex;
}
.error {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.error-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.error-glyph {
  display: flex;
  color: var(--kara-danger);
}
.error-title {
  color: var(--kara-text);
  font-size: 13px;
  font-weight: 600;
}
@media (prefers-reduced-motion: reduce) {
  :host,
  button,
  .bar .fill,
  .chevron,
  .practice-tooltip {
    transition: none;
  }
}
`;

export interface PanelHandlers {
  /** The primary button: start when off, stop when running, retry after error. */
  readonly onToggle: () => void;
  readonly onMode: (mode: PlayMode) => void;
  /** The whole desk, as slider positions plus mute and solo switches. */
  readonly onMix: (mix: StemMix) => void;
  /** The key the person has landed on, in whole semitones. */
  readonly onKey: (semitones: number) => void;
  /** Start the opt-in second pass. */
  readonly onDuetStart: () => void;
  readonly onDuetMix: (mix: DuetMix) => void;
  readonly onDuetSwap: () => void;
  /** Mark the current video moment as one of the two voices. */
  readonly onDuetAnchor: (voice: 1 | 2) => void;
  readonly onDuetClear: () => void;
  /** Begin pitch practice: learn the melody, then listen to the microphone. */
  readonly onPracticeStart: () => void;
  /** Release the microphone and put the video back. */
  readonly onPracticeStop: () => void;
  /** The microphone desk as a whole; the monitor switch is part of it. */
  readonly onMicFx: (fx: MicFx) => void;
  readonly onRecordStart: () => void;
  readonly onRecordStop: () => void;
}

export interface Panel {
  /** The element in the page, so the caller can tell if it was torn out. */
  readonly host: HTMLElement;
  update: (view: PanelView) => void;
  /** The player has hidden its controls, so hide with them. */
  setAutohidden: (hidden: boolean) => void;
  destroy: () => void;
}

/** One collapsible section, and the pieces its caller arranges. */
interface Disclosure {
  readonly box: HTMLDivElement;
  readonly head: HTMLDivElement;
  readonly toggle: HTMLButtonElement;
  readonly body: HTMLDivElement;
}

/** One stem's row, and the controls `update` and the reset reach through it. */
interface StemControl {
  readonly row: HTMLDivElement;
  readonly input: HTMLInputElement;
  readonly fill: HTMLDivElement;
  readonly value: HTMLSpanElement;
  readonly mute: HTMLButtonElement;
  readonly solo: HTMLButtonElement;
}

/** One voice's row, the duet twin of `StemControl`. */
interface DuetControl {
  readonly row: HTMLDivElement;
  readonly input: HTMLInputElement;
  readonly fill: HTMLDivElement;
  readonly value: HTMLSpanElement;
  readonly mute: HTMLButtonElement;
  readonly solo: HTMLButtonElement;
}

function icon(name: string): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', '0 0 24 24');
  root.setAttribute('width', '16');
  root.setAttribute('height', '16');
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

function iconButton(name: string, className: string, label: string): HTMLButtonElement {
  const made = button('', className);
  made.setAttribute('aria-label', label);
  made.title = label;
  made.append(icon(name));
  return made;
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
  // A closed root is the contract: the page cannot read or restyle this, and
  // this cannot leak styles into the page.
  const root = host.attachShadow({ mode: 'closed' }); // taste-skill-ignore: attachShadow is the DOM API
  const style = document.createElement('style');
  style.textContent = STYLE;

  const panel = div('panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Kara karaoke controls');

  /**
   * One disclosure whose open state is remembered for the session.
   *
   * A button is the whole keyboard story: Enter and Space click it, and
   * `aria-expanded` is what a screen reader reads. The chevron turns with it,
   * so the state is visible as well as announced.
   */
  const disclosure = (key: string, title: string, meta: string): Disclosure => {
    const box = div('section');
    const head = div('section-head');
    const toggle = button('', 'disclosure');
    const body = div('section-body');
    body.id = `kara-${key}`;
    toggle.setAttribute('aria-controls', body.id);
    const chevron = span('chevron');
    chevron.append(icon('chevron'));
    const label = span('section-label');
    label.textContent = title;
    const metaText = span('section-meta');
    metaText.textContent = meta;
    toggle.append(label, metaText, chevron);
    head.append(toggle);
    box.append(head, body);

    const setOpen = (open: boolean): void => {
      if (open) {
        OPEN_DISCLOSURES.add(key);
      } else {
        OPEN_DISCLOSURES.delete(key);
      }
      box.dataset['open'] = String(open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.title = `${open ? 'Hide' : 'Show'} ${title.toLowerCase()}`;
      body.hidden = !open;
    };
    toggle.addEventListener('click', () => {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    setOpen(OPEN_DISCLOSURES.has(key));
    return { box, head, toggle, body };
  };

  const advanced = disclosure('advanced', 'Advanced', 'More controls');
  advanced.box.classList.add('advanced');
  advanced.body.classList.add('advanced-body');
  const backingSection = disclosure('advanced-backing', 'Backing', 'Drums, bass, other');
  const micSection = disclosure('advanced-mic', 'Mic & recording', 'Monitor and record');
  const keySection = div('section flat');
  const songSection = div('section flat');
  const practiceSection = div('section flat');
  const duetSection = div('section flat');
  const cacheRow = div('cache-row');
  const cacheText = span('cache-text');
  cacheRow.append(cacheText);
  cacheRow.hidden = true;
  advanced.body.append(
    cacheRow,
    backingSection.box,
    songSection,
    practiceSection,
    micSection.box,
    duetSection,
    keySection,
  );

  const top = div('top');
  const brand = div('brand');
  const brandGlyph = span('brand-glyph');
  brandGlyph.append(icon('mic'));
  const brandName = span('brand-name');
  brandName.textContent = 'Kara';
  brand.append(brandGlyph, brandName);
  const topActions = div('top-actions');

  const mode = button('', 'mode');
  const modeGlyph = span('mode-glyph');
  const modeLabel = span('mode-label');
  mode.append(modeGlyph, modeLabel);
  const stop = iconButton('power', 'icon-button stop', 'Stop karaoke');
  topActions.append(mode, stop);
  top.append(brand, topActions);

  const launch = div('launch');
  const start = button('', 'primary');
  const startGlyph = span('primary-glyph');
  startGlyph.append(icon('mic'));
  const startLabel = span('primary-label');
  start.append(startGlyph, startLabel);
  const hint = paragraph('hint');
  hint.textContent = 'Takes the vocal out, on this device.';
  launch.append(start, hint);

  const loading = div('loading');
  const loadingHead = div('loading-head');
  const loadingTitle = span('loading-title');
  const loadingPercent = span('loading-percent');
  loadingHead.append(loadingTitle, loadingPercent);
  const bar = div('bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Getting karaoke ready');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = div('fill');
  bar.append(fill);
  const loadingDetail = paragraph('detail');
  loading.append(loadingHead, bar, loadingDetail);

  const mixer = div('mixer');

  /**
   * One slider and two switches per stem, built the same way, so a level can
   * never mean something different from one row to the next. `stemControls`
   * is how `update` reaches them and how the reset finds them without a second
   * lookup table.
   */
  const stemControls = new Map<Stem, StemControl>();

  /**
   * What the controls say, assembled into one mix.
   *
   * Read from the controls rather than kept in a variable: a report arriving
   * mid-drag must not put back a level the person has already moved past, and
   * the controls are the only thing that knows what the person has actually
   * asked for between reports. Mute and solo are read from `aria-pressed`
   * because that is also what the screen reader sees.
   */
  const mixFromControls = (): StemMix => {
    let mix = DEFAULT_MIX;
    for (const stem of STEMS) {
      const control = stemControls.get(stem);
      if (control === undefined) {
        continue;
      }
      mix = withStem(mix, stem, stemFromPercent(Number(control.input.value)));
      mix = withMute(mix, stem, control.mute.getAttribute('aria-pressed') === 'true');
      mix = withSolo(mix, stem, control.solo.getAttribute('aria-pressed') === 'true');
    }
    return mix;
  };

  const flipSwitch = (control: StemControl, kind: 'mute' | 'solo'): void => {
    const target = kind === 'mute' ? control.mute : control.solo;
    const pressed = target.getAttribute('aria-pressed') !== 'true';
    target.setAttribute('aria-pressed', String(pressed));
    control.row.dataset[kind] = String(pressed);
    handlers.onMix(mixFromControls());
  };

  const paintLevel = (control: StemControl, percent: number): void => {
    control.input.value = String(percent);
    control.value.textContent = String(percent);
    control.fill.style.width = `${String(percent)}%`;
  };

  const stemRow = (stem: Stem, featured: boolean, glyph?: string): HTMLDivElement => {
    const row = div(featured ? 'stem featured' : 'stem');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', STEM_LABEL[stem]);
    const head = div('stem-head');
    if (glyph !== undefined) {
      const mark = span('stem-glyph');
      mark.append(icon(glyph));
      head.append(mark);
    }
    const name = span('stem-name');
    name.textContent = STEM_LABEL[stem];
    const switches = div('switches');
    const mute = button('M', 'switch mute');
    mute.title = `Mute ${STEM_LABEL[stem].toLowerCase()}`;
    mute.setAttribute('aria-label', `Mute ${STEM_LABEL[stem].toLowerCase()}`);
    mute.setAttribute('aria-pressed', String(DEFAULT_MIX.muted[stem]));
    const solo = button('S', 'switch solo');
    solo.title = `Solo ${STEM_LABEL[stem].toLowerCase()}`;
    solo.setAttribute('aria-label', `Solo ${STEM_LABEL[stem].toLowerCase()}`);
    solo.setAttribute('aria-pressed', String(DEFAULT_MIX.soloed[stem]));
    switches.append(mute, solo);
    const level = span('level');
    head.append(name, switches, level);
    row.dataset['muted'] = String(DEFAULT_MIX.muted[stem]);
    row.dataset['soloed'] = String(DEFAULT_MIX.soloed[stem]);

    const slider = div('slider');
    const track = div('track');
    const sliderFill = div('slider-fill');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.setAttribute('aria-label', `${STEM_LABEL[stem]} level`);
    slider.append(track, sliderFill, input);
    row.append(head, slider);

    const control: StemControl = {
      row,
      input,
      fill: sliderFill,
      value: level,
      mute,
      solo,
    };
    stemControls.set(stem, control);
    paintLevel(control, stemPercent(DEFAULT_LEVELS[stem]));
    input.addEventListener('input', () => {
      paintLevel(control, Number(input.value));
      handlers.onMix(mixFromControls());
    });
    mute.addEventListener('click', () => {
      flipSwitch(control, 'mute');
    });
    solo.addEventListener('click', () => {
      flipSwitch(control, 'solo');
    });
    return row;
  };

  const vocalsRow = stemRow('vocals', true);
  mixer.append(vocalsRow, advanced.box);

  /**
   * Pitch practice, inside Advanced. The button stays disabled until the whole
   * vocal stem exists, because analysis reads all of it; the row then carries
   * the learning bar and, once ready, the headphone advice. Nothing here
   * touches the mixer's four levels.
   */
  const practiceBox = div('practice-panel');
  const practiceHead = div('practice-head');
  const practiceTitle = span('practice-title');
  practiceTitle.textContent = 'Pitch practice';
  const practiceAction = div('practice-action');
  practiceAction.setAttribute('role', 'group');
  practiceAction.setAttribute('aria-label', 'Pitch practice');
  practiceAction.tabIndex = -1;
  const practiceButton = button('Practice', 'practice-button');
  practiceButton.title = 'Score your singing against the guide melody';
  practiceButton.setAttribute('aria-label', 'Start pitch practice');
  const practiceTooltip = span('practice-tooltip');
  practiceTooltip.id = 'kara-practice-tooltip';
  practiceTooltip.setAttribute('role', 'tooltip');
  practiceTooltip.hidden = true;
  practiceAction.append(practiceButton, practiceTooltip);
  practiceHead.append(practiceTitle, practiceAction);

  const practiceHint = paragraph('practice-hint');
  practiceHint.hidden = true;

  const practiceBar = div('bar');
  practiceBar.setAttribute('role', 'progressbar');
  practiceBar.setAttribute('aria-label', 'Learning the guide melody');
  practiceBar.setAttribute('aria-valuemin', '0');
  practiceBar.setAttribute('aria-valuemax', '100');
  const practiceBarFill = div('fill');
  practiceBar.append(practiceBarFill);

  const practiceDetail = paragraph('practice-detail');
  practiceBox.append(practiceHead, practiceHint, practiceBar, practiceDetail);
  practiceSection.append(practiceBox);

  /**
   * The song row. It is information rather than a control: it only says what
   * the separated audio appears to be, in one compact line. A key the analysis
   * is not sure of is a question mark, and a tempo it is not sure of is
   * absent, so an unsure read never looks like a fact.
   */
  const songBox = div('song-panel');
  const songFacts = div('song-row');

  const songRow = (label: string): { readonly row: HTMLSpanElement; readonly value: HTMLSpanElement } => {
    const row = span('song-fact');
    const name = span('song-label');
    name.textContent = label;
    const value = span('song-value');
    row.append(name, value);
    songFacts.append(row);
    return { row, value };
  };
  const songKeyCell = songRow('Key');
  const songBpmCell = songRow('BPM');
  const songRangeCell = songRow('Range');
  const songDetail = paragraph('song-detail');
  songDetail.hidden = true;
  songBox.append(songFacts, songDetail);
  songSection.append(songBox);

  /**
   * The microphone desk. The monitor starts off and the warning is always
   * beside the switch, because the one mistake this panel must not invite is
   * a microphone through the same speakers as the backing. Recording is
   * independent: it takes the processed microphone whether the monitor is on
   * or not, mixed with whatever the stems are playing.
   */
  const micBox = div('mic-panel');
  const micHead = div('mic-head');
  const monitor = button('Monitor off', 'mic-button');
  monitor.setAttribute('aria-pressed', 'false');
  monitor.setAttribute('aria-label', 'Monitor the microphone in the speakers');
  monitor.title = MONITOR_WARNING;
  micHead.append(monitor);

  const micWarning = paragraph('mic-warning');
  micWarning.textContent = MONITOR_WARNING;

  const micRows = div('mic-rows');
  interface MicControl {
    readonly input: HTMLInputElement;
    readonly fill: HTMLDivElement;
    readonly value: HTMLSpanElement;
  }
  const micControls = new Map<MicSlider, MicControl>();

  const paintMic = (control: MicControl, percent: number): void => {
    control.input.value = String(percent);
    control.value.textContent = String(percent);
    control.fill.style.width = `${String(percent)}%`;
  };

  const micFromControls = (): MicFx => {
    const percent = (key: MicSlider): number =>
      Number(micControls.get(key)?.input.value ?? 0);
    return normaliseMicFx({
      level: stemFromPercent(percent('level')),
      monitor: monitor.getAttribute('aria-pressed') === 'true',
      reverb: stemFromPercent(percent('reverb')),
      echo: stemFromPercent(percent('echo')),
      tone: stemFromPercent(percent('tone')),
      compression: stemFromPercent(percent('compression')),
    });
  };

  for (const { key, label } of MIC_SLIDERS) {
    const row = div('mic-row');
    const name = span('mic-name');
    name.textContent = label;
    const slider = div('slider');
    const track = div('track');
    const sliderFill = div('slider-fill');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.setAttribute('aria-label', `Mic ${label.toLowerCase()}`);
    slider.append(track, sliderFill, input);
    const value = span('mic-value');
    row.append(name, slider, value);
    const control: MicControl = { input, fill: sliderFill, value };
    micControls.set(key, control);
    paintMic(control, stemPercent(DEFAULT_MIC_FX[key]));
    input.addEventListener('input', () => {
      paintMic(control, Number(input.value));
      handlers.onMicFx(micFromControls());
    });
    micRows.append(row);
  }

  const recordRow = div('record-row');
  const recordButton = button('Record', 'record-button');
  recordButton.setAttribute('aria-label', 'Record the performance');
  recordButton.title = 'Record the backing and the processed microphone to a WebM file';
  const recordTime = span('record-time');
  recordTime.textContent = '0:00';
  recordTime.setAttribute('role', 'timer');
  recordTime.setAttribute('aria-live', 'off');
  recordRow.append(recordButton, recordTime);

  const micDetail = paragraph('mic-detail');
  micDetail.hidden = true;

  micBox.append(micHead, micWarning, micRows, recordRow, micDetail);
  micSection.body.append(micBox);

  monitor.addEventListener('click', () => {
    const pressed = monitor.getAttribute('aria-pressed') !== 'true';
    monitor.setAttribute('aria-pressed', String(pressed));
    handlers.onMicFx(micFromControls());
  });
  recordButton.addEventListener('click', () => {
    if (recordButton.disabled) {
      return;
    }
    if (lastView?.recordActive === true) {
      handlers.onRecordStop();
    } else {
      handlers.onRecordStart();
    }
  });

  /**
   * The duet panel. It is a second desk, shown only after the helper has
   * returned two voices. While the job runs the single vocal row above stays
   * live, which is the whole point of keeping the second pass opt-in.
   */
  const duetBox = div('duet-panel');

  const duetIdle = div('duet-idle');
  const duetIdleLabel = span('section-label');
  duetIdleLabel.textContent = 'Duet';
  const duetStart = button('Start duet', 'duet-button');
  duetStart.title = 'Duet (beta) — split the two singers';
  duetStart.setAttribute('aria-label', 'Start duet (beta)');
  duetStart.addEventListener('click', () => {
    handlers.onDuetStart();
  });
  duetIdle.append(duetIdleLabel, duetStart);

  const duetProgress = div('loading');
  const duetProgressHead = div('loading-head');
  const duetProgressTitle = span('loading-title');
  const duetProgressPercent = span('loading-percent');
  duetProgressHead.append(duetProgressTitle, duetProgressPercent);
  const duetBar = div('bar');
  duetBar.setAttribute('role', 'progressbar');
  duetBar.setAttribute('aria-label', 'Splitting the two voices');
  duetBar.setAttribute('aria-valuemin', '0');
  duetBar.setAttribute('aria-valuemax', '100');
  const duetBarFill = div('fill');
  duetBar.append(duetBarFill);
  const duetProgressDetail = paragraph('detail');
  const duetCancel = button('Cancel', 'duet-action');
  duetCancel.title = 'Stop the duet helper and keep the single vocal';
  duetCancel.addEventListener('click', () => {
    handlers.onDuetClear();
  });
  duetProgress.append(duetProgressHead, duetBar, duetProgressDetail, duetCancel);

  const duetReady = div('duet-ready');
  const duetHead = div('duet-head');
  const duetTitle = span('duet-title');
  duetTitle.textContent = 'Duet';
  const duetActions = div('duet-actions');
  const duetSwap = button('Swap', 'duet-action');
  duetSwap.title = 'Swap which separated stream is Voice 1';
  const duetFix = button('Fix line', 'duet-action');
  duetFix.title = 'Teach the helper that a line belongs to one voice';
  const duetOff = button('Single vocal', 'duet-action');
  duetOff.title = 'Go back to the single vocal stem';
  duetActions.append(duetSwap, duetFix, duetOff);
  duetHead.append(duetTitle, duetActions);

  const duetRows = div('duet-rows');
  const duetControls = new Map<0 | 1, DuetControl>();

  const duetMixFromControls = (): DuetMix => {
    let mix = DEFAULT_DUET_MIX;
    for (const index of [0, 1] as const) {
      const control = duetControls.get(index);
      if (control === undefined) {
        continue;
      }
      mix = withDuetLevel(mix, index, stemFromPercent(Number(control.input.value)));
      mix = withDuetMute(mix, index, control.mute.getAttribute('aria-pressed') === 'true');
      mix = withDuetSolo(mix, index, control.solo.getAttribute('aria-pressed') === 'true');
    }
    return mix;
  };

  const paintDuetLevel = (control: DuetControl, percent: number): void => {
    control.input.value = String(percent);
    control.value.textContent = String(percent);
    control.fill.style.width = `${String(percent)}%`;
  };

  const flipDuetSwitch = (control: DuetControl, kind: 'mute' | 'solo'): void => {
    const target = kind === 'mute' ? control.mute : control.solo;
    const pressed = target.getAttribute('aria-pressed') !== 'true';
    target.setAttribute('aria-pressed', String(pressed));
    control.row.dataset[kind] = String(pressed);
    handlers.onDuetMix(duetMixFromControls());
  };

  const duetRow = (index: 0 | 1): HTMLDivElement => {
    const row = div('stem');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', DUET_LABEL[index]);
    const head = div('stem-head');
    const name = span('stem-name');
    name.textContent = DUET_LABEL[index];
    const switches = div('switches');
    const mute = button('M', 'switch mute');
    mute.title = `Mute ${DUET_LABEL[index].toLowerCase()}`;
    mute.setAttribute('aria-label', `Mute ${DUET_LABEL[index].toLowerCase()}`);
    mute.setAttribute('aria-pressed', String(DEFAULT_DUET_MIX.muted[index]));
    const solo = button('S', 'switch solo');
    solo.title = `Solo ${DUET_LABEL[index].toLowerCase()}`;
    solo.setAttribute('aria-label', `Solo ${DUET_LABEL[index].toLowerCase()}`);
    solo.setAttribute('aria-pressed', String(DEFAULT_DUET_MIX.soloed[index]));
    switches.append(mute, solo);
    const level = span('level');
    head.append(name, switches, level);
    row.dataset['muted'] = String(DEFAULT_DUET_MIX.muted[index]);
    row.dataset['soloed'] = String(DEFAULT_DUET_MIX.soloed[index]);

    const slider = div('slider');
    const track = div('track');
    const sliderFill = div('slider-fill');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.setAttribute('aria-label', `${DUET_LABEL[index]} level`);
    slider.append(track, sliderFill, input);
    row.append(head, slider);

    const control: DuetControl = {
      row,
      input,
      fill: sliderFill,
      value: level,
      mute,
      solo,
    };
    duetControls.set(index, control);
    paintDuetLevel(control, duetPercent(DEFAULT_DUET_MIX.levels[index]));
    input.addEventListener('input', () => {
      paintDuetLevel(control, Number(input.value));
      handlers.onDuetMix(duetMixFromControls());
    });
    mute.addEventListener('click', () => {
      flipDuetSwitch(control, 'mute');
    });
    solo.addEventListener('click', () => {
      flipDuetSwitch(control, 'solo');
    });
    return row;
  };

  duetRows.append(duetRow(0), duetRow(1));
  const duetNote = paragraph('duet-note');
  duetNote.hidden = true;

  const duetFixPanel = div('duet-fix');
  duetFixPanel.hidden = true;
  const fixHint = paragraph('hint');
  fixHint.textContent = 'Pause on a line where only one singer sings.';
  const fixActions = div('duet-fix-actions');
  const fixVoice1 = button('This is Voice 1', 'duet-action');
  const fixVoice2 = button('This is Voice 2', 'duet-action');
  fixVoice1.addEventListener('click', () => {
    duetFixPanel.hidden = true;
    handlers.onDuetAnchor(1);
  });
  fixVoice2.addEventListener('click', () => {
    duetFixPanel.hidden = true;
    handlers.onDuetAnchor(2);
  });
  fixActions.append(fixVoice1, fixVoice2);
  duetFixPanel.append(fixHint, fixActions);

  duetSwap.addEventListener('click', () => {
    handlers.onDuetSwap();
  });
  duetFix.addEventListener('click', () => {
    duetFixPanel.hidden = !duetFixPanel.hidden;
  });
  duetOff.addEventListener('click', () => {
    handlers.onDuetClear();
  });

  duetReady.append(duetHead, duetRows, duetNote, duetFixPanel);

  const duetError = div('duet-error');
  const duetErrorHead = div('duet-error-head');
  const duetErrorGlyph = span('duet-error-glyph');
  duetErrorGlyph.append(icon('warn'));
  const duetErrorTitle = span('duet-error-title');
  duetErrorTitle.textContent = 'Duet stopped';
  duetErrorHead.append(duetErrorGlyph, duetErrorTitle);
  const duetErrorDetail = paragraph('detail');
  const duetRetry = button('Try again', 'primary');
  duetRetry.addEventListener('click', () => {
    handlers.onDuetStart();
  });
  duetError.append(duetErrorHead, duetErrorDetail, duetRetry);
  duetError.hidden = true;

  duetBox.append(duetIdle, duetProgress, duetReady, duetError);
  duetSection.append(duetBox);

  const reset = button('Reset', 'reset');
  reset.title = 'Backing stems to full, unmuted and unsoloed';
  backingSection.head.append(reset);
  for (const stem of BACKING) {
    backingSection.body.append(stemRow(stem, false, BACKING_ICONS[stem]));
  }
  const syncReset = (): void => {
    reset.hidden = backingSection.toggle.getAttribute('aria-expanded') !== 'true';
  };
  backingSection.toggle.addEventListener('click', syncReset);
  syncReset();

  const keyRow = div('key-row');
  /** The last key drawn, which is what a slider move or a shortcut moves from. */
  let semitones = KEY_DEFAULT;
  const keySlider = div('slider key-slider');
  const keyTrack = div('track');
  const keyFill = div('slider-fill');
  const keyInput = document.createElement('input');
  keyInput.type = 'range';
  keyInput.min = String(KEY_MIN);
  keyInput.max = String(KEY_MAX);
  keyInput.step = '1';
  keyInput.value = String(KEY_DEFAULT);
  keyInput.setAttribute('aria-label', 'Song key');
  keyInput.title = 'Transpose the song; [ and ] step one semitone';
  keySlider.append(keyTrack, keyFill, keyInput);
  const keyValue = span('key-value');
  keyValue.setAttribute('role', 'status');
  keyValue.setAttribute('aria-live', 'polite');
  keyValue.textContent = keyLabel(KEY_DEFAULT);
  const keyClear = iconButton('reset', 'icon-button key-reset', 'Back to the original key');
  keyClear.hidden = true;
  const keyResetSlot = span('key-reset-slot');
  keyResetSlot.append(keyClear);
  keyRow.append(keySlider, keyValue, keyResetSlot);
  keySection.append(keyRow);

  const paintKey = (value: number): void => {
    keyInput.value = String(value);
    keyValue.textContent = keyLabel(value);
    keyInput.setAttribute('aria-valuetext', keyLabel(value));
    keyClear.hidden = value === KEY_DEFAULT;
    const percent = ((value - KEY_MIN) / (KEY_MAX - KEY_MIN)) * 100;
    keyFill.style.left = `${String(Math.min(50, percent))}%`;
    keyFill.style.width = `${String(Math.abs(percent - 50))}%`;
  };
  paintKey(KEY_DEFAULT);
  keyInput.addEventListener('input', () => {
    const value = Number(keyInput.value);
    semitones = value;
    paintKey(value);
    handlers.onKey(value);
  });

  const note = div('note');
  const noteGlyph = span('note-glyph');
  noteGlyph.append(icon('clock'));
  const noteText = span('note-text');
  note.append(noteGlyph, noteText);
  note.hidden = true;
  mixer.append(note);

  const errorBox = div('error');
  const errorHead = div('error-head');
  const errorGlyph = span('error-glyph');
  errorGlyph.append(icon('warn'));
  const errorTitle = span('error-title');
  errorHead.append(errorGlyph, errorTitle);
  const errorDetail = paragraph('detail');
  const retry = button('', 'primary');
  const retryGlyph = span('primary-glyph');
  retryGlyph.append(icon('reset'));
  const retryLabel = span('primary-label');
  retryLabel.textContent = 'Try again';
  retry.append(retryGlyph, retryLabel);
  errorBox.append(errorHead, errorDetail, retry);
  errorBox.hidden = true;

  panel.append(top, launch, loading, mixer, errorBox);
  root.append(style, panel);

  let autohidden = false;
  let hovering = false;
  let lastView: PanelView | null = null;

  /**
   * Keep the panel inside the player. The host sits 72px above the control
   * bar, so the usable height is the player minus that and a small top gap;
   * when Advanced is open, the panel scrolls rather than reaching into the
   * picture above.
   */
  const fit = (): void => {
    const height = container.clientHeight;
    if (height > 0) {
      panel.style.maxHeight = `${String(Math.max(160, height - 84))}px`;
    }
  };
  const sizeWatcher = new ResizeObserver(fit);
  sizeWatcher.observe(container);
  fit();

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
   * root. So they cost the page nothing, and somebody who has just pressed a
   * key button can press the next one without aiming.
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
    semitones = nudgeKey(semitones, step);
    paintKey(semitones);
    handlers.onKey(semitones);
  };

  for (const kind of ['click', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']) {
    // The player makes a click anywhere in itself mean play or pause.
    host.addEventListener(kind, keepToSelf);
  }
  // And it reads arrow keys as seeks, which the guide slider also wants.
  host.addEventListener('keydown', onKeydown);
  host.addEventListener('keyup', keepToSelf);
  container.addEventListener('pointermove', onPointerMove, { passive: true });

  start.addEventListener('click', () => {
    handlers.onToggle();
  });
  retry.addEventListener('click', () => {
    handlers.onToggle();
  });
  stop.addEventListener('click', () => {
    handlers.onToggle();
  });
  mode.addEventListener('click', () => {
    handlers.onMode(lastView?.mode === 'instrumental' ? 'original' : 'instrumental');
  });
  practiceButton.addEventListener('click', () => {
    if (lastView?.practiceActive === true) {
      handlers.onPracticeStop();
    } else {
      handlers.onPracticeStart();
    }
  });
  keyClear.addEventListener('click', () => {
    handlers.onKey(KEY_DEFAULT);
  });

  // The backing only: the vocal row is outside this and is the person's
  // guide, not part of the backing. A reset that left a stem muted or soloed
  // would not be a reset, so the switches go back too. While collapsed there
  // is nothing to reset that can be seen, so the button is not shown.
  reset.addEventListener('click', () => {
    for (const stem of BACKING) {
      const control = stemControls.get(stem);
      if (control === undefined) {
        continue;
      }
      paintLevel(control, stemPercent(DEFAULT_LEVELS[stem]));
      control.mute.setAttribute('aria-pressed', 'false');
      control.solo.setAttribute('aria-pressed', 'false');
      control.row.dataset['muted'] = 'false';
      control.row.dataset['soloed'] = 'false';
    }
    handlers.onMix(mixFromControls());
  });

  function update(view: PanelView): void {
    lastView = view;
    panel.dataset['state'] = view.state;
    launch.hidden = view.state !== 'off';
    loading.hidden = view.state !== 'preparing' || view.controls;
    mixer.hidden = !view.controls;
    cacheRow.hidden = view.cacheLabel === null;
    cacheRow.dataset['state'] = view.cacheState ?? '';
    cacheText.textContent = view.cacheLabel ?? '';
    cacheRow.title = view.cacheDetail ?? '';
    errorBox.hidden = view.state !== 'error' && view.state !== 'unsupported';
    topActions.dataset['mode'] = view.mode;
    mode.hidden = !view.controls;
    stop.hidden =
      view.state !== 'preparing' && view.state !== 'ready' && view.state !== 'paused';

    startLabel.textContent = view.label;
    start.setAttribute('aria-label', view.label);

    const percent = view.progress === null ? null : progressPercent(view.progress);
    loadingTitle.textContent = view.label;
    loadingPercent.textContent = percent === null ? '' : `${String(percent)}%`;
    if (percent !== null) {
      fill.style.width = `${String(percent)}%`;
      bar.setAttribute('aria-valuenow', String(percent));
      bar.setAttribute('aria-valuetext', view.detail ?? `${String(percent)}%`);
    }
    loadingDetail.textContent = view.detail ?? '';
    loadingDetail.hidden = view.detail === null;

    const instrumental = view.mode === 'instrumental';
    mode.setAttribute('aria-pressed', String(instrumental));
    mode.setAttribute('aria-label', instrumental ? 'Switch to original audio' : 'Switch to instrumental');
    mode.title = instrumental ? 'Switch to original audio' : 'Switch to instrumental';
    modeLabel.textContent = instrumental ? 'Instrumental' : 'Original';
    modeGlyph.replaceChildren(icon(instrumental ? 'audio' : 'volume'));

    errorTitle.textContent = view.label;
    errorDetail.textContent = view.detail ?? '';
    errorDetail.hidden = view.detail === null;
    retry.hidden = view.state !== 'error';

    note.hidden = !(view.state === 'preparing' && view.controls && view.note !== null);
    noteText.textContent =
      view.note === null
        ? ''
        : `${view.note}${percent === null ? '' : ` · ${String(percent)}%`}`;

    const duetVoicesVisible = view.duetHasVoices;
    vocalsRow.hidden = duetVoicesVisible;
    duetIdle.hidden = view.duetState !== 'off';
    duetProgress.hidden = view.duetState !== 'preparing';
    duetReady.hidden = !duetVoicesVisible;
    duetError.hidden = view.duetState !== 'error';
    duetStart.disabled = !view.duetCanStart;
    duetStart.title = view.duetCanStart
      ? 'Duet (beta) — split the two singers'
      : 'Finish preparing karaoke first';

    duetProgressTitle.textContent = view.duetLabel;
    const duetFraction = view.duetProgress === null ? 0 : progressPercent(view.duetProgress);
    duetProgressPercent.textContent = duetFraction === 0 && view.duetProgress === null ? '' : `${String(duetFraction)}%`;
    duetBarFill.style.width = `${String(duetFraction)}%`;
    duetBar.setAttribute('aria-valuenow', String(duetFraction));
    duetBar.setAttribute('aria-valuetext', view.duetDetail ?? `${String(duetFraction)}%`);
    duetProgressDetail.textContent = view.duetDetail ?? '';
    duetProgressDetail.hidden = view.duetDetail === null;

    duetNote.textContent = view.duetState === 'ready' ? (view.duetDetail ?? '') : '';
    duetNote.hidden = view.duetState !== 'ready' || view.duetDetail === null;
    duetErrorDetail.textContent = view.duetDetail ?? '';
    duetErrorDetail.hidden = view.duetDetail === null;
    if (!duetVoicesVisible) {
      duetFixPanel.hidden = true;
    }

    practiceButton.textContent = view.practiceActive
      ? 'Stop'
      : view.practiceState === 'error'
        ? 'Try again'
        : 'Practice';
    practiceButton.dataset['active'] = String(view.practiceActive);
    practiceButton.disabled = !view.practiceActive && !view.practiceCanStart;
    const practiceTip = view.practiceTooltip;
    if (practiceTip === null) {
      practiceAction.tabIndex = -1;
      practiceAction.removeAttribute('aria-describedby');
      practiceButton.removeAttribute('aria-describedby');
      practiceButton.title = view.practiceActive
        ? 'Stop practice and release the microphone'
        : 'Score your singing against the guide melody';
      practiceTooltip.textContent = '';
      practiceTooltip.hidden = true;
    } else {
      // A disabled button cannot take focus, so the wrapper is the keyboard
      // stop that reveals the tooltip and carries its description.
      practiceAction.tabIndex = 0;
      practiceAction.setAttribute('aria-describedby', practiceTooltip.id);
      practiceButton.setAttribute('aria-describedby', practiceTooltip.id);
      practiceButton.removeAttribute('title');
      practiceTooltip.textContent = practiceTip;
      practiceTooltip.hidden = false;
    }
    practiceButton.setAttribute(
      'aria-label',
      view.practiceActive ? 'Stop pitch practice' : 'Start pitch practice',
    );
    practiceHint.textContent = view.practiceHint ?? '';
    practiceHint.hidden = view.practiceHint === null;
    practiceBar.hidden = view.practiceProgress === null;
    if (view.practiceProgress !== null) {
      const practicePercent = Math.round(view.practiceProgress * 100);
      practiceBarFill.style.width = `${String(practicePercent)}%`;
      practiceBar.setAttribute('aria-valuenow', String(practicePercent));
      practiceBar.setAttribute('aria-valuetext', view.practiceDetail ?? `${String(practicePercent)}%`);
    }
    practiceDetail.textContent = view.practiceDetail ?? '';
    practiceDetail.hidden = view.practiceDetail === null;
    practiceDetail.dataset['tone'] = view.practiceState === 'error' ? 'error' : 'hint';

    songSection.hidden = view.songAnalysisState === 'off';
    songDetail.textContent = view.songDetail ?? '';
    songDetail.hidden = view.songDetail === null;
    songFacts.hidden = view.songAnalysisState !== 'ready';
    if (view.songAnalysisState === 'ready') {
      songKeyCell.value.textContent = view.songKey ?? '?';
      songBpmCell.row.hidden = view.songBpm === null;
      songBpmCell.value.textContent = view.songBpm === null ? '' : String(view.songBpm);
      songRangeCell.row.hidden = view.songRange === null;
      songRangeCell.value.textContent = view.songRange ?? '';
    }

    monitor.setAttribute('aria-pressed', String(view.monitorOn));
    monitor.textContent = view.monitorOn ? 'Monitor on' : 'Monitor off';
    monitor.setAttribute(
      'aria-label',
      view.monitorOn ? 'Stop monitoring the microphone' : 'Monitor the microphone in the speakers',
    );
    monitor.title = view.monitorOn
      ? `${view.micWarning} Monitoring is on.`
      : view.micWarning;
    for (const { key } of MIC_SLIDERS) {
      const control = micControls.get(key);
      if (control === undefined) {
        continue;
      }
      const percent = stemPercent(view.mic[key]);
      if (root.activeElement !== control.input) {
        paintMic(control, percent);
      } else {
        control.value.textContent = String(percent);
      }
    }
    recordButton.textContent = view.recordLabel;
    recordButton.dataset['active'] = String(view.recordActive);
    recordButton.disabled = view.recordBusy;
    recordButton.setAttribute(
      'aria-label',
      view.recordActive ? 'Stop recording' : view.recordLabel,
    );
    recordButton.title = view.recordActive
      ? 'Stop and save the recording'
      : view.recordBusy
        ? 'Finishing the recording'
        : 'Record the backing and the processed microphone to a WebM file';
    recordTime.textContent = view.recordTimer;
    recordTime.dataset['active'] = String(view.recordActive);
    micDetail.textContent = view.micDetail ?? '';
    micDetail.hidden = view.micDetail === null;
    micDetail.dataset['tone'] = view.micError ? 'error' : 'hint';

    for (const index of [0, 1] as const) {
      const control = duetControls.get(index);
      if (control === undefined) {
        continue;
      }
      control.mute.setAttribute('aria-pressed', String(view.duetMix.muted[index]));
      control.solo.setAttribute('aria-pressed', String(view.duetMix.soloed[index]));
      control.row.dataset['muted'] = String(view.duetMix.muted[index]);
      control.row.dataset['soloed'] = String(view.duetMix.soloed[index]);
      const level = duetPercent(view.duetMix.levels[index]);
      if (root.activeElement !== control.input) {
        paintDuetLevel(control, level);
      } else {
        control.value.textContent = String(level);
      }
    }

    for (const stem of STEMS) {
      const control = stemControls.get(stem);
      if (control === undefined) {
        continue;
      }
      control.mute.setAttribute('aria-pressed', String(view.mix.muted[stem]));
      control.solo.setAttribute('aria-pressed', String(view.mix.soloed[stem]));
      control.row.dataset['muted'] = String(view.mix.muted[stem]);
      control.row.dataset['soloed'] = String(view.mix.soloed[stem]);
      const level = stemPercent(view.mix.levels[stem]);
      if (root.activeElement !== control.input) {
        paintLevel(control, level);
      } else {
        control.value.textContent = String(level);
      }
    }

    semitones = view.semitones;
    if (root.activeElement !== keyInput) {
      paintKey(semitones);
    } else {
      keyValue.textContent = view.keyLabel;
    }
    keyClear.hidden = semitones === KEY_DEFAULT;
  }

  container.append(host);
  mode.hidden = true;
  stop.hidden = true;
  loading.hidden = true;
  mixer.hidden = true;

  return {
    host,

    update,

    setAutohidden(hidden) {
      autohidden = hidden;
      apply();
    },

    destroy() {
      container.removeEventListener('pointermove', onPointerMove);
      sizeWatcher.disconnect();
      host.remove();
    },
  };
}
