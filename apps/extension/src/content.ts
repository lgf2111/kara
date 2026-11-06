import { analyzedFraction } from './audio/analysis.ts';
import { isRunning } from './audio/status.ts';
import type { DuetMix } from './audio/duet.ts';
import {
  normalisePracticeAnalysis,
  normalisePracticeLive,
  normalisePracticeScore,
  type PracticeAnalysis,
  type PracticeLive,
  type PracticeScore,
} from './audio/practice.ts';
import type { StemMix } from './audio/stems.ts';
import { mountAnalysisBar, type AnalysisBar } from './content/analysis-bar.ts';
import { panelView } from './content/panel-view.ts';
import { mountPanel, type Panel } from './content/panel.ts';
import { mountPracticeOverlay, type PracticeOverlay } from './content/practice-overlay.ts';
import { practiceOverlayView } from './content/practice-view.ts';
import { shouldMuteVideo } from './content/video-mute.ts';
import { findPlayer, isAdShowing, isAutohidden, watchPlayer } from './content/youtube.ts';
import { wallNowMs } from './picture/wall-clock.ts';
import { isVideoId } from './stream/player.ts';
import {
  packet,
  packetFor,
  type Command,
  type MediaSample,
  type PlayMode,
  type PracticeAnalysisReport,
  type PracticeLiveReport,
  type Request,
  type StatusReport,
  type StreamInfo,
} from './protocol.ts';

/**
 * The page's side of it: the panel, the practice overlay, the mute, and the
 * reports.
 *
 * Four things live here and nothing else does. The panel, which is the only
 * place in the page a person can see what the extension is doing or change
 * what it plays. The practice overlay, which draws the guide lane over the
 * video and is only mounted while somebody has asked for it. The video's
 * mute, which is the page's half of the vocal switch. And the media reports —
 * the video's own clock — which the stems and the score are played by.
 *
 * The delayed picture is gone, and with it every decision it needed: there is
 * no delay to hold a picture against, so there is nothing to reset and
 * nothing to judge. A seek is just the next report, with a different number
 * in it.
 *
 * It owns no selectors: every question about what YouTube's DOM looks like
 * goes through `content/youtube.ts`, so a page change breaks one small file
 * and not this one. It owns no decisions either: whether the video should be
 * muted is a pure function in `content/video-mute.ts`, and what the panel
 * should say is a function in `content/panel-view.ts`. What is left here is
 * the wiring, which is the part that cannot be unit tested and so should be
 * the part with the least thinking in it.
 */

/** How often the panel is redrawn and the mounting re-checked, in ms. */
const TICK_MS = 500;

/**
 * How often the page says where it is in the song.
 *
 * Four times a second, plus on every media event. This is the clock the stems
 * are anchored to.
 */
const MEDIA_TICK_MS = 250;

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
  __karaReport?: StatusReport;
}

interface Mounted {
  readonly player: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly panel: Panel;
  readonly analysisBar: AnalysisBar;
  readonly practiceOverlay: PracticeOverlay;
  readonly unwatch: () => void;
}

let mounted: Mounted | null = null;
let report: StatusReport | null = null;
let inAd = false;
let moaned = false;
/**
 * The practice state, as the offscreen document last reported it. Analysis is
 * the learning pass; live is the throttled microphone view while listening;
 * summary is the frozen score the end card shows after the video ends.
 */
let practice: PracticeAnalysis | null = null;
let practiceLive: PracticeLive | null = null;
let practiceSummary: PracticeScore | null = null;
let practiceFrame: number | null = null;
/** The score with every note still unhit, for a run that ended before singing. */
const NO_PRACTICE_SCORE = normalisePracticeScore(null);
/**
 * Whether the extension is the one holding the video muted. Only a mute this
 * file applied is ever taken back, so a person who muted the video themselves
 * stays muted when the toggle moves to `original`.
 */
let mutedByUs = false;
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

/** Whether the audio side is doing something the mute should matter to. */
function running(): boolean {
  return report !== null && isRunning(report.status);
}

function refresh(): void {
  mounted?.panel.update(panelView({ report, practice }));
  const ready =
    report !== null && isRunning(report.status) && !inAd
      ? analyzedFraction(report.analyzedSeconds, report.durationSeconds)
      : null;
  mounted?.analysisBar.update(ready);
}

/** Whether the overlay is on screen, including the end card after a run. */
function practiceVisible(): boolean {
  return practice !== null || practiceSummary !== null;
}

/**
 * Draws the lane from `video.currentTime`, once a frame while practice is on.
 * The live reports arrive about seventeen times a second, which is plenty for
 * a score and not nearly enough for a playhead; the clock comes from the video
 * itself, which is the same clock the score is measured against.
 */
