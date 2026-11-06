# The browser extension: whole-track analysis and a vocal switch

A Chrome extension that takes the vocal out of a video's audio while the tab is playing, on the
machine it is playing on. Press Start karaoke in the page, or Start in the toolbar popup. The
extension reads the video's own audio stream once, separates the whole track into drums, bass,
other and vocals with the same htdemucs model the web app uses, and holds the four stems in memory
for as long as the session lasts. The video keeps playing normally the entire time.

The vocal switch goes live as soon as the separated audio has caught up with the playhead — usually
well before the whole track is finished — and the rest carries on being separated in the
background. The switch means:

- **Original** plays the video's own sound, untouched, which is what the toggle is at rest on.
- **Instrumental** mutes the video and plays the four stems mixed to the levels in the panel, in
  whatever key was asked for, with a mute and a solo switch on every stem. The default has every
  slider at full and the vocal muted, so what sounds is karaoke; one press of M brings the full
  guide in, and moving drums, bass or other is the mixer.

The stems follow the video's own clock, so a pause holds and a resume carries on from the same
place. A seek behind the separated frontier works immediately; a seek ahead of it plays the video's
own sound until the frontier arrives, and then the stems take over. There is no delay between the
picture and the sound, because there is no delay: whatever is in hand is played at the video's
position.

## What it does

1. **Reads the stream.** A MAIN-world script watches the player responses YouTube already fetches.
   It watches `/youtubei/v1/player` and the newer `/youtubei/v1/get_watch`, which is what a
   related-video click uses without a page reload; both carry a player response, the second inside
   an array of envelopes. When the web player answers with SABR — format entries with no address,
   only a session URL this extension does not speak — the same script asks YouTube once more as
   VISIONOS, the client that still returns ordinary signed URLs, from the page's own origin and with
   the page's own visitor
   data. It reports the best audio-only address it finds; nothing is guessed from the DOM.
2. **Fetches and decodes it.** The offscreen document reads that stream in bounded range requests —
   one long GET gets cut off partway, a megabyte at a time does not — and decodes it to stereo at
   the model's 44.1 kHz. The video carries on playing from YouTube's own copy while this happens.
3. **Separates the whole track.** The decoded audio is pushed to a dedicated worker running the same
   separation engine as the web app, window by window, until the last hop is done. Each finished
   block is handed to the player as it arrives.
4. **Holds the stems in the player.** The audio worklet allocates eight buffers the length of the
   song when the track is decoded — left and right for each of the four stems — and every separated
   block is copied into them. The frontier — the end of the separated audio — moves forward; the
   player can play anything behind it. The toggle goes live as soon as that frontier has passed the
   playhead, while the rest is still being separated. The player mixes the four stereo stems with
   one ramped gain each, so a slider changes the sound without asking the model for anything.
5. **Follows the video.** Four times a second, and on every media event, the content script says
   where the video is and whether it is moving. The player anchors the stems to that clock. A seek
   is the next report with a different number in it; a pause is the next report saying nothing is
   moving; an ad is a report saying the video's own sound is the honest one. A seek beyond the
   frontier is also a report saying the video's own sound is the honest one, until the frontier
   reaches it.

The download and separation take a while — roughly a minute or two for a four-minute song on a GPU,
several minutes on WASM — but they happen once, while the video plays normally. The toggle appears
before they finish: as soon as the frontier reaches the playhead. Nothing is delayed afterwards.

## What the person sees

A panel in the bottom left of the player, in a closed shadow root so that none of its styles and
none of the page's can reach each other. It hides when the player hides its own controls and comes
back when they do, except while the pointer is resting on it. It takes no keyboard shortcut away:
every key the page handled before, it still handles. The two it adds — `[` and `]` for the key —
are read only while the focus is already inside the panel, which a closed shadow root can answer
and nothing else can see. Pointer and key events on the panel itself are stopped there, so nudging
a stem slider does not also pause the video or seek it.

The panel is a small console, not a settings page: a header with the Kara wordmark and the session
controls, one lead vocal row, a folded backing section, and a key stepper. Every actionable control
is thirty-two pixels tall, so the rows share one rhythm instead of the five heights the old panel
mixed.

- **Start karaoke** while nothing is running. Once a session exists, the power button at the right
  of the header stops it. Starting needs no special gesture any more because there is no tab
  capture to grant: the stream is the one the page itself reported.
