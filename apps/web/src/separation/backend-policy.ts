import type { Backend } from './protocol.ts';

/**
 * Which backend separates a song, decided from facts rather than from hope.
 *
 * WebGPU runs htdemucs at about 3.4x realtime on an M1 against about 1.2x on
 * WASM, so it is the default wherever it can be trusted. `shader-f16` is the
 * condition: the exported model is float16 apart from its convolutions, and an
 * adapter without that feature is not a configuration anything here has
 * measured.
 *
 * Three things can overrule the hardware, in this order: an explicit
 * `?backend=` for testing, a WebGPU failure earlier in this session
 * (webgpu-memo.ts), and then the capability probe.
 *
 * Nothing here touches a browser API. The probing lives in backend-choice.ts,
 * so this decision can be tested on a machine with no GPU at all.
 */

export type BackendRequest = Backend | 'auto';

export interface GpuCapability {
  /** `navigator.gpu` exists at all. */
  readonly present: boolean;
  /** An adapter was handed back, which a blocklisted GPU will not do. */
  readonly adapter: boolean;
  /** That adapter offers `shader-f16`. */
  readonly shaderF16: boolean;
  /** Vendor and architecture, for a report rather than for the decision. */
  readonly detail: string | null;
}

export const NO_GPU: GpuCapability = {
  present: false,
  adapter: false,
  shaderF16: false,
  detail: null,
};

export interface BackendChoice {
  readonly backend: Backend;
  readonly reason: string;
  /** True when something other than the hardware decided. */
  readonly forced: boolean;
}

export interface PolicyInput {
  readonly capability: GpuCapability;
  /** From the query string, or null when nothing asked for a backend. */
  readonly override?: BackendRequest | null;
  /** Why WebGPU was set aside earlier in this session, or null. */
  readonly blockedReason?: string | null;
}

/**
 * `?backend=wasm`, `?backend=webgpu` or `?backend=auto`. Anything else is
 * null, so a typo leaves the policy in charge rather than silently picking a
 * backend nobody asked for.
 */
export function parseBackendOverride(search: string): BackendRequest | null {
  const value = new URLSearchParams(search).get('backend');
  return value === 'wasm' || value === 'webgpu' || value === 'auto' ? value : null;
}

export function decideBackend(input: PolicyInput): BackendChoice {
  const override = input.override ?? null;
  if (override === 'wasm') {
    return { backend: 'wasm', reason: 'wasm was asked for explicitly', forced: true };
  }
  if (override === 'webgpu') {
    // Deliberately past both the memo and the probe: this is the flag a
    // measurement uses to make WebGPU run whatever the policy thinks of it.
    return { backend: 'webgpu', reason: 'webgpu was asked for explicitly', forced: true };
  }

  const blocked = input.blockedReason ?? null;
  if (blocked !== null) {
    return {
      backend: 'wasm',
      reason: `webgpu was set aside this session: ${blocked}`,
      forced: true,
    };
  }

  const { capability } = input;
  if (!capability.present) {
    return { backend: 'wasm', reason: 'this browser has no WebGPU', forced: false };
  }
  if (!capability.adapter) {
    return { backend: 'wasm', reason: 'WebGPU offered no adapter', forced: false };
  }
  if (!capability.shaderF16) {
    return {
      backend: 'wasm',
      reason: 'the WebGPU adapter has no shader-f16, which this float16 model needs',
      forced: false,
    };
  }
  return {
    backend: 'webgpu',
    reason: `WebGPU with shader-f16${capability.detail === null ? '' : ` on ${capability.detail}`}`,
    forced: false,
  };
}
