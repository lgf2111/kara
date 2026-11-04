# The browser extension: live separation on a tab

A Chrome extension that takes the vocal out of a tab's audio while the tab is playing, on the
machine it is playing on, and plays the result back about sixteen seconds late. The picture is
delayed to meet it, with an overlay drawn over the page's own video, so the words arrive while
the mouth is still saying them.

## What it does

Press the toolbar button on a YouTube tab and press Start in the popup. The extension captures
that tab's audio output with `chrome.tabCapture`, separates it into vocal and instrumental with
the same htdemucs model the web app uses, and plays `instrumental + guide × vocals` back through
its own output, delayed, in whatever key was asked for. Switching to the original is a thirty
millisecond crossfade on one gain.

Seeking, changing the playback rate, reaching the end, crossing an ad boundary or loading another
video throws the buffer away and primes again. **Pausing does not.** A pause holds: the capture
stops being fed, the output and the picture freeze where they are, and a resume carries on from
the same sample with the same delay.

Tab capture mutes the tab for the person, so the extension's output is the only thing they hear.
During the first sixteen seconds there is nothing to play, and the `When ready` setting is what
happens then: quiet, with a still frame and a progress bar, and the song starting from where the
button was pressed; or the tab's own audio and the real video, undelayed, crossfading over to the
delayed pair when they arrive. Quiet is the default. The one case where the tab's own audio is
let through whatever the setting says is an advertisement, which is below.

## What the person sees

A panel in the bottom left of the player, in a closed shadow root so that none of its styles and
none of the page's can reach each other. It hides when the player hides its own controls and
comes back when they do, except while the pointer is resting on it. It takes no keyboard shortcut
away: every key the page handled before, it still handles. The two it adds — `[` and `]` for the
key — are read only while the focus is already inside the panel, which a closed shadow root can
answer and nothing else can see. Pointer and key events on the panel itself are stopped there, so
nudging the guide slider does not also pause the video or seek it.

The panel is one button, a progress bar, and once there is audio, three controls.

- **Karaoke** — off, preparing, on, paused, unavailable or failed. Pressed while off it asks the
  service worker to start, and the service worker will almost always answer that it cannot: a
  click inside a page is a gesture for the page, not for the extension, and Chrome grants
  `chrome.tabCapture` off the back of a click in one of the extension's own contexts and nowhere
  else. So the panel says *click the Kara icon in the toolbar to start*. Pressed while running it
  stops, which needs no gesture and so always works. `unavailable` and `failed` carry the reason
  from the status report — a missing WebGPU adapter, usually.
- **A bar, while it is getting ready**, with one line under it saying which of the four stages is
  being waited for and — only once this machine has been timed doing them — about how long is
  left. *Getting ready* below is what the stages are and why there is no longer a countdown.
- **Paused**, saying *nothing lost; it carries on from here*, because the behaviour it replaced
  was to throw everything away and that is what people will expect.
- **Original | Instrumental**, which is the one gain in `mix-gain.ts` crossfading over thirty
  milliseconds.
- **Guide**, 0 to 100, which is how much of the vocal is left in the instrumental to sing against.
- **Key**, a minus, a plus and the words — *Key +2*, *Key −3*, or *Original key* at nought — with
  a reset that only appears when there is something to reset. Six semitones either way, in whole
  steps, and `[` and `]` do the same without the aiming. *Changing the key* below is what it costs
  and why it stops at six.
- And a line saying *picture is 18 s behind YouTube*, because without it the delay reads as a
  broken page rather than as the thing that was asked for. It counts the pauses in: a pause moves
  the picture further behind the page by exactly as long as it lasted.
- And a sentence when something made it start getting ready again — *You jumped; preparing
  again* — because a bar that restarts on its own reads as a crash.

The icons are inline SVG assembled with `createElementNS`: the repository holds no binaries, and
building elements rather than assigning markup keeps the extension clear of the page's HTML sinks.

## The popup

