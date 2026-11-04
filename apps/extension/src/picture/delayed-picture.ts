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
 * Three decisions in it are worth stating.
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
 * **While priming it dims rather than freezes.** For the first `delay` seconds
 * there is no frame old enough to show, and there is nothing to be done about
 * that. It shows the newest frame instead, dimmed, with the seconds counting
 * down, so the person can see the video is running and see how long the wait
 * is. When the countdown reaches zero the picture steps back by the delay — at
 * the same moment the audio starts playing from the same instant, which is the
 * point of all of it.
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

const DIM = 'rgba(0, 0, 0, 0.55)';

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
  readonly frozen: boolean;
  /** Nothing is old enough to paint yet, so the dimmed frame is showing. */
  readonly priming: boolean;
  readonly frames: number;
  readonly bytes: number;
  /** Frames thrown away because the budget was spent. */
  readonly dropped: number;
  /** The delay being aimed at, which is the audio's. */
  readonly delaySeconds: number;
  /** When the frame now on the canvas was displayed, on the wall clock. */
  readonly paintedStampMs: number | null;
  /**
   * How far the painted frame is from where the delay says it should be, in
   * seconds. Positive means the picture is later than asked, negative means
   * earlier — which is what a budget too small for the delay looks like. In
   * the harness, where the real video plays undelayed next to the delayed
   * audio, this is the picture-to-audio offset.
   */
  readonly offsetSeconds: number | null;
  readonly secondsLeft: number;
}

export interface DelayedPicture {
  /** Hides the video, puts the canvas up, and starts keeping frames. */
  start: (delaySeconds: number) => void;
  setDelay: (seconds: number) => void;
  /** Holds the frame on screen and stops keeping new ones, for a pause. */
  freeze: () => void;
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
  let delaySeconds = DEFAULT_DELAY_SECONDS;
  let painted: Held<ImageBitmap> | null = null;
  let paintedStamp: number | null = null;
  /** The first frame kept since the last start, which the countdown is from. */
  let firstStamp: number | null = null;
  let lastKept = 0;
  let pending = 0;
  let rect: Rect = NOWHERE;
  let measuredAt = 0;
  /** The video's own inline opacity, to put back. Null when not hidden. */
  let hiddenOpacity: string | null = null;
  let paintHandle: number | null = null;
  let cancelFrames: (() => void) | null = null;
  /**
   * What the dimmed frame is already showing, so that it is not redrawn sixty
   * times a second for eighteen seconds to say the same thing.
   */
  let shownSecond = -1;
  let shownNewest: number | null = null;

  const sizes = new ResizeObserver(() => {
    measure(true);
  });

  const onViewChange = (): void => {
    measure(true);
  };

  function secondsLeft(now: number): number {
    if (firstStamp === null) {
      return delaySeconds;
    }
    return Math.max(0, delaySeconds - (now - firstStamp) / 1000);
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

  function drawPriming(now: number): void {
    if (brush === null) {
      return;
    }
    const newest = ring.newest();
    if (newest === null) {
      brush.fillStyle = '#000';
      brush.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      drawFrame(newest.frame);
    }
    brush.fillStyle = DIM;
    brush.fillRect(0, 0, canvas.width, canvas.height);
    const size = Math.max(14, Math.round(canvas.height * 0.055));
    brush.fillStyle = '#fff';
    brush.font = `600 ${String(size)}px system-ui, -apple-system, sans-serif`;
    brush.textAlign = 'center';
    brush.textBaseline = 'middle';
    brush.fillText(
      `Preparing ${String(Math.ceil(secondsLeft(now)))} s`,
      canvas.width / 2,
      canvas.height / 2,
    );
  }

  function repaint(now: number): void {
    if (painted !== null && !priming) {
      drawFrame(painted.frame);
      return;
    }
    drawPriming(now);
  }

  function measure(force: boolean): void {
    measuredAt = clock();
    if (!active) {
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
        firstStamp ??= stamp;
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

  function paint(): void {
    paintHandle = requestAnimationFrame(paint);
    const now = clock();
    if (now - measuredAt >= GEOMETRY_MS) {
      measure(false);
    }
    if (frozen) {
      return;
    }
    const wanted = now - delaySeconds * 1000;
    ring.trim(wanted);
    // Once the countdown has run out something is always painted: if the
    // frame the delay asked for has been evicted, the oldest frame held is as
    // close to it as this budget can get, and `offsetSeconds` says by how far.
    const chosen = ring.at(wanted) ?? (secondsLeft(now) > 0 ? null : ring.oldest());
    if (chosen === null) {
      priming = true;
      const second = Math.ceil(secondsLeft(now));
      const newest = ring.newest()?.stamp ?? null;
      if (second !== shownSecond || newest !== shownNewest) {
        shownSecond = second;
        shownNewest = newest;
        drawPriming(now);
      }
      return;
    }
    priming = false;
    if (chosen.stamp !== paintedStamp) {
      painted = chosen;
      paintedStamp = chosen.stamp;
      drawFrame(chosen.frame);
    }
  }

  function stopPainting(): void {
    if (paintHandle !== null) {
      cancelAnimationFrame(paintHandle);
      paintHandle = null;
    }
  }

  function hideVideo(): void {
    hiddenOpacity ??= video.style.opacity;
    video.style.opacity = '0';
  }

  function showVideo(): void {
    if (hiddenOpacity !== null) {
      video.style.opacity = hiddenOpacity;
      hiddenOpacity = null;
    }
  }

  function down(): void {
    active = false;
    frozen = false;
    priming = true;
    stopFrames();
    stopPainting();
    sizes.disconnect();
    ring.clear();
    painted = null;
    paintedStamp = null;
    firstStamp = null;
    lastKept = 0;
    shownSecond = -1;
    shownNewest = null;
    rect = NOWHERE;
    canvas.remove();
    showVideo();
  }

  window.addEventListener('resize', onViewChange);
  document.addEventListener('fullscreenchange', onViewChange);

  return {
    start(seconds) {
      delaySeconds = positive(seconds, DEFAULT_DELAY_SECONDS);
      if (active) {
        // Already up: a start is a thaw, which is what a resume after a pause
        // is. Nothing held is stale, because a stamp is a wall instant and a
        // pause does not move it.
        frozen = false;
        if (cancelFrames === null) {
          scheduleFrames();
        }
        return;
      }
      active = true;
      frozen = false;
      priming = true;
      // A canvas can only be positioned on the player if the player is a
      // positioning context. YouTube's is; a plain page's may not be.
      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
      container.append(canvas);
      hideVideo();
      measure(true);
      sizes.observe(video);
      sizes.observe(container);
      scheduleFrames();
      paint();
    },

    setDelay(seconds) {
      delaySeconds = positive(seconds, delaySeconds);
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
        frozen,
        priming,
        frames: ring.frames,
        bytes: ring.bytes,
        dropped: ring.dropped,
        delaySeconds,
        paintedStampMs: paintedStamp,
        offsetSeconds:
          paintedStamp === null ? null : (now - paintedStamp) / 1000 - delaySeconds,
        secondsLeft: secondsLeft(now),
      };
    },
  };
}
