import {
  CROSSFADE_SECONDS,
  FADE_IN_SECONDS,
  gainAt,
  heldGain,
  rampTo,
  type GainRamp,
} from '../audio/mix-gain.ts';
import { createFrameCodec, LOOK_AHEAD_SECONDS, type FrameCodec } from './frame-codec.ts';
import { createFrameStore, type FrameStore, type StoredFrame } from './frame-store.ts';
import { correctFollow, followedTo, startFollowing, type FollowState } from './media-follow.ts';
import { wallNowMs } from './wall-clock.ts';

/**
 * The picture, where the audio is, drawn over the one the page is playing.
 *
 * The audio half of this extension cannot be fast. A window of separated audio
 * is only final once the next one has been run, so what comes out of the
 * player is the tab's audio as it was about eighteen seconds ago. Sung over a
 * picture that is live, that is useless: the words arrive after the mouth has
 * finished saying them. So the picture is delayed to meet it.
 *
 * **How it finds the frame, which is the whole of this file.** Every displayed
 * frame of the real video is compressed to a webp of a few tens of kilobytes
 * and kept with its `mediaTime` — where in the song it belongs. The audio side
 * reports where in the song its *output* has reached, about ten times a
 * second. The overlay paints the frame whose media time matches. That is all.
 *
 * What that replaced was two clocks pretending to be one. The audio was
 * stamped on the `AudioContext`, each frame was stamped with the wall instant
 * it was displayed at, and the picture was painted from `now - delay - held`,
 * where `held` was how long the audio had been frozen by pauses. It worked
 * exactly as long as the page played steadily. A buffering stall — video time
 * standing still while the capture ran on — moved the audio and the picture
 * apart by the length of the stall, permanently, with no term in that
 * subtraction able to notice. Media time has no such hole in it: the song is
 * where the song is, and both halves name the same place.
 *
 * Which also deletes a whole category of arithmetic. There is no pause shift,
 * because a pause does not move media time. There is no delay in here at all:
 * the audio reports its position and the picture goes there, so a delay that
 * grows to catch up carries the picture with it with nothing to tell it.
 *
 * Between reports the position is carried forward on the wall clock and each
 * report eases it back into line — `media-follow.ts` — because ten corrections
 * a second cannot drive sixty paints a second without stepping.
 *
 * Four more decisions are worth stating.
 *
 * **Frames are compressed, not decoded.** Holding eighteen seconds of
 * `ImageBitmap`s cost about 250 MB of GPU-backed memory on the GPU that runs
 * the model and decodes the page's own video, and the page went from lagging
 * to crawling. `frame-store.ts` and `frame-codec.ts` are that repair: tens of
 * megabytes of webp in the heap, one bitmap decoded just before it is shown
 * and a handful kept.
 *
 * **The overlay takes no input.** `pointer-events: none`, appended inside the
 * player above the video and below everything the page draws on top of it. The
 * page's own controls, keyboard shortcuts and context menu carry on working.
 *
 * **It follows the video's displayed rect, not the player's.** A player is
 * usually wider than the picture in it, and the difference is the letterbox.
 * Each frame is fitted inside that rect the way a browser fits a video:
 * contained, centred, black either side. Theatre mode, fullscreen and a window
 * drag arrive through a `ResizeObserver`.
 *
 * **It has three faces, and which one is up is the `onReady` setting.**
 * `dimmed` holds one still frame — the one on screen when the audio capture
 * began — behind a progress bar, and the dim fades off when the audio arrives.
 * `hidden` keeps the canvas out of the document entirely so the person watches
 * the real video, and dissolves in when the audio arrives, which is a picture
 * jumping back by the delay and the panel says so. `live` is the delayed
 * picture. Both fades are the tested curves in `audio/mix-gain.ts`, read on the
 * wall clock instead of the audio one.
 */

/** Frames a second kept. Enough to read a face by, cheap enough to hold. */
const FRAMES_PER_SECOND = 15;

/** Above the video, below the player's own furniture. */
const OVERLAY_Z_INDEX = 10;

/** How often the canvas re-checks where the video is, in ms. */
const GEOMETRY_MS = 250;

/** How black the still frame goes while the audio gets ready. */
const DIM_ALPHA = 0.55;

/**
 * Seconds of song kept behind the painted frame. The delay may grow to catch
 * up, which steps the position backwards, and a frame thrown away a moment
 * before it is wanted again is a black flash.
 */
