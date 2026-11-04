import { isRunning } from './audio/status.ts';
import { decidePageEvent, shouldReprime, type PageEvent } from './content/page-events.ts';
import { panelView, prepareDetail, TOOLBAR_HINT } from './content/panel-view.ts';
import { mountPanel, type Panel } from './content/panel.ts';
import { isRealSeek, type TimelinePoint } from './content/timeline.ts';
import { findPlayer, isAdShowing, isAutohidden, watchPlayer } from './content/youtube.ts';
import {
  createDelayedPicture,
  DEFAULT_DELAY_SECONDS,
  type DelayedPicture,
  type PictureFace,
} from './picture/delayed-picture.ts';
import {
  packet,
  packetFor,
  type Command,
  type PlayMode,
  type Report,
  type Request,
  type StatusReport,
} from './protocol.ts';

/**
 * The page's side of it: the panel, the delayed picture, and the events that
 * invalidate both.
 *
 * Four things live here and nothing else does. The panel, which is the only
 * place in the page a person can see what the extension is doing or change
 * what it plays. The delayed picture, which holds the video back by the same
 * amount the audio is held back by, so that the two agree. The media events —
 * a seek, a pause, a resume, a rate change — which the audio side has to be
 * told about because only the page knows about them. And the ad transitions,
 * which mean the person should be allowed to hear the ad.
 *
 * It owns no selectors: every question about what YouTube's DOM looks like
 * goes through `content/youtube.ts`, so a page change breaks one small file
 * and not this one. It owns no decisions either: what an event means is a
 * table in `content/page-events.ts`, whether a `seeking` event was a jump at
 * all is `content/timeline.ts`, and what the panel should say is a function in
 * `content/panel-view.ts`. What is left here is the wiring, which is the part
 * that cannot be unit tested and so should be the part with the least
 * thinking in it.
 *
 * Three shapes of the page are worth knowing about. Media events do not
 * bubble, so the listeners are on the document in the capture phase: that
 * catches them wherever they are targeted, which matters on a site that
 * replaces its video element whenever it feels like it. Because it does that,
 * the panel and the overlay are re-mounted whenever either turns out to have
 * been torn out from under them, which is cheaper and far more reliable than
 * listening for the site's own navigation events. And `currentTime` is
 * sampled as the video plays, because a `seeking` event is not evidence of a
 * seek — the page fires them for buffering and for quality changes too, and
 * priming again costs the whole delay.
 */

/** How often the panel is redrawn and the mounting re-checked, in ms. */
const TICK_MS = 500;

/**
 * How long a page is allowed to have no video in it before that is worth a
 * line in the console. Every watch page starts that way for a moment.
 */
const GRACE_MS = 10_000;

/**
 * How long the panel says the picture jumped back for. Long enough to be read
 * by somebody who was watching the video rather than the panel.
 */
const JUMPED_NOTE_MS = 8000;

/**
 * Where the last report from the audio side is kept: the content script's own
 * isolated world, which the page cannot see and the extension's devtools
 * console can.
 */
interface ReportHolder {
  __karaReport?: Report;
}

interface Mounted {
  readonly player: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly panel: Panel;
  readonly picture: DelayedPicture;
  readonly unwatch: () => void;
}

let mounted: Mounted | null = null;
let report: StatusReport | null = null;
let hint: string | null = null;
let inAd = false;
let moaned = false;
const startedAt = performance.now();

/** Where the video's clock was, so a jump in it can be told from playing. */
let lastPoint: TimelinePoint | null = null;
/** Whether the seek in flight was a real one, which is what `seeked` needs. */
let seeking = false;
/** When the page paused, so the picture can be shifted before the audio says. */
let pausedAt: number | null = null;
/** What the audio had been frozen for before this pause began. */
let heldBefore = 0;
/** Seconds of pause the picture is shifted by, until the report refines it. */
let heldGuess = 0;
/** When the picture last jumped back, which the panel explains for a while. */
let jumpedAt: number | null = null;
/** Whether the still frame has been pinned to where the audio capture began. */
let anchored = false;

function toOffscreen(body: Command): void {
  // Straight to the offscreen document: a runtime message from a content
  // script reaches every extension context, and the envelope says which one
  // should act on it.
  chrome.runtime.sendMessage(packet('offscreen', body)).catch(() => undefined);
}

function toBackground(body: Request): void {
  chrome.runtime.sendMessage(packet('background', body)).catch(() => undefined);
}

/** Whether the audio side is doing anything the picture should match. */
function running(): boolean {
  return report !== null && isRunning(report.status);
}

/** The delay to aim at: what was measured, or the guess until it is. */
function delayNow(): number {
  return report?.delaySeconds ?? DEFAULT_DELAY_SECONDS;
}

function refresh(): void {
  mounted?.panel.update(
    panelView({
      report,
      hint,
      jumped: jumpedAt !== null && performance.now() - jumpedAt < JUMPED_NOTE_MS,
    }),
  );
}

