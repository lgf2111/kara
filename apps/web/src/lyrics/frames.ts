import type { Band } from './bands.ts';
import { prepareForOcr, toGray } from './pixels.ts';

/**
 * Frames out of a video file, through a video element and a canvas.
 *
 * A video element rather than WebCodecs because WebCodecs needs the container
 * demuxed first, and nothing in the browser will do that for an mp4. Seeking a
 * video element is slower, but the cost of a frame here is a rounding error
 * next to the cost of running OCR on it.
 *
 * The element is never added to the document: nothing has to be laid out or
 * painted for `drawImage` to work, so a detached element cannot be seen or
 * heard by accident.
 */

export interface GrayFrame {
  /** One byte of brightness per pixel, row by row. */
  readonly gray: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface FrameReader {
  /** The video's own pixel size. */
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  /** Moves to a time; the frame there is what the next read returns. */
  seek(atSeconds: number): Promise<void>;
  /** The whole frame in grey, downscaled to this width, for measuring rows. */
  gray(width: number): GrayFrame;
  /** One band, upscaled and prepared, as a PNG for OCR to read. */
  band(band: Band, scale: number): Promise<Blob>;
  close(): void;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('this browser would not turn a video frame into an image'));
      } else {
        resolve(blob);
      }
    }, 'image/png');
  });
}

export async function openFrameReader(blob: Blob): Promise<FrameReader> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;

  try {
    // loadeddata rather than loadedmetadata: the size and duration arrive with
    // the metadata, but only loadeddata promises a frame that can be drawn.
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => {
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        resolve();
      };
      const failed = (): void => {
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        reject(new Error('this browser could not open the video kept with this song'));
      };
      video.addEventListener('loadeddata', ready);
      video.addEventListener('error', failed);
    });
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause;
  }

  const width = video.videoWidth;
  const height = video.videoHeight;
  const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
  const scratch = document.createElement('canvas');
  // willReadFrequently: every frame is drawn only to be read straight back,
  // which is the one case where the GPU path is the slow one.
  const context = scratch.getContext('2d', { willReadFrequently: true });

  const close = (): void => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };

  if (width === 0 || height === 0) {
    close();
    throw new Error('the video kept with this song has no picture to read');
  }
  if (durationSeconds <= 0) {
    close();
    throw new Error('this browser will not say how long the kept video is');
  }
  if (context === null) {
    close();
    throw new Error('this browser gave no 2d canvas to draw frames on');
  }

  /** Draws a source rectangle of the current frame at a chosen size. */
  const draw = (
    into: { width: number; height: number },
    from: { top: number; height: number },
  ): ImageData => {
    scratch.width = into.width;
    scratch.height = into.height;
    context.drawImage(
      video,
      0,
      from.top,
      width,
      from.height,
      0,
      0,
      into.width,
      into.height,
    );
    return context.getImageData(0, 0, into.width, into.height);
  };

  return {
    width,
    height,
    durationSeconds,
    seek(atSeconds) {
      // The last frame is not seekable in every container, so stop just short.
      const target = Math.max(0, Math.min(atSeconds, durationSeconds - 0.05));
      if (Math.abs(video.currentTime - target) < 0.001) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const done = (): void => {
          video.removeEventListener('seeked', done);
          video.removeEventListener('error', failed);
          resolve();
        };
        const failed = (): void => {
          video.removeEventListener('seeked', done);
          video.removeEventListener('error', failed);
          reject(new Error('the kept video stopped while it was being read'));
        };
        video.addEventListener('seeked', done);
        video.addEventListener('error', failed);
        video.currentTime = target;
      });
    },
    gray(target) {
      const into = Math.max(1, Math.min(Math.round(target), width));
      const rows = Math.max(1, Math.round((into * height) / width));
      const image = draw({ width: into, height: rows }, { top: 0, height });
      return { gray: toGray(image.data), width: into, height: rows };
    },
    async band(band, scale) {
      const top = Math.max(0, Math.min(height - 1, Math.round(band.top * height)));
      const bottom = Math.max(top + 1, Math.min(height, Math.round(band.bottom * height)));
      const image = draw(
        {
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round((bottom - top) * scale)),
        },
        { top, height: bottom - top },
      );
      prepareForOcr(image.data);
      context.putImageData(image, 0, 0);
      return await canvasBlob(scratch);
    },
    close,
  };
}
