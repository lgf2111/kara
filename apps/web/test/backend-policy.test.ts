import { describe, expect, it } from 'vitest';

import {
  NO_GPU,
  decideBackend,
  parseBackendOverride,
  type GpuCapability,
} from '../src/separation/backend-policy.ts';

const capable: GpuCapability = {
  present: true,
  adapter: true,
  shaderF16: true,
  detail: 'apple metal-3',
};

describe('decideBackend', () => {
  it('prefers WebGPU on an adapter with shader-f16', () => {
    const choice = decideBackend({ capability: capable });

    expect(choice.backend).toBe('webgpu');
    expect(choice.forced).toBe(false);
    expect(choice.reason).toContain('apple metal-3');
  });

  it('falls to WASM when there is no WebGPU at all', () => {
    const choice = decideBackend({ capability: NO_GPU });

    expect(choice.backend).toBe('wasm');
    expect(choice.reason).toContain('no WebGPU');
  });

  it('falls to WASM when WebGPU hands back no adapter', () => {
    const choice = decideBackend({ capability: { ...NO_GPU, present: true } });

    expect(choice.backend).toBe('wasm');
    expect(choice.reason).toContain('no adapter');
  });

  // The model is float16 apart from its convolutions, so an adapter without
  // fp16 shaders is not the configuration anything here has measured.
  it('falls to WASM when the adapter has no shader-f16', () => {
    const choice = decideBackend({ capability: { ...capable, shaderF16: false } });

    expect(choice.backend).toBe('wasm');
    expect(choice.reason).toContain('shader-f16');
  });

  it('honours an explicit wasm override on capable hardware', () => {
    const choice = decideBackend({ capability: capable, override: 'wasm' });

    expect(choice.backend).toBe('wasm');
    expect(choice.forced).toBe(true);
  });

  it('keeps WASM for the rest of a session in which WebGPU failed', () => {
    const choice = decideBackend({ capability: capable, blockedReason: 'returned 42 NaNs' });

    expect(choice.backend).toBe('wasm');
    expect(choice.forced).toBe(true);
    expect(choice.reason).toContain('returned 42 NaNs');
  });

  // The override exists so a measurement can be taken of a backend the policy
  // would refuse, so it has to outrank both the memo and the probe.
  it('lets an explicit webgpu override past the memo and the probe', () => {
    const choice = decideBackend({
      capability: NO_GPU,
      override: 'webgpu',
      blockedReason: 'returned 42 NaNs',
    });

    expect(choice.backend).toBe('webgpu');
    expect(choice.forced).toBe(true);
  });

  it('treats auto as no override at all', () => {
    expect(decideBackend({ capability: capable, override: 'auto' }).backend).toBe('webgpu');
    expect(decideBackend({ capability: NO_GPU, override: 'auto' }).backend).toBe('wasm');
  });
});

describe('parseBackendOverride', () => {
  it('reads the backend a query string asks for', () => {
    expect(parseBackendOverride('?backend=wasm')).toBe('wasm');
    expect(parseBackendOverride('?backend=webgpu')).toBe('webgpu');
    expect(parseBackendOverride('?backend=auto')).toBe('auto');
    expect(parseBackendOverride('?segments=4&backend=wasm')).toBe('wasm');
  });

  it('ignores anything it does not recognise, so a typo leaves the policy in charge', () => {
    expect(parseBackendOverride('')).toBeNull();
    expect(parseBackendOverride('?backend=')).toBeNull();
    expect(parseBackendOverride('?backend=WASM')).toBeNull();
    expect(parseBackendOverride('?backend=cuda')).toBeNull();
    expect(parseBackendOverride('?segments=4')).toBeNull();
  });
});
