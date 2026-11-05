/// <reference lib="webworker" />
import { reasonText } from '../reason.ts';
import {
  createSegmentRunner,
  createStreamingSeparator,
  decideBackend,
  probeGpu,
  type SegmentRunner,
  type StreamBlock,
  type StreamingSeparator,
} from './engine.ts';
import type { SeparatorCommand, SeparatorEvent } from './messages.ts';

/**
 * Whole-track separation, off the offscreen document's thread.
 *
 * The thread matters: the same thread runs an `AudioContext`'s main-thread
 * half, and one window of htdemucs is a couple of seconds of GPU work with
 * host-side spectrograms either side of it. Left on the document's thread it
 * would stall the message pump the player is fed through. So the engine runs
 * here and only finalised blocks cross back.
 *
 * The track is pushed in chunks and then flushed, exactly like the web app
 * runs a file. This used to be live, with a delay to hold against a window
 * costing longer than its hop — WebGPU or nothing, because WASM could not
 * keep up. A whole file can be separated slowly, so the WASM fallback now
 * runs rather than refusing: the toggle is simply ready later.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

let runner: SegmentRunner | null = null;
let separator: StreamingSeparator | null = null;
/** Pushes are chained so windows reach the model in the order they arrived. */
let pushing: Promise<void> = Promise.resolve();
let closed = false;
let samples = 0;

function post(event: SeparatorEvent, transfer: Transferable[] = []): void {
  scope.postMessage(event, transfer);
}

function fail(cause: unknown): void {
  if (closed) {
    return;
  }
  const stack = cause instanceof Error ? cause.stack : undefined;
  post({ type: 'failed', reason: reasonText(cause), ...(stack === undefined ? {} : { stack }) });
}

/**
 * A finalised block, copied out of the separator's own buffers and handed over.
 *
 * `streaming.ts` reuses those buffers for the next window, so the copy is not
 * optional: the offscreen document owns the stems from the moment it receives
 * them, for as long as the session lasts. The eight channels are drums, bass,
 * other and vocals in the model's order, left before right in each pair, which
 * is the layout `audio/stem-player-messages.ts` names.
 */
function sendBlock(block: StreamBlock): void {
  const stems = block.stems;
  if (stems === undefined) {
    throw new Error('the separator returned no separate stems');
  }
  const channels = stems.flatMap(([left, right]) => [left.slice(), right.slice()]);
  post(
    {
      type: 'block',
      startSample: block.startSample,
      frames: channels[0]?.length ?? 0,
      channels,
      computeMs: separator?.latency().computeMs ?? 0,
    },
    channels.map((channel) => channel.buffer as ArrayBuffer),
  );
}

async function init(command: Extract<SeparatorCommand, { type: 'init' }>): Promise<void> {
  const capability = await probeGpu();
  // No override and no session memo: the only question is what this adapter
  // can do, and the policy's answer is WebGPU where it can be trusted and
  // WASM everywhere else. Both separate a file; one is faster.
  const choice = decideBackend({ capability, override: null, blockedReason: null });

  runner = await createSegmentRunner({
    backend: choice.backend,
    weightsBase: command.weightsBase,
    runtimePath: command.runtimePath,
    onPiece: (loaded, total) => {
      post({ type: 'loading', loaded, total });
    },
  });

  separator = createStreamingSeparator({
    runner,
    sampleRate: command.sampleRate,
    onBlock: sendBlock,
    stems: 'all',
  });

  post({
    type: 'ready',
    windowSamples: separator.plan.segment,
    hopSamples: separator.plan.stride,
    backend: choice.backend,
    backendReason: choice.reason,
  });
}

function handle(command: SeparatorCommand): void {
  switch (command.type) {
    case 'init':
      init(command).catch(fail);
      return;

    case 'chunk': {
      const live = separator;
      if (live === null) {
        // Still loading the model. The engine does not push until `ready`, so
        // reaching here means an ordering bug; dropping the chunk is kinder
        // than throwing from inside a message handler.
        return;
      }
      samples += command.left.length;
      pushing = pushing
        .then(() => live.push(command.left, command.right))
        .catch((cause: unknown) => {
          fail(cause);
        });
      return;
    }

    case 'flush': {
      const live = separator;
      if (live === null) {
        return;
      }
      pushing = pushing
        .then(() => live.flush())
        .then(() => {
          post({ type: 'done', samples });
        })
        .catch((cause: unknown) => {
          fail(cause);
        });
      return;
    }

    case 'close':
      closed = true;
      void (async () => {
        try {
          await runner?.release();
        } finally {
          scope.close();
        }
      })();
      return;
  }
}

scope.addEventListener('message', (event: MessageEvent<SeparatorCommand>) => {
  try {
    handle(event.data);
  } catch (cause) {
    fail(cause);
  }
});
