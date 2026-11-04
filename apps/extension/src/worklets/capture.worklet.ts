import {
  CAPTURE_CHUNK_FRAMES,
  CAPTURE_PROCESSOR,
  QUANTUM,
  type CaptureChunk,
  type CaptureCommand,
} from '../audio/worklet-messages.ts';

/**
 * The tab's audio, gathered and stamped.
 *
 * Two jobs, and the second is the one that matters. Gathering render quanta
 * into chunks of four thousand frames keeps the message rate down to eleven a
 * second. Stamping each chunk with the context time of the quantum it began in
 * is what gives every sample downstream a moment it was captured at, which is
 * what the delay, the player and step B's picture all hang off.
 *
 * A track that has not started, or that has gone away, still advances the
 * count by a quantum of silence. The clock downstream maps sample indices onto
 * context time by assuming the two move together, and a count that stops while
 * the context's clock does not is exactly the drift it cannot correct for.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  private readonly left = new Float32Array(CAPTURE_CHUNK_FRAMES);
  private readonly right = new Float32Array(CAPTURE_CHUNK_FRAMES);
  private filled = 0;
  private startTime = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<CaptureCommand>): void => {
      if (event.data.type === 'flush') {
        this.filled = 0;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // The output is here only so the graph pulls this node. It stays silent:
    // the offscreen document's audible signal is the delayed one.
    for (const channel of outputs[0] ?? []) {
      channel.fill(0);
    }

    const input = inputs[0] ?? [];
    const inLeft = input[0];
    const inRight = input[1] ?? inLeft;
    const frames = inLeft?.length ?? QUANTUM;

    let done = 0;
    while (done < frames) {
      if (this.filled === 0) {
        this.startTime = currentTime + done / sampleRate;
      }
      const take = Math.min(frames - done, CAPTURE_CHUNK_FRAMES - this.filled);
      if (inLeft === undefined || inRight === undefined) {
        this.left.fill(0, this.filled, this.filled + take);
        this.right.fill(0, this.filled, this.filled + take);
      } else {
        this.left.set(inLeft.subarray(done, done + take), this.filled);
        this.right.set(inRight.subarray(done, done + take), this.filled);
      }
      this.filled += take;
      done += take;
      if (this.filled === CAPTURE_CHUNK_FRAMES) {
        this.send();
      }
    }
    return true;
  }

  private send(): void {
    const left = this.left.slice();
    const right = this.right.slice();
    this.filled = 0;
    const chunk: CaptureChunk = { type: 'chunk', time: this.startTime, left, right };
    this.port.postMessage(chunk, [left.buffer, right.buffer]);
  }
}

registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
