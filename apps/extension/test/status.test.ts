import { describe, expect, it } from 'vitest';

import { IDLE, isRunning, nextStatus, type StatusState } from '../src/audio/status.ts';

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
    expect(nextStatus(dead, { type: 'hold' })).toBe(dead);
    // An error on top of it would replace the more useful of the two reasons.
    expect(nextStatus(dead, { type: 'error', reason: 'and then this' })).toBe(dead);
    expect(nextStatus(dead, { type: 'stop' })).toEqual(IDLE);
  });

  it('lets a start retry after an error', () => {
    const failed = nextStatus(LIVE, { type: 'error', reason: 'the worker died' });

    expect(nextStatus(failed, { type: 'start' })).toEqual(PRIMING);
  });
});

describe('a pause', () => {
  it('holds rather than resetting, and goes back to what it was doing', () => {
    const paused = nextStatus(LIVE, { type: 'hold' });

    expect(paused).toEqual({ status: 'paused', reason: null, resumeTo: 'live' });
    expect(nextStatus(paused, { type: 'resume' })).toEqual(LIVE);
  });

  it('remembers that it had not finished getting ready', () => {
    const paused = nextStatus(PRIMING, { type: 'hold' });

    expect(paused).toEqual({ status: 'paused', reason: null, resumeTo: 'priming' });
    expect(nextStatus(paused, { type: 'resume' })).toEqual(PRIMING);
  });

  it('stays paused through a second pause', () => {
    const paused = nextStatus(LIVE, { type: 'hold' });

    expect(nextStatus(paused, { type: 'hold' })).toBe(paused);
  });

  it('notices the first block becoming due while the page was paused', () => {
    const paused = nextStatus(PRIMING, { type: 'hold' });
    const primed = nextStatus(paused, { type: 'primed' });

    expect(primed).toEqual({ status: 'paused', reason: null, resumeTo: 'live' });
    expect(nextStatus(primed, { type: 'resume' })).toEqual(LIVE);
  });

  it('stays paused through a seek, and goes back to getting ready', () => {
    const paused = nextStatus(LIVE, { type: 'hold' });
    const seeked = nextStatus(paused, { type: 'reset' });

    expect(seeked).toEqual({ status: 'paused', reason: null, resumeTo: 'priming' });
    expect(nextStatus(seeked, { type: 'resume' })).toEqual(PRIMING);
  });

  it('is not something an idle tab can do', () => {
    expect(nextStatus(IDLE, { type: 'hold' })).toBe(IDLE);
    expect(nextStatus(IDLE, { type: 'resume' })).toBe(IDLE);
  });

  it('stops from paused like anything else', () => {
    expect(nextStatus(nextStatus(LIVE, { type: 'hold' }), { type: 'stop' })).toEqual(IDLE);
  });
});

describe('isRunning', () => {
  it('counts a paused capture as running, because it still holds everything', () => {
    expect(isRunning('priming')).toBe(true);
    expect(isRunning('live')).toBe(true);
    expect(isRunning('paused')).toBe(true);
  });

  it('counts a tab with nothing to lose as not running', () => {
    expect(isRunning('idle')).toBe(false);
    expect(isRunning('unsupported')).toBe(false);
    expect(isRunning('error')).toBe(false);
  });
});
