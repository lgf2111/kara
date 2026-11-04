import {
  CROSSFADE_SECONDS,
  FADE_IN_SECONDS,
  gainAt,
  heldGain,
  rampTo,
  type GainRamp,
} from '../audio/mix-gain.ts';
import { createFrameRing, frameBytes, type Held } from './frame-ring.ts';
import { wallMsOf, wallNowMs } from './wall-clock.ts';

/**
 * The picture, eighteen seconds late, drawn over the one the page is playing.
 *
 * The audio half of this extension cannot be fast. A window of separated
 * audio is only final once the next one has been run, so what comes out of the
 * player is the tab's audio as it was about eighteen seconds ago. Sung over a
 * picture that is live, that is useless: the words arrive after the mouth has
 * finished saying them. So the picture is delayed to meet it.
 *
 * How, in one paragraph. Every displayed frame of the real video is copied
 * into an `ImageBitmap`, downscaled to about 640 px wide, at about fifteen a
 * second, and kept with the instant it was displayed at — `wall-clock.ts` says
 * which instant and why that is the clock. An overlay canvas sits over the
 * video and paints, on every animation frame, the newest frame that was on
 * screen at `now - delay`. The real video is hidden, with opacity rather than
 * by pausing it: it has to keep playing, because it is the thing producing the
 * frames and the audio being captured.
 *
 * Four decisions in it are worth stating.
 *
 * **The overlay takes no input.** `pointer-events: none`, and it is appended
 * inside the player at a z-index above the video and below everything the page
 * draws on top of it. The page's own controls, keyboard shortcuts and context
 * menu carry on working, because every event still lands on the page's own
 * elements. Hiding the video and showing our canvas changes what is on screen
 * and nothing else.
 *
 * **It follows the video's displayed rect, not the player's.** A player is
 * usually wider than the picture in it, and the difference is the letterbox.
 * So the canvas is positioned on the video element's rect, and the frame is
 * fitted inside it the way the browser fits a video: contained, centred, black
 * either side. Theatre mode, fullscreen and a window drag all come through a
 * `ResizeObserver`.
 *
 * **It has three faces, and which one is up is the `onReady` setting.** While
 * the audio gets ready there is no frame old enough to show, and there is
 * nothing to be done about that; what there is a choice about is what to show
 * instead.
 *
 * - `dimmed` holds one still frame — the one that was on screen at the instant
 *   the audio capture began — behind a progress bar. When the audio arrives,
 *   the dim fades off and the picture carries on from that same frame, so
 *   nothing jumps. This is `restart`.
 * - `hidden` keeps the canvas off the page entirely and lets the person watch
 *   the real video, undelayed, while frames are collected behind it. When the
 *   audio arrives the canvas dissolves in over about eight tenths of a second,
 *   which is a picture jumping back by the delay, and the panel says so. This
 *   is `continue`.
 * - `live` is the delayed picture.
 *
 * Both fades are the tested curves in `audio/mix-gain.ts`, read on the wall
 * clock instead of the audio one.
 *
 * **A pause shifts the delay rather than resetting it.** The page stops
 * producing frames and the audio stops being fed, so when both start again
 * every frame held is still good and the audio is still exactly where it was:
 * what has changed is that the wall clock moved on while neither did. So the
 * frame to paint is the one from `now - delay - held`, where `held` is how
 * long the *audio* was frozen, reported by the player. Its own freeze is a
 * fraction shorter than the page's, by the twenty milliseconds the output
 * spends fading out, and matching the audio is the point.
 *
 * Used by the content script on YouTube and by the debug page on a local
 * fixture. It knows nothing about either: a `<video>`, something to put the
 * canvas in, and a delay.
 */

/**
 * What to delay by until the audio side reports what it measured. It reports
 * about eighteen; starting on a guess means the first frames are kept from the
 * moment capture starts rather than from the moment the first block arrives,
 * which is eighteen seconds too late to start keeping them.
 */
