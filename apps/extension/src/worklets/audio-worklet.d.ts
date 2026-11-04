/**
 * The AudioWorklet global scope, which lib.dom does not describe.
 *
 * Only what the two processors here use: the base class, the registration
 * function, and the three globals that make a worklet able to say when it is.
 */

/** Start of the render quantum being processed, on the context's clock. */
declare const currentTime: number;
/** Frames the context has rendered since it was created. */
declare const currentFrame: number;
declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
