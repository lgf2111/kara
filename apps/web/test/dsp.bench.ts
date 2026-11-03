import { describe, expect, it } from 'vitest';

import { createStftPlan, type StftOptions } from '../src/dsp/stft.ts';
import { referenceIstft, referenceStft } from './reference-stft.ts';

/**
 * Measured at the shapes the separation host actually uses, one channel at a
 * time. htdemucs is the product default: a 343980-sample segment at n_fft
 * 4096. MDX is kept because its n_fft 7680 exercises the Bluestein path.
 *
 * Reported as the fastest of several runs, not the mean. This machine is
 * shared, and a mean on a loaded machine measures the other workload: the same
 * benchmark swung by 9x between two consecutive runs before this changed. The
 * minimum is the closest thing available to the cost with the machine to
 * itself, and the ratio between the two implementations is steadier still.
 *
 * Run with `pnpm run bench`. Not part of `pnpm run test`.
 */

function noise(length: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    out[i] = (state / 4294967296) * 2 - 1;
  }
  return out;
}

/** Fastest of `runs` attempts, in milliseconds. */
function fastest(label: string, runs: number, work: () => void): number {
  work(); // warm up
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const began = performance.now();
    work();
    best = Math.min(best, performance.now() - began);
  }
  console.log(`${label.padEnd(44)} ${best.toFixed(1)} ms`);
  return best;
}

function summarise(label: string, before: number, after: number, inferenceMs: number): void {
  console.log(`${label}: ${before.toFixed(0)} ms -> ${after.toFixed(0)} ms per segment, both channels`);
  console.log(
    `  speedup ${(before / after).toFixed(2)}x, host share of segment ${(
      (before / (before + inferenceMs)) *
      100
    ).toFixed(0)}% -> ${((after / (after + inferenceMs)) * 100).toFixed(0)}%`,
  );
}

const HTDEMUCS: StftOptions = { nFft: 4096, hop: 1024, center: true };
const MDX: StftOptions = { nFft: 7680, hop: 1024, center: true };

describe('separation host transform', () => {
  it(
    'htdemucs segment, n_fft 4096, the product default',
    () => {
      const signal = noise(343980, 3);
      const plan = createStftPlan(HTDEMUCS);
      const frames = plan.frames(signal.length);
      const re = new Float32Array(plan.bins * frames);
      const im = new Float32Array(plan.bins * frames);
      const output = new Float32Array(signal.length);
      plan.forward(signal, frames, re, im);
      const spectrum = { re, im, bins: plan.bins, frames };

      const referenceForward = fastest('forward, reference complex fft', 7, () => {
        referenceStft(signal, HTDEMUCS);
      });
      const planForward = fastest('forward, real fft plan', 7, () => {
        plan.forward(signal, frames, re, im);
      });
      const referenceInverse = fastest('inverse, reference complex fft', 7, () => {
        referenceIstft(spectrum, HTDEMUCS, signal.length);
      });
      const planInverse = fastest('inverse, real fft plan', 7, () => {
        plan.inverse(re, im, frames, output);
      });

      // Measured htdemucs inference on WebGPU in M1.
      summarise(
        'htdemucs',
        (referenceForward + referenceInverse) * 2,
        (planForward + planInverse) * 2,
        1619,
      );

      expect(planForward).toBeLessThan(referenceForward);
      expect(planInverse).toBeLessThan(referenceInverse);
    },
    120_000,
  );

  it(
    'mdx segment, n_fft 7680, the Bluestein path',
    () => {
      const signal = noise(261120, 5);
      const plan = createStftPlan(MDX);
      const frames = plan.frames(signal.length);
      const re = new Float32Array(plan.bins * frames);
      const im = new Float32Array(plan.bins * frames);
      const output = new Float32Array(signal.length);
      plan.forward(signal, frames, re, im);
      const spectrum = { re, im, bins: plan.bins, frames };

      const referenceForward = fastest('forward, reference complex fft', 5, () => {
        referenceStft(signal, MDX);
      });
      const planForward = fastest('forward, real fft plan', 5, () => {
        plan.forward(signal, frames, re, im);
      });
      const referenceInverse = fastest('inverse, reference complex fft', 5, () => {
        referenceIstft(spectrum, MDX, signal.length);
      });
      const planInverse = fastest('inverse, real fft plan', 5, () => {
        plan.inverse(re, im, frames, output);
      });

      // Measured MDX inference on WebGPU in M1.
      summarise('mdx', (referenceForward + referenceInverse) * 2, (planForward + planInverse) * 2, 1306);

      expect(planForward).toBeLessThan(referenceForward);
      expect(planInverse).toBeLessThan(referenceInverse);
    },
    180_000,
  );
});