function paintPractice(): void {
  const here = mounted;
  if (here === null || !practiceVisible()) {
    practiceFrame = null;
    return;
  }
  here.practiceOverlay.update(
    practiceOverlayView({
      analysis: practice,
      live: practiceLive,
      summary: practiceSummary,
      at: here.video.currentTime,
    }),
  );
  practiceFrame = requestAnimationFrame(paintPractice);
}

function startPracticeLoop(): void {
  if (practiceFrame === null) {
    practiceFrame = requestAnimationFrame(paintPractice);
  }
}

function startPractice(): void {
  if (mounted === null || inAd) {
    return;
  }
  practiceSummary = null;
  practiceLive = null;
  practice = {
    state: 'analyzing',
    progress: 0,
    notes: null,
    detail: 'Learning the guide melody.',
  };
  toOffscreen({ type: 'practice-start' });
  refresh();
  startPracticeLoop();
}

/**
 * Releases the microphone and takes the overlay away. The command goes to the
 * offscreen document, which owns the tracks; when it has already stopped for
 * us a closed document simply ignores it.
 */
function stopPractice(notify = true): void {
  const wasVisible = practiceVisible();
  practice = null;
  practiceLive = null;
  practiceSummary = null;
  if (notify) {
    toOffscreen({ type: 'practice-stop' });
  }
  if (wasVisible) {
    // The frame loop stops when there is nothing to draw, so the last frame
    // has to be taken down here rather than left over the video.
    mounted?.practiceOverlay.update(
      practiceOverlayView({ analysis: null, live: null, summary: null, at: 0 }),
    );
    refresh();
  }
}

/**
 * The video ended: freeze the score the last live report carried, stop the
 * microphone, and leave the end card up. The guide melody is already learnt,
 * so Sing again can start at once.
 */
function finishPractice(): void {
  if (!practiceVisible()) {
    return;
  }
  practiceSummary = practiceLive?.score ?? NO_PRACTICE_SCORE;
  practice = null;
  practiceLive = null;
  toOffscreen({ type: 'practice-stop' });
  refresh();
  startPracticeLoop();
}

function singAgain(): void {
  const here = mounted;
  if (here === null) {
    return;
  }
  here.video.currentTime = 0;
  practiceSummary = null;
  practiceLive = null;
  practice = {
    state: 'analyzing',
    progress: 0,
    notes: null,
    detail: 'Learning the guide melody.',
  };
  toOffscreen({ type: 'practice-start' });
  refresh();
  startPracticeLoop();
  void here.video.play().catch(() => undefined);
}

function onPracticeAnalysis(message: PracticeAnalysisReport): void {
  // A late progress or ready report from a run that was stopped must not put
  // the overlay back on screen; only a start begun here creates the state
  // that these reports are allowed to move.
  if (practice === null) {
    return;
  }
  const next = normalisePracticeAnalysis(message);
  practice = next;
  if (next.state !== 'ready') {
    practiceLive = null;
  }
  if (next.state === 'error') {
    practiceSummary = null;
  }
  refresh();
  startPracticeLoop();
}

function onPracticeLive(message: PracticeLiveReport): void {
  // A report can still be in flight when a run stops; it must not resurrect
  // the overlay or overwrite a frozen summary.
  if (practice === null || practice.state !== 'ready') {
    return;
  }
  practiceLive = normalisePracticeLive(message);
  startPracticeLoop();
}

/**
 * Whether the page is moving through the song.
 *
 * `paused` alone is not it: a video that is buffering, waiting for data or
 * stalled is not paused and is not moving either, and the stems must hold
 * through those just as they do through a pause.
 */
function playingNow(video: HTMLVideoElement): boolean {
  return (
    !video.paused && !video.ended && !video.seeking && video.readyState >= video.HAVE_FUTURE_DATA
  );
}

/** The mute that makes the stems the only thing heard, or not. */
function syncMute(): void {
  const video = mounted?.video;
  if (video === undefined || report === null) {
    return;
  }
  const wanted = shouldMuteVideo({
    mode: report.mode,
    status: report.status,
    covered: report.covered,
    playing: playingNow(video),
    inAd,
    rate: video.playbackRate,
  });
  if (wanted) {
    if (!video.muted) {
      video.muted = true;
      // Remember whose mute this is. A video somebody had already muted
      // themselves keeps its own state when the toggle moves back.
      mutedByUs = true;
    }
    return;
  }
  if (mutedByUs) {
    mutedByUs = false;
    if (video.muted) {
      video.muted = false;
    }
  }
}

