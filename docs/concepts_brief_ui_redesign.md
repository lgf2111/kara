# Kara front-end redesign — concepts brief

* **Author:** Jeff Lee
* **Date:** 2026-11-11

## Overview

Redesign the whole visible front end of the Kara Chrome extension: the in-page panel that
appears over the YouTube player (including the window above the play button), and the
toolbar popup that opens when the extension icon is clicked. The goal is a single, coherent
surface that covers every state the product can be in, built to the two design skills
(tasteskill 2.5 and Apple HIG) rather than a taste call, and shipped as the stable edition.

## Evidence found in the repo (verified, not assumed)

- **Two separate surfaces, 4,760 lines between them.** The in-page panel is
  `apps/extension/src/content/panel.ts` (2,203 lines, all CSS inline in the file, shadow
  root closed), its state model is `content/panel-view.ts` (372 lines), the practice overlay
  is `content/practice-overlay.ts` (734), the small analysis bar is `content/analysis-bar.ts`
  (108). The popup is `apps/extension/popup.html` (680 lines) driven by `src/popup.ts` (611)
  and `src/popup/popup-view.ts` (399).
- **The panel has six states**, defined in `panel-view.ts`: `off`, `preparing`, `ready`,
  `paused`, `unsupported`, `error`. The popup mirrors this plus three sub-states for duet
  (`duet.state`), practice (`practiceState`), and song analysis (`songAnalysisState`), each
  `off | analyzing | ready | error`.
- **The palette is one token block** (`panel.ts` lines 143-156): ground `#1b1116`, surface
  `#24171d`, raised `#2c1b22`, border `#3a2730`, border-strong `#4b343b`, text `#f7efe6`,
  muted `#c3b0a6`, faint `#9a877e`, accent `#e8b86d`, accent-ink `#21140b`, danger `#e58b8b`,
  track `#3a2730`. The user has already chosen to keep Ink & Gold.
- **Popup sections today:** header + state line + progress bar + primary action, key control,
  practice permission, score history, stem cache, duet helper, diagnostics (with tabs).
  In the **stable edition** (`--stable`), practice, scores and duet are removed at runtime; that
  leaves header, state, action, key, cache, diagnostics.
- **Panel rows today:** `Advanced` disclosure holding cache row, Backing (drums/bass/other),
  Song, Key, Practice+Duet, Mic & recording; stem rows each with level, M, S.
- **Constraints already in force:** closed shadow root (`attachShadow({mode:'closed'})`), no
  remote origins, CSP `script-src 'self' 'wasm-unsafe-eval'`, weights and all assets packed
  locally, no network fetches of any kind, keyboard reachable, `aria-label` on the panel and
  every icon-only control, `role="status" aria-live="polite"` on state text.

## Analysis

Seven reviewers ran against this brief; their findings are folded in below, and every number
they quote was recomputed here before being accepted.

### What the review changed

- **The signature element was missing, and it exists in the data already.** `PanelView` carries
  four stem levels and nothing draws them as a whole. The agreed mark: a four-lane level rail
  directly above the player's controls — vocals first in gold, the three backing stems
  half-weight — where each lane *is* the slider for that stem. It answers "what am I hearing"
  and "what can I change" with one object, and it is the only graphic a one-mixdown player
  could not draw.
- **"Coverage" is measured, not asserted.** The panel has six top-level states; the popup has
  six plus cache (4), diagnostics (3), duet (4), practice (4), song (3) and mic (4) sub-states.
  A state is "designed" only when it has copy, a primary action, focus order and a mapped node.
- **The anchoring question is answered.** The panel's **bottom-left anchors to the play button's
  top-left, offset -8 px vertically, width at most 400 px**. Centring on the play button pushes
  the panel past the player's left edge at narrow widths.

### Defects the review found in shipped code (verified here)

1. **Mode toggle gives three answers** (`panel.ts:1980-1982`): visible text names the mode that
   is playing, `aria-pressed` describes state, `aria-label`/`title` describe the action.
2. **The default is indistinguishable from a bug** (`stems.ts:75`, `DEFAULT_MUTED.vocals = true`,
   rendered as a 32 px button labelled `M`): karaoke starts with the guide muted at 100%, and the
   popup needs five conditional sentences (`popup-view.ts:171-189`) to explain one switch.
3. **Errors surface engine exceptions** (`engine.ts:336/351/375`): `the audio ended early (1234567
   of 8000000 bytes)` is what a person sees; the popup's fallback is literally `no reason given`
   (`popup-view.ts:395`). `unsupported` shows a reason but hides the only action (`panel.ts:1988`).
4. **The panel's status line is not announced**: `aria-live` is on the key readout and the record
   timer, not on the headline.
5. **Stable edition binds dead listeners** (`popup.ts`): `need()` resolves at 94-108, sections are
   removed at 113, listeners attach at 450-540 to detached nodes. No crash, silent waste.
6. **Two token sets, two radii, two title policies** (panel `:host` vs `popup.html`); closed
   shadow root means tokens must be shared at **build time**, not inherited.

