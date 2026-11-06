# YouTube queue reading and next-song preload: feasibility

**Status:** research only. No extension source or UI was changed. The only file
this branch adds is this report.

**Measured:** 2026-11-06, Chrome 156.0.8078.80 (headless) on macOS, YouTube web
client `2.20261030.02.00`, logged out, region `SG`. The live checks used public
playlists and videos over Chrome DevTools Protocol; the repo was read at
`137930d`.

**Labels used below:**

- **Measured** — observed on the live page or read from the repo's current code.
- **Derived** — arithmetic from a measured constant or a code path.
- **Inferred** — plausible but not exercised here.

## Verdict

| Question | Verdict | Why |
| --- | --- | --- |
| Read the current queue / order | **Go** | `watchNextResponse` from the already-intercepted `/get_watch` payload carries the ordered `playlistPanelVideoRenderer` list and `currentIndex`; `movie_player.getPlaylist()`/`getPlaylistIndex()` are a live fallback. |
| Resolve the next stream before the current ends | **Go** | The existing MAIN-world `visionosStream(videoId)` resolves any video ID in about 100 ms in the test; no new permission, no gesture. |
| Full pre-separation of the next song | **No-go in the current architecture** | Navigation closes the offscreen document and destroys all in-memory work; a second full stem set doubles memory; one worker/model cannot separate two songs concurrently. |
| Smallest safe user-facing improvement | **Go: queue + next stream resolution** | One small MAIN-world change; no new protocol, permission, offscreen or model work. It makes the next stream ready, not the next stems. |
| If "next song is ready" is a hard requirement | **Conditional go: one-slot OPFS pre-separation** | Medium project. Reuses the loaded model after the current separation, writes stems to disk, and adds a fast path that loads them without the model. Not surgical. |

## 1. Reading YouTube's current queue

### 1.1 What is actually available

The watch page exposes three different things that are easy to confuse:

1. **The queue / playlist panel.** This is the ordered list YouTube will play
   next, either a real playlist or the rolling radio/mix list. On first load it
   is under `ytInitialData.contents.twoColumnWatchNextResults.playlist.playlist`;
   the live copy arrives in `/get_watch` (see 1.2).
2. **The autoplay next video.** A normal watch page with no playlist has no
   ordered queue; it has one `autoplayVideo` under
   `...twoColumnWatchNextResults.autoplay.autoplay.sets[0]`.
3. **The sidebar recommendations.** These are under `secondaryResults`. They
   are not the queue. Measured on `dQw4w9WgXcQ`: the first sidebar video was
   `ip9VJIWP1DA`, while the autoplay next was `UMANMEfZtYA` (and had changed
   from an earlier run). Do not preload from the sidebar's first item.

### 1.2 The live source that already passes through the extension

`/youtubei/v1/get_watch` — which `src/stream/stream-info.ts` already
intercepts for the player response — returns an array of two envelopes.
Measured response on a playlist SPA transition:

```text
[0] { responseContext, playerResponse, responseType, subStreamResponseCompleted }
[1] { responseContext, watchNextResponse, responseType, subStreamResponseCompleted }
```

The queue is at:

```text
[1].watchNextResponse.contents.twoColumnWatchNextResults.playlist.playlist
  contents[]           ordered; each entry has playlistPanelVideoRenderer
  currentIndex         the playing item
  isInfinite            true for radio/mix, false for a normal playlist
  playlistId
```

Each `playlistPanelVideoRenderer` measured:

```text
videoId
title.simpleText | title.runs[0].text
selected
lengthText.simpleText
navigationEndpoint.watchEndpoint.index
navigationEndpoint.watchEndpoint.playlistId
```

The autoplay next for a page with no queue is:

```text
[1].watchNextResponse.contents.twoColumnWatchNextResults
  .autoplay.autoplay.sets[0].autoplayVideo.watchEndpoint.videoId
```

Measured queue sizes and behaviour:

- Playlist `PLEvFeuJghFyNZ6aOrLGsBrVomoTiFRRfr` with 89 videos:
  89 items, `currentIndex: 0`, `isInfinite: false`. After clicking next,
  `currentIndex: 1` and the same 89 items.
- Radio `RDRQC7JL4a6fc` (`start_radio=1`): 25 items, `currentIndex: 0`,
  `isInfinite: true`. After next, the live watch-next queue had 26 items and
  `currentIndex: 1` — the rolling window grows as it advances.