The action has a popup, and it is not decoration. `chrome.tabCapture.getMediaStreamId` is granted
off the back of a click in one of the extension's own contexts, and the moment an action has a
popup, `chrome.action.onClicked` stops firing altogether — so the popup is the only place left
where that click can land. It fetches the stream id itself and hands it to the service worker,
which starts the offscreen pipeline exactly as before. There is no `onClicked` path any more
because there cannot be one.

It is plain DOM in one small file, with the decisions in `src/popup/popup-view.ts` where they are
tested. It shows the state of the tab it was opened over — idle, getting ready with the same bar
the panel draws, live, paused, or unsupported with the reason — a Start or Stop button, the same
key control the panel has, and the two settings.

The state comes out of `chrome.storage.session`, where the service worker leaves the last status
report as it routes it. A popup cannot have been listening when a report went past, because it
did not exist; so it reads the last one and then follows `chrome.storage.onChanged`, which is a
push. The bar moves four times a second with nobody polling anything.

## When ready

The first setting, in `chrome.storage.sync` under one key with the other, with `src/settings.ts`
holding the shape, the default and the parse, and `src/settings-store.ts` holding the three calls
that touch Chrome.

There is no way to make the first eighteen seconds free. Something has to give at the moment the
delayed audio arrives, and which thing gives is a matter of taste:

- **Restart from where I started, with a fade** — the default. Nothing is audible while it gets
  ready, and the overlay holds the one frame that was on screen at the instant the audio capture
  began, dimmed, with the bar on it. When the audio arrives the dim fades off over about seven
  tenths of a second and the picture carries on from that same frame, so nothing jumps.
- **Keep playing the original, then switch** — the tab's own audio plays undelayed through the
  passthrough gain and the real video stays visible, with frames being collected invisibly behind
  it. When the audio arrives the two cross over in about eight tenths of a second, and the
  picture jumps back by the delay. The panel says *jumped back 18 s*, because a video that leaps
  backwards looks like a fault.

Restart is the default because the jump surprises people and the quiet does not.

Both fades are gain curves in `audio/mix-gain.ts`, pure and tested, read on the `AudioContext`
clock by the playback worklet and on the wall clock by the overlay. The crossfade is equal power
— `sin` up against `cos` down — rather than two linear ramps, because two uncorrelated signals
passing each other linearly are both at a half in the middle, which is three decibels down and
audible as a hole. The fades in and out of silence are raised cosines, flat at both ends, because
the corner a short linear ramp leaves is what a speaker ticks at.

## Changing the key

Six semitones either way, in whole steps, applied last of all: after the mixing and before the
output, so the instrumental, the guide vocal and the original all come out in the same key rather
than one of them being special. It is a phase vocoder, in `apps/web/src/dsp/pitch-shift.ts`,
shared with the web app rather than written twice, and the player's worklet is the only thing in
the extension that calls it.

The person's choice sticks to the capture rather than to the timeline. A seek, a pause, an ad or
another video throws the audio buffer away and keeps the key: a key is something somebody decided
about their own voice, and nothing on that list is them changing their mind. Only another press
moves it, and the popup's copy of the control is also remembered in `chrome.storage.sync`, so the
next song starts where the last one did. The panel's buttons move the capture and leave that
default alone, because nudging the key for one song is not a decision about every song after it.

**The latency is the same number at every key, including none.** This is the only part of it that
had to be designed rather than looked up. The usual arrangement — time-stretch by the ratio, then
resample back — is two stages at different rates with a buffer between them, and how full that
buffer is depends on the ratio, so the latency moves when the key moves. The picture is held back
to meet the audio by a number fixed when the capture started, so audio that slid forwards by
thirty milliseconds on a key press would slide out of the mouth it was coming from. So the two
stages are folded into one pass at a constant rate: analyse at a hop of 512, move each partial's
magnitude to `bin × ratio` and advance its phase by `ratio ×` its measured frequency, synthesise
at the same hop of 512. Input and output are the same length by construction, and the wait is one
2048-sample frame whatever the ratio is — about forty-six milliseconds at 44.1 kHz.

At nought semitones the chain is bypassed and still delayed by exactly that one frame, so toggling
transpose cannot move the audio against the picture by a single sample, and the untouched path is
bit for bit the input rather than nearly it.