- **A bar, while it is getting ready**, with one line under it naming the stage and — once this
  machine has timed a window — about how long is left for the whole track, not for the first usable
  audio. While the controls are already live, a line under them says *the rest is still being
  prepared*. *Getting ready* below says what the stages are and why there is no countdown.
- **No paused announcement.** A pause is visible in the video, so the panel keeps its controls and
  drops the status line rather than telling somebody a thing they can already see.
- **Instrumental**, a single toggle button in the header. Pressed, the video is muted and the stems
  are faded up; unpressed it reads *Original*, the stems are faded out and the video is unmuted.
  The fade is thirty milliseconds on one gain. One button rather than a two-option segmented bar:
  the two are one choice, not two destinations.
- **Vocals**, 0 to 100, how much of the vocal is left in the instrumental to sing against. It is
  the lead row, always on screen, and it starts at 100 but muted: the backing alone is what sounds,
  and pressing M is the one step that brings the guide in.
- **Drums, bass, other**, behind one press. Each is a level of its own, 0 to 100, and a Reset puts
  the backing back to full, unmuted and unsoloed without touching the vocal. At full the three add
  back up to the instrumental the old single slider played, so nothing is louder than the
  recording. Pulling the bass down for a bass line, or the drums down to practise a fill, is a
  change of mix rather than a second separation.
- **M** and **S** on every stem row. M mutes that stem exactly as if its slider were at zero,
  without losing where the slider was; S solos it, so the other stems go quiet while the switch is
  on. More than one stem can be soloed, and mute wins over solo. The slider keeps its position
  while a switch is on, so unmuting or unsoloing gives the balance back rather than a guess.
- **Key**, a minus, a plus and the words — *Key +2*, *Key −3*, or *Original key* at nought — with a
  reset that only appears when there is something to reset. Six semitones either way, in whole
  steps, and `[` and `]` do the same without the aiming. *Changing the key* below is what it costs
  and why it stops at six.

The icons are inline SVG paths in the Lucide vocabulary ShadCN builds on, assembled with
`createElementNS`: the repository holds no binaries, and building elements rather than assigning
markup keeps the extension clear of the page's HTML sinks.

## The mixer

htdemucs returns four sources, and the extension keeps all four apart from the model to the
speaker. It used to add drums, bass and other together and call the result the instrumental,
because a vocal switch was the only control. A mixer needs the difference: turning the drums down
and turning the backing down are two different requests.

Each stem has a gain between nought and one, never a boost. At one, the four add back up to the
mixture the video played, because htdemucs applies no mask and the stems sum to its input. That
makes a mix safe by construction: no setting of the four can clip a source that did not already
clip. It is also why the default is the honest one — every slider at one, with only the vocal
muted; pressing M then adds back the part karaoke removed, at the level already chosen.

Mute and solo sit beside the gain rather than replacing it. Muting a stem sets its effective gain
to nought but leaves the slider where the person put it; soloing a stem silences the others while
it is on, and several stems can be soloed together. If both switches are pressed on one stem, mute
wins, which is what a hardware desk does and the only reading that cannot surprise anybody. The
panel reads the switches back from `aria-pressed`, the same state a screen reader sees.

The levels and switches are session-only, like the key in the panel: another song starts at the
default because a balance chosen for one song is not a decision about every song after it. The
whole mix travels as one message rather than separate patches, so a status report can never show
one balance while the player is playing another. The player resolves it to four effective gains
and ramps each over thirty milliseconds, so moving a slider or pressing M or S does not click.

The cost is memory: the player holds eight buffers rather than four. The sums are the easy part;
see *Limits* for what that comes to on a long track.

## Duet (beta)

The four-stem mixer removes the whole vocal. **Duet** is a second, opt-in pass
that splits the vocal stem into two voices so one singer can be muted instead of
both. It is not part of normal preparation and it never blocks it: the single
Vocals row stays live while the second pass runs.

The split is done by the native `tools/duet-helper` process, not by the browser.
The extension sends only the mono vocal stem to `127.0.0.1`, where the helper
runs UNMIXX and a voice map, and returns two 44.1 kHz WAVs. Nothing leaves the
machine. The helper is started separately:

