import { decidePageEvent, shouldReprime, type PageEvent } from './content/page-events.ts';
import { panelView, TOOLBAR_HINT } from './content/panel-view.ts';
import { mountPanel, type Panel } from './content/panel.ts';
import { findPlayer, isAdShowing, isAutohidden, watchPlayer } from './content/youtube.ts';
import {
  createDelayedPicture,
  DEFAULT_DELAY_SECONDS,
  type DelayedPicture,
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
 * place a person can see what the extension is doing or change what it plays.
 * The delayed picture, which holds the video back by the same amount the audio
 * is held back by, so that the two agree. The media events — a seek, a pause,
 * a resume, a rate change — each of which means the separated audio in flight
 * belongs to a timeline nobody is on any more. And the ad transitions, which
 * mean the same thing and also that the person should be allowed to hear the
 * ad.
 *
 * It owns no selectors: every question about what YouTube's DOM looks like
 * goes through `content/youtube.ts`, so a page change breaks one small file
 * and not this one. It owns no decisions either: what an event means is a
 * table in `content/page-events.ts`, and what the panel should say is a
 * function in `content/panel-view.ts`. What is left here is the wiring, which
 * is the part that cannot be unit tested and so should be the part with the
 * least thinking in it.
 *
 * Two shapes of the page are worth knowing about. Media events do not bubble,
 * so the listeners are on the document in the capture phase: that catches them
 * wherever they are targeted, which matters on a site that replaces its video
 * element whenever it feels like it. And because it does that, the panel and
 * the overlay are re-mounted whenever either turns out to have been torn out
 * from under them, which is cheaper and far more reliable than listening for
 * the site's own navigation events.
 */

/** How often the panel is redrawn and the mounting re-checked, in ms. */
const TICK_MS = 500;

/**
 * How long a page is allowed to have no video in it before that is worth a
 * line in the console. Every watch page starts that way for a moment.
 */
const GRACE_MS = 10_000;

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
/** When that report arrived, so the priming countdown can tick between them. */
let reportAt = performance.now();
let hint: string | null = null;
let inAd = false;
let moaned = false;
const startedAt = performance.now();

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
  return report?.status === 'priming' || report?.status === 'live';
}

/** The delay to aim at: what was measured, or the guess until it is. */
function delayNow(): number {
  return report?.delaySeconds ?? DEFAULT_DELAY_SECONDS;
}

function refresh(): void {
  mounted?.panel.update(
    panelView({ report, sinceMs: performance.now() - reportAt, hint }),
  );
}

function apply(event: PageEvent): void {
  const decision = decidePageEvent(event);
  if (decision.reset !== null) {
    toOffscreen({ type: 'reset', reason: decision.reset });
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
    case 'clear':
      picture.clear();
      return;
    case 'reprime':
      if (shouldReprime({ action: decision.picture, inAd, running: running() })) {
        // Down and straight back up: the frames held are from before whatever
        // just happened, and the audio has thrown its own away too.
        picture.clear();
        picture.start(delayNow());
      }
      return;
  }
}

function onStatus(next: StatusReport): void {
  report = next;
  reportAt = performance.now();
  if (next.status !== 'idle') {
    // Whatever the person had to be told, they are past it.
    hint = null;
  }
  const picture = mounted?.picture;
  if (picture !== undefined) {
    if (!running() || inAd) {
      picture.clear();
    } else if (picture.state().frozen) {
      // A pause reports priming, and a frozen picture should stay frozen
      // until the page plays again.
      picture.setDelay(delayNow());
    } else {
      picture.start(delayNow());
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
  refresh();
  if (running() && !inAd) {
    // The audio was already going: this is a re-mount after the page replaced
    // its player, so the picture starts again from here.
    picture.start(delayNow());
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
  toBackground({ type: 'request-start' });
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
      apply(event);
    },
    true,
  );
}

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
  refresh();
}, TICK_MS);
ensure();
