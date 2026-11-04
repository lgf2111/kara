import { describe, expect, it } from 'vitest';

import { STEM_SUM_LIMIT, checkSegment } from '../src/separation/backend-guard.ts';

const clean = { nonFinite: 0, stemSumError: 0.004 };

describe('checkSegment', () => {
  it('keeps a first segment that is finite and sums back to the mixture', () => {
    expect(checkSegment('webgpu', clean).action).toBe('keep');
    expect(checkSegment('wasm', clean).action).toBe('keep');
  });

  // A silent segment has nothing to compare against, which is not a fault.
  it('keeps a segment whose stem sum could not be measured', () => {
    expect(checkSegment('webgpu', { nonFinite: 0, stemSumError: null }).action).toBe('keep');
  });

  it('abandons WebGPU for WASM on a non-finite output', () => {
    const decision = checkSegment('webgpu', { nonFinite: 129024, stemSumError: 0.004 });

    expect(decision.action).toBe('fall-back-to-wasm');
    expect(decision.reason).toContain('129024');
    expect(decision.reason).toContain('webgpu');
  });

  // Nothing is left to fall back to, so the job has to stop rather than write
  // stems nobody can listen to.
  it('stops the job when WASM is the backend that went wrong', () => {
    const decision = checkSegment('wasm', { nonFinite: 1, stemSumError: 0.004 });

    expect(decision.action).toBe('stop');
    expect(decision.reason).toContain('cannot be run on it');
  });

  it('abandons a backend whose stems do not add back up to the mixture', () => {
    const decision = checkSegment('webgpu', { nonFinite: 0, stemSumError: 0.9 });

    expect(decision.action).toBe('fall-back-to-wasm');
    expect(decision.reason).toContain('90.0%');
  });

  it('allows the rounding a correct run shows and refuses what is past it', () => {
    expect(checkSegment('webgpu', { nonFinite: 0, stemSumError: STEM_SUM_LIMIT }).action).toBe(
      'keep',
    );
    expect(
      checkSegment('webgpu', { nonFinite: 0, stemSumError: STEM_SUM_LIMIT * 1.1 }).action,
    ).toBe('fall-back-to-wasm');
  });

  it('treats a stem sum error that is itself NaN as a failure', () => {
    expect(checkSegment('webgpu', { nonFinite: 0, stemSumError: Number.NaN }).action).toBe(
      'fall-back-to-wasm',
    );
  });

  it('reports both measurements when both went wrong', () => {
    const decision = checkSegment('webgpu', { nonFinite: 8, stemSumError: 1.4 });

    expect(decision.reason).toContain('non-finite');
    expect(decision.reason).toContain('and');
  });

  it('takes a different limit when one is given', () => {
    expect(checkSegment('webgpu', { nonFinite: 0, stemSumError: 0.2 }, 0.5).action).toBe('keep');
  });
});