**Where the arithmetic goes.** The worklet reads the ring forty-six milliseconds *early*, because
that is how long the shifter will hold what it reads. That is the whole of the change to the sync:
`heard` in `src/worklets/playback.worklet.ts` is `currentTime` plus the shifter's latency, and every
moment the file reasons about — the epoch, the gain ramps, the instant a hold freezes — is a moment
on that audible timeline rather than on the clock. Nothing on the other side of the worklet knows
the key exists. A pause is unaffected: both ends of the freeze move by the same amount, so how long
it was held is unchanged, and that is the number the picture is shifted by.

**Why it does not sound like a phase vocoder.** Advancing every bin's phase independently is what
makes one audible: the bins of a single partial drift out of step and a struck note turns to mush.
So the peaks of the magnitude spectrum are found, each one gets the only phase accumulator in its
region, and every other bin in that region is put back at the phase it had relative to its peak in
this frame — identity phase locking. One complex rotation does a whole region, which is why it is
nearly free: no `atan2` per bin, two multiply-adds, and ten seconds of stereo goes through in a
fraction of a second.

A happy consequence is that at a ratio of exactly one the whole thing is the identity, because the
accumulators are started from the first frame's own phases and advance by each peak's measured
advance. So the shifter can be crossfaded against its own bypass while the ratio glides towards
one, and neither end of that crossfade is audible. A change takes about an eighth of a second: the
ratio slides, and when the shift is being switched on the crossfade is held at nothing for a frame
first, so the part where the overlap is still filling is never mixed in.

## Getting ready

Four things happen between pressing Start and hearing anything, and on a first prime the first of
them is the longest.

| Stage | What it is waiting for | The bar |
| --- | --- | --- |
| Loading the model | twenty-one graph pieces fetched and compiled for the GPU | 0% to 45% |
| Listening | the 7.8 s of audio one window needs | 45% to 70% |
| Separating | the first window, and the hop that finalises it | 70% to 85% |
| Filling the delay | the moment that first block is due | 85% to 100% |

What this replaced was a countdown from the delay the separator asked for, and it was wrong in
both directions: it froze at 15.5 s through ten seconds of model loading and then sat at nought
for the twelve seconds that were actually left, while live began about twenty-eight seconds after
the start. The mistake was assuming the only thing being waited for was the delay.

So `src/audio/progress.ts` maps what has measurably happened onto a fraction instead. Three of
the four stages know exactly what they are waiting for — pieces compiled, seconds of audio heard,
seconds until the epoch — so their part of the bar is a ratio. Separating does not: what a window
costs is a fact about this GPU that is not known until it has done one. That stage therefore
approaches its top edge rather than reaching it, so a machine slower than the guess keeps seeing
movement rather than a bar that has apparently stopped. The fraction is also kept at its
high-water mark, because every input is a measurement and a bar that retreats reads as a fault.

A prime that is not the first starts at the listening stage, and so at 45%: the model is loaded,
and that is honestly less work left.

**There is no estimate until there is one.** A seconds figure is offered only when every stage it
covers has been timed on this machine, which on a first prime means not at all until the last
stage, whose remaining time is exact. When there is one it says *about*, and it is allowed to go
up. The pipeline reports `{stage, fraction, aboutSeconds, pieces}` in its status report, four
times a second while priming, so the panel, the popup and the overlay all draw the same bar from
the same number and none of them extrapolates anything.

## The picture

`src/picture/delayed-picture.ts` holds the video back by the same number of seconds the audio is
held back by. Every displayed frame is copied into an `ImageBitmap` downscaled to 640 px wide, at
about fifteen a second, and kept with the instant it was displayed at. A canvas over the video
paints, on every animation frame, the newest frame that was on screen at `now - delay`. The real
video stays exactly where it was and keeps playing — it is the thing producing the frames and the
audio being captured — at opacity zero, with the canvas ignoring pointer events, so the player's
own controls, shortcuts and context menu all still work on the elements they always worked on.

