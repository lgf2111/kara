import {
  NO_GPU,
  decideBackend,
  parseBackendOverride,
  type BackendChoice,
  type BackendRequest,
  type GpuCapability,
} from './backend-policy.ts';
import { webgpuBlockedReason } from './webgpu-memo.ts';

/**
 * What this machine can offer, and therefore what the next job runs on.
 *
 * Kept apart from backend-policy.ts because this half needs a browser: the
 * decision itself is tested without one.
 */

interface AdapterLike {
  readonly features?: Iterable<string>;
  readonly info?: Readonly<Record<string, unknown>>;
}

/** Typed structurally: @webgpu/types is not a dependency of this app. */
function gpu(): { requestAdapter: () => Promise<AdapterLike | null> } | undefined {
  return (navigator as unknown as { gpu?: { requestAdapter: () => Promise<AdapterLike | null> } })
    .gpu;
}

/** GPUAdapterInfo keeps its values on the prototype, so they are read by key. */
function describe(adapter: AdapterLike): string | null {
  const info = adapter.info as Record<string, unknown> | undefined;
  const parts = ['vendor', 'architecture']
    .map((key) => info?.[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return parts.length === 0 ? null : parts.join(' ');
}

/** Never throws: a browser refusing an adapter is an answer, not a failure. */
export async function probeGpu(): Promise<GpuCapability> {
  const api = gpu();
  if (api === undefined) {
    return NO_GPU;
  }
  try {
    const adapter = await api.requestAdapter();
    if (adapter === null) {
      return { ...NO_GPU, present: true };
    }
    return {
      present: true,
      adapter: true,
      shaderF16: [...(adapter.features ?? [])].includes('shader-f16'),
      detail: describe(adapter),
    };
  } catch {
    return { ...NO_GPU, present: true };
  }
}

/**
 * The backend to start the next job on: the policy, with this page's override
 * and this session's memo of any earlier WebGPU failure.
 */
export async function chooseBackend(
  search: string,
  requested: BackendRequest = 'auto',
): Promise<BackendChoice> {
  const override = requested === 'auto' ? parseBackendOverride(search) : requested;
  // No adapter request when wasm was asked for: nothing would read the answer.
  const capability = override === 'wasm' ? NO_GPU : await probeGpu();
  return decideBackend({ capability, override, blockedReason: webgpuBlockedReason() });
}