- Plain video `dQw4w9WgXcQ`: no playlist panel, `movie_player.getPlaylist()`
  returned `null`, `getPlaylistIndex()` returned `-1`, and only the one
  `autoplayVideo` was available.

The full `/get_watch` body measured 1,064,172 bytes and contained both the
player response and 90 `playlistPanelVideoRenderer` occurrences (89 entries
plus the key). The extension already `JSON.parse`s this body in
`stream-info.ts`'s `consider()` for the player response, so extracting the
queue adds no second parse and no second network request.

### 1.3 The player API

In the MAIN world, `document.getElementById('movie_player')` exposes (measured
by property enumeration and calls):

```text
getPlaylist()        ordered video IDs, or null when there is no queue
getPlaylistIndex()   current index, or -1
getPlaylistId()      playlist/radio ID
getVideoData()       current video ID, title, author, ...
getWatchNextResponse()  the live watch-next object
getCurrentPlaylistSequence()  { sequence, elapsed }
```

Measured on the 89-item playlist: `getPlaylist()` returned the first ten IDs
in order and `getPlaylistIndex()` moved 0 → 1 after next. On the radio page it
returned 25 IDs. On the plain video it returned `null`.

`getPlaylist()` and `getPlaylistIndex()` are documented YouTube IFrame Player
API methods, which makes them the most stable of the options. `getPlaylistId()`,
`getVideoData()`, `getWatchNextResponse()` and `getCurrentPlaylistSequence()`
are internal methods that happened to exist; they are not part of the
documented API. All of these are reached through the page's internal
`movie_player` object rather than the iframe API, so even the documented pair
is not a formal extension contract.

**Important:** these methods live on the page's JS object. A content script in
the isolated world sees the same DOM element but not the page's expando
methods. Queue reading must happen in the MAIN world (`stream-info.ts`) or be
relayed from it; `content/youtube.ts` cannot read it.

### 1.4 `ytInitialData` is a seed, not live state

`ytInitialData` has the same playlist shape on first load, but it is not
updated by YouTube's SPA navigation. Measured after clicking next on the
playlist:

| Value | Before | After | New page's actual state |
| --- | --- | --- | --- |
| `location.href` | video A | video B | video B |
| `getVideoData().video_id` | A | B | B |
| `getPlaylistIndex()` | 0 | 1 | 1 |
| `getWatchNextResponse()` currentIndex | 0 | 1 | 1 |
| DOM selected item | A | B | B |
| `ytInitialPlayerResponse.videoDetails.videoId` | A | **A (stale)** | B |
| `ytInitialData...playlist.currentIndex` | 0 | **0 (stale)** | 1 |

The same staleness was reproduced on the radio page. `ytInitialData` is about
1,001 KB on the 89-item page, and its queue JSON is about 516 KB; parsing it
once as a seed is fine, but it must not be the live source.

### 1.5 DOM

Measured on the playlist page: `#playlist` and `ytd-playlist-panel-renderer`
exist; 89 `ytd-playlist-panel-video-renderer` elements, each with an
`a#wc-endpoint` href and a `selected` attribute; the selected item followed
the SPA navigation correctly. On a plain video `#playlist` still exists but
has zero items.

The DOM is consistent today, but it is the least stable option and the current
code deliberately keeps YouTube selectors in one small file
(`content/youtube.ts`) and out of the audio path. Queue reading should not add
DOM selectors; the data is already in a payload the MAIN world intercepts.

### 1.6 Recommended queue read path

1. **Primary:** `watchNextResponse` from the intercepted `/get_watch` payload.
   Extract only `videoId`, `title`, `currentIndex`, `isInfinite`; do not retain
   the 1 MB object.
2. **Fallback:** in the MAIN world, `movie_player.getWatchNextResponse()` and
   `getPlaylist()/getPlaylistIndex()` if the payload was missed or the queue
   was edited without a new `/get_watch`.
3. **Seed only:** `ytInitialData...playlist.playlist` on first load.
4. **Null:** no queue and no autoplay next. Fail closed; never guess from the
   sidebar.

A queue edit (add/remove/reorder) may not produce a new `/get_watch`. A slow
read of `getPlaylist()`/`getPlaylistIndex()` — for example, on a few-second
timer or when the next stream is about to be resolved — catches it. A stale
preload is harmless: the stream is filed under its own video ID and is only
used if the address bar later names that video.

A pure extractor is enough. The shape of the function the tests would hold:

```ts
// src/stream/queue.ts — sketch, not implemented here
function nextFromWatchNext(payload: unknown): NextVideo | null {
  for (const envelope of Array.isArray(payload) ? payload : [payload]) {
    const nav =
      envelope?.watchNextResponse?.contents?.twoColumnWatchNextResults ??
      envelope?.contents?.twoColumnWatchNextResults;
    const list = nav?.playlist?.playlist;
    if (list !== undefined && Array.isArray(list.contents)) {
      const index = Number.isInteger(list.currentIndex)
        ? list.currentIndex
        : list.contents.findIndex((item) => item?.playlistPanelVideoRenderer?.selected === true);
      const next = list.contents[index + 1]?.playlistPanelVideoRenderer;
      if (isVideoId(next?.videoId)) {
        return { videoId: next.videoId, title: titleOf(next), source: 'playlist', ... };
      }
    }
    const autoplay = nav?.autoplay?.autoplay?.sets?.[0]?.autoplayVideo;
    if (isVideoId(autoplay?.watchEndpoint?.videoId)) {
      return { videoId: autoplay.watchEndpoint.videoId, source: 'autoplay', ... };
    }
  }
  return null;
}
```

A prototype against the captured `/get_watch` fixture returned the correct next
ID:

```text
captured get_watch: { videoId: 'tdd0e9WG63c', title: 'Alex Warren - Ordinary (Lyrics)', source: 'playlist', currentIndex: 1, queueLength: 89, isInfinite: false }
malformed: null null null
last item playlist: { videoId: 'CCCCCCCCCCC', source: 'autoplay' }   // falls back to autoplay
```

### 1.7 Stability

- `playlistPanelVideoRenderer` is an internal YouTube renderer. YouTube already
  uses `lockupViewModel` on other surfaces (the sidebar recommendations in the
  measured page), so a future queue-panel migration is plausible. If it
  happens, the extractor returns `null` and the fallback still works; nothing
  breaks.
- `watchNextResponse` is an internal envelope key. It is a sibling of
  `playerResponse` in the same `get_watch` response the extension already
  depends on, so it adds no new endpoint dependency — only a new shape
  dependency.
- `getPlaylist`/`getPlaylistIndex` are the documented player API and the safest
  fallback, but only the IDs, not titles or `isInfinite`.
- `getWatchNextResponse()` is undocumented and could disappear; it is a
  fallback, not the primary.
- DOM selectors are the least stable and are not recommended.
- **Inferred:** the logged-in "Add to queue" panel uses the same
  `playlistPanelVideoRenderer` shape. It was not exercised because the test
  browser was logged out; the data model is the same playlist panel, but this
  is the one queue path that is not measured here.

## 2. Resolving the next video's audio stream

### 2.1 The existing bridge can do it

`src/stream/stream-info.ts` already has `visionosStream(videoId)`, a MAIN-world
same-origin POST to `/youtubei/v1/player` using the page's `ytcfg`, cookies
and visitor data, asking as the VISIONOS client. It is currently called only
for videos whose player responses the page itself produced. It takes any
video ID; the queue supplies the next one.

The page's own player response for the current video is not enough: measured
on the playlist page it was SABR-shaped — 24 adaptive formats, zero `url`
fields, one muxed format with `signatureCipher`, and a
`serverAbrStreamingUrl`. The queue entries carry no `streamingData` at all, and
the page does not request the next video's player response until the
transition. So proactive VISIONOS is required; there is no ordinary player
response to read ahead of time.

`movie_player.preloadVideoById(...)` exists, but it is undocumented, returned
`undefined`, and does not expose a stream URL in the test. It is not useful for
separation.

### 2.2 Measured

From a page playing `Gl5wGd7Dyts`, resolving the next playlist item
`UHAcPMJve04`:

- HTTP 200 in **102 ms**; `playabilityStatus.status: "OK"`.
- 5 audio-only formats with direct URLs.
- `expiresInSeconds: "21540"` (about 5.98 hours).

Resolving a later queue item `tdd0e9WG63c`:

- HTTP 200 in **107 ms**; best audio
  `audio/webm; codecs="opus"`, bitrate 156,100, `contentLength` 2,984,373
  (about 2.85 MiB), `expiresInSeconds: "21540"`.
- A ranged GET of `bytes=0-65535` on that URL returned **HTTP 206**,
  `content-type: audio/webm`, 65,536 bytes.

This proves both the metadata and the bytes are available while another song
is playing.

### 2.3 Permission and timing constraints

- **No new permission.** The player request is made from the page's own origin
  with the page's cookies; the audio fetch from `*.googlevideo.com` is already
  covered by `host_permissions` in `src/manifest.ts`. No user gesture.
- **The MAIN world is mandatory.** YouTube refuses a player request carrying an
  extension origin; a content script cannot make this request. The existing
  MAIN-world script is the right place.
- **`ytcfg` must exist.** `waitForConfig()` polls for up to 8 seconds and then
  gives up. A page without it cannot resolve the next stream.
- **VISIONOS can stop answering.** It is an experiment, not a contract. If it
  returns no playable response or no direct URL, the next stream is simply not
  preloaded; the current song is unaffected.
- **The next video may be unplayable.** Live, age-restricted, members-only or
  region-blocked videos return a non-OK status or no direct URL. `pickStream`
  already refuses live streams. This should be a quiet "no preload", not an
  error in the current session. A playlist may also skip an unavailable item,
  so the adjacent queue entry is a candidate, not a promise; the VISIONOS
  playability check is the guard. Preloading the item after it would be a
  separate policy decision.
- **URLs expire.** Measured about 6 hours. Resolving minutes before the next
  song is safe; resolving the whole queue hours in advance is not. Keep only
  the immediate next item, and re-resolve if the stored answer is old.
- **One request per next ID.** Do not resolve the entire queue; it is
  wasteful and increases the chance of YouTube treating the traffic as
  anomalous.
- **The page can spoof `postMessage`.** The current stream path already treats
  the page as untrusted and validates the shape in `content.ts` and again in
  `background.ts`. For the queue path, validate the 11-character video ID and
  only resolve a stream — do not automatically download bytes — so a spoofed
  message can at worst pollute `chrome.storage.session` with a small URL.

### 2.4 The smallest bridge change

`stream-info.ts`'s `post()` records `last`, which `repost()` sends when the
content script asks for the stream at `document_idle`. If a next stream were
posted through `post()`, `repost()` would send the wrong video as the current
one. Add a separate `postNext(stream)` that:

- sends the existing `{ kara: 'kara/1', stream }` shape, so `content.ts` and
  `background.ts` need no new message type;
- does not update `last`, so `repost()` remains about the current video;
- marks the video ID as VISIONOS-sourced so a later SABR page response cannot
  overwrite it with a worse URL.

The content script already forwards any valid `stream` to
`request-stream`; the service worker already files it under
`kara.stream.<tabId>.<videoId>`. When the user starts karaoke on that video,
`asked()` looks up the address-bar video ID and finds it. **This is the whole
Phase 0 design: no protocol, background, offscreen or manifest change.**

## 3. What can be preloaded safely

### 3.1 The lifecycle blocker

The current implementation stops a session on any new video:

- `src/background.ts` `chrome.tabs.onUpdated` compares the tab's active video
  with the new URL and, for a different video, sends `stop` to the offscreen
  document and calls `stop()` (lines 384–406).
- `stop()` closes the offscreen document with
  `chrome.offscreen.closeDocument()` (lines 246–265).
- `src/offscreen.ts` serialises `start`/`stop`; `engine.stop()` terminates the
  separation worker, disconnects the player and pitch nodes, and closes the
  `AudioContext` (lines 1129–1160).

So any decoded audio, separated stems, or worklet buffers held in memory are
destroyed at the moment the next video starts. Preloading into memory ahead of
navigation is only useful if the session is deliberately kept alive and
handed over, or if the result is persisted outside the document.

### 3.2 One offscreen document

Chrome allows one offscreen document per extension. `ensureOffscreen()` in
`background.ts` checks `chrome.runtime.getContexts` and creates it only if it
is absent. A second engine cannot live in a second offscreen document. It
could live as a second worker/AudioContext inside the same document, but that
does not avoid the model and memory costs below.

### 3.3 Memory, measured/derived

The stem layout is eight Float32 channels (four stereo stems), at 44.1 kHz.