export const DEFAULT_DELAY_SECONDS = 18;

/** Frames are downscaled to this width, which is what the budget is for. */
const MAX_WIDTH = 640;

/** Frames a second kept. Enough to read a face by, cheap enough to hold. */
const FRAMES_PER_SECOND = 15;

/** Above the video, below the player's own furniture. */
const OVERLAY_Z_INDEX = 10;

/** How often the canvas re-checks where the video is, in ms. */
const GEOMETRY_MS = 250;

/** `createImageBitmap` calls allowed in flight at once. */
const PENDING_LIMIT = 2;

/** How black the still frame goes while the audio gets ready. */
const DIM_ALPHA = 0.55;

/** Which face is on screen. */
export type PictureFace = 'dimmed' | 'hidden' | 'live';

/** What the overlay says while it is waiting, straight from the audio side. */
export interface PreparingView {
  /** Nought to one. */
  readonly fraction: number;
  readonly label: string;
}

export interface DelayedPictureOptions {
  /** The page's video. Hidden while the overlay is up, never paused. */
  readonly video: HTMLVideoElement;
  /** Where the canvas is appended. The player, so fullscreen carries it. */
  readonly container: HTMLElement;
  readonly maxWidth?: number;
  readonly fps?: number;
  readonly budgetBytes?: number;
  readonly zIndex?: number;
  /** The clock, for a test that would rather not wait eighteen seconds. */
  readonly now?: () => number;
}

export interface PictureState {
  readonly active: boolean;
  readonly face: PictureFace;
  readonly frozen: boolean;
  /** Nothing is old enough to paint yet, so a still frame is showing. */
  readonly priming: boolean;
  readonly frames: number;
  readonly bytes: number;
  /** Frames thrown away because the budget was spent. */
  readonly dropped: number;
  /** The delay being aimed at, which is the audio's. */
  readonly delaySeconds: number;
  /** Seconds the audio has been frozen by pauses, which is added to it. */
  readonly heldSeconds: number;
  /** When the frame now on the canvas was displayed, on the wall clock. */
  readonly paintedStampMs: number | null;
  /** The still frame `dimmed` holds, or null before the audio started. */
  readonly anchorStampMs: number | null;
  /**
   * How far the painted frame is from where the delay says it should be, in
   * seconds. Positive means the picture is later than asked, negative means
   * earlier — which is what a budget too small for the delay looks like. In
   * the harness, where the real video plays undelayed next to the delayed
   * audio, this is the picture-to-audio offset.
   */
  readonly offsetSeconds: number | null;
}

export interface DelayedPicture {
  /** Starts keeping frames, with the given face on screen. */
  start: (delaySeconds: number, face?: PictureFace) => void;
  setDelay: (seconds: number) => void;
  /** Seconds the audio has spent frozen, which the picture is shifted by. */
  setHeld: (seconds: number) => void;
  /** Swaps the face, fading rather than cutting on the way to `live`. */
  setFace: (face: PictureFace) => void;
  /** What the progress bar on the dimmed face says. */
  setPreparing: (view: PreparingView | null) => void;
  /**
   * Pins the still frame to whatever is on screen now, which is the instant
   * the audio capture began. What `restart` holds, and where it carries on
   * from.
   */
  anchor: () => void;
  /** Holds the frame on screen and stops keeping new ones, for a pause. */
  freeze: () => void;
  /** Carries on from it, for a resume. */
  thaw: () => void;
  /** Frames gone, canvas down, the real video visible again. */
  clear: () => void;
  stop: () => void;
  state: () => PictureState;
}

interface FrameMetadata {
  readonly expectedDisplayTime: number;
}

/**
 * `requestVideoFrameCallback` is in every Chromium this extension can run on
 * and in none of TypeScript's DOM libraries, so it is named here.
 */