```bash
cd tools/duet-helper
source .venv/bin/activate
python bridge.py
```

It prints a token. Paste the URL and token into the popup's **Duet helper**
section and press Save; the offscreen document reads them from
`chrome.storage.local` when Duet is pressed. The helper's setup and CLI are in
`tools/duet-helper/README.md`.

What the person sees:

- **Duet** on the Vocals row once normal preparation is complete. Pressing it
  starts the second pass and leaves the normal controls usable.
- **A second progress line** under the vocal row: *Splitting the two voices*,
  then *Mapping who sings when*. The percentage is the helper's real progress,
  and **Cancel** stops the job and returns to the single vocal.
- **Two voice rows** when it finishes: Voice 1 and Voice 2, each with a level,
  M and S, exactly like a stem. The backing rows and key control stay where they
  were. The two voices are mono, so they are added to both output channels.
- **Swap** exchanges which separated stream is called Voice 1. The row controls
  stay with the label.
- **Fix line** is the calibration: pause on a line where only one singer sings,
  press Fix line, then **This is Voice 1** or **This is Voice 2**. The helper
  uses that three-second line as an anchor, re-labels the map, re-renders from
  the saved streams, and the panel reloads the WAVs. The model is not run again.
- **Single vocal** returns to the ordinary one-vocal stem and the normal mixer.
- If the helper is missing, has the wrong token, or the song cannot be mapped,
  the error appears under the vocal row with a retry button. Karaoke itself is
  untouched.

The voice map is heuristic by necessity. Solo lines are rendered from the
untouched vocal stem; simultaneous lines use the separated streams; unison
lines are copied to both voices because they cannot be split. The helper reports
low-confidence seconds and the panel says so. A high male register and a low
female register can be acoustically close, which is why **Fix line** exists.

The engine keeps one extra mono copy of the vocal stem (about 52 MB for a
five-minute song) so the upload can be encoded when Duet is pressed. The helper
keeps the raw streams and a `map.json` under `~/.kara-duet/jobs` for a day, so a
calibration is a re-render rather than another five-minute model run.

The full run is roughly five to eight minutes on an M1 Mac with MPS, depending
on the song; a calibration is a few seconds. CPU-only is much slower. The
feature is deliberately opt-in for that reason.

## The popup

The action has a popup, and it is no longer the only place a session can start — the panel in the
page starts just as well, because no tab capture permission is involved. The popup stays because it
is the one window that exists even when the person is not on a video: it shows the state of the tab
it was opened over, the Start or Stop button, the remembered key, and the debug report.

It is plain DOM in one small file, with the decisions in `src/popup/popup-view.ts` where they are
tested. The state comes out of `chrome.storage.session`, where the service worker leaves the last
status report as it routes it. A popup cannot have been listening when a report went past, because
it did not exist; so it reads the last one and then follows `chrome.storage.onChanged`, which is a
push. The bar moves four times a second with nobody polling anything.

The key in the popup is the remembered default and the running session at once: pressing it moves
both. The panel's buttons move only the session, because nudging the key for one song is not a
decision about every song after it.

The popup is also the only place diagnostics live. **View diagnostics** opens a disclosure with
three tabs: Session (status, stage, progress, model pieces, coverage, ETA, analysed time, length),
Analysis (backend, windows, compute time, download, sample rate, backend reason) and Audio (mode,
key, levels, switches, playhead, separated frontier). **Copy debug report** sits inside that disclosure,
so nothing raw is on screen until somebody asks for it and nothing is copied by accident. The panel
over the video has no developer controls at all: it is a player, and the popup is the window.

## Changing the key

Six semitones either way, in whole steps, applied last of all: after the four stems are mixed and
before the output, so every stem comes out in the same key. The shift is a dedicated
**Signalsmith Stretch** worklet (MIT, WASM) after the player, not the simple phase vocoder
this used to carry. Its whole job is pitch and time shifting, it handles transients far better than
a bin-by-bin vocoder, and it is the difference between a key change that sounds like the song and
one that sounds like it is underwater. The video's own sound is not put through it: `original` means
the recording as it is.

The key belongs to the session rather than to the video: a seek, a pause, an ad or another video
leaves it exactly where the person put it, because none of those is a decision about their voice.
Only another press moves it, and the popup's copy is also remembered in `chrome.storage.sync`, so
the next song starts where the last one did.

