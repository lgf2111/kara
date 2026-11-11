/**
 * The one place Kara's palette and control metrics live.
 *
 * Three surfaces read this file: the in-page panel (a closed shadow root, so it
 * can inherit nothing from the page or from the popup), the toolbar popup, and
 * the practice overlay with its score card. They are compiled into the bundle
 * rather than fetched, which is what keeps the CSP at `script-src 'self'`.
 *
 * These are ShadCN's role names with a KTV palette: one warm ground, one ink,
 * one gold accent, and red only where a stem is actually silenced. Change a
 * value here and every surface moves together; a second hex of `#1b1116`
 * anywhere in the extension is a bug.
 */

/** Every shared custom property, in the order both surfaces declare them. */
export const TOKEN_VALUES = {
  '--kara-ground': '#1b1116',
  '--kara-surface': '#24171d',
  '--kara-raised': '#2c1b22',
  '--kara-border': '#3b2a30',
  '--kara-border-strong': '#4b343b',
  '--kara-text': '#f7efe6',
  '--kara-muted': '#c3b0a6',
  '--kara-faint': '#9a877e',
  '--kara-accent': '#e8b86d',
  '--kara-accent-ink': '#21140b',
  '--kara-danger': '#e58b8b',
  '--kara-danger-tint': 'rgba(229, 139, 139, 0.16)',
  '--kara-accent-tint': 'rgba(232, 184, 109, 0.18)',
  '--kara-track': '#3a2730',
  '--kara-control': '32px',
  '--kara-radius': '8px',
  '--kara-panel-radius': '12px',
} as const;

export type TokenName = keyof typeof TOKEN_VALUES;

/** A single value by name, for canvases and other non-CSS consumers. */
export const token = (name: TokenName): string => TOKEN_VALUES[name];

/** The declarations as CSS text. */
export const PALETTE = Object.entries(TOKEN_VALUES)
  .map(([name, value]) => `  ${name}: ${value};`)
  .join('\n');

/** Practice-only colours: the score bands, which nothing else uses. */
export const PRACTICE_TOKENS = [
  '  --kara-perfect: #7bd88f;',
  '  --kara-good: #e8b86d;',
  '  --kara-off: #e58b8b;',
  '  --kara-ink: #21140b;',
  '  --kara-note-radius: 8px;',
].join('\n');

/** Declarations that belong to the panel's host element and to nothing else. */
export const PANEL_HOST_CHROME = `
  transition: opacity 160ms ease;
  color: var(--kara-text);
  font: 500 13px/1.4 "Avenir Next", "Segoe UI", system-ui, sans-serif;`;

/** The shadow root's `:host` rule: palette plus the panel's own chrome. */
export const panelTokens = `:host {${PALETTE}${PANEL_HOST_CHROME}}`;

/** The popup's `:root` rule: the same palette, without shadow-root chrome. */
export const popupTokens = `:root {
  color-scheme: dark;${PALETTE}}`;