The canvas is positioned on the video element's displayed rect rather than the player's, because a
player is usually wider than the picture in it, and each frame is fitted inside that rect the way
a browser fits a video: contained, centred, black either side. Theatre mode, fullscreen and a
window drag arrive through a `ResizeObserver`.

**Which clock.** The audio times everything on its `AudioContext`, which is in the offscreen
document; the frames are captured in a content script, which is a different realm in a different
process. `performance.now()` is measured from each context's own creation, so the two sides read
different numbers at the same instant. What they both read is `performance.timeOrigin +
performance.now()`, and that is what a frame is stamped with. The agreement between the two halves
is one sentence — *a moment of the tab captured at instant T is heard at T + delay + held* — and
those two numbers in the status report are the only ones that have to cross between them. Neither
side needs the other's epoch. It is not exact to the millisecond: capture adds a little latency
before a sample reaches the worklet and `outputLatency` adds a little after the player writes one,
so the sound is some tens of milliseconds later than the frame drawn for the same instant. That is
within a frame or two at fifteen a second, it does not accumulate, and the debug harness measures
what it actually comes to rather than assuming.

**The priming wait.** For the first eighteen seconds there is no frame old enough to paint and
nothing to be done about it. What there is a choice about is what to show instead, and that is the
`When ready` setting above: a still frame with the progress bar on it, or the real video with the
canvas not even in the document. The still frame is not the newest one — it is the frame that was
on screen at the instant the audio capture began, which the content script pins the moment the
status report's stage stops being `loading`. Holding that one rather than a live one is what makes
the arrival seamless: when the audio starts playing from that instant, the picture is already
there.

**The pause shift.** A pause does not reset the picture and does not invalidate a single frame
held. The page stops producing frames, the audio stops being fed, and all that has changed when
both start again is that the wall clock moved on while neither did. So the frame to paint is the
one from `now - delay - held`, where `held` is how long the *audio* was frozen. That number is
reported by the playback worklet, which is the half holding the clock the epoch is on; its freeze
is a fraction shorter than the page's, by the twenty milliseconds the output spends fading out,
and matching the audio rather than the page is the point. The content script makes its own guess
at the resume so the picture does not lurch in the millisecond before the next report, and the
report then corrects it.

**Memory.** Eighteen seconds of picture has to be held, and the only question is what it costs.
At 640 × 360 a frame is 640 × 360 × 4 bytes, and at fifteen a second eighteen seconds is about
250 MB. The ring is given a budget under 300 MB rather than a length, because a budget is the
quantity that matters and the number of frames it buys depends on the video; at that size it holds
about 21 s, which covers the delay with a little to spare. When the budget is spent the oldest
frame goes, which is the only end to drop from: the newest is the one the delay has not reached
yet. A budget too small for the delay therefore shows a picture that is less delayed than asked
for, which the harness measures, rather than one that stutters. `ImageBitmap`s are closed by hand
on every eviction, every trim and every clear — they are handles on memory outside the heap, and
letting the collector find them is how an overlay becomes a leak.

## Seeking, pausing and ads

What each event means is one table, in `src/content/page-events.ts`, because every row is a
judgement worth arguing with.

| On | The audio | The picture |
| --- | --- | --- |
| a real `seeking` | reset | overlay down, real video back |
| `seeked` | nothing; the seek already reset it | overlay up again, keeping frames from here |
| `pause` | **hold**: freeze the output, keep everything | frozen where it is |
| `play` | **resume**: carry on from the same sample | carries on, with the pause taken out |
| `ratechange` | reset | overlay down, real video back |
| `ended` | reset | overlay down, real video back |
| an ad starting | reset, and passthrough on | overlay down, real video back |
| an ad ending | reset, and passthrough off | overlay up again |

**Why a pause is not a reset.** The reasoning for resetting is that a separated block belongs to
the timeline it was captured on, and a seek or a rate change really does put the person on another
timeline. A pause does not. The capture is fed by the page, so a paused page feeds it nothing: the
samples either side of a pause are the same song with nothing missing between them. Resetting
meant that clicking the video — which is how YouTube pauses — cost the entire delay again,
eighteen seconds of silence for a click somebody probably made by accident. That was the single
worst thing about using this.