function point(): TimelinePoint | null {
  const video = mounted?.video;
  if (video === undefined) {
    return null;
  }
  return {
    mediaSeconds: video.currentTime,
    wallMs: performance.now(),
    rate: video.playbackRate,
    paused: video.paused,
  };
}

function sample(): void {
  lastPoint = point() ?? lastPoint;
}

/**
 * Which face the overlay should be wearing, or null when it should be down.
 *
 * Down for an ad or for nothing running, because a delayed picture over audio
 * nobody is separating is a frozen tab with extra steps. While getting ready
 * it is the setting's choice: a dimmed still frame with the bar on it, or the
 * real video with the frames being collected invisibly behind it. A pause
 * changes nothing, which is why it is not in here.
 */
function faceWanted(): PictureFace | null {
  if (report === null || inAd || !running()) {
    return null;
  }
  if (report.status === 'live') {
    return 'live';
  }
  return report.onReady === 'continue' ? 'hidden' : 'dimmed';
}

function apply(event: PageEvent): void {
  const decision = decidePageEvent(event);
  switch (decision.audio) {
    case 'reset':
      if (decision.reset !== null) {
        toOffscreen({ type: 'reset', reason: decision.reset });
      }
      // A new timeline, so the pause shift and the still frame go with it.
      heldGuess = 0;
      heldBefore = 0;
      pausedAt = null;
      anchored = false;
      break;
    case 'hold':
      pausedAt = performance.now();
      heldBefore = report?.heldSeconds ?? heldGuess;
      toOffscreen({ type: 'hold' });
      break;
    case 'resume':
      if (pausedAt !== null) {
        // Counted from what the audio had been frozen for before this pause,
        // rather than added to whatever the reports have reached mid-pause, so
        // that the two cannot be counted twice. The audio's own number lands
        // in the next report; this is so the picture does not lurch in the
        // meantime.
        heldGuess = Math.max(heldGuess, heldBefore + (performance.now() - pausedAt) / 1000);
        pausedAt = null;
        mounted?.picture.setHeld(heldGuess);
      }
      toOffscreen({ type: 'resume' });
      break;
    case 'none':
      break;
  }
  if (decision.passthrough !== null) {
    toOffscreen({ type: 'passthrough', enabled: decision.passthrough });
  }
  const picture = mounted?.picture;
  if (picture === undefined) {
    return;
  }
  switch (decision.picture) {
    case 'none':
      return;
    case 'freeze':
      picture.freeze();
      return;
    case 'thaw':
      picture.thaw();
      return;
    case 'clear':
      picture.clear();
      return;
    case 'reprime':
      if (shouldReprime({ action: decision.picture, inAd, running: running() })) {
        // Down and straight back up: the frames held are from before whatever
        // just happened, and the audio has thrown its own away too.
        picture.clear();
        picture.start(delayNow(), faceWanted() ?? 'dimmed');
      }
      return;
  }
}

function onStatus(next: StatusReport): void {
  const was = report;
  report = next;
  if (next.status !== 'idle') {
    // Whatever the person had to be told, they are past it.
    hint = null;
  }
  if (next.status === 'live' && was?.status !== 'live' && next.onReady === 'continue') {
    // The picture has just jumped back by the delay, which looks like a fault
    // until somebody says it was meant.
    jumpedAt = performance.now();
  }
  // The audio is the authority on how long it was frozen: its own freeze is a
  // fraction shorter than the page's, by the twenty milliseconds the output
  // spends fading out, and matching the audio is the point. The guess made at
  // the resume is only there to bridge the gap until this report arrives.
  if (next.heldSeconds + 0.1 >= heldGuess) {
    heldGuess = next.heldSeconds;
  }
  const picture = mounted?.picture;
  const face = faceWanted();
  if (picture !== undefined) {
    if (face === null) {
      picture.clear();
      anchored = false;
    } else {
      picture.setDelay(delayNow());
      picture.setHeld(heldGuess);
      picture.setPreparing(
        next.prepare === null
          ? null
          : { fraction: next.prepare.fraction, label: prepareDetail(next) ?? 'Preparing' },
      );
      if (!anchored && next.prepare !== null && next.prepare.stage !== 'loading') {
        // The model is loaded, so the capture clock has just started: the
        // frame on screen now is the one the audio will begin from.
        picture.anchor();
        anchored = true;
      }
      if (!picture.state().active) {
        picture.start(delayNow(), face);
      } else if (next.status !== 'paused') {
        // A pause leaves the face alone; everything else follows the report.
        picture.setFace(face);
      }
    }
  }
  refresh();
}

/**
 * Re-reads the two things the player only tells anyone by restyling itself:
 * whether an ad is on, and whether it has hidden its controls.
 */
