# Contributing

This is a solo repository, but the history is kept as if it were a team one: every change has a
branch, a green verification, and a squash merge into `main`.

## The loop

1. **Branch from `main`.** Use `feat/…`, `fix/…`, `chore/…`, or `refactor/…`. Never commit
   directly to `main`.
2. **Make the change.** Keep it surgical. Match the surrounding style. Add a test when the change
   has behaviour worth holding.
3. **Verify before committing.**
   - Web and extension: `pnpm verify` (lint, typecheck, tests, build, repo guards).
   - Duet helper: `cd tools/duet-helper && python -m ruff check kara_duet tests && python -m pytest`.
4. **Commit with a conventional message.** Say what changed, not which tools helped. The
   `commit-msg` hook and the `guards` CI job reject tool attribution.
5. **Squash merge into `main`.**
   ```sh
   git switch main
   git pull --ff-only origin main
   git merge --squash feat/your-change
   git commit
   git push origin main
   ```
6. **Delete the branch**, local and remote. Finish on `main` with a clean tree.

## CI

`.github/workflows/ci.yml` runs four jobs:

- `verify` — `pnpm verify` for the web app and extension.
- `guards` — no media or model weights in the index; no tool attribution.
- `helper` — `ruff` and `pytest` for `tools/duet-helper`.
- `package-extension` — on `main` or manual dispatch, fetches the htdemucs weights, builds the
  unpacked extension, zips it, and uploads the `kara-extension` artifact.

The packaged artifact is the one to load in `chrome://extensions`; the plain `find` build omits the
weights and cannot separate anything.

## Duet helper

The helper is native Python and is not installed by `pnpm install`. See
[tools/duet-helper/README.md](tools/duet-helper/README.md). Its unit tests do not download UNMIXX,
torch, or the ECAPA model.

## House rules

- Audio, video and model weights never enter the index.
- The relay never accepts request bodies.
- The duet helper binds to loopback only and requires its token.
- `main` is always green and is the branch left checked out.