**The latency is paid in the anchor only when the key is shifted.** At the original key the stems
bypass the shifter and the player reads the video's own position, so there is no delay and no
vocoder in a path with nothing to shift. Pressing a key fades the dry path out, inserts the
shifter, and fades it back in once its buffer holds the re-aimed audio. Signalsmith reports its own
delay — 120 ms at the default block size — and while it is in, the player reads the stems that far
ahead, so the sample the video is showing is the sample the shifter is about to emit. The head is
the video position plus the shifter's latency, and every number the worklet reasons about — where
an anchor lands, where a jump lands, where the report says it is playing — is converted back to
video time by subtracting it. The cost is that the shifter holds 120 ms of audio: a seek or pause
can leave that much of the previous position in its buffer. It is the trade for the quality, and
it is why the block size is left at the library's default rather than shortened.

Six semitones is a product choice, not the library's limit: the control is for singing along, and a
key change past half an octave stops being useful long before the arithmetic stops working.

## Getting ready

Three things happen between pressing Start and the whole track being ready, and each owns a slice
of the bar:

| Stage | What it is waiting for | The bar |
| --- | --- | --- |
| Reading the audio | the stream fetched and decoded | 0% to 10% |
| Loading the model | twenty-one graph pieces fetched and compiled | 10% to 50% |
| Taking the vocal out | the whole track, window by window | 50% to 100% |

The toggle does not wait for the third stage to finish. As soon as the frontier of finished blocks
passes the playhead, the report says `covered` and the controls appear; the bar continues for the
rest of the track.

The download is a ratio of bytes when the stream reported a length and a creep when it did not. The
model load is a ratio of pieces, which the runner reports. Separating is a ratio of windows: the
plan is known exactly before the first one runs, so the bar has a real total for the stage that
takes the longest. The fraction never goes backwards, because every input is a measurement and a
bar that retreats reads as a fault.

**The only estimate is the separating one.** Once this machine has timed a window, the remaining
windows times the median window cost is an honest *about how long is left*. Before the plan is
known there is no seconds figure at all: a countdown that is wrong is worse than no countdown,
which is what the old design proved.

The engine reports `{stage, fraction, pieces, aboutSeconds, covered}` in its status report as it
goes, so the panel and the popup draw the same bar from the same number and neither extrapolates
anything.

There is no "when ready" setting any more. Nothing has to give when the audio arrives, because the
video has been playing normally all along: the stems simply take over when the toggle is pressed.

## How the stems follow the video

The page is the only thing that knows where the video is, so it says so — four times a second and
on every media event. A sample carries the wall instant it was taken, the video's `currentTime`,
whether it is playing, its rate, and whether an ad is on screen.

The offscreen document projects that sample to the instant it arrives and sends it to the player as
an anchor. The player's head becomes the anchored position, and between anchors it advances by the
video's rate. The audio clock and the video clock drift against each other by parts per million;
four anchors a second correct that without anybody hearing it.

- **A seek behind the frontier** moves the anchor by more than a few frames. The player fades out
  over ten milliseconds, lands the head at the new position, and fades back in. No reset, no
  re-priming, no waiting: that part of the track is already in hand.
- **A seek ahead of the frontier** is the video's own sound until the separated audio reaches the
  new position. The player is told not to play rather than fed zeros, and the next report after the
  frontier arrives anchors it there. The bar keeps moving; nothing is silent.
- **A correction of a few frames** is stepped without a fade, because a few frames is a tenth of a
  millisecond and fading over it would only make it louder.
- **A pause** is the report saying the video is not moving. The player mutes over twenty
  milliseconds and holds the head where it is. A resume anchors again and carries on from there:
  nothing is thrown away.
- **An ad** is the report saying the video's own sound is the honest one. The stems go quiet, the
  video is unmuted for its duration, and when the ad ends the next anchor lands at the post-ad
  position — a jump, faded like any other. There is no second preparation, which the old design
  could not avoid.
- **A rate other than one** is also the video's own sound: YouTube at 2× is pitch-preserved, and
  reading the stems at 2× is not. Back at 1×, the next anchor lands where the video is.
- **The end of the video** switches the mode back to original, so the end screen is not met in
  silence.

## The readiness band