So a pause holds, and holding is three things in step. The playback worklet fades its output out
over twenty milliseconds, freezes, and reads nothing at all until the resume — which is also what
stops the ring counting frames late, missing or early for a stretch nobody was listening to. The
capture stops being handed to the separator, and the capture clock is told to rejoin the timeline
on the next chunk after the pause rather than reading the gap as the audio thread skipping. And on
the resume the worklet pushes the epoch forward by exactly how long it was frozen, so every sample
after the pause plays at the same place in the delay it would have.

The cost is under a tenth of a second of audio at each boundary: the part-gathered chunk is
dropped at the pause and again at the resume, so that paused silence cannot be stapled into the
stream. The splice is at the moment the person paused, which is where they will expect one.

**Why a `seeking` event is not a seek.** The page fires `seeking` while buffering, when it adopts
a new source, when a quality change reloads the stream and at the start of playback, none of which
move the person anywhere. Obeying all of them means paying the whole delay for nothing, so
`src/content/timeline.ts` judges it by arithmetic on the video's own clock instead: a playing
video's `currentTime` advances by the wall time that went by times the rate, a paused one does not
advance at all, and a jump is being somewhere else by more than three quarters of a second.
`currentTime` is sampled on `timeupdate` and on the panel's own tick, so there is always a recent
point to compare against. `seeked` follows whatever its `seeking` was judged to be.

The picture half of each row is a choice. A frame is stamped with a wall instant, so strictly the
picture needs no resetting after a seek either — eighteen seconds later it would still be showing
exactly what the audio was playing. What makes that wrong is that it would be eighteen seconds of
pre-seek video over silence, which reads as a frozen tab. So the picture comes down when the audio
does, the person gets the real video back while there is nothing to sing to, and both go delayed
again together.

A seek is two rows on purpose: the first throws everything away and the second starts again, so a
long scrub that fires `seeking` a hundred times primes once, at the end.

Ads are the only row that changes what is audible. The extension cannot tell an ad from a song,
and eighteen seconds of separated advertisement is not worth having, so an ad turns the whole
thing off for its duration: the real video comes back and passthrough lets the tab's own audio
through undelayed, which it has to, because capture has muted the tab and the ad would otherwise
be silent. When it is over, both halves prime again — which does mean eighteen seconds of quiet
over the start of the song.

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

Five scopes, because Manifest V3 gives each of them different powers.

| Where | File | What it owns |
| --- | --- | --- |
| Popup | `popup.html`, `src/popup.ts` | The click that a tab capture is granted off the back of, and the settings |
| Service worker | `src/background.ts` | The tab, the offscreen document's existence, the last report, and routing |
| Offscreen document | `src/offscreen.ts`, `src/offscreen/pipeline.ts` | The `AudioContext`, the capture, the delay, the playback |
| Dedicated worker | `src/separation/separator.worker.ts` | The model, on WebGPU |
| Audio worklets | `src/worklets/*.worklet.ts` | Stamping captured chunks, and playing blocks at their moment in the key asked for |
| Content script | `src/content.ts` | The wiring: what is mounted, what each event does, what the panel is told |

The pure files either side of them are where the arguing happens, and they are the ones with
tests: `audio/progress.ts` for the bar, `audio/status.ts` for the six states and what moves
between them, `audio/mix-gain.ts` for every gain curve, `audio/key.ts` for the range of the key
and the words it wears, `content/page-events.ts` for the table above, `content/timeline.ts` for
whether a seek happened, `content/panel-view.ts` and `popup/popup-view.ts` for the words, and
`settings.ts` for the shape of the two settings.

The pitch shifter is the other thing not copied: `apps/web/src/dsp/pitch-shift.ts` is imported
across the workspace by relative path, built on the same `dsp/fft.ts` the separation host uses,
and tested in `apps/web/test/pitch-shift.test.ts` against synthetic tones. It bundles into the
playback worklet, which is a single self-contained file, so nothing it pulls in survives as an
`import` in the file `addModule` is handed; the build fails if one ever does.

