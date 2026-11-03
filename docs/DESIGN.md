# Kara design

Status: M0. This describes the system we are building, and marks what is decided versus what M1
has to answer. Keep it current; keep it short.

## What it is

A static website. You hand it a music file you own, it separates the vocal from the backing track,
lines lyrics up with the audio, and plays a KTV room: instrumental with a vocal switch, wiping
lyrics, key and tempo controls, a queue, phones as remotes, a microphone with scoring. Your library
lives on your own disk. You can hand a friend a recipe so they get the same room from their own copy
of the song.

Non-goals: acquiring music, hosting music, a catalogue, accounts, any server that sees audio.

## Legal boundary, and where the code enforces it

| Rule | Enforcement |
| --- | --- |
| Upload only, no fetching of media | No network code reads media; `connect-src 'self'` in `apps/web/public/_headers`, pinned by a test |
| Audio never leaves the device | Same CSP; the relay refuses request bodies (`workers/relay/src/index.ts`), covered by tests |
| No copyrighted material in the repo | `scripts/check-no-media.mjs` fails CI on tracked audio, video, weights or any file over 2 MiB; `.gitignore` lists the same extensions |
| Fixtures are synthesised | ffmpeg writes tones and noise into `fixtures/generated/`, which stays untracked |
| Exports carry no audio | Recipe schema below has no audio field; lyric text is opt-in |
| Lyrics come from the user | Transcription and video OCR run locally; there is no lyric-site client |

Weight licences are checked per model before a model is used, and recorded here when chosen.

## Architecture

```
file picker ─▶ decode (WebCodecs, AudioContext fallback)
                 │
                 ├─▶ fingerprint (WASM)                      ─▶ IndexedDB
                 ├─▶ separation worker (ONNX Runtime Web)     ─▶ stems in OPFS
                 └─▶ transcription worker (ONNX Runtime Web)  ─▶ lyrics in IndexedDB
                                                                  │
player: AudioWorklet graph (stem gains, key, tempo) ◀─────────────┘
                 │
room: WebRTC data channels ◀─▶ relay Worker (signalling only) ◀─▶ phones
```

- **Hosting.** Cloudflare Pages, static. Cross-origin isolation via COOP/COEP so SharedArrayBuffer
  is available to the WASM runtimes. Dev and preview servers read the same `_headers` file, so they
  cannot drift from production.
- **Inference.** ONNX Runtime Web, WebGPU first with a WASM fallback, always in a Web Worker.
  Separation from the Demucs family, or a smaller model if that is the only thing that fits.
  Transcription and alignment from the Whisper family. A video that already has the words in its
  picture is read with tesseract.js instead, which is cheaper and more accurate than transcribing
  the singing; see `docs/lyrics-ocr.md`.
- **DSP.** WASM and AudioWorklet: key shift that preserves tempo, tempo change that preserves key,
  fingerprinting. The vocal switch is a gain change on an already-loaded stem, so it is gapless by
  construction rather than by reloading anything.
- **Weights.** Fetched on first use, cached in OPFS, never committed. Hosting is an open question:
  the Pages per-file limit will probably rule out shipping them with the site, so expect R2 behind
  the same custom domain to keep `connect-src 'self'` true.
- **Relay.** One small Worker for WebRTC signalling and room codes. Signalling arrives as a
  WebSocket upgrade, which has no request body, so the relay rejects every body it is handed. Only
  microphone audio and control messages ever cross the network, peer to peer.

### Memory, on an 8 GB M1

Four minutes of stereo float32 at 44.1 kHz is about 85 MB per stem. Holding a decoded song plus
several stems plus a model would blow the budget, so:

- process in overlapping windows (target 10-30 s, 1-2 s overlap) and stream each window's output
  straight to OPFS;
- never keep more than one window of each stem in RAM;
- hold one model in memory at a time, and release it when its stage ends;
- playback reads stems from OPFS through a streaming source, not a decoded buffer.

Jobs are resumable: progress is recorded per window, so closing the tab loses one window at most.

## Data model

Metadata in IndexedDB, bytes in OPFS. Nothing is stored in both.

IndexedDB database `kara`, version 2:

| Store | Key | Holds |
| --- | --- | --- |
| `songs` | `songId` | title, artist, duration, sample rate, channels, source kind (audio or video), source file name and size, fingerprint, timestamps, and one optional set of lyric lines |
| `stems` | `[songId, kind]` | kind (`vocals`, `accompaniment`), OPFS path, codec, window size used |
| `lyrics` | `[songId, lyricsId]` | source (`pasted`, `transcribed`), language, script, lines, unit timings, romanisation |

