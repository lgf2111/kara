import { describe, expect, it } from 'vitest';

import { IDLE, nextStatus, primingSecondsLeft, type StatusState } from '../src/audio/status.ts';

const PRIMING: StatusState = { status: 'priming', reason: null };
const LIVE: StatusState = { status: 'live', reason: null };

describe('nextStatus', () => {
  it('primes on a start and goes live on the first delayed sample', () => {
    const priming = nextStatus(IDLE, { type: 'start' });
    expect(priming).toEqual(PRIMING);
    expect(nextStatus(priming, { type: 'primed' })).toEqual(LIVE);
  });

  it('primes again on a reset, because what is buffered is worthless', () => {
    expect(nextStatus(LIVE, { type: 'reset' })).toEqual(PRIMING);
    expect(nextStatus(PRIMING, { type: 'reset' })).toEqual(PRIMING);
  });

  it('ignores a reset from a tab nobody is capturing', () => {
    expect(nextStatus(IDLE, { type: 'reset' })).toBe(IDLE);
  });

  it('ignores a prime that nothing asked for', () => {
    expect(nextStatus(IDLE, { type: 'primed' })).toBe(IDLE);
  });

  it('stops from anywhere', () => {
    for (const state of [PRIMING, LIVE, { status: 'error' as const, reason: 'boom' }]) {
      expect(nextStatus(state, { type: 'stop' })).toEqual(IDLE);
    }
  });

  it('keeps the reason it was given', () => {
    expect(nextStatus(PRIMING, { type: 'unsupported', reason: 'no shader-f16' })).toEqual({
      status: 'unsupported',
      reason: 'no shader-f16',
    });
    expect(nextStatus(LIVE, { type: 'error', reason: 'the model would not load' })).toEqual({
      status: 'error',
      reason: 'the model would not load',
    });
  });

  it('answers nothing but a stop once the machine cannot do it at all', () => {
    const dead = nextStatus(PRIMING, { type: 'unsupported', reason: 'this browser has no WebGPU' });

    expect(nextStatus(dead, { type: 'start' })).toBe(dead);
    expect(nextStatus(dead, { type: 'reset' })).toBe(dead);
    expect(nextStatus(dead, { type: 'primed' })).toBe(dead);
    // An error on top of it would replace the more useful of the two reasons.
    expect(nextStatus(dead, { type: 'error', reason: 'and then this' })).toBe(dead);
    expect(nextStatus(dead, { type: 'stop' })).toEqual(IDLE);
  });

  it('lets a start retry after an error', () => {
    const failed = nextStatus(LIVE, { type: 'error', reason: 'the worker died' });

    expect(nextStatus(failed, { type: 'start' })).toEqual(PRIMING);
  });
});

describe('primingSecondsLeft', () => {
  it('counts the delay down and stops at zero', () => {
    expect(primingSecondsLeft(1000, 1000, 16)).toBe(16);
    expect(primingSecondsLeft(1000, 5000, 16)).toBe(12);
    expect(primingSecondsLeft(1000, 17_000, 16)).toBe(0);
    expect(primingSecondsLeft(1000, 90_000, 16)).toBe(0);
  });

  it('says nothing is left when it cannot tell', () => {
    expect(primingSecondsLeft(Number.NaN, 0, 16)).toBe(0);
    expect(primingSecondsLeft(0, 0, Number.NaN)).toBe(0);
  });
});