The content script is five files and one of them is load-bearing in a way the others are not.
`src/content/youtube.ts` is the only place in the extension that knows what YouTube's DOM looks
like — the player, the main video, the class the player wears while an ad is on screen, the class
it wears when it has hidden its controls — and every one of them fails to null or false, logged
once, rather than throwing. When the page changes, that file changes and nothing else does. The
audio half reads none of it at all, because media events are a web platform contract rather than a
YouTube one, so a broken selector costs the picture and the panel and never the sound.

The other four are deliberately dull: `src/content/panel.ts` draws, `src/content/panel-view.ts`
works out what it should say, `src/content/page-events.ts` is the table above, and
`src/content/timeline.ts` is the one question that table cannot answer. The last three are pure
and tested; the two that touch the DOM have no decisions left in them.

Starting is a `request-start` to the service worker rather than a command, because neither the
page nor the popup can start a capture by itself: the popup has the gesture and the service worker
has the tab and the offscreen document. The popup sends the stream id it was granted along with
the request. The panel sends none, because a click inside a page is a gesture for the page; the
service worker tries anyway and, when Chrome refuses, sends back the hint that points at the
toolbar. Trying rather than assuming means the panel's button starts working by itself on the day
Chrome allows it, and the refusal costs one rejected promise. `request-stop` needs no gesture and
always works.

The service worker has no `AudioContext`, no `getUserMedia` and no promise of being alive in a
second's time, so the audio lives in an offscreen document instead, created with the `USER_MEDIA`
and `AUDIO_PLAYBACK` reasons. Which tab is captured, and the last report about it, are kept in
`chrome.storage.session` rather than in variables, because the service worker is killed whenever
Chrome feels like it, including while the audio is still playing.

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
reset, because the picture is delayed by exactly this and a delay that twitches is worse than one
slightly too long. With the headroom added it comes out at about eighteen seconds in practice,
which is the number the panel quotes.

Everything in the audio is timed on the `AudioContext`, never on `performance.now()`. The capture
worklet stamps
each chunk with the context time of the render quantum it began in, which gives every sample index
a capture time, which gives every sample a play time: capture time plus the delay. The player works
out which frame it owes from `(heard - epoch) × sampleRate`, where `heard` is the context clock
plus the pitch shifter's fixed forty-six milliseconds, so it cannot drift away from the ring's
contents — both are counted in the same frames by the same clock. The picture is in another
process and cannot read that clock at all, which is what *The picture* above is about: it keeps
the same delay on a clock both contexts share, and `delaySeconds` and `heldSeconds` are all that
cross between.

The delay stays put across a pause, which is the one case where the epoch moves. Holding freezes
the player and the resume pushes the epoch forward by however long it was frozen for, so the
distance between a sample being captured and being heard is unchanged and nothing has to be
primed again. What grows is how far the picture is behind the *page*, by exactly the same amount,
which is why the panel's line adds the two together.

## Build and load it

Weights first, once. They are gitignored and never committed:

```sh
node scripts/spike/models.mjs fetch htdemucs-web
```

Then build an unpacked extension that carries its own weights and runtime:

```sh
pnpm --filter @kara/extension run build:unpacked
```

Load `apps/extension/dist` at `chrome://extensions` with developer mode on, open the popup from
the toolbar on a YouTube tab, and press Start. The badge says `...` while priming, `on` when it
is live and `||` while the page is paused.

`pnpm --filter @kara/extension run build` is the same thing with the weights optional, which is
what CI runs: it has no `models/` directory and no business failing over it. A dist built that way
bundles and loads but cannot separate anything. Add `--localhost` to either to make the extension
match `http://localhost/*` as well, which is only useful for pointing it at the debug page.

The build is four vite builds into one `dist/`, because an extension's pieces are not all the same
kind of file: pages — the offscreen document, the popup and the debug page — and the service worker
as ES modules, each audio worklet as a single self-contained file, and the content script as an
IIFE because Chrome runs content scripts as classic scripts. `apps/extension/vite.config.ts` has
the detail, and `scripts/build-extension.mjs` runs them and then copies in the weights and the
runtime.

