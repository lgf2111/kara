import type { MemorySample } from './protocol.ts';

interface ChromeMemory {
  readonly usedJSHeapSize: number;
}

interface MeasurableMemory {
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  memory?: ChromeMemory;
}

function perf(): MeasurableMemory {
  return performance as unknown as MeasurableMemory;
}

/**
 * Cheap enough to call between segments. Chrome only, and it sees the JS heap
 * of this realm: not WASM linear memory, not GPU buffers.
 */
export function jsHeapBytes(): number | null {
  return perf().memory?.usedJSHeapSize ?? null;
}

/**
 * Whole-agent measurement, which does include WASM memory and other realms,
 * but needs cross-origin isolation and waits for a garbage collection, so it
 * must not be called inside a timed loop.
 */
export async function agentBytes(): Promise<number | null> {
  const measure = perf().measureUserAgentSpecificMemory;
  if (measure === undefined) {
    return null;
  }
  try {
    return (await measure.call(performance)).bytes;
  } catch {
    return null;
  }
}

export function cheapSample(): MemorySample {
  return { jsHeapBytes: jsHeapBytes(), agentBytes: null };
}

export async function fullSample(): Promise<MemorySample> {
  return { jsHeapBytes: jsHeapBytes(), agentBytes: await agentBytes() };
}
