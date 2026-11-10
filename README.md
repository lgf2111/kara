# Kara

_Kara_ as in "empty", as in karaoke. Upload a song or music video you own and get a KTV room:
the original, an instrumental, synced lyrics and a vocal switch. Build a library, share it with
a friend.

Everything runs on your machine. The web app and extension do their work in the browser; the
opt-in duet helper is a local loopback process. There is no remote server that sees your music.

## Where we stand

The web app has library ingest, htdemucs separation, a four-stem player, timed lyrics, a live key
change and a self-contained Pages deployment. The Chrome extension reads the audio of the video in
the tab, separates it locally and puts the same mixer over YouTube. **Duet (beta)** is an opt-in
second pass: a native local helper splits the vocal stem into two voices, with panel calibration
for the hard lines.

## The rules this project holds itself to

These are not preferences. They are enforced in code, in tests and in CI.

1. **The audio comes from what you are already playing, on your own machine.** The web app takes
   a file from your own device. The extension reads the audio of the video in the tab it is
   watching. Either way it is processed locally: nothing is uploaded anywhere, and nothing is
   redistributed.
2. **Your audio never leaves your device.** Decoding, separation, transcription and playback all
   happen in the browser. The opt-in duet helper is a loopback process on `127.0.0.1`; no audio is
   uploaded to a remote origin. The page may only talk to its own origin: `connect-src 'self'` in
   the Content-Security-Policy, with no code that uploads audio anywhere.
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

The opt-in duet helper is separate and needs Python 3.12; see
[tools/duet-helper/README.md](tools/duet-helper/README.md).

## Install the extension

The extension is not on a store. Every tagged release is a zip built by CI with
the separation weights inside it:

1. Download `kara-stable.zip` from [Releases](../../releases/latest).
2. Unzip it somewhere permanent — Chrome loads the extension from that folder.
3. `chrome://extensions` → Developer mode → **Load unpacked** → that folder.

The release build is the **stable edition**: karaoke only, no Duet helper and no
microphone practice scoring, and no loopback host permission. The duet features
are still in `main` and are built by `pnpm --filter @kara/extension build:unpacked`.

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
| `pnpm --filter @kara/extension build` | Unpacked extension shell; weights if `models/` is present |
| `pnpm --filter @kara/extension build:unpacked` | Extension with weights; fails if they are missing |
| `cd tools/duet-helper && python -m pytest` | Duet helper unit tests                    |
| `cd tools/duet-helper && python -m ruff check kara_duet tests` | Duet helper lint |
| `python tools/duet-helper/bridge.py` | Local duet bridge; see `tools/duet-helper/README.md` |

## Repository layout

```
apps/web          static site: the KTV app, all processing in the browser
apps/extension    Chrome extension: stream read, separation, mixer, duet UI
tools/duet-helper native UNMIXX + calibrated voice map + local bridge
workers/relay     Cloudflare Worker: WebRTC signalling and room codes only
scripts           repo guards, run locally and in CI
docs/DESIGN.md    architecture, data model, recipe format, legal rationale
docs/lyrics-ocr.md  reading lyrics off a video you own
docs/browser-support.md  what runs in which browser, and the Safari workarounds
docs/deploy.md    the Pages bundle and the extension artifact
.github/workflows CI: web/extension checks, guards, helper tests, packaged extension
.githooks         tracked git hooks
```

## Commits

Commits say what changed, not which tools were involved: no co-authorship trailers, no tool names,
in messages or in code. `pnpm run hooks:install` points `core.hooksPath` at `.githooks`, which
rejects such a message before it is written, and the `guards` job in CI checks the whole pull
request range.

Branch per change, conventional commits, never commit directly to `main`. Before merging, run
`pnpm verify` and the helper checks (`ruff` and `pytest` under `tools/duet-helper`). Squash merge
into `main`, push, delete the branch, and leave `main` green and checked out.

## Licence

The source is MIT; see [LICENSE](LICENSE). The weights and libraries that ship inside a release
package carry their own terms — mostly MIT, plus the non-commercial UNMIXX checkpoint that the
optional duet helper fetches and never redistributes. [NOTICE](NOTICE) lists them one by one.