/**
 * Tells the audio side where the page is in the song.
 *
 * Stamped on the clock both contexts share — `performance.timeOrigin +
 * performance.now()` — because each context measures `performance.now()` from
 * its own creation, so the two would otherwise be reading different numbers
 * for the same instant.
 */
function tellMedia(): void {
  const video = mounted?.video;
  if (video === undefined || !running()) {
    return;
  }
  const sampled: MediaSample = {
    wallMs: wallNowMs(),
    mediaSeconds: video.currentTime,
    playing: playingNow(video),
    rate: video.playbackRate,
    inAd,
  };
  toOffscreen({ type: 'media', sample: sampled });
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
    // Practice is a microphone and a score against the song's own timeline;
    // an ad has neither. Stop cleanly now rather than measuring an ad's clock.
    if (ad && practiceVisible()) {
      stopPractice();
    }
    // The stems go quiet for an ad and the video's own sound returns; the
    // next media report carries it, and the mute follows on this tick. The
    // readiness band hides too, because the bar underneath is now the ad's
    // timeline rather than the song's.
    tellMedia();
    refresh();
  }
  here.panel.setAutohidden(isAutohidden(here.player));
  syncMute();
}

function unmount(): void {
  const was = mounted;
  mounted = null;
  if (was === null) {
    return;
  }
  if (practiceFrame !== null) {
    cancelAnimationFrame(practiceFrame);
    practiceFrame = null;
  }
  // A replaced player, a navigation or a closed page must never leave the
  // microphone open or the video darkened.
  stopPractice();
  // Leaving a video muted after the panel is gone would be the extension
  // taking something with it.
  if (mutedByUs) {
    mutedByUs = false;
    if (was.video.muted) {
      was.video.muted = false;
    }
  }
  was.unwatch();
  was.analysisBar.destroy();
  was.panel.destroy();
  was.practiceOverlay.destroy();
}

function mount(): void {
  const parts = findPlayer();
  if (parts === null) {
    if (!moaned && performance.now() - startedAt > GRACE_MS) {
      moaned = true;
      console.warn('kara: no video on this page, so there is no panel');
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
    onMix: (mix) => {
      setMix(mix);
    },
    onKey: (semitones) => {
      setKey(semitones);
    },
    onDuetStart: () => {
      toOffscreen({ type: 'duet-start' });
    },
    onDuetMix: (mix) => {
      setDuetMix(mix);
    },
    onDuetSwap: () => {
      toOffscreen({ type: 'duet-swap' });
    },
    onDuetAnchor: (voice) => {
      const video = mounted?.video;
      if (video !== undefined) {
        toOffscreen({ type: 'duet-anchor', voice, seconds: video.currentTime });
      }
    },
    onDuetClear: () => {
      toOffscreen({ type: 'duet-clear' });
    },
    onPracticeStart: () => {
      startPractice();
    },
    onPracticeStop: () => {
      stopPractice();
    },
  });
  mounted = {
    player: parts.player,
    video: parts.video,
    panel,
    analysisBar: mountAnalysisBar(parts.player),
    practiceOverlay: mountPracticeOverlay(parts.player, {
      onSingAgain: () => {
        singAgain();
      },
      onClose: () => {
        stopPractice();
      },
    }),
    unwatch: watchPlayer(parts.player, look),
  };
  look();
  refresh();
}

/** Mounted, and still attached to the page the person is looking at. */
function attached(): boolean {
  return mounted !== null && mounted.panel.host.isConnected && mounted.video.isConnected;
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
  toBackground({ type: 'request-start', tabId: null });
  refresh();
}

function setMode(mode: PlayMode): void {
  toOffscreen({ type: 'mode', mode });
  if (report !== null) {
    // The switch answers now and the report confirms it a moment later.
    report = { ...report, mode };
    refresh();
    syncMute();
  }
}

/**
 * The mixer answers now and the report confirms it a moment later, the same
 * way the mode switch does. The panel draws the slider from the report, and a
 * slider that waited for a round trip would fight the thumb.
 */
function setMix(mix: StemMix): void {
  toOffscreen({ type: 'mix', mix });
  if (report !== null) {
    report = { ...report, mix };
    refresh();
  }
}

/** The duet desk answers now the same way; the engine confirms it. */
function setDuetMix(mix: DuetMix): void {
  toOffscreen({ type: 'duet-mix', mix });
  if (report !== null && report.duet !== undefined) {
    report = { ...report, duet: { ...report.duet, mix } };
    refresh();
  }
}

/**
 * The key, which moves the session and not the remembered default: a nudge
 * for one song is not a decision about every song after it, and the popup is
 * where a decision about those is made.
 */