Version 2 put the first lyrics on the song record itself: one set, read off a kept video, as
`{ lines: [{ startMs, endMs, text }], source: 'video-ocr', readAt }`. See `docs/lyrics-ocr.md`. The
`lyrics` store above is still ahead of us, for when a song can have several sets in several scripts.
| `settings` | `songId` | key semitones, tempo ratio, guide-vocal gain, count-in beats, lyric offset |
| `jobs` | `jobId` | songId, stage, state, windows done, total, error |
| `scores` | `scoreId` | songId, singer name, score, timestamp |

OPFS layout:

```
/songs/<songId>/source.<ext>
/songs/<songId>/stems/vocals.<ext>
/songs/<songId>/stems/accompaniment.<ext>
/models/<modelId>/<file>
```

Stem encoding is an M1 question: WebCodecs Opus if it is available and fast enough, otherwise raw
WAV, which costs disk but no CPU.

## Recipe format

A recipe is what you hand a friend. It is JSON, it carries no audio, and lyric text is absent
unless the person exporting ticks the box.

```json
{
  "format": "kara-recipe",
  "version": 1,
  "exportedAt": "2026-11-03T12:00:00Z",
  "song": {
    "title": "...",
    "artist": "...",
    "durationMs": 214300,
    "fingerprint": {
      "algorithm": "chroma-landmark/1",
      "sampleRate": 11025,
      "hopSize": 256,
      "payload": "<base64>"
    }
  },
  "sync": { "offsetMs": -120, "driftPpm": 42 },
  "timings": {
    "lines": [
      {
        "startMs": 10240,
        "endMs": 14880,
        "units": [{ "startMs": 10240, "endMs": 10620, "span": [0, 2] }]
      }
    ]
  },
  "settings": {
    "keySemitones": -2,
    "tempoRatio": 1.0,
    "guideVocalGain": 0.25,
    "countInBeats": 4
  },
  "lyrics": null
}
```

- `version` is an integer. An importer refuses a version it does not know.
- `span` is a `[start, end)` character range into the line's text, which gives word timing for
  Latin scripts and per-character timing for Han, Kana and Hangul without a second shape.
- `lyrics` is `null` by default. Including it means
  `{ "included": true, "language": "yue", "script": "han", "lines": ["..."] }` and the export UI
  labels it as sharing lyric text.
- Import matches the friend's own file by fingerprint, estimates `offsetMs` and `driftPpm` against
  their master, applies both, and warns when the match is weak rather than silently misaligning.
- Without lyric text, timings attach to the friend's local transcription or pasted lyrics by unit
  position. When the unit count differs, the importer says so instead of guessing; line timings
  still apply.
- A library pack is the same schema under `{ "format": "kara-library", "version": 1, "recipes": [...] }`.

## Repository layout

```
apps/web                  static site (Vite, React, TypeScript strict)
  public/_headers          COOP/COEP and CSP, read by vite.config.ts and by a test
  src/security-headers.ts  parser shared by config and test
workers/relay             signalling Worker, deployed with pnpm dlx wrangler
scripts                   repo guards, plain Node ESM, typechecked with checkJs
.githooks/commit-msg      rejects tool attribution before a message is written
docs/DESIGN.md            this file
docs/lyrics-ocr.md        reading lyrics off a video, and where its model data comes from
```

## Quality gates

`pnpm run verify` runs what CI runs: ESLint, `tsc --noEmit` per package, Vitest, the production
build, the attribution guard and the media guard. CI runs it as two jobs on every pull request and
on pushes to `main`; the guard job scans the whole pull request range.

## Milestones

| | |
| --- | --- |
| M0 | foundation: workspace, lint, typecheck, tests, CI, this doc |
| M1 | feasibility spike: separation and transcription on an 8 GB M1, WebGPU versus WASM, memory peaks |
| M2 | ingest and library: drop in audio or video, separation, resumable jobs with progress and ETA |
| M3 | lyrics: read off a lyric video, transcription, paste-to-align, line and unit timing editor, romanisation |
| M4 | player: wiping lyrics, vocal switch, guide-vocal fader, key, tempo, count-in |
| M5 | room: queue, cut and push to top, singer names, phones as remotes over WebRTC |
| M6 | microphone: echo and reverb, Bluetooth latency warning, pitch bar, score, local leaderboard |
| M7 | sharing: recipe export and import, fingerprint match, offset and drift correction |
| M8 | online rooms: clock-synced playback of each person's own copy, shared queue, voice call |

## Open questions for M1

1. Which separation model fits in the budget, and at what quality and speed?
2. WebGPU on an M1 8 GB: available, stable, and faster than WASM with threads?
3. Where do weights live, given the Pages per-file limit, without loosening `connect-src 'self'`?
4. Opus via WebCodecs for stems, or WAV?
5. Which fingerprint survives different masters of the same song well enough to correct drift?
6. Cantonese transcription quality, and how much the pasted-lyrics path has to carry.
