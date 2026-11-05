/**
 * The slice of `signalsmith-stretch` this extension uses.
 *
 * The package ships a browser module and a WASM worklet but no TypeScript
 * declarations. This is deliberately narrower than its API: the player only
 * needs to start the node, ask how far behind it is, and change the key.
 */
declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    /** Audio-context time the change should be heard at. */
    output?: number;
    active?: boolean;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
  }

  export interface StretchConfiguration {
    blockMs?: number;
    intervalMs?: number;
    splitComputation?: boolean;
    preset?: 'default' | 'cheaper';
  }

  export interface StretchNode extends AudioWorkletNode {
    /** Where playback has reached in the input buffers, in seconds. */
    readonly inputTime: number;
    schedule(change: StretchSchedule): Promise<void>;
    start(when?: number): Promise<void>;
    stop(when?: number): Promise<void>;
    /** The node's own delay, in seconds. */
    latency(): Promise<number>;
    configure(options: StretchConfiguration): Promise<void>;
  }

  export interface StretchFactory {
    (context: AudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
    /**
     * A packed worklet module to load instead of building one from a Blob.
     * Extension pages cannot load Blob scripts under the default CSP.
     */
    moduleUrl?: string;
  }

  const stretch: StretchFactory;
  export default stretch;
}