## The debug harness

Tab capture needs a browser profile with an unpacked extension in it, a YouTube tab and a click,
none of which a test can have. None of that is the part that can be wrong, though. The parts that
can be wrong are whether the delay is what the separator said, whether blocks come back in order
and tile the timeline, whether the instrumental has anything in it, and whether the frame on
screen is the one the audio is playing — and all four only need a video and a stream.

So `apps/extension/test/page.html` plays a local fixture in a `<video>`, hands
`video.captureStream()` to the same `startPipeline` the offscreen document calls and the video to
the same `createDelayedPicture` the content script calls, with the same worklets and the same
worker, and puts the status, the metrics, every block and the overlay's own state on
`window.__karaDebug`. The fixture's own `pause`, `play` and `seeking` events go through the same
`page-events.ts` table and the same `timeline.ts` judgement the content script uses, which is what
makes the two promises this page exists to prove testable without a browser profile.

```sh
node scripts/spike/make-fixtures.mjs                        # fixtures/generated, gitignored
pnpm --filter @kara/extension run build:unpacked
pnpm --filter @kara/extension run preview                    # http://localhost:5276
```

Then open `http://localhost:5276/test/page.html` and press Start, or drive
`/test/page.html?autoplay=1` in Playwright with `--autoplay-policy=no-user-gesture-required`.

- `__karaDebug.blocks()` gives each block's start sample, capture time, play time, arrival time
  and the loudness of each pair, which is enough to assert the lag, the ordering and that the
  instrumental is not silence.
- `__karaDebug.picture()` gives the overlay's state: frames held, what they cost, the stamp of the
  frame on the canvas, the delay being aimed at, and how far from it the painted frame is.
- `__karaDebug.pictureOffsetSeconds()` is the one number worth asserting on. The fixture's own
  audio plays undelayed, so the separated audio is `delaySeconds` behind it and the painted frame
  is however far behind it the overlay managed; the difference between the two is this, and it
  should sit near zero once both halves are live.
- `__karaDebug.seek()` moves the fixture, and `.pause()` and `.play()` drive it, for testing what
  each of them does to both halves at once.
- `__karaDebug.progress()` gives every fraction the bar has been at, whether it ever went
  backwards, the highest it reached and whether it got all the way to audible. The assertion is
  `monotonic`, a `max` near one, and `live`.
- `__karaDebug.primes()` counts the times it has started getting ready again after having been
  audible, and `.delays()` every delay it has settled on. **A pause and a play must leave both
  alone**: same delay, no new prime. A seek must add to both.
- `__karaDebug.setTranspose()` changes the key, and `.dominantHz()` reads the loudest frequency
  coming out of the player off an `AnalyserNode` on its output. Two readings either side of a
  transpose are enough to prove the shift on the tone fixture: their ratio should be
  `2 ** (semitones / 12)`, and `pictureOffsetSeconds()` should not have moved, because the
  shifter's latency is the same at every key.

Which is four Playwright assertions for the four things these steps changed:

```js
// The bar only ever goes forwards, and it gets there.
const run = await page.evaluate(() => window.__karaDebug.progress());
expect(run.monotonic).toBe(true);
expect(run.max).toBeGreaterThan(0.9);
expect(run.live).toBe(true);

// A pause and a play keep the same delay and do not prime again.
const before = await page.evaluate(() => window.__karaDebug.primes());
await page.evaluate(() => window.__karaDebug.pause());
await page.waitForTimeout(3000);
await page.evaluate(() => window.__karaDebug.play());
expect(await page.evaluate(() => window.__karaDebug.primes())).toBe(before);
expect(await page.evaluate(() => window.__karaDebug.delays())).toHaveLength(1);

// A seek does.
await page.evaluate(() => window.__karaDebug.seek(90));
expect(await page.evaluate(() => window.__karaDebug.primes())).toBe(before + 1);

// And the key moves the pitch by the ratio it claims, without moving the sync.
const low = await page.evaluate(() => window.__karaDebug.dominantHz());
const was = await page.evaluate(() => window.__karaDebug.pictureOffsetSeconds());
await page.evaluate(() => window.__karaDebug.setTranspose(5));
await page.waitForTimeout(1000);
const high = await page.evaluate(() => window.__karaDebug.dominantHz());
expect(high / low).toBeCloseTo(2 ** (5 / 12), 2);
expect(await page.evaluate(() => window.__karaDebug.pictureOffsetSeconds())).toBeCloseTo(was, 1);
```

