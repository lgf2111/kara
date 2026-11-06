/// <reference lib="webworker" />
import { analyseSong } from '../audio/song-analysis.ts';
import { reasonText } from '../reason.ts';
import type { SongAnalysisCommand, SongAnalysisEvent } from './song-analysis-messages.ts';

/**
 * The song's key, tempo and vocal range, off the offscreen document's thread.
 *
 * A four-minute song is thousands of FFTs and pitch frames. On the document's
 * thread that would stall the message pump that keeps the stems playing, so it
 * happens here and the result is a few small numbers. The stems arrive as
 * copies by transfer and are never the buffers the player or the duet helper
 * holds.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(event: SongAnalysisEvent): void {
  scope.postMessage(event);
}

function analyse(command: Extract<SongAnalysisCommand, { type: 'analyze' }>): void {
  try {
    const facts = analyseSong(
      {
        harmonic: command.harmonic,
        percussive: command.percussive,
        vocals: command.vocals,
      },
      command.sampleRate,
      {
        onProgress: (progress) => {
          post({ type: 'progress', progress });
        },
      },
    );
    post({ type: 'facts', facts });
  } catch (cause) {
    post({ type: 'failed', reason: reasonText(cause) });
  }
}

scope.onmessage = (event: MessageEvent<SongAnalysisCommand>) => {
  const command = event.data;
  if (command.type === 'analyze') {
    analyse(command);
  }
};
