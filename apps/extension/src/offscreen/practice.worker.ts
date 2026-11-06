/// <reference lib="webworker" />
import { analyseMelody } from '../audio/practice.ts';
import { reasonText } from '../reason.ts';
import type { PracticeCommand, PracticeEvent } from './practice-messages.ts';

/**
 * The offline half of pitch practice, off the offscreen document's thread.
 *
 * A four-minute stem is a few seconds of pitch detection over tens of
 * thousands of frames. On the document's thread it would stall the message
 * pump that keeps the stems playing, so it runs here and sends back only
 * progress and the finished note list.
 *
 * The samples arrive as a copy, by transfer. They are never the array the
 * duet helper reads, so one feature cannot empty the other's buffer.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(event: PracticeEvent): void {
  scope.postMessage(event);
}

function analyse(command: Extract<PracticeCommand, { type: 'analyze' }>): void {
  try {
    const notes = analyseMelody(command.samples, command.sampleRate, {
      range: command.range,
      onProgress: (progress) => {
        post({ type: 'progress', progress });
      },
    });
    post({ type: 'notes', notes });
  } catch (cause) {
    post({ type: 'failed', reason: reasonText(cause) });
  }
}

scope.onmessage = (event: MessageEvent<PracticeCommand>) => {
  const command = event.data;
  if (command.type === 'analyze') {
    analyse(command);
  }
};