The fixtures are synthesised: tones and pink noise for the audio, and an ffmpeg test pattern with
its own timestamp burnt into every frame for the picture, so a test that would rather read the
screen than trust a number can read the delay straight off it. They are the only media this
repository ever sees, and they are gitignored.

## Limits

- **WebGPU only, with `shader-f16`.** There is no WASM fallback and there cannot be a useful one:
  WASM runs this model at about 1.2× realtime, and the hop has to stay longer than the time a
  window costs or the stream falls behind for good and no fixed delay rescues it. A machine without
  a suitable adapter is told it is unsupported, in the backend policy's own words.
- **About sixteen seconds of delay**, for the reason above. Shortening it means a shorter window,
  which costs separation quality near a window's edges and leaves very little headroom;
  `streaming.ts` has the trade in full.
- **The first prime is slower than later ones**, because twenty-one graph pieces have to be loaded
  and compiled before the first window can run. It is about twenty-eight seconds against about
  eighteen, which is why the bar is weighted the way it is and why a later prime starts at 45%.
- **No estimate on a first prime.** How long the model takes to compile and what a window costs
  are facts about the machine, and this one refuses to guess at them: there is a bar and a stage,
  and a seconds figure only once the stages have been timed here. A countdown that is wrong is
  worse than no countdown, which is what the one this replaced proved.
- **YouTube's DOM is not a contract.** Media events are found by listening on the document in the
  capture phase, which survives the video element being replaced, but the player, the ad class and
  the autohide class are somebody else's markup and will change. They are in one file, they fail
  quietly, and the panel and the picture are what is lost when they do.
- **A quarter of a gigabyte of frames.** That is what eighteen seconds of 640 px picture costs, and
  it is the price of the delay rather than an implementation detail to be optimised away. A
  smaller cap would show a softer picture; a shorter delay would cost separation quality.
- **The panel cannot start a capture.** Chrome grants `chrome.tabCapture` from a click in one of
  the extension's own contexts and nowhere else, so the panel's own button can only point at the
  popup. It tries first, every time, in case that ever changes.
- **A pause loses a tenth of a second of song.** The part-gathered capture chunk is dropped at the
  pause and again at the resume, so that paused silence cannot be stapled into the stream. The
  splice lands where the person paused.
- **A long pause makes the picture further behind the page**, by exactly as long as the pause. The
  delay between hearing something and seeing it is unchanged — that is the point — but the frames
  being held are older, so the memory budget is reached sooner and the picture ends up less
  delayed than asked for after several minutes of pausing. The overlay's `offsetSeconds` is what
  says so.
- **Ads cost the delay twice.** The extension cannot tell an ad from a song. It hands the ad back
  to the tab undelayed and primes again afterwards, which means the first eighteen seconds of
  whatever follows an ad are silent.
- **Six semitones of key, and a phase vocoder's worth of quality.** A 2048-sample frame smears a
  transient across forty-six milliseconds, so a struck piano note or a snare softens; and the
  further the partials are moved, the more of the synthesis spectrum is gaps the magnitudes were
  stretched over, which is what large shifts hear as hollow and thin. Identity phase locking is
  what keeps it listenable at all rather than what makes it transparent. Six either way is where
  the arithmetic stops being worth offering, not where it stops working — the shifter itself takes
  two octaves — and a key control with a setting nobody would choose is a worse control. Singing a
  fifth down is a job for a different algorithm than one that has to run live with a fixed latency.
- **One tab at a time.** The model only fits on the GPU once, so starting a second capture stops
  the first.
- **No icons in the toolbar.** The action uses Chrome's default, because the repository holds no
  binaries. The panel's own icons are inline SVG.
