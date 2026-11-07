# Kara: rules for any coding agent

Kara is a browser-only KTV app (upload a song you own, get a player with vocal removal, key change and lyrics) plus a Chrome extension prototype in `apps/extension`. Specs: `docs/DESIGN.md`, `docs/extension.md`, `docs/deploy.md`. The website is on Cloudflare Pages (`kara-5v7.pages.dev`).

## Hard rules
- **Legal line.** The website is upload-only. The extension may only use the tab's own audio output through `chrome.tabCapture`: it must never fetch, download or extract media or streams, and never keep whole-song copies. No copyrighted media or lyrics in the repo, tests, fixtures, site or relay.
- **No AI attribution** in commits or PR text: no `Co-Authored-By`, no "Generated with". A commit hook and CI enforce it.
- **Done means `pnpm run verify` passes** (lint, typecheck, tests, build, attribution and media guards). Never weaken, skip or delete a check or a test to get green.
- Small PRs, squash-merged after green CI. Force-push is blocked: never rebase pushed work.
- Run browser tests **headless** (the owner uses the machine). Keep changes minimal and surgical (see `CLAUDE.md`).

## Setting up a new machine
```sh
pnpm install
node scripts/spike/models.mjs fetch htdemucs-web      # weights, gitignored (about 120 MB)
mkdir -p models/tessdata && curl -L -o models/tessdata/eng.traineddata \
  https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
pnpm run verify
pnpm --filter @kara/extension run build:unpacked      # then load apps/extension/dist unpacked in Chrome
```
Test fixtures are regenerated with `node scripts/spike/make-fixtures.mjs` (synthetic tones and a pattern video). Real songs for testing live in the gitignored `fixtures/local/` and must be supplied by the owner. Logins to redo: `gh auth login`, `wrangler login`, `opencode auth login`.

## Budget notes
The owner has limited AI usage. Prefer cheap models for routine work, keep briefs short and name exact files, and let the worker run `pnpm run verify` itself before handing back.
