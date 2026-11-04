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
 * Live separation, off the offscreen document's thread.
 *
 * The thread matters more here than in the web app. The same thread runs an
 * `AudioContext`'s main-thread half, and one window of htdemucs is a couple of
 * seconds of GPU work with host-side spectrograms either side of it: left on
 * the document's thread it would stall the very message pump the player is fed
 * through. So the engine runs here and only finalised blocks cross back.
 *
 * WebGPU or nothing. The web app falls back to WASM for a file because a file
 * can be separated slowly; live audio cannot. WASM runs this model at about
 * 1.2x realtime against WebGPU's 3.4x, and a hop has to stay longer than the
 * time one window costs or the stream falls behind for good and no fixed delay
 * rescues it — the arithmetic is in `streaming.ts`. So a machine without
 * WebGPU and `shader-f16` is told it is unsupported, in the backend policy's
 * own words, rather than quietly handed something unlistenable.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

let runner: SegmentRunner | null = null;
let separator: StreamingSeparator | null = null;
/** Pushes are chained so windows reach the model in the order they arrived. */
let pushing: Promise<void> = Promise.resolve();
let closed = false;

function post(event: SeparatorEvent, transfer: Transferable[] = []): void {
  scope.postMessage(event, transfer);
}

function fail(cause: unknown): void {
  if (!closed) {
    post({ type: 'failed', reason: reasonText(cause) });
  }
}

/**
 * A finalised block, copied out of the separator's own buffers and handed over.
 *
 * `streaming.ts` reuses those buffers for the next window and the player holds
 * a block until its moment has passed, so the copy is not optional. The
 * latency report rides along with it: it is the only measurement of what this
 * machine is actually doing, and the delay is set from the first one.
 */
function sendBlock(block: StreamBlock): void {
  const channels = [
    block.vocals[0].slice(),
    block.vocals[1].slice(),
    block.instrumental[0].slice(),
    block.instrumental[1].slice(),
  ];
  const report = separator?.latency();
  post(
    {
      type: 'block',
      startSample: block.startSample,
      frames: channels[0]?.length ?? 0,
      channels,
      lagMs: report?.totalLagMs ?? 0,
      computeMs: report?.computeMs ?? 0,
      bufferSamples: report?.bufferSamples ?? 0,
    },
    channels.map((channel) => channel.buffer as ArrayBuffer),
  );
}

async function init(command: Extract<SeparatorCommand, { type: 'init' }>): Promise<void> {
  const capability = await probeGpu();
  // Deliberately without the session memo and without an override: there is
  // no query string here and nowhere to fall back to, so the only question is
  // what this adapter can do.
  const choice = decideBackend({ capability, override: null, blockedReason: null });
  if (choice.backend !== 'webgpu') {
    post({ type: 'unsupported', reason: choice.reason });
    return;
  }

  runner = await createSegmentRunner({
    backend: 'webgpu',
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
  });

  const report = separator.latency();
  post({
    type: 'ready',
    // Before a window has run, this is the structural lag alone: one window
    // plus one hop. What the first block measures is what the delay is set to.
    lagMs: report.totalLagMs,
    windowSamples: separator.plan.segment,
    hopSamples: separator.plan.stride,
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
        // Still loading the model, or unsupported. Either way these samples
        // have nowhere to go, and the clock is reset once there is somewhere.
        return;
      }
      pushing = pushing
        .then(() => live.push(command.left, command.right))
        .catch((cause: unknown) => {
          fail(cause);
        });
      return;
    }

    case 'reset':
      separator?.reset(0);
      pushing = Promise.resolve();
      return;

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