function setKey(semitones: number): void {
  toOffscreen({ type: 'key', semitones });
  if (report !== null) {
    report = { ...report, semitones };
    refresh();
  }
}

function onStatus(next: StatusReport): void {
  report = next;
  // Practice belongs to a live karaoke session. If that session stops or
  // dies, the microphone goes with it rather than scoring a video whose stems
  // are gone.
  if (
    (next.status === 'idle' || next.status === 'error' || next.status === 'unsupported') &&
    practiceVisible()
  ) {
    stopPractice();
  }
  refresh();
  syncMute();
}

/** The video ended: the session's work is done, and the original sound is back. */
function onEnded(): void {
  if (practiceVisible()) {
    finishPractice();
  }
  if (report !== null && report.mode === 'instrumental') {
    setMode('original');
  }
}

/**
 * The bridge from the MAIN world script that finds the page's audio stream.
 *
 * A MAIN world script has no Chrome API, so it speaks through
 * `window.postMessage`, which both worlds can see. Anything else on the page
 * can post the same tag, so the message is read with the same suspicion as
 * everything the page says: the shape is checked here, and what is done with
 * it is the service worker's decision.
 */
window.addEventListener('message', (event) => {
  const message = event.data as { kara?: unknown; stream?: unknown } | null;
  if (message === null || typeof message !== 'object' || message.kara !== 'kara/1') {
    return;
  }
  const stream = message.stream as Partial<StreamInfo> | undefined;
  if (
    stream === undefined ||
    !isVideoId(stream.videoId) ||
    typeof stream.url !== 'string' ||
    !stream.url.startsWith('https://') ||
    typeof stream.mimeType !== 'string'
  ) {
    return;
  }
  // The page may still be finishing the previous video, or playing an ad, and
  // the address bar may be a moment behind the player on a related-video
  // click. Nothing is decided here: the service worker files the stream under
  // its own video id and only uses the one the tab is actually showing.
  toBackground({
    type: 'request-stream',
    stream: {
      videoId: stream.videoId,
      url: stream.url,
      mimeType: stream.mimeType,
      ...(typeof stream.bitrate === 'number' ? { bitrate: stream.bitrate } : {}),
      ...(typeof stream.contentLength === 'string'
        ? { contentLength: stream.contentLength }
        : {}),
    },
  });
});

// The page world may have resolved the stream before this script existed: it
// starts at document_start, and a VISIONOS answer can land within a second.
// Asking for the last one costs a message and can save the session.
window.postMessage({ kara: 'kara/1', request: 'stream' }, '*');

chrome.runtime.onMessage.addListener((message: unknown) => {
  const body = packetFor('tab', message)?.body;
  if (body === undefined) {
    return false;
  }
  if (body.type === 'status') {
    (globalThis as unknown as ReportHolder).__karaReport = body;
    onStatus(body);
  }
  if (body.type === 'practice-analysis') {
    onPracticeAnalysis(body);
  }
  if (body.type === 'practice-live') {
    onPracticeLive(body);
  }
  return false;
});

// The video ending is the one media event with a decision in it: the stems
// end with it, and nobody should meet the end screen in silence.
document.addEventListener(
  'ended',
  (fired) => {
    if (mounted !== null && fired.target === mounted.video) {
      onEnded();
    }
  },
  true,
);

// Media events are how the mute and the reports stay in step at the boundary
// rather than up to a quarter of a second later.
for (const event of ['pause', 'play', 'ratechange', 'seeking', 'seeked'] as const) {
  document.addEventListener(
    event,
    (fired) => {
      if (mounted === null || fired.target !== mounted.video) {
        return;
      }
      syncMute();
      tellMedia();
    },
    true,
  );
}

// If somebody unmutes the video while the stems are playing, they have asked
// for the video's own sound. The mute control is the page's, so it wins: the
// session moves to `original` and the toggle follows, rather than the next
// tick muting them again.
document.addEventListener(
  'volumechange',
  (fired) => {
    if (mounted === null || fired.target !== mounted.video || mounted.video.muted) {
      return;
    }
    if (!mutedByUs) {
      return;
    }
    mutedByUs = false;
    if (running() && report?.mode === 'instrumental') {
      setMode('original');
    }
  },
  true,
);

setInterval(() => {
  ensure();
  syncMute();
  refresh();
}, TICK_MS);

// A page that is being torn down must not leave the microphone open behind it.
window.addEventListener('pagehide', () => {
  if (practiceVisible()) {
    stopPractice();
  }
});

// Faster than the panel, because this one is load-bearing: the stems are
// anchored to these.
setInterval(tellMedia, MEDIA_TICK_MS);
ensure();
