import { describe, expect, it } from 'vitest';

import { IDLE_HIDE_MS, idleAtRest, idleStep, type IdleState } from '../src/player/idle.ts';

/** Playing, with the last activity at this moment. */
function playingSince(atMs: number): IdleState {
  return idleStep(idleAtRest(0), { kind: 'playing', playing: true, atMs });
}

describe('idleAtRest', () => {
  it('starts with everything on show and nothing playing', () => {
    expect(idleAtRest(100)).toEqual({ shown: true, playing: false, sinceMs: 100 });
  });

  it('survives a clock that has not been read yet', () => {
    expect(idleAtRest(Number.NaN).sinceMs).toBe(0);
  });
});

describe('while something is playing', () => {
  it('keeps the overlays for a moment after the last thing anyone did', () => {
    const state = playingSince(1000);
    expect(idleStep(state, { kind: 'tick', atMs: 1000 }).shown).toBe(true);
    expect(idleStep(state, { kind: 'tick', atMs: 1000 + IDLE_HIDE_MS - 1 }).shown).toBe(true);
  });

  it('hides them once nobody has done anything for long enough', () => {
    const state = playingSince(1000);
    expect(idleStep(state, { kind: 'tick', atMs: 1000 + IDLE_HIDE_MS }).shown).toBe(false);
    expect(idleStep(state, { kind: 'tick', atMs: 9000 }).shown).toBe(false);
  });

  it('takes the wait it is given', () => {
    const state = playingSince(1000);
    expect(idleStep(state, { kind: 'tick', atMs: 1500 }, 400).shown).toBe(false);
    expect(idleStep(state, { kind: 'tick', atMs: 1500 }, 5000).shown).toBe(true);
  });

  it('brings them back on a hand, a finger or a key, and waits again', () => {
    const hidden = idleStep(playingSince(1000), { kind: 'tick', atMs: 8000 });
    expect(hidden.shown).toBe(false);

    const woken = idleStep(hidden, { kind: 'activity', atMs: 8100 });
    expect(woken.shown).toBe(true);
    // The wait starts from the moment they did it, not from the song.
    expect(idleStep(woken, { kind: 'tick', atMs: 8100 + IDLE_HIDE_MS - 1 }).shown).toBe(true);
    expect(idleStep(woken, { kind: 'tick', atMs: 8100 + IDLE_HIDE_MS }).shown).toBe(false);
  });
});

describe('while nothing is playing', () => {
  it('keeps the overlays however long the room sits there', () => {
    const paused = idleAtRest(0);
    expect(idleStep(paused, { kind: 'tick', atMs: 10 ** 6 }).shown).toBe(true);
  });

  it('brings them back the moment the song stops', () => {
    const hidden = idleStep(playingSince(1000), { kind: 'tick', atMs: 8000 });
    const stopped = idleStep(hidden, { kind: 'playing', playing: false, atMs: 8000 });
    expect(stopped.shown).toBe(true);
    expect(idleStep(stopped, { kind: 'tick', atMs: 99_000 }).shown).toBe(true);
  });
});

describe('idleStep', () => {
  it('hands back the state it was given when nothing changed', () => {
    const state = playingSince(1000);
    // Both of these would redraw the stage for nothing.
    expect(idleStep(state, { kind: 'tick', atMs: 1200 })).toBe(state);
    expect(idleStep(state, { kind: 'playing', playing: true, atMs: 1200 })).toBe(state);
  });

  it('counts a clock that stands still as no time passing', () => {
    const state = playingSince(1000);
    expect(idleStep(state, { kind: 'tick', atMs: Number.NaN }).shown).toBe(true);
  });
});
