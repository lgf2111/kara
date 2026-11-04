# The browser extension: live separation on a tab

A Chrome extension that takes the vocal out of a tab's audio while the tab is playing, on the
machine it is playing on, and plays the result back about sixteen seconds late. This file covers
the audio half, which is what exists. The picture half — delaying the video by the same amount so
the two line up — is step B and is not written yet.

## What it does

Press the toolbar button on a YouTube tab. The extension captures that tab's audio output with
`chrome.tabCapture`, separates it into vocal and instrumental with the same htdemucs model the web
app uses, and plays `instrumental + guide × vocals` back through its own output, delayed. Switching
to the original is a thirty millisecond crossfade on one gain. Seeking, pausing or changing the
playback rate throws the buffer away and primes again.

The mode and the guide level are commands the audio side already accepts; there is no control for
them yet, because the controls belong with the picture in step B. Until then it starts on the
instrumental with the guide at zero, and the toolbar button is a toggle.

Tab capture mutes the tab for the person, so the extension's output is the only thing they hear.
During the first sixteen seconds there is nothing to play, so there is silence — or the tab's own
audio, undelayed, if the passthrough option is turned on. It is off by default, because sixteen
seconds of undelayed audio followed by a jump into the delayed stream is worse than quiet.

## The one audio source

**The tab's own audio output, and nothing else.** There is no code path in this extension that
fetches media, resolves a stream URL, reads a YouTube endpoint or downloads anything. The audio
comes from `chrome.tabCapture.getMediaStreamId` and `getUserMedia({chromeMediaSource: 'tab'})`, is
separated inside an offscreen document, and is played back from there. It never leaves the device
and it is never written to disk.

This is worth setting beside the web app's first rule in the README, which says there is no
integration with YouTube or any streaming service and that none will be added. That rule is about
acquiring music: no link import, no downloader, nothing that turns a URL into a file. This
extension does none of those things. It reads what a tab is already playing to the speakers on the
machine it is playing on, separates it there, and plays it back; it keeps nothing, writes nothing
and sends nothing. Whether that distinction is one the project wants to hold is a decision for the
README rather than for this file.

The manifest says the same thing: `host_permissions` is `https://www.youtube.com/*`, the content
security policy names no remote origin, there are no `web_accessible_resources`, and everything
loaded at runtime — the model's twenty-one graph pieces, the ONNX runtime's wasm, both audio
worklets and the separation worker — is read from the packed extension through
`chrome.runtime.getURL`.

## How it is put together

Four scopes, because Manifest V3 gives each of them different powers.

| Where | File | What it owns |
| --- | --- | --- |
| Service worker | `src/background.ts` | The click, the tab, the offscreen document's existence, and routing |
| Offscreen document | `src/offscreen.ts`, `src/offscreen/pipeline.ts` | The `AudioContext`, the capture, the delay, the playback |
| Dedicated worker | `src/separation/separator.worker.ts` | The model, on WebGPU |
| Audio worklets | `src/worklets/*.worklet.ts` | Stamping captured chunks, and playing blocks at their moment |
| Content script | `src/content.ts` | Telling the audio side about seeks and pauses. Step B's half of the file |

The service worker exists where it does because `chrome.tabCapture.getMediaStreamId` is only
granted off the back of a user gesture and `chrome.action.onClicked` is where one arrives. It has no
`AudioContext`, no `getUserMedia` and no promise of being alive in a second's time, so the audio
lives in an offscreen document instead, created with the `USER_MEDIA` and `AUDIO_PLAYBACK` reasons.
Which tab is captured is kept in `chrome.storage.session` rather than in a variable, because the
service worker is killed whenever Chrome feels like it, including while the audio is still playing.

Routing is asymmetric and worth knowing before looking for the other half. A `chrome.runtime`
message from a content script already reaches every extension context, the offscreen document
included, so a command travelling towards the audio needs no relay: every message is wrapped in an
envelope naming who it is for, and that is what stops the wrong context acting on it. A report
travelling back does need the relay, because reaching a tab means `chrome.tabs.sendMessage`, and
only the service worker has `chrome.tabs`.

Nothing of the separation engine is copied. `apps/extension/src/separation/engine.ts` imports
`apps/web/src/separation` across the workspace by relative path: the windowing, the crossfade, the
tiling guarantee, the float32 island patch WebGPU needs and the backend policy are all the tested
code the web app runs on a file. What the extension adds is a capture at one end and a delayed
player at the other.

## Why about sixteen seconds

The arithmetic is in `apps/web/src/separation/streaming.ts` and it is not negotiable without
changing the window. A window of separated audio is only final once the next window has been run,
so the frontier of finished audio trails live by one window, and it moves in hops rather than
smoothly. The delay a player can hold without running dry is a window, plus a hop, plus the time a
window costs to compute. With the model's own 7.8 s window and 25% overlap that is 13.65 s before a
single multiply, and about 16 s once a GPU that separates at 3.4× realtime has spent 2.3 s on each
window.

The extension does not assume the number, it measures it. The separator reports its own lag; when
the first block arrives the real lag is measured against the capture clock; the larger of the two
wins, headroom is added, and the result is rounded up to a half second. It then stays put until a
reset, because step B delays the picture by exactly this and a delay that twitches is worse than
one slightly too long.

Everything is timed on the `AudioContext`, never on `performance.now()`. The capture worklet stamps
each chunk with the context time of the render quantum it began in, which gives every sample index
a capture time, which gives every sample a play time: capture time plus the delay. The player works
out which frame it owes from `(currentTime - epoch) × sampleRate`, so it cannot drift away from the
ring's contents — both are counted in the same frames by the same clock.

## Build and load it

Weights first, once. They are gitignored and never committed:

```sh
node scripts/spike/models.mjs fetch htdemucs-web
```

Then build an unpacked extension that carries its own weights and runtime:

```sh
pnpm --filter @kara/extension run build:unpacked
```

Load `apps/extension/dist` at `chrome://extensions` with developer mode on, and press the toolbar
button on a YouTube tab. The badge says `...` while priming and `on` when it is live.

`pnpm --filter @kara/extension run build` is the same thing with the weights optional, which is
what CI runs: it has no `models/` directory and no business failing over it. A dist built that way
bundles and loads but cannot separate anything. Add `--localhost` to either to make the extension
match `http://localhost/*` as well, which is only useful for pointing it at the debug page.

The build is four vite builds into one `dist/`, because an extension's pieces are not all the same
kind of file: pages and the service worker as ES modules, each audio worklet as a single
self-contained file, and the content script as an IIFE because Chrome runs content scripts as
classic scripts. `apps/extension/vite.config.ts` has the detail, and
`scripts/build-extension.mjs` runs them and then copies in the weights and the runtime.

## The debug harness

Tab capture needs a browser profile with an unpacked extension in it, a YouTube tab and a click,
none of which a test can have. None of that is the part that can be wrong, though. The parts that
can be wrong are whether the delay is what the separator said, whether blocks come back in order
and tile the timeline, and whether the instrumental has anything in it — and all three only need a
stream.

So `apps/extension/test/page.html` plays a local fixture in a `<video>`, hands
`video.captureStream()` to the same `startPipeline` the offscreen document calls, with the same
worklets and the same worker, and puts the status, the metrics and every block on
`window.__karaDebug`.

```sh
node scripts/spike/make-fixtures.mjs                        # fixtures/generated, gitignored
pnpm --filter @kara/extension run build:unpacked
pnpm --filter @kara/extension run preview                    # http://localhost:5276
```

Then open `http://localhost:5276/test/page.html` and press Start, or drive
`/test/page.html?autoplay=1` in Playwright with `--autoplay-policy=no-user-gesture-required`.
`window.__karaDebug.blocks()` gives each block's start sample, capture time, play time, arrival
time and the loudness of each pair, which is enough to assert the lag, the ordering and that the
instrumental is not silence. The fixtures are synthesised tones and noise and are the only media
this repository ever sees.

## Limits

- **WebGPU only, with `shader-f16`.** There is no WASM fallback and there cannot be a useful one:
  WASM runs this model at about 1.2× realtime, and the hop has to stay longer than the time a
  window costs or the stream falls behind for good and no fixed delay rescues it. A machine without
  a suitable adapter is told it is unsupported, in the backend policy's own words.
- **About sixteen seconds of delay**, for the reason above. Shortening it means a shorter window,
  which costs separation quality near a window's edges and leaves very little headroom;
  `streaming.ts` has the trade in full.
- **The first prime is slower than later ones**, because twenty-one graph pieces have to be loaded
  and compiled before the first window can run.
- **YouTube's DOM is not a contract.** The content script finds media events by listening on the
  document in the capture phase, which survives the video element being replaced, but anything that
  reads the page's own structure is fragile by nature. Step B will depend on more of it than this.
- **Ads are audio like any other.** The extension separates whatever the tab plays, and an ad
  arriving mid-song is a discontinuity it has no way to know about: expect sixteen seconds of
  nonsense around one unless the page reports a seek.
- **One tab at a time.** The model only fits on the GPU once, so starting a second capture stops
  the first.
- **No icons.** The action uses Chrome's default, because the repository holds no binaries.
