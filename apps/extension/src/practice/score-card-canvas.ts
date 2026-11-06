import {
  scoreCardFilename,
  scoreCardLayout,
  type ScoreCardLayout,
} from './score-card.ts';
import type { PracticeRun } from './history.ts';

/**
 * The score card as pixels, and the download that follows.
 *
 * The layout is already decided in `score-card.ts`; this file only fills a
 * canvas with it. There is no image, no font file and no network here: the
 * card is drawn from the same palette and system fonts as the panel, encoded
 * to a PNG on this machine and handed straight to a download. Nothing is
 * uploaded.
 */

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '"Avenir Next", "Segoe UI", system-ui, sans-serif';

export function drawScoreCard(layout: ScoreCardLayout): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    return canvas;
  }

  context.fillStyle = layout.background;
  context.fillRect(0, 0, layout.width, layout.height);

  const glow = context.createRadialGradient(
    layout.glow.x,
    layout.glow.y,
    0,
    layout.glow.x,
    layout.glow.y,
    layout.glow.radius,
  );
  glow.addColorStop(0, layout.glow.color);
  glow.addColorStop(1, 'rgba(27, 17, 22, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, layout.width, layout.height);

  for (const rect of layout.rects) {
    context.beginPath();
    context.roundRect(rect.x, rect.y, rect.width, rect.height, rect.radius);
    if (rect.fill !== null) {
      context.fillStyle = rect.fill;
      context.fill();
    }
    if (rect.stroke !== null) {
      context.strokeStyle = rect.stroke;
      context.lineWidth = 1;
      context.stroke();
    }
  }

  for (const line of layout.lines) {
    context.beginPath();
    context.moveTo(line.x1, line.y);
    context.lineTo(line.x2, line.y);
    context.strokeStyle = line.color;
    context.lineWidth = line.width;
    context.stroke();
  }

  context.textBaseline = 'alphabetic';
  for (const text of layout.texts) {
    context.font = `${String(text.weight)} ${String(text.size)}px ${text.family === 'serif' ? SERIF : SANS}`;
    context.fillStyle = text.color;
    context.textAlign = text.align;
    context.fillText(text.text, text.x, text.y, text.maxWidth);
  }

  return canvas;
}

/** The canvas as a PNG, or null when the browser refuses to encode it. */
export function scoreCardPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** Hands a finished PNG to Chrome's download shelf, with no network involved. */
export function downloadScoreCard(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The download reads the blob after the click; give it time to start before
  // releasing the URL.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

/** One run into one downloaded card. Failures stay on the end card's side. */
export async function sharePracticeRun(run: PracticeRun): Promise<void> {
  try {
    const canvas = drawScoreCard(scoreCardLayout(run));
    const blob = await scoreCardPng(canvas);
    if (blob !== null) {
      downloadScoreCard(blob, scoreCardFilename(run));
    }
  } catch {
    // A card that cannot be drawn is not worth interrupting the end card for.
  }
}