| Item | Formula | 4-minute song | 5-minute song |
| --- | --- | ---: | ---: |
| Eight stem channels | 8 × 4 B × 44,100/s | **323 MiB** (338.7 MB) | **404 MiB** |
| Decoded stereo track | 2 × 4 B × 44,100/s | 81 MiB | 101 MiB |
| Mono vocal copy (for Duet) | 4 B × 44,100/s | 40 MiB | 51 MiB |
| htdemucs weights on disk | measured from the model repo | **120.1 MiB** | 120.1 MiB |
| Runner Float32 scratch | derived from `SEGMENT_SAMPLES` etc. | roughly 100 MB | roughly 100 MB |

The repo's own `docs/extension.md` already quotes about 340 MB for a
four-minute song's stems. A second full song therefore adds roughly another
323 MiB of stems, plus 81 MiB if its decoded track is held, plus a possible
second 120 MiB model. Peak memory for two full songs is on the order of
**800 MiB to 1 GiB** before browser overhead. On a 4 GB machine this is not a
safe default; on 8 GB it is possible but heavy.

A second `createSegmentRunner` would also duplicate the model and its scratch
buffers: `segment-runner.ts` preallocates several `Float32Array`s of
`SEGMENT_SAMPLES` and `plane = bins × frames` (bins 2,048, frames 336 for the
7.8 s segment), about 100 MB per runner, in addition to the 120.1 MiB of
weights. Reusing the loaded runner is the only economical option.

### 3.4 CPU and GPU

- The model is htdemucs at a fixed 7.8 s segment (`SEGMENT_SAMPLES = 343,980`)
  with a 25% overlap and a 5.85 s hop. A four-minute song is about 41 windows.
- The repo's own measurements: about 2.3 s per window on a 3.4× real-time
  WebGPU machine; about 1.2× real-time on WASM. That is roughly 94 s for a
  four-minute song on WebGPU and roughly 200 s on WASM, plus model load.
- Running a second song **while the current one is still separating** would
  take GPU time from the current frontier and delay the current vocal toggle.
  That is the one thing that must not happen.
- Running it **after the current separation has finished** does not delay the
  current preparation. The current song is playing from stems already in the
  worklet; separation is audio-free. The remaining risk is CPU contention with
  the audio worklet on WASM/low-core machines and GPU contention if the user
  seeks or toggles while it runs. Gate full pre-separation on WebGPU and spare
  hardware; on WASM, prefer download-only or no preload.

### 3.5 The options

| Preload | Safe during current separation? | Safe after current separation? | Cost | Survives SPA navigation? | Verdict |
| --- | --- | --- | --- | --- | --- |
| Resolve next stream URL | Yes (network only, ~100 ms) | Yes | a few KB in `chrome.storage.session` | Yes, by video ID | **Go** |
| Download compressed audio | Network only; avoid competing with current download | Yes | 2–4 MB per song | No, offscreen closes; needs OPFS/keep-alive | Conditional, low value alone |
| Decode to PCM | No (CPU/alloc spike) | Yes | 81 MiB/4 min | No, unless persisted | Low value |
| Separate full next song in same worker | **No** (contends with current) | Yes | +323 MiB stems; model reused | No, unless handover/OPFS | Conditional |
| Separate into OPFS, release memory | No (contends) | Yes | 323 MiB on disk; low RAM | **Yes** | Best full path, medium project |
| Second worker/model | No | No | +120 MiB weights +100 MB scratch | No | **No-go** |

### 3.6 YouTube SPA navigation