interface FrameSource {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: FrameMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const NOWHERE: Rect = { left: 0, top: 0, width: 0, height: 0 };

function same(one: Rect, other: Rect): boolean {
  return (
    Math.abs(one.left - other.left) < 0.5 &&
    Math.abs(one.top - other.top) < 0.5 &&
    Math.abs(one.width - other.width) < 0.5 &&
    Math.abs(one.height - other.height) < 0.5
  );
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createDelayedPicture(options: DelayedPictureOptions): DelayedPicture {
  const video = options.video;
  const container = options.container;
  const maxWidth = positive(options.maxWidth, MAX_WIDTH);
  const fps = positive(options.fps, FRAMES_PER_SECOND);
  const clock = options.now ?? wallNowMs;
  const ring = createFrameRing<ImageBitmap>(
    options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes },
  );

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'absolute';
  canvas.style.pointerEvents = 'none';
  canvas.style.background = '#000';
  canvas.style.zIndex = String(positive(options.zIndex, OVERLAY_Z_INDEX));
  const brush = canvas.getContext('2d', { alpha: false });

  let active = false;
  let frozen = false;
  let priming = true;
  let face: PictureFace = 'dimmed';
  let delaySeconds = DEFAULT_DELAY_SECONDS;
  let heldSeconds = 0;
  let preparing: PreparingView | null = null;
  let painted: Held<ImageBitmap> | null = null;
  let paintedStamp: number | null = null;
  /** The still frame the dimmed face holds: where the audio capture began. */
  let anchorStamp: number | null = null;
  let lastKept = 0;
  let pending = 0;
  let rect: Rect = NOWHERE;
  let measuredAt = 0;
  /** The video's own inline opacity, to put back. Null when not hidden. */
  let hiddenOpacity: string | null = null;
  let videoHidden = false;
  let mounted = false;
  let paintHandle: number | null = null;
  let cancelFrames: (() => void) | null = null;
  /** How dimmed the still frame is, from one to nought as the audio arrives. */
  let dim: GainRamp = heldGain(1);
  /** The canvas's own opacity, for dissolving in over the real video. */
  let shown: GainRamp = heldGain(1);
  /**
   * What the waiting face is already showing, so that it is not redrawn sixty
   * times a second for eighteen seconds to say the same thing.
   */
  let drawnAs = '';

  const sizes = new ResizeObserver(() => {
    measure(true);
  });

  const onViewChange = (): void => {
    measure(true);
  };

  /** The instant the painted frame should be from. */
  function wantedStamp(now: number): number {
    return now - (delaySeconds + heldSeconds) * 1000;
  }

  function drawFrame(bitmap: ImageBitmap): void {
    if (brush === null) {
      return;
    }
    const width = canvas.width;
    const height = canvas.height;
    brush.fillStyle = '#000';
    brush.fillRect(0, 0, width, height);
    if (bitmap.width === 0 || bitmap.height === 0) {
      return;
    }
    // Contained and centred, the way a browser fits a video into a box, so
    // the overlay letterboxes exactly where the video did.
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const drawn = { width: bitmap.width * scale, height: bitmap.height * scale };
    brush.drawImage(
      bitmap,
      (width - drawn.width) / 2,
      (height - drawn.height) / 2,
      drawn.width,
      drawn.height,
    );
  }

  /** The still frame: the anchor if there is one, the newest until there is. */
  function stillFrame(): Held<ImageBitmap> | null {
    if (anchorStamp !== null) {
      return ring.at(anchorStamp) ?? ring.oldest();
    }
    return ring.newest();
  }

  function drawBar(alpha: number): void {
    const view = preparing;
    if (brush === null || view === null || alpha <= 0) {
      return;
    }
    const width = Math.max(120, Math.round(canvas.width * 0.5));
    const height = Math.max(4, Math.round(canvas.height * 0.012));
    const left = Math.round((canvas.width - width) / 2);
    const top = Math.round(canvas.height / 2);
    brush.globalAlpha = alpha;
    brush.fillStyle = 'rgba(255, 255, 255, 0.28)';
    brush.fillRect(left, top, width, height);
    brush.fillStyle = '#ffd682';
    brush.fillRect(left, top, Math.round(width * Math.min(1, Math.max(0, view.fraction))), height);
    const size = Math.max(13, Math.round(canvas.height * 0.045));
    brush.fillStyle = '#fff';
    brush.font = `600 ${String(size)}px system-ui, -apple-system, sans-serif`;
    brush.textAlign = 'center';
    brush.textBaseline = 'bottom';
    brush.fillText(view.label, canvas.width / 2, top - size * 0.6);
    brush.globalAlpha = 1;
  }

  /** The dim, wherever its fade has got to, over whatever was just drawn. */
  function dimOver(now: number): number {
    const alpha = gainAt(dim, now / 1000);
    if (brush !== null && alpha > 0) {
      brush.fillStyle = `rgba(0, 0, 0, ${String(DIM_ALPHA * alpha)})`;
      brush.fillRect(0, 0, canvas.width, canvas.height);
    }
    return alpha;
  }

  function drawWaiting(now: number): void {
    if (brush === null) {
      return;
    }
    const still = stillFrame();
    if (still === null) {
      brush.fillStyle = '#000';
      brush.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      drawFrame(still.frame);
    }
    drawBar(dimOver(now));
  }

  function repaint(now: number): void {
    if (painted !== null && !priming) {
      drawFrame(painted.frame);
      return;
    }
    drawWaiting(now);
  }

  function measure(force: boolean): void {
    measuredAt = clock();
    if (!active || !mounted) {
      return;
    }
    const box = video.getBoundingClientRect();
    const around = container.getBoundingClientRect();
    const next: Rect = {
      left: box.left - around.left,
      top: box.top - around.top,
      width: box.width,
      height: box.height,
    };
    if (!force && same(next, rect)) {
      return;
    }
    rect = next;
    canvas.style.left = `${String(Math.round(next.left))}px`;
    canvas.style.top = `${String(Math.round(next.top))}px`;
    canvas.style.width = `${String(Math.round(next.width))}px`;
    canvas.style.height = `${String(Math.round(next.height))}px`;
    // Resizing the backing store clears it, so whatever was on screen has to
    // be put back in the same turn or the overlay flashes black on every drag.
    canvas.width = Math.max(1, Math.round(next.width));
    canvas.height = Math.max(1, Math.round(next.height));
    drawnAs = '';
    repaint(measuredAt);
  }

  function keptSize(): { readonly width: number; readonly height: number } | null {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) {
      return null;
    }
    const scale = Math.min(1, maxWidth / width);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function keep(stamp: number): void {
    if (pending >= PENDING_LIMIT || stamp - lastKept < 1000 / fps - 1) {
      return;
    }
    const size = keptSize();
    if (size === null) {
      return;
    }
    lastKept = stamp;
    pending += 1;
    createImageBitmap(video, {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: 'low',
    })
      .then((bitmap) => {
        pending -= 1;
        if (!active) {
          bitmap.close();
          return;
        }
        ring.push(bitmap, stamp, frameBytes(bitmap.width, bitmap.height));
      })
      .catch(() => {
        // A frame that would not decode is one frame. The next one will.
        pending -= 1;
      });
  }

  function scheduleFrames(): void {
    const source = video as unknown as FrameSource;
    const onFrame = source.requestVideoFrameCallback;
    if (onFrame !== undefined) {
      const handle = onFrame.call(video, (_now, metadata) => {
        cancelFrames = null;
        if (!active || frozen) {
          return;
        }
        // `expectedDisplayTime` is when the page shows this frame, which is
        // the instant the picture has to be matched to.
        keep(wallMsOf(metadata.expectedDisplayTime));
        scheduleFrames();
      });
      cancelFrames = () => {
        source.cancelVideoFrameCallback?.(handle);
      };
      return;
    }
    // No `requestVideoFrameCallback`: sample on the animation clock and stamp
    // with now, which is a frame or so out and still better than nothing.
    const handle = requestAnimationFrame(() => {
      cancelFrames = null;
      if (!active || frozen) {
        return;
      }
      keep(clock());
      scheduleFrames();
    });
    cancelFrames = () => {
      cancelAnimationFrame(handle);
    };
  }

  function stopFrames(): void {
    cancelFrames?.();
    cancelFrames = null;
  }

  /**
   * The canvas is only on the page when it has something to show. While the
   * real video is what the person is watching it is not in the document at
   * all, which is cheaper than a transparent canvas over the top and leaves
   * nothing to get in the way.
   */
  function mount(): void {
    if (mounted) {
      return;
    }
    // A canvas can only be positioned on the player if the player is a
    // positioning context. YouTube's is; a plain page's may not be.
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.append(canvas);
    mounted = true;
    drawnAs = '';
    measure(true);
  }

  function unmount(): void {
    if (!mounted) {
      return;
    }
    canvas.remove();
    mounted = false;
    rect = NOWHERE;
  }

  function hideVideo(): void {
    if (videoHidden) {
      return;
    }
    hiddenOpacity ??= video.style.opacity;
    video.style.opacity = '0';
    videoHidden = true;
  }

  function showVideo(): void {
    if (!videoHidden) {
      return;
    }
    video.style.opacity = hiddenOpacity ?? '';
    hiddenOpacity = null;
    videoHidden = false;
  }

  function paint(): void {
    paintHandle = requestAnimationFrame(paint);
    const now = clock();
    if (now - measuredAt >= GEOMETRY_MS) {
      measure(false);
    }
    if (face === 'hidden') {
      // The real video is what the person is watching; frames are being kept
      // behind it and nothing is painted.
      priming = true;
      return;
    }
    // Opacity below one is the dissolve from the real video to the delayed
    // one, so the video underneath has to stay visible until it lands.
    const opacity = gainAt(shown, now / 1000);
    canvas.style.opacity = String(opacity);
    if (opacity >= 1) {
      hideVideo();
    } else {
      showVideo();
    }
    if (frozen) {
      return;
    }
    const wanted = wantedStamp(now);
    if (face === 'live') {
      ring.trim(wanted);
    }
    const chosen = face === 'live' ? ring.at(wanted) : null;
    if (chosen === null) {
      priming = true;
      // Redrawn only when it would say something different: this runs sixty
      // times a second for as long as getting ready takes.
      const fading = !fadeDone(now);
      const state = `${String(stillFrame()?.stamp ?? 0)}/${String(preparing?.label ?? '')}/${String(
        Math.round((preparing?.fraction ?? 0) * 200),
      )}/${fading ? String(Math.round(now)) : 'still'}`;
      if (state !== drawnAs) {
        drawnAs = state;
        drawWaiting(now);
      }
      return;
    }
    priming = false;
    if (chosen.stamp !== paintedStamp || !fadeDone(now)) {
      painted = chosen;
      paintedStamp = chosen.stamp;
      drawFrame(chosen.frame);
      // The dim fades off over the delayed picture rather than over the still
      // frame it was holding: by now the two are the same frame.
      dimOver(now);
    }
  }

  function fadeDone(now: number): boolean {
    const at = now / 1000;
    return gainAt(dim, at) === dim.to && gainAt(shown, at) === shown.to;
  }

  function stopPainting(): void {
    if (paintHandle !== null) {
      cancelAnimationFrame(paintHandle);
      paintHandle = null;
    }
  }

  /** The face, and the two fades that are the difference between them. */
  function wear(next: PictureFace): void {
    if (next === face) {
      return;
    }
    const now = clock() / 1000;
    const was = face;
    face = next;
    if (next === 'hidden') {
      dim = heldGain(1);
      shown = heldGain(1);
      canvas.style.opacity = '1';
      showVideo();
      unmount();
      return;
    }
    if (next === 'dimmed') {
      dim = heldGain(1);
      shown = heldGain(1);
      canvas.style.opacity = '1';
      drawnAs = '';
      mount();
      return;
    }
    // Going live. From the dimmed still frame, the dim fades off and the
    // picture carries on from the frame it was holding. From the real video,
    // the canvas dissolves in over the top of it — and its opacity is set
    // before it is appended, or the first animation frame is a hard cut.
    if (was === 'hidden') {
      shown = rampTo(heldGain(0), 1, now, CROSSFADE_SECONDS, 'power-in');
      dim = heldGain(0);
      canvas.style.opacity = '0';
    } else {
      dim = rampTo(dim, 0, now, FADE_IN_SECONDS, 'smooth');
      shown = heldGain(1);
    }
    mount();
  }

  function down(): void {
    active = false;
    frozen = false;
    priming = true;
    face = 'dimmed';
    stopFrames();
    stopPainting();
    sizes.disconnect();
    ring.clear();
    painted = null;
    paintedStamp = null;
    anchorStamp = null;
    heldSeconds = 0;
    preparing = null;
    dim = heldGain(1);
    shown = heldGain(1);
    canvas.style.opacity = '1';
    lastKept = 0;
    drawnAs = '';
    unmount();
    showVideo();
  }

  window.addEventListener('resize', onViewChange);
  document.addEventListener('fullscreenchange', onViewChange);

  return {
    start(seconds, wanted = 'dimmed') {
      delaySeconds = positive(seconds, DEFAULT_DELAY_SECONDS);
      if (active) {
        frozen = false;
        if (cancelFrames === null) {
          scheduleFrames();
        }
        wear(wanted);
        return;
      }
      active = true;
      frozen = false;
      priming = true;
      heldSeconds = 0;
      // The face a start opens on is worn rather than faded into: there is
      // nothing on screen yet for a fade to come from.
      face = wanted;
      dim = heldGain(wanted === 'live' ? 0 : 1);
      shown = heldGain(1);
      canvas.style.opacity = '1';
      if (face !== 'hidden') {
        mount();
      }
      sizes.observe(video);
      sizes.observe(container);
      scheduleFrames();
      paint();
    },

    setDelay(seconds) {
      delaySeconds = positive(seconds, delaySeconds);
    },

    setHeld(seconds) {
      heldSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : heldSeconds;
    },

    setFace(next) {
      if (active) {
        wear(next);
      }
    },

    setPreparing(view) {
      preparing = view;
    },

    anchor() {
      // Whatever is on screen now. Frames arrive through a promise, so the
      // newest one held may be a frame or two behind the instant asked for,
      // which is near enough: the ring is picked from by stamp, not by index.
      anchorStamp = ring.newest()?.stamp ?? clock();
      drawnAs = '';
    },

    freeze() {
      if (!active) {
        return;
      }
      // The frame stays where it is and no more are kept. A paused video is
      // producing none anyway; what this stops is the picture sliding on
      // while the page stands still.
      frozen = true;
      stopFrames();
    },

    thaw() {
      if (!active || !frozen) {
        return;
      }
      // Everything held is still good: a stamp is a wall instant and the audio
      // has been shifted by the same pause, which arrives as `setHeld`.
      frozen = false;
      if (cancelFrames === null) {
        scheduleFrames();
      }
    },

    clear() {
      down();
    },

    stop() {
      down();
      window.removeEventListener('resize', onViewChange);
      document.removeEventListener('fullscreenchange', onViewChange);
    },

    state() {
      const now = clock();
      return {
        active,
        face,
        frozen,
        priming,
        frames: ring.frames,
        bytes: ring.bytes,
        dropped: ring.dropped,
        delaySeconds,
        heldSeconds,
        paintedStampMs: paintedStamp,
        anchorStampMs: anchorStamp,
        offsetSeconds:
          paintedStamp === null
            ? null
            : (now - paintedStamp) / 1000 - (delaySeconds + heldSeconds),
      };
    },
  };
}