const KEEP_BEHIND_SECONDS = 12;

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
  /** Nothing matches the audio's position yet, so a still frame is showing. */
  readonly priming: boolean;
  readonly frames: number;
  readonly bytes: number;
  /** Frames thrown away because the budget was spent. */
  readonly dropped: number;
  /** Decoded frames held, which is the only GPU memory this costs. */
  readonly decoded: number;
  /** Where in the song the audio says it is, or null before it says. */
  readonly positionSeconds: number | null;
  /** Where in the song the frame on the canvas is from. */
  readonly paintedSeconds: number | null;
  /** The still frame `dimmed` holds, or null before the audio started. */
  readonly anchorSeconds: number | null;
  /**
   * How far the painted frame is from where the audio is, in seconds. Negative
   * by up to one frame interval is correct — a frame is painted from at or
   * before the moment asked for, never after. Anything larger is the picture
   * being wrong, which is the one number worth asserting on.
   */
  readonly offsetSeconds: number | null;
  /** Times the position had to be taken in one step rather than eased. */
  readonly snaps: number;
}

export interface DelayedPicture {
  /** Starts keeping frames, with the given face on screen. */
  start: (face?: PictureFace) => void;
  /**
   * Where in the song the audio has reached. The one number this file is
   * driven by; null means the audio is not playing yet.
   */
  setPosition: (mediaSeconds: number | null) => void;
  /** How fast the song is moving, for carrying the position between reports. */
  setRate: (rate: number) => void;
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
  /** Where in the song this frame belongs, in seconds. */
  readonly mediaTime: number;
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
  const fps = positive(options.fps, FRAMES_PER_SECOND);
  const clock = options.now ?? wallNowMs;
  const store: FrameStore<Blob> = createFrameStore<Blob>(
    options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes },
  );
  const codec: FrameCodec = createFrameCodec(
    options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth },
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
  let preparing: PreparingView | null = null;
  /** Where the audio says it is, carried forward between its reports. */
  let follow: FollowState | null = null;
  let rate = 1;
  let snaps = 0;
  let paintedSeconds: number | null = null;
  /** The still frame the dimmed face holds: where the audio capture began. */
  let anchorSeconds: number | null = null;
  let lastKeptMedia = -1;
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

  /** Where in the song to paint from, or null before the audio has said. */
  function wantedSeconds(now: number): number | null {
    return follow === null ? null : followedTo(follow, now);
  }

  function drawBitmap(bitmap: ImageBitmap): void {
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
  function stillFrame(): StoredFrame<Blob> | null {
    if (anchorSeconds !== null) {
      return store.at(anchorSeconds) ?? store.oldest();
    }
    return store.newest();
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
    const bitmap = still === null ? null : codec.bitmapFor(still);
    if (bitmap === null) {
      brush.fillStyle = '#000';
      brush.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      drawBitmap(bitmap);
    }
    drawBar(dimOver(now));
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
    paintedSeconds = null;
    repaint(measuredAt);
  }

  /**
   * Puts back whatever should be on screen, after a resize cleared it. The
   * next animation frame will paint properly either way; this is so a drag
   * does not strobe.
   */
  function repaint(now: number): void {
    const wanted = priming ? null : wantedSeconds(now);
    const frame = wanted === null ? null : store.at(wanted);
    const bitmap = frame === null ? null : codec.bitmapFor(frame);
    if (bitmap !== null) {
      drawBitmap(bitmap);
      return;
    }
    if (priming) {
      drawWaiting(now);
    }
  }

  /**
   * Keeps the frame the page has just displayed, stamped with where in the
   * song it belongs.
   *
   * One encode at a time, and no faster than the frame rate asked for: a
   * machine that cannot keep up should keep fewer frames rather than queue
   * them, because a queue of frames is the memory this was written to avoid.
   */
  function keep(mediaSeconds: number): void {
    if (!Number.isFinite(mediaSeconds) || mediaSeconds - lastKeptMedia < 1 / fps - 0.001) {
      return;
    }
    const encoding = codec.keep(video);
    if (encoding === null) {
      return;
    }
    lastKeptMedia = mediaSeconds;
    encoding
      .then((blob) => {
        if (blob !== null && active) {
          store.push(blob, mediaSeconds, blob.size);
        }
      })
      .catch(() => {
        // One frame that would not encode is one frame. The next one will.
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
        // `mediaTime` is where in the song this frame is, which is the only
        // stamp that survives everything the page does to its own clock.
        keep(metadata.mediaTime);
        scheduleFrames();
      });
      cancelFrames = () => {
        source.cancelVideoFrameCallback?.(handle);
      };
      return;
    }
    // No `requestVideoFrameCallback`: sample on the animation clock and take
    // the video's own clock, which is a frame or so out and still better than
    // nothing.
    const handle = requestAnimationFrame(() => {
      cancelFrames = null;
      if (!active || frozen) {
        return;
      }
      keep(video.currentTime);
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

  function fadeDone(now: number): boolean {
    const at = now / 1000;
    return gainAt(dim, at) === dim.to && gainAt(shown, at) === shown.to;
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

    const wanted = face === 'live' ? wantedSeconds(now) : null;
    const frame = wanted === null ? null : store.at(wanted);
    const bitmap = frame === null ? null : codec.bitmapFor(frame);
    if (wanted !== null) {
      // Everything the delay can no longer reach, minus the slack a catch-up
      // needs, and the next half second decoded before it is wanted.
      store.trim(wanted - KEEP_BEHIND_SECONDS);
      codec.prefetch(store.window(wanted, wanted + LOOK_AHEAD_SECONDS));
    }
    if (frame === null || bitmap === null) {
      priming = true;
      // Redrawn only when it would say something different: this runs sixty
      // times a second for as long as getting ready takes.
      const still = stillFrame();
      const fading = !fadeDone(now);
      const state = `${String(still?.mediaSeconds ?? 0)}/${
        still !== null && codec.bitmapFor(still) !== null ? 'drawn' : 'blank'
      }/${String(preparing?.label ?? '')}/${String(
        Math.round((preparing?.fraction ?? 0) * 200),
      )}/${fading ? String(Math.round(now)) : 'still'}`;
      if (state !== drawnAs) {
        drawnAs = state;
        drawWaiting(now);
      }
      return;
    }
    priming = false;
    if (frame.mediaSeconds !== paintedSeconds || !fadeDone(now)) {
      paintedSeconds = frame.mediaSeconds;
      drawBitmap(bitmap);
      // The dim fades off over the delayed picture rather than over the still
      // frame it was holding: by now the two are the same frame.
      dimOver(now);
    }
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
    store.clear();
    codec.clear();
    follow = null;
    snaps = 0;
    paintedSeconds = null;
    anchorSeconds = null;
    preparing = null;
    dim = heldGain(1);
    shown = heldGain(1);
    canvas.style.opacity = '1';
    lastKeptMedia = -1;
    drawnAs = '';
    unmount();
    showVideo();
  }

  window.addEventListener('resize', onViewChange);
  document.addEventListener('fullscreenchange', onViewChange);

  return {
    start(wanted = 'dimmed') {
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

    setPosition(mediaSeconds) {
      if (mediaSeconds === null || !Number.isFinite(mediaSeconds)) {
        return;
      }
      const now = clock();
      if (follow === null) {
        follow = startFollowing(mediaSeconds, now, rate);
        return;
      }
      const corrected = correctFollow(follow, mediaSeconds, now, { rate });
      follow = corrected.state;
      if (corrected.snapped) {
        snaps += 1;
      }
    },

    setRate(next) {
      rate = Number.isFinite(next) && next > 0 ? next : rate;
      if (follow !== null) {
        follow = { ...follow, seconds: followedTo(follow, clock()), atMs: clock(), rate };
      }
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
      // which is near enough: the store is picked from by media time, not by
      // index.
      anchorSeconds = store.newest()?.mediaSeconds ?? video.currentTime;
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
      // Everything held is still good: a frame is stamped with where in the
      // song it belongs, and a pause moved nothing in the song.
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
      const position = follow === null ? null : followedTo(follow, clock());
      return {
        active,
        face,
        frozen,
        priming,
        frames: store.frames,
        bytes: store.bytes,
        dropped: store.dropped,
        decoded: codec.decoded,
        positionSeconds: position,
        paintedSeconds,
        anchorSeconds,
        offsetSeconds:
          position === null || paintedSeconds === null ? null : paintedSeconds - position,
        snaps,
      };
    },
  };
}