YouTube's progress bar carries a two-pixel gold line from the start of the song to the end of the
separated audio, with a small marker at that frontier. It is drawn from `analyzedSeconds`, which is
the same prefix the player is allowed to play, so it answers the question the wait creates: whether
a particular point can be clicked and heard as karaoke yet. The overlay is passive — `pointer-events:
none` sends every click, drag and hover through to YouTube's own seek bar — so it is information,
not a second transport. It disappears when the frontier reaches the end, and while an ad is on
screen, because then the bar underneath is the ad's timeline rather than the song's. If YouTube
replaces its progress-list element on a navigation, the next status report reattaches the line.

The content script's half of the switch is the video's mute. It mutes the video exactly while the
stems are the sound being heard — instrumental mode, actually playing, at rate one, no ad, and the
stems have reached the playhead — and undoes only a mute it applied itself. A person who muted the video by hand stays muted when the
toggle moves to original; a person who unmutes it by hand while the stems are playing has asked
for the video's own sound, so the session moves to original rather than muting them again.

## The one audio source

**The video's own audio, read once, and nothing else.** The extension reads the audio stream of the
video the tab is watching, fetches it to the device, separates it locally and plays it back from
there. It never uploads anything and it never redistributes anything.

This replaces the original source, which was the tab's speaker output through `chrome.tabCapture`.
That design could only hear audio in real time as it played, which forced a sixteen-second delay
between the video and its sound. Reading the audio stream directly means the track is read ahead of
the playhead rather than heard in real time: no delay, no real-time constraint, and once the rest is
ready the toggle can point at any timestamp.

This is a deliberate change to the web app's first rule in the README, which says there is no link
import and no downloader. That rule still stands for the web app: it takes a file from your own
device and nothing else. The extension's job is different — it works on the video you are already
watching — and it reads that video's own audio for your own use, on your own machine. The rule that
has not changed is the one that matters: nothing is uploaded anywhere, and nothing is redistributed.
Kara is not a way to acquire music for anyone else.

The manifest's `host_permissions` covers YouTube and the host the audio streams come from; the
content security policy still names no third-party script origin, and everything loaded at
runtime — the model's twenty-one graph pieces, the ONNX runtime's wasm, the audio worklet and the
separation worker — is read from the packed extension through `chrome.runtime.getURL`.

## How it is put together

Seven parts, in the contexts Manifest V3 gives them.

| Where | File | What it owns |
| --- | --- | --- |
| Page world | `src/stream/stream-info.ts` | Noticing the player responses from `player` and `get_watch`, resolving a SABR-only answer as VISIONOS, and reporting the best audio stream |
| Popup | `popup.html`, `src/popup.ts` | The state, the start and stop, the remembered key, the debug report |
| Service worker | `src/background.ts` | The tab, the offscreen document's existence, the streams filed by video id, routing |
| Offscreen document | `src/offscreen.ts`, `src/offscreen/engine.ts` | The `AudioContext`, the fetch, the decode, the pitch shifter, and every block on to the player |
| Dedicated worker | `src/separation/separator.worker.ts` | The model, window by window |
| Audio worklet | `src/worklets/stem-player.worklet.ts` | Playing the whole track at the video's clock, through the key shifter when shifted |
| Content script | `src/content.ts` | The wiring: the panel, the mute, the media reports |

The pure files either side of them are where the arguing happens, and they are the ones with
tests: `audio/progress.ts` for the bar, `audio/status.ts` for the states and what moves between
them, `audio/media-time.ts` for projecting a report to now, `audio/mix-gain.ts` for every gain and
its ramp, `audio/stems.ts` for the four levels, their mute and solo switches, and their order,
`audio/key.ts` for the range of the key and the words it wears, `content/video-mute.ts` for when
the video steps aside, `content/panel-view.ts` and `popup/popup-view.ts` for the words, and
`settings.ts` for the shape of the setting.

The key shifter is not copied either: `signalsmith-stretch` is an MIT-licensed WASM worklet, packed
as `signalsmith-stretch.js` and loaded by the offscreen document as a static file, because an
extension page cannot load the Blob the package would otherwise build. It sits after the player,
reports its own latency so the player can read ahead by exactly that much, and is told the key as
one scheduled change. The extension's own player worklet stays a single self-contained file, so
nothing it pulls in survives as an `import` in the file `addModule` is handed.