function look(): void {
  const here = mounted;
  if (here === null) {
    return;
  }
  const ad = isAdShowing(here.player);
  if (ad !== inAd) {
    inAd = ad;
    apply(ad ? 'ad-start' : 'ad-end');
  }
  here.panel.setAutohidden(isAutohidden(here.player));
}

function unmount(): void {
  const was = mounted;
  mounted = null;
  if (was === null) {
    return;
  }
  was.unwatch();
  was.picture.stop();
  was.panel.destroy();
}

function mount(): void {
  const parts = findPlayer();
  if (parts === null) {
    if (!moaned && performance.now() - startedAt > GRACE_MS) {
      moaned = true;
      // Nothing to draw over and nothing to control. The audio half is
      // unaffected: it listens for media events, not for elements.
      console.warn('kara: no video on this page, so there is no panel and no delayed picture');
    }
    return;
  }
  const panel = mountPanel(parts.player, {
    onToggle: () => {
      toggled();
    },
    onMode: (mode) => {
      setMode(mode);
    },
    onGuide: (level) => {
      setGuide(level);
    },
  });
  const picture = createDelayedPicture({ video: parts.video, container: parts.player });
  mounted = {
    player: parts.player,
    video: parts.video,
    panel,
    picture,
    unwatch: watchPlayer(parts.player, look),
  };
  look();
  sample();
  refresh();
  const face = faceWanted();
  if (face !== null) {
    // The audio was already going: this is a re-mount after the page replaced
    // its player, so the picture starts again from here.
    picture.setHeld(report?.heldSeconds ?? 0);
    picture.start(delayNow(), face);
  }
}

/** Mounted, and still attached to the page the person is looking at. */
function attached(): boolean {
  return (
    mounted !== null && mounted.panel.host.isConnected && mounted.video.isConnected
  );
}

function ensure(): void {
  if (attached()) {
    return;
  }
  unmount();
  mount();
}

function toggled(): void {
  if (running()) {
    toBackground({ type: 'request-stop' });
    return;
  }
  hint = null;
  // Without a stream id, because a click in the page is a gesture for the page
  // and not for the extension. The service worker tries anyway.
  toBackground({ type: 'request-start', streamId: null, tabId: null });
  refresh();
}

function setMode(mode: PlayMode): void {
  toOffscreen({ type: 'mode', mode });
  if (report !== null) {
    // The switch answers now and the report confirms it a moment later.
    report = { ...report, mode };
    refresh();
  }
}

function setGuide(level: number): void {
  toOffscreen({ type: 'guide', level });
  if (report !== null) {
    report = { ...report, guide: level };
  }
}

/** The rows of the table that are events the page already fires. */
type MediaEvent = Extract<
  PageEvent,
  'seeking' | 'seeked' | 'pause' | 'play' | 'ratechange' | 'ended'
>;

const MEDIA_EVENTS: readonly MediaEvent[] = [
  'seeking',
  'seeked',
  'pause',
  'play',
  'ratechange',
  'ended',
];

/**
 * Whether this event is worth acting on at all.
 *
 * `seeking` is the only one that has to be judged rather than obeyed, and it
 * is judged by arithmetic on the video's own clock: the page fires it for
 * buffering, for adopting a new source and for a quality change, none of which
 * move the person anywhere, and all of which would otherwise cost the whole
 * delay. `seeked` follows whatever its `seeking` was decided to be.
 */
function worthActingOn(event: MediaEvent): boolean {
  if (event === 'seeking') {
    const now = point();
    seeking = now !== null && isRealSeek(lastPoint, now);
    return seeking;
  }
  if (event === 'seeked') {
    const real = seeking;
    seeking = false;
    return real;
  }
  return true;
}

for (const event of MEDIA_EVENTS) {
  document.addEventListener(
    event,
    (fired) => {
      const target = fired.target;
      if (!(target instanceof HTMLMediaElement)) {
        return;
      }
      // Once a video has been adopted, only that one counts: a page full of
      // autoplaying previews would otherwise reset the pipeline all day.
      if (mounted !== null && target !== mounted.video) {
        return;
      }
      if (worthActingOn(event)) {
        apply(event);
      }
      sample();
    },
    true,
  );
}

document.addEventListener(
  'timeupdate',
  (fired) => {
    if (mounted !== null && fired.target === mounted.video) {
      sample();
    }
  },
  true,
);

chrome.runtime.onMessage.addListener((message: unknown) => {
  const body = packetFor('tab', message)?.body;
  if (body === undefined) {
    return false;
  }
  if (body.type === 'status') {
    (globalThis as unknown as ReportHolder).__karaReport = body;
    onStatus(body);
  }
  if (body.type === 'metrics') {
    (globalThis as unknown as ReportHolder).__karaReport = body;
  }
  if (body.type === 'hint') {
    hint = TOOLBAR_HINT;
    refresh();
  }
  return false;
});

setInterval(() => {
  ensure();
  sample();
  refresh();
}, TICK_MS);
ensure();
