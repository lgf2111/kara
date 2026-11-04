# Browser support

Everything Kara does happens in the tab: decode, separation, OCR, playback. That makes the
browser the platform, and the browsers disagree in four places that matter. This is what each
one does, what Kara does about it, and where the code is.

## What runs where

| Browser                       | Plays songs | Keeps songs | Separation | Lyric OCR |
| ----------------------------- | ----------- | ----------- | ---------- | --------- |
| Chrome / Edge 111+            | yes         | yes         | yes        | yes       |
| Safari 17+ (macOS, iPadOS)    | yes         | yes         | yes        | yes       |
| Safari on iPhone              | yes         | yes         | no         | no        |
| Firefox 111+                  | yes         | yes         | no         | no        |

Separation and OCR need cross-origin isolation, `SharedArrayBuffer` and a few hundred megabytes
of working memory. The drawer says at the bottom whether this tab is isolated; when it is not,
separation refuses rather than failing halfway. Firefox has no `createSyncAccessHandle` pathway
problem but does not give the WASM runtime the threads the model needs, and an iPhone does not
have the memory.

Nothing in this table involves the network. No audio, no lyrics and no model output ever leaves
the device, in any browser.

## Writing to the filesystem: Safari has no `createWritable`

The origin private filesystem has two writers, and no browser has both in both scopes.

- `FileSystemFileHandle.createWritable()` is a stream. Safari does not offer it on origin private
  files at all.
- `FileSystemFileHandle.createSyncAccessHandle()` is the one Safari does offer, and it exists only
  inside a dedicated worker. Calling it on the page throws.

Writing inline worked in Chrome and failed in Safari, which is the bug the routing exists to
close. Every whole-file write now asks which writer the current scope actually has:

| Scope                        | Writer used                                  |
| ---------------------------- | -------------------------------------------- |
| Worker with a sync handle    | `createSyncAccessHandle` where it stands     |
| Worker with only a stream    | `createWritable`                             |
| Page with a stream           | `createWritable`                             |
| Page without one (Safari)    | posted to a writer worker, which uses a sync handle |
| Neither, anywhere            | refuses, and says so on screen               |

The decision is a pure function, `writeRouteFor` in
[`apps/web/src/storage/opfs-support.ts`](../apps/web/src/storage/opfs-support.ts), tested in
`apps/web/test/opfs-support.test.ts`. The probe that reads the real browser is beside it in
`opfs-abilities.ts`; the two mechanisms are in `opfs-write.ts`; the page's writer worker is
`opfs-writer.worker.ts`, and it takes the bytes as a `Blob`, which crosses by reference, so a
kept video never sits in two heaps at once.

Appends are different and deliberately not routed. A separation writes each stem segment by
segment and has to be resumable, so it needs every segment durable the moment it is written.
`createWritable` stages the whole stream in a swap file and commits only on close, which would
lose every byte since the stream opened if the tab were killed mid-job. So appends use a sync
access handle and `flush()`, and the separation worker is the only thing that appends. The handle
holds an exclusive lock, which is why a song being separated reads as 0 bytes in the drawer until
its job closes the files.

When nothing can write, the store throws a failure tagged `storage` and the room gets a notice
saying this browser cannot keep songs on the device. It is never silent.

## Starting playback: Safari will not autoplay

Safari refuses to start media nobody asked for, and the refusal arrives as a rejected promise
from `element.play()` with `NotAllowedError`. The `autoplay` attribute swallows that, leaving a
stage that looks like it is playing and is silent, so Kara calls `play()` itself and reads the
rejection:

- `NotAllowedError` puts a large play button in the middle of the stage and keeps the transport
  bar visible rather than letting it idle away. One press starts the song.
- `AbortError` is ignored: something paused it or changed the source, which is normal.
- Anything else becomes a notice with the browser's own reason in the detail line.

`readPlayRefusal` in [`apps/web/src/player/media-failure.ts`](../apps/web/src/player/media-failure.ts)
is the mapping; `PlayGate.tsx` is the button, and its wrapper takes no pointer events so the
controls underneath stay reachable.

## Codecs: Safari can open a video it cannot decode

Safari will accept an MP4 whose video track its chip has no decoder for — AV1 on Apple silicon
before the M3, for one — and then fail the element with `MEDIA_ERR_SRC_NOT_SUPPORTED`. The audio
track of the same file is usually fine.

So a video that fails with `unsupported` or `decode` **before anything has played** falls back to
playing the same file through an audio element, with the waveform stage instead of the picture,
and a short non-blocking notice saying the picture could not be shown. The same file, the same
object URL, no reload: only the element changes.

Two limits, both on purpose. A file that fails *after* a picture has played has a damaged track
somewhere in the middle, and restarting it as sound alone would lose the person their place, so
that is reported instead. And a song that is already sound alone has nothing to fall back to.

`videoRemedy` in `media-failure.ts` is that decision, tested in
`apps/web/test/media-failure.test.ts`. `MediaStage.tsx` holds the answer and remounts
`MediaSurface.tsx` when it changes, because the clock, the volume, the keyboard and the stems all
hang off the element and every one of them has to be bound to the new one.

Separation is unaffected by any of this: it decodes with an `OfflineAudioContext`, which only ever
touches the audio track.

## When something still goes wrong

Every failure in ingest, analysis, playback, lyric reading and storage comes out in one place: a
toast with a plain first line about what happened to the song, and the technical reason in a
detail line under it. The mapping is pure and tested
([`apps/web/src/notices/notices.ts`](../apps/web/src/notices/notices.ts),
`apps/web/test/notices.test.ts`); the toast that draws it is not. A failure that knows its own
area — a refused write, a refused decode — keeps it, so a filesystem that cannot write is never
reported as a bad file.

## Testing a browser by hand

There is no automated browser matrix. To check Safari after a change:

1. `pnpm run dev`, open the app in Safari, and drop in an audio file you own. It should play on the
   first press, appear in the drawer, and finish separating.
2. Reload. The song should play again from the copy kept with it, which proves the write went
   through the worker.
3. Drop in an AV1 MP4 on a pre-M3 Mac. It should fall back to the waveform stage with a notice
   rather than showing a black rectangle.
4. Delete the song. Storage in the drawer should drop back.