YouTube swaps videos without a page reload. The content script is not
re-injected; `content.ts`'s `ensure()` re-mounts the panel on the same page.
The background stops the old session on the URL change. If the next video
auto-plays, there is a window where YouTube's own sound is playing and the
extension is idle; this is the current behaviour by design ("a different song
needs a different separation", `background.ts` comment).

A full pre-separation design must cross that boundary. There are two ways:

1. **Handover in the same offscreen document.** Do not close it on a
   navigation that matches the stored next video. Send a `handover` command
   with the new stream and pre-separated stems; reuse the same worker/model
   and `AudioContext`. Peak memory includes the old and new stem sets during
   the switch unless the old is released first.
2. **OPFS one-slot.** Persist the next song's stems to disk before navigation,
   let the old session stop normally, and have the new session load the
   completed/partial stems from disk without creating a model worker. This is
   the memory-safe option and does not require a handover, but adds a disk
   cache and a new engine fast path.

## 4. The smallest safe design

### 4.1 Phase 0 (recommended): queue + next stream, no separation

This is the only change that is both useful and surgical.

1. Add `src/stream/queue.ts` (pure):
   - `nextFromWatchNext(payload): NextVideo | null`
   - `nextFromPlaylist(ids, index): string | null`
   - `NextVideo` carries `videoId`, optional `title`, `source`
     (`'playlist' | 'autoplay'`), `currentIndex`, `queueLength`, `isInfinite`.
2. In `stream-info.ts`:
   - After the existing `playerResponses(payload)` loop in `considerPayload`,
     call `considerQueue(payload)`.
   - Keep `lastNextId`; when the next video changes, remember it and call
     `visionosStream(nextId)` once.
   - On success, `postNext(stream)` using the existing `stream` message shape
     and not touching `last`.
   - On the content script's initial handshake, read
     `movie_player.getPlaylist()/getPlaylistIndex()` or `getWatchNextResponse()`
     as a fallback and resolve the next ID if the payload was missed.
3. No changes to `protocol.ts`, `background.ts`, `offscreen.ts`, the worker,
   the worklet or the manifest. The existing `request-stream` path stores the
   next stream under its own video ID, and `asked()` finds it when the tab
   navigates.

What the user gets: when the next song starts and they press Start, the
stream URL is already known, so the download stage starts immediately instead
of waiting for the page to report it. It does **not** make the next stems
ready; separation still takes the normal minute or two.

Why it is safe: no model work, no large allocation, no change to the current
playback, no new permission, and no new network host. It does add one
`youtubei/v1/player` request per queue change, on the same YouTube origin the
page already uses; that is not a new service, but it is an extra request. The
optional audio prefetch would use the same `*.googlevideo.com` host as the
current song. If "no new network calls" is meant literally, even Phase 0's
resolve is out; queue reading alone is still possible and costs nothing.

### 4.2 Phase 1 (optional): warm start

- On a navigation from video A to the stored next video B, if A's session was
  running and the user had karaoke on, start B automatically instead of
  stopping and waiting for a click. This is a product decision; the current
  code deliberately does not do it.
- Optionally prefetch the compressed audio bytes (2–4 MB) after the current
  separation finishes. To survive navigation this requires either keeping the
  offscreen document alive across the handover or writing the bytes to OPFS.
  It saves the download stage only, not the model load or separation.

This is still not "next song is ready"; it is "next song starts preparing
sooner."

### 4.3 Phase 2 (conditional): full pre-separation

If the product requirement is genuinely "the next song is already separated,"
the safe architecture is **one-slot OPFS**, not two in-memory stem sets:

1. Wait until the current `handStems()` has completed (`status` moves to
   ready). Never pre-separate during the current preparation.
2. Resolve/download/decode the next stream. Reuse the existing worker and
   loaded model; `createStreamingSeparator` already supports `reset()` after
   `flush()` (tested in `apps/web/test/streaming.test.ts`). The worker needs a
   `begin`/`reset` command and a reset of its `samples`/`pushing` state.
3. As each block is finalised, write the eight channels to a one-slot OPFS
   file and release them. Do not keep a second full set in the offscreen heap
   or the worklet.
4. On navigation, leave the OPFS slot in place. The new session checks for a
   complete/partial slot for the new video ID and loads it into the worklet
   using the existing `stems`/`begin` + `stem-block` commands, skipping the
   fetch, decode, model load and separation for the completed prefix.
5. If the slot is partial, play the prefix and either continue separating with
   a newly loaded model (losing the model-reuse benefit) or let the video's
   own sound carry the rest. Record the frontier exactly as today's status
   report does.
6. One slot only; delete it when the song is finished/abandoned, on tab close,
   or when the next different video is queued. Verify video ID, duration,
   sample rate and channel count before use. Check
   `navigator.storage.estimate()` and fail to the normal path if quota is low.

This gives "nearly ready" across a navigation without doubling memory. It is
still a medium project: new persistence, a new engine fast path, quota/cleanup,
and a deliberate exception to the current "session-only, no disk cache" rule in
`docs/extension.md`.

### 4.4 Go / no-go

- **Go:** queue reading and next-stream resolution (Phase 0).
- **Go:** a "Next: …" label and a warm-start option, if the product wants
  them; they do not require pre-separation.
- **No-go:** full pre-separation in memory, a second engine/offscreen
  document, a second model, or separating the next song while the current one
  is still separating. The lifecycle, memory and contention costs are real.
- **Conditional go:** OPFS one-slot full pre-separation, if "ready" is a hard
  requirement and a medium project is acceptable.

## 5. Files, APIs, tests and prototype

### 5.1 Files and APIs

| File | Role in Phase 0 | Role in Phase 2 |
| --- | --- | --- |
| `apps/extension/src/stream/stream-info.ts` | Extract `watchNextResponse`; call `visionosStream(nextId)`; `postNext` without touching `last`; repost queue/next on handshake | Supply the next stream and queue metadata to the engine |
| `apps/extension/src/stream/player.ts` | Existing `isVideoId`, `pickStream`, `PlayerResponse`; no change required | Validate preloaded stream metadata |
| `apps/extension/src/stream/queue.ts` (new) | Pure queue extractor and `NextVideo` type | Same |
| `apps/extension/src/content.ts` | No change if reusing `request-stream`; add a `queue`/`next` branch only if the panel shows it | Forward handover/next commands if added |
| `apps/extension/src/protocol.ts` | No change for Phase 0 | Add next/preload/handover messages |
| `apps/extension/src/background.ts` | No change: `request-stream` files the next stream by video ID; `asked()` finds it | Navigation handover or OPFS slot lookup; expiry/cleanup |
| `apps/extension/src/offscreen.ts` | No change | Preload/fast-path commands; keep one document |
| `apps/extension/src/offscreen/engine.ts` | No change | Reuse worker/model, write/read OPFS, skip model on a complete slot |
| `apps/extension/src/separation/separator.worker.ts` + `messages.ts` | No change | `begin`/`reset` command for a second track; reset `samples`/`pushing` |
| `apps/extension/src/worklets/stem-player.worklet.ts` | No change | Load pre-separated stems; avoid allocating a second full bank on the audio thread |
| `apps/extension/src/content/youtube.ts` | **No queue selectors.** Keep the DOM file limited to the player/ad/autohide | Same |
| `apps/extension/src/manifest.ts` | No new permissions | No new permissions |
| `docs/extension.md` | Update only if Phase 0 ships | Document the preload cache and its cleanup |

The key API calls are:

```text
MAIN world:
  window.ytcfg.get('INNERTUBE_API_KEY')
  window.ytcfg.get('INNERTUBE_CONTEXT').client
  fetch('/youtubei/v1/player?key=…', { credentials: 'same-origin', … })
  document.getElementById('movie_player').getPlaylist()
  …getPlaylistIndex()
  …getWatchNextResponse()

Existing extension path:
  window.postMessage({ kara: 'kara/1', stream })       // content.ts
  { type: 'request-stream', stream }                  // content → background
  chrome.storage.session[kara.stream.<tabId>.<videoId>]
  { type: 'start', stream, tabId, key }               // background → offscreen
```

### 5.2 Tests that would prove it

**Pure unit tests** — add `apps/extension/test/queue.test.ts`:

- Playlist payload with `currentIndex` in the middle → the next ID.
- Playlist at the last item → fall back to `autoplayVideo`, or `null` if none.
- Radio payload with `isInfinite: true` → next item in the rolling window.
- Plain page with only `autoplayVideo` → that ID.
- No `watchNextResponse`, no `playlist`, malformed entries, wrong-shape video
  IDs → `null`, no throw.
- `selected: true` used when `currentIndex` is missing.
- A `watchNextResponse` envelope is not mistaken for a player response;
  `playerResponses()` behaviour is unchanged.
- The current page's `playerResponse` remains SABR-shaped and `pickStream`
  still returns `null`; the next stream must come from VISIONOS.

**Bridge tests** — in `apps/extension/test/player.test.ts` or a new test:

- `postNext` does not replace `last`; `repost()` still sends the current
  video.
- A next stream with a valid ID/URL is accepted; a spoofed/invalid one is
  rejected by the same shape checks as today.
- One resolve per next ID; a changed next ID resolves again; a failed resolve
  backs off rather than looping.

**Live/manual prototype** — Playwright is already a root dev dependency. A
non-CI script can:

1. Open a public playlist, e.g.
   `https://www.youtube.com/watch?v=Gl5wGd7Dyts&list=PLEvFeuJghFyNZ6aOrLGsBrVomoTiFRRfr`.
2. Evaluate the extractor in the page and assert the next ID equals
   `movie_player.getPlaylist()[getPlaylistIndex() + 1]`.
3. Click `.ytp-next-button`, wait for the new video, assert the extractor
   updates and `ytInitialData` still shows the old index (documenting the
   trap).
4. Resolve the new next ID as VISIONOS and assert a ranged `fetch` returns
   206 and an audio mime type.
5. Repeat on a radio URL and a plain video (autoplay only).

**Pre-separation prototype** — before writing extension code:

- Use `apps/web/test/streaming.test.ts`'s existing reset/reuse coverage to
  prove the same runner can separate a second track after `flush()`.
- Add a fake-runner test that feeds a full track, flushes, resets, feeds a
  second track and asserts the second block timeline starts at zero and tiles
  correctly.
- In the debug page (`apps/extension/test/page.html`), measure the second
  track's separation time and memory; the page already has the engine,
  fixtures, and `__karaDebug` hooks. A real OPFS/extension-offscreen run is a
  separate manual check because the debug page is a normal localhost page, not
  an extension origin.

### 5.3 Verification for this branch

This branch adds only this report; no extension source, UI or tests changed.
The repo's normal `pnpm verify` remains the gate if the report is turned into
code. The live measurements above are a snapshot of somebody else's service,
not a committed fixture.

## 6. Measured vs inferred

**Measured live on 2026-11-06:**

- `ytInitialData` and `/get_watch` playlist shapes, counts (89, 25), and
  `currentIndex`.
- `ytInitialData` and `ytInitialPlayerResponse` staleness after SPA next.
- `movie_player.getPlaylist()/getPlaylistIndex()/getPlaylistId()/
  getVideoData()/getWatchNextResponse()` behaviour.
- `get_watch` body is an array of two envelopes:
  `playerResponse` and `watchNextResponse`.
- VISIONOS next-video resolution in 102–107 ms, 5 audio URLs, 6-hour expiry.
- Ranged fetch of the next audio URL returns 206.
- Current page player response is SABR-shaped (no direct URLs).
- Playlist/radio DOM item counts and selected item updates.
- The sidebar's first recommendation is not the autoplay next.

**Derived from the repo:**

- 323 MiB of stems for a 4-minute song; 404 MiB for 5 minutes; 81 MiB decoded
  stereo; 40 MiB mono vocal.
- 120.1 MiB htdemucs weights and roughly 100 MB runner scratch.
- 41 windows for a 4-minute song; ~94 s WebGPU / ~200 s WASM at the repo's
  quoted rates.
- Navigation closes the offscreen document and destroys in-memory work.

**Inferred/untested:**

- The logged-in "Add to queue" panel uses the same
  `playlistPanelVideoRenderer` shape. Not exercised.
- OPFS is expected to work in an extension offscreen document (secure
  `chrome-extension://` context), but the extension does not use OPFS today;
  this needs a prototype.
- Exact glitch thresholds on low-core/WASM machines; the gate is a
  recommendation, not a measurement.
- Long-term stability of `watchNextResponse`, VISIONOS and the player API;
  all are somebody else's service and can change.
- The `preloadVideoById`/`queueNextVideo` internal methods returned `undefined`
  and had no observable effect logged out; they are not relied on.
- Not tested: a signed-in account, the "Add to queue" UI, autoplay switched
  off, Shorts, YouTube Music, or regions other than `SG`. The queue and
  VISIONOS behaviour can vary by account, region and experiment.

## 7. Bottom line

The queue and the next stream are both readable now, with no new permissions
and no new network service: the `/get_watch` response the extension already
parses contains the ordered queue, and the existing VISIONOS bridge can
resolve the next audio URL in about a tenth of a second. That is a **go** and
is small enough to ship as a single MAIN-world change.

Full next-song pre-separation is a different project. The current session is
deliberately destroyed on navigation, the model/worker is session-scoped, a
second full stem set costs another ~323 MiB for a four-minute song, and
separating two songs at once would slow the song the person is actually
listening to. The safe full-preparation path is a one-slot OPFS cache written
after the current separation finishes, with a fast path that loads completed
stems without the model. Until that exists, the honest fallback is: know the
next song, resolve its stream early, and start preparing it immediately when
it begins — not claim it is already ready.