The content script reads YouTube's DOM through one small file, `src/content/youtube.ts`: the
player, the main video, the class the player wears while an ad is on screen, the class it wears
when it has hidden its controls. Every one of them fails to null or false, logged once, rather than
throwing. When the page changes, that file changes and nothing else does. The audio half reads none
of it, because media events are a web platform contract rather than a YouTube one.

The page world script is separate from the content script on purpose. A MAIN-world script has no
Chrome API at all, so it can only speak through `window.postMessage`; the content script treats
what comes back with the same suspicion as anything else the page says, and the service worker
checks it again before keeping it. That is the whole bridge: an address for the audio, no audio
crossing it.

The VISIONOS request has to be made from the page's world, not the extension's. YouTube refuses a
player request carrying an extension origin, and the page's own cookies and visitor data are what
make the answer the same video the tab is playing. A fetched stream is filed under its tab and its
video id, because a related-video click can report the next video before the address bar has caught
up, and a late answer for the previous video can arrive after it. A start asks for the video the
address bar names, so neither race can make it separate the wrong song. A YouTube tab in the
background is still a page with a video on it, and its streams are kept apart from the tab somebody
is looking at.

Starting is a `request-start` to the service worker, which owns the tab and the offscreen document.
The service worker answers with words when the page has not reported a stream yet — usually a video
that has not started playing — rather than guessing. A session belongs to one video: navigating the
tab, or YouTube swapping in another video, ends it, because a different song needs a different
separation.

The service worker has no `AudioContext`, no `fetch` of media it can keep alive, and no promise of
being alive in a second's time, so the audio lives in an offscreen document instead. It is created
with the `WORKERS` reason rather than `AUDIO_PLAYBACK` on purpose: Chrome closes an
`AUDIO_PLAYBACK` document after thirty seconds without sound, and preparing is minutes of silence
while the video is still the thing being heard. `WORKERS` has no lifetime limit, and the document
does own the separation worker as well as the audio context. Which tab is running, and the last
report about it, are kept in `chrome.storage.session` rather than in variables, because the service
worker is killed whenever Chrome feels like it, including while the audio is still playing.

Routing is asymmetric and worth knowing before looking for the other half. A `chrome.runtime`
message from a content script already reaches every extension context, the offscreen document
included, so a command travelling towards the audio needs no relay: every message is wrapped in an
envelope naming who it is for, and that is what stops the wrong context acting on it. A report
travelling back does need the relay, because reaching a tab means `chrome.tabs.sendMessage`, and
only the service worker has `chrome.tabs`.

Nothing of the separation engine is copied. `apps/extension/src/separation/engine.ts` imports
`apps/web/src/separation` across the workspace by relative path: the windowing, the crossfade, the
tiling guarantee, the float32 island patch WebGPU needs and the backend policy are all the tested
code the web app runs on a file. What the extension adds is a fetch at one end and a whole-track
player at the other.

## Why the whole track

The old design separated live, in real time, because `chrome.tabCapture` could only hear the tab as
it played. A live separator can only finalise a window once the next one has been run, so the
frontier of finished audio trails the present by a window, and the player has to hold that much
back. That is where the sixteen to eighteen seconds came from, and no amount of buffering made it
go away.

Reading the stream removes the constraint: the whole file exists before the first window runs.
`streaming.ts` still works in windows — the model's window is the model's window — but nothing is
due at any particular moment, so the engine can run the track from beginning to end and hand each
block over as it is finalised. The player plays behind the frontier and does not wait for the last
block. The cost is paid once, up front, behind a progress bar, instead of forever as a delay. It
also means the WASM backend is usable: at about 1.2× realtime it would have fallen behind a live
stream, but a file can be separated slowly — and when it cannot stay ahead of the playhead, the
video's own sound carries the session until it does, or until the whole track is ready.

The price is memory. A Float32 channel at 44.1 kHz is about 10.6 MB a minute, so the eight channels
that make up four stereo stems are about 85 MB a minute — around 340 MB for a four-minute song,
held by the worklet. The decoded stereo track is held in the offscreen document until it has been
pushed to the worker. It is session-first on purpose: the stems live in the worklet until it stops,
and nothing is written to disk. Reloading the page or navigating starts again.

## Build and load it

Weights first, once. They are gitignored and never committed:

```sh
node scripts/spike/models.mjs fetch htdemucs-web
```

Then build an unpacked extension that carries its own weights and runtime:

```sh
pnpm --filter @kara/extension run build:unpacked
```

Load `apps/extension/dist` at `chrome://extensions` with developer mode on, open a YouTube video,
and press Kara in the page or Start in the popup. The badge says `...` while preparing, `♪` when
the toggle is live and `||` while the video is paused.

**The manifest now asks for the audio host as well as YouTube.** If the extension was already
loaded before this change, Chrome will not grant the new host permission on a reload: remove it at
`chrome://extensions` and add the unpacked directory again.

`pnpm --filter @kara/extension run build` is the same thing with the weights optional, which is
what CI runs: it has no `models/` directory and no business failing over it. A dist built that way
bundles and loads but cannot separate anything. Add `--localhost` to either to make the extension
match `http://localhost/*` as well, which is only useful for pointing it at the debug page.

The build is four vite builds into one `dist/`, because an extension's pieces are not all the same
kind of file: pages — the offscreen document, the popup and the debug page — and the service worker
as ES modules, the player worklet as a single self-contained file, and the two classic scripts
(`content.js` in the isolated world and `stream-info.js` in the page's) as separate IIFEs.
`apps/extension/vite.config.ts` has the detail, and `scripts/build-extension.mjs` runs them and
then copies in the weights, the runtime and the Signalsmith pitch-shift worklet.

## The debug harness

The extension needs a browser profile with an unpacked extension in it, a YouTube tab, and a live
stream, none of which a test can have. But none of that is the part that can be wrong. The parts
that can be wrong are whether the whole track is read, separated and played where the video is —
and those only need a video and a file.

So `apps/extension/test/page.html` plays a local fixture in a `<video>`, hands the same fixture's
audio to the same `startEngine` the offscreen document calls, and reports the video's clock the way
the content script does. The fixture keeps playing while the engine reads, decodes and separates
the same track; once it is ready, switching the mode to `instrumental` mutes the video and the
stems play at its clock position.

```sh
node scripts/spike/make-fixtures.mjs                        # fixtures/generated, gitignored
pnpm --filter @kara/extension run build:unpacked
pnpm --filter @kara/extension run preview                    # http://localhost:5276
```

Then open `http://localhost:5276/test/page.html` and press Start, or drive
`/test/page.html?autoplay=1` in Playwright with `--autoplay-policy=no-user-gesture-required`.

- `__karaDebug.progress()` gives every fraction the bar has been at, whether it ever went
  backwards, the highest it reached and whether it got to `ready`.
- `__karaDebug.mediaSeconds()` is where the stems are playing. Once the toggle is on it should sit
  on the fixture's own clock, and a seek should move it to the new place rather than starting
  anything over.
- `__karaDebug.status()` and `.metrics()` are the engine's own reports; `.failure()` is what went
  wrong, if anything. `status().covered` is whether the separated audio has reached the playhead,
  which can be true while `status().status` is still `preparing`. `status().analyzedSeconds` is the
  end of the ready prefix, which is what the gold line on YouTube's progress bar draws.
  `__karaDebug.pipeline()` adds the backend, its reason and the model's window count.
- `__karaDebug.setMode()`, `.setMix()`, `.setStem(stem, level)`, `.setMute(stem, muted)`,
  `.setSolo(stem, soloed)` and `.setTranspose()` move the controls without the panel.
  `.setGuide(level)` is the old name for the vocal stem and still works.
- `__karaDebug.dominantHz()` reads the loudest frequency coming out of the player off an
  `AnalyserNode` on its output, and `__karaDebug.peakHz(hz, spread)` reads the loudest within
  `spread` hertz of a known partial. The fixture is three partials of 110 Hz, and a pitch shifter
  moves every partial by the same ratio but not by the same amount, so the loudest one can change
  places after a shift. Looking where a chosen partial should have gone is the measurement that
  means something; the loudest bin is only a rough look.
- `__karaDebug.seek()`, `.pause()` and `.play()` drive the fixture, for testing what each does to
  the stems at once.
- `__karaDebug.start()` and `.stop()` are the page's own buttons.

Which is three Playwright assertions for the things this design changed:

```js
// The bar only ever goes forwards, and it gets there.
const run = await page.evaluate(() => window.__karaDebug.progress());
expect(run.monotonic).toBe(true);
expect(run.max).toBeGreaterThan(0.99);
expect(run.ready).toBe(true);

// The toggle, a seek and a pause are all the same clock.
await page.evaluate(() => window.__karaDebug.setMode('instrumental'));
await page.waitForTimeout(1000);
expect(await page.evaluate(() => window.__karaDebug.mediaSeconds())).toBeCloseTo(
  await page.evaluate(() => document.querySelector('#video').currentTime),
  0,
);
await page.evaluate(() => window.__karaDebug.seek(90));
await page.waitForTimeout(1000);
expect(await page.evaluate(() => window.__karaDebug.mediaSeconds())).toBeCloseTo(90, 0);

// And the key moves the pitch by the ratio it claims.
const ratio = 2 ** (5 / 12);
const low = await page.evaluate(() => window.__karaDebug.peakHz(220, 20));
await page.evaluate(() => window.__karaDebug.setTranspose(5));
await page.waitForTimeout(1000);
const high = await page.evaluate(
  (wanted) => window.__karaDebug.peakHz(wanted, 25),
  220 * ratio,
);
expect(high / low).toBeCloseTo(ratio, 2);
```

The fixtures are synthesised: tones and pink noise for the audio. They are the only media this
repository ever sees, and they are gitignored.

## Limits

- **The wait to full quality is real, though the wait to first use is shorter.** The whole track has
  to be fetched, decoded and separated before every timestamp is playable. A four-minute song is
  roughly a minute or two on WebGPU and several minutes on WASM, plus the model load. The controls
  appear as soon as the frontier reaches the playhead — often within tens of seconds — but a seek
  ahead of the frontier is the video's own sound until it gets there. The bar is honest about the
  whole track.
- **Memory grows with the song.** The player holds eight Float32 channels — four stereo stems —
  which is about 340 MB for four minutes, doubling the old vocal-and-instrumental pair. The decoded
  track is held as well while it is being pushed. It is session-only; reloading the page starts
  again. There is no disk cache to come back to. The mixer is why: keeping the three backing
  sources apart is what makes a per-stem level possible, and the sum could not be decomposed again
  without another separation.
- **WebGPU is much faster; WASM is the fallback.** There is no refusal any more, because a file can
  be separated slowly. The backend policy trusts WebGPU where the adapter has `shader-f16` and falls
  back to WASM everywhere else; on WASM the frontier may never catch the playhead, so the toggle can
  wait for the whole track. The popup's debug report says which backend ran and what a window cost.
- **YouTube's stream report is the fragile part.** The MAIN-world script reads the player responses
  the page already makes, from both `player` and `get_watch`. The web player often answers with SABR
  now, where the formats carry no address at all; the script asks again as VISIONOS and gets
  ordinary signed URLs today. Both are guesses about somebody else's service, and the day VISIONOS
  stops answering that way the extension says it has no stream rather than guessing at one. Stream
  URLs also expire: a page left open for hours may need a reload before it can be read.
- **YouTube's DOM is not a contract.** Media events are a platform contract and survive the video
  element being replaced; the player, the ad class and the autohide class are somebody else's
  markup and will change. They are in one file, they fail quietly, and the panel is what is lost
  when they do.
- **One tab at a time.** The model only fits on the GPU once, so starting a second session stops
  the first.
- **The key shifter is high quality, but it holds 120 ms of audio while it is in use.** Signalsmith
  Stretch is built for this rather than being a hand-rolled phase vocoder, so the old smearing and
  hollowness are gone. The delay is reported by the node and paid in the anchor, so steady playback
  stays in sync; the cost is that a seek or pause can leave up to 120 ms of the previous position
  in its buffer. The original key bypasses it entirely, so the cost is only paid while a key is
  shifted.
  Six semitones either way is a product choice, not the library's limit — the control is for
  singing along, and a key change past half an octave stops being useful long before the arithmetic
  stops working.
- **`original` is the recording, warts and all.** The key and the mixer apply to the stems, not to
  the video's own sound. That is what the word means, but it is worth knowing before reporting
  that the key control did nothing: it did nothing because there was no separation playing.
- **No icons in the toolbar.** The action uses Chrome's default, because the repository holds no
  binaries. The panel's own icons are inline SVG.
