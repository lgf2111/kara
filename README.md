# Kara

_Kara_ as in "empty", as in karaoke. Upload a song or music video you own and get a KTV room:
the original, an instrumental, synced lyrics and a vocal switch. Build a library, share it with
a friend.

Everything runs in your browser. There is no server that sees your music.

## Where we stand

M0: the foundation only. Workspace, strict TypeScript, lint, tests, CI and this design. No ingest,
no separation, no lyrics, no player yet. See [docs/DESIGN.md](docs/DESIGN.md) for the plan and
[the milestones](docs/DESIGN.md#milestones) for the order.

## The rules this project holds itself to

These are not preferences. They are enforced in code, in tests and in CI.

1. **Upload only.** You give Kara a file from your own device. There is no link import, no
   downloader, and no integration with YouTube or any streaming service. None will be added.
2. **Your audio never leaves your device.** Decoding, separation, transcription and playback all
   happen in the browser. The page may only talk to its own origin: `connect-src 'self'` in the
   Content-Security-Policy, with no code that uploads audio anywhere.
3. **No copyrighted material in this repository**, on the deployed site, or in the relay. Test
   fixtures are synthesised with ffmpeg, or carry a clear licence. A CI guard fails the build if
   audio, video or model weights are ever committed.
4. **Exports carry no audio.** What you share with a friend is a recipe: a fingerprint, timings and
   settings. Your friend plays their own copy of the song. Lyric text is excluded by default and
   including it is a labelled opt-in at export time.
5. **Lyrics come from you.** Paste them, read them off your own lyric video, or transcribe your own
   file locally. All three happen in the browser. No lyric site is ever scraped.
6. **The relay never touches media.** It exists for WebRTC signalling and room codes. It refuses
   request bodies outright, so there is nothing to upload to.

Kara helps you sing the music you already own. It is not a way to acquire music.

## Getting started

Requires Node 24 or newer and pnpm 12.

```sh
pnpm install
pnpm run hooks:install   # commit-msg hook, see below
pnpm run dev             # http://localhost:5173
```

## Commands

| Command                  | What it does                                               |
| ------------------------ | ---------------------------------------------------------- |
| `pnpm run dev`           | Vite dev server for `apps/web`                             |
| `pnpm run build`         | Production build of every package that has one             |
| `pnpm run lint`          | ESLint over the workspace                                  |
| `pnpm run typecheck`     | `tsc --noEmit` per package, including the Node scripts     |
| `pnpm run test`          | Vitest, once                                               |
| `pnpm run check:media`   | Fails if the index tracks media, weights or anything big    |
| `pnpm run check:attribution` | Fails if commits or files name the tools behind them    |
| `pnpm run verify`        | All of the above, in CI order                              |

## Repository layout

```
apps/web          static site: the KTV app, all processing in the browser
workers/relay     Cloudflare Worker: WebRTC signalling and room codes only
scripts           repo guards, run locally and in CI
docs/DESIGN.md    architecture, data model, recipe format, legal rationale
docs/lyrics-ocr.md  reading lyrics off a video you own
.githooks         tracked git hooks
```

## Commits

Commits say what changed, not which tools were involved: no co-authorship trailers, no tool names,
in messages or in code. `pnpm run hooks:install` points `core.hooksPath` at `.githooks`, which
rejects such a message before it is written, and the `guards` job in CI checks the whole pull
request range.

Branch per pull request, conventional commits, never commit to `main`.
