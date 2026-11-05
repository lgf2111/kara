import { describe, expect, it } from 'vitest';

import { IDLE, isRunning, nextStatus, type StatusState } from '../src/audio/status.ts';

const PREPARING: StatusState = { status: 'preparing', reason: null };
const READY: StatusState = { status: 'ready', reason: null };

describe('nextStatus', () => {
  it('prepares on a start and goes ready when the stems are done', () => {
    const preparing = nextStatus(IDLE, { type: 'start' });

    expect(preparing).toEqual(PREPARING);
    expect(nextStatus(preparing, { type: 'prepared' })).toEqual(READY);
  });

  it('ignores a prepared that nothing asked for', () => {
    expect(nextStatus(IDLE, { type: 'prepared' })).toBe(IDLE);
  });

  it('stops from anywhere', () => {
    for (const state of [PREPARING, READY, { status: 'paused' as const, reason: null }]) {
      expect(nextStatus(state, { type: 'stop' })).toEqual(IDLE);
    }
  });

  it('keeps the reason it was given', () => {
    expect(nextStatus(PREPARING, { type: 'unsupported', reason: 'no shader-f16' })).toEqual({
      status: 'unsupported',
      reason: 'no shader-f16',
    });
    expect(nextStatus(READY, { type: 'error', reason: 'the model would not load' })).toEqual({
      status: 'error',
      reason: 'the model would not load',
    });
  });

  it('answers nothing but a stop once the machine cannot do it at all', () => {
    const dead = nextStatus(PREPARING, { type: 'unsupported', reason: 'this browser has no WebGPU' });

    expect(nextStatus(dead, { type: 'start' })).toBe(dead);
    expect(nextStatus(dead, { type: 'prepared' })).toBe(dead);
    expect(nextStatus(dead, { type: 'hold' })).toBe(dead);
    // An error on top of it would replace the more useful of the two reasons.
    expect(nextStatus(dead, { type: 'error', reason: 'and then this' })).toBe(dead);
    expect(nextStatus(dead, { type: 'stop' })).toEqual(IDLE);
  });

  it('lets a start retry after an error', () => {
    const failed = nextStatus(READY, { type: 'error', reason: 'the worker died' });

    expect(nextStatus(failed, { type: 'start' })).toEqual(PREPARING);
  });
});

describe('a pause', () => {
  it('holds rather than resetting, and goes back to ready', () => {
    const paused = nextStatus(READY, { type: 'hold' });

    expect(paused).toEqual({ status: 'paused', reason: null, resumeTo: 'ready' });
    expect(nextStatus(paused, { type: 'resume' })).toEqual(READY);
  });

  it('is not something a session has to be ready for', () => {
    // A pause while preparing means nothing: the video plays on untouched
    // until the stems exist, and there is no audio of ours to hold.
    expect(nextStatus(PREPARING, { type: 'hold' })).toBe(PREPARING);
  });

  it('stays paused through a second pause', () => {
    const paused = nextStatus(READY, { type: 'hold' });

    expect(nextStatus(paused, { type: 'hold' })).toBe(paused);
  });

  it('notices the stems becoming ready while the page was paused', () => {
    // The engine cannot pause before there is anything to hold, but the table
    // has an answer for it and this one keeps the work.
    const paused: StatusState = { status: 'paused', reason: null, resumeTo: 'ready' };
    const prepared = nextStatus(paused, { type: 'prepared' });

    expect(prepared).toEqual(paused);
    expect(nextStatus(prepared, { type: 'resume' })).toEqual(READY);
  });

  it('is not something an idle tab can do', () => {
    expect(nextStatus(IDLE, { type: 'hold' })).toBe(IDLE);
    expect(nextStatus(IDLE, { type: 'resume' })).toBe(IDLE);
  });

  it('stops from paused like anything else', () => {
    expect(nextStatus(nextStatus(READY, { type: 'hold' }), { type: 'stop' })).toEqual(IDLE);
  });
});

describe('isRunning', () => {
  it('counts a paused session as running, because it still holds the stems', () => {
    expect(isRunning('preparing')).toBe(true);
    expect(isRunning('ready')).toBe(true);
    expect(isRunning('paused')).toBe(true);
  });

  it('counts a tab with nothing to lose as not running', () => {
    expect(isRunning('idle')).toBe(false);
    expect(isRunning('unsupported')).toBe(false);
    expect(isRunning('error')).toBe(false);
  });
});