### Numbers accepted after recomputation

Ink & Gold contrast: text 16.2:1, muted 8.86:1, faint 5.39:1 (4.77:1 on raised), accent 10.11:1,
accent-ink on accent 9.84:1, danger 7.38:1 — and the trap, `#f7efe6` on accent is **1.60:1**, so
nothing but accent ink goes inside a gold fill. Borders are 1.37:1 and 1.63:1 and can never carry
state: selection must be fill or accent, never border colour (WCAG 1.4.11).

### Structure the build has to respect

- `panel.ts` is 2,203 lines: an 884-line CSS string (139-1023), DOM builders, and a 230-line
  `update()` (1948-2178). The seam that must not move is the `root.activeElement` guard, repeated
  at seven sites, which stops a status report overwriting a control the user is dragging.
- `panel-view.ts` and `popup-view.ts` are already pure and stay untouched; they are the test
  surface for every state.
- `OPEN_DISCLOSURES` is module-level on purpose (survives remounts).
- Popup selectors are a contract with `popup.html`; ids and `popup.ts` change in one commit.

### Verifiability

The panel's shadow root is closed, so DOM assertions are impossible by design. Tests inject a
status report through the real channel, then read the **accessibility tree** via CDP and compare
screenshots at fixed viewports. Acceptance is a branch-to-test table with no gaps, plus hand
checks for auto-hide, keyboard scope and player fit that a headless browser cannot judge.

### Alternatives rejected during review

- **Radial dial for all four stems**: one control for everything, but radial dials are poor
  keyboard targets and need a hidden native range twin for assistive tech.
- **Diff-only panel**: shows only what changed in the last six seconds; a silent panel reads as
  broken and Start has no home.
- **Status-board ledger with no disclosure**: rows reorder rather than hide; needs a hard
  three-row budget and every row competes for 320 px.
- **Cut the popup entirely** (contrarian): correct on risk, wrong on brief — it ships second, on
  shared tokens, without redesigning its sub-states.
- **A component framework**: CSP forbids `unsafe-eval` and the bundle has no framework today.

### Staging agreed by the review

1. **Foundation, no behaviour change**: `src/ui/tokens.ts` as the single token source, the panel's
   CSS string extracted to `src/ui/panel.css` (inline import, CSP-safe), popup reading the same
   tokens. One grep for `#1b1116` must return one file.
2. **The three blockers**: mode control with one meaning, error copy (plain sentence, raw detail
   behind diagnostics), `unsupported` gets an action, vocal row says `Guide vocal: Off`.
3. **State coverage**: every state in the grid gets its copy, action, focus order and screenshot.
4. **Signature rail**, then the popup reflow on the same primitives.

Every stage lands as its own commit with the test that proves it.

## Provisional goals

1. One design system: tokens, type scale, spacing, radius, one button family, one icon
   language, shared by the panel and the popup so they read as one product.
2. Total state coverage: every state of every surface gets a designed layout — off,
   preparing (with determinate progress and a cancel), ready, paused, error (with the real
   message and a retry), unsupported (with the reason and what to do), plus empty/error
   states for cache and diagnostics.
3. The panel's default view answers three questions in three seconds: what is playing, is it
   separated yet, and what do I do next. Everything else sits behind one disclosure.
4. Accessibility: contrast computed, focus visible, 44px hit targets on touch widths, reduced
   motion respected, nothing conveyed by colour alone, headings in order.
5. The stable edition is the shape that ships: no duet, no practice. The full edition keeps
   them behind the same system.
6. No new permissions, no new host access, no network, and no change to the extension's
   behaviour — this is a redesign of what exists, not a new feature.

## Provisional non-goals

- New features (queue, playlists, sharing, lyrics editing).
- Touching the web app (`apps/web`), the duet helper, or the relay.
- Migrating the panel from a closed shadow root to open, or from inline CSS to a stylesheet
  fetched at runtime.
- Changing the separation pipeline, the audio path, or the duet protocol.
- A light-mode theme: the product sits over video; Ink & Gold on a dark ground stays.

## Alternatives weighed

- **Restyle inside `panel.ts`** (keep one file, rewrite the token block and the CSS): smallest
  diff, but 2,200 lines with design and logic interleaved will drift again.
- **Split presentation out** (a `panel/` folder: tokens.css, components, per-state views, with
  `panel.ts` keeping behaviour): bigger diff, and the panel view model already exists in
  `panel-view.ts` to build on — the honest structure.
- **Rebuild as HTML templates in shadow DOM** and keep the same view model: gains designer
  readability, costs a rewrite of every DOM builder call.
- **Rejected for now:** moving to Lit or a component framework, because the extension ships
  from a Vite bundle with no framework dependency today and the CSP would need `unsafe-eval`
  for some template engines.

## Key decisions so far

- Ink & Gold stays; the redesign re-derives its tokens rather than replacing the hue.
- The stable edition is the reference build: practice and duet must remain removable without
  the layout collapsing.
- Coverage is the acceptance test: a state that has no designed layout is a bug in the
  redesign, not an edge case.