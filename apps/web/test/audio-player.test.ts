import { describe, expect, it } from 'vitest';

import {
  clockEnded,
  clockPosition,
  pauseClock,
  pausedClock,
  seekClock,
  startClock,
} from '../src/player/audio-clock.ts';
import { WAVEFORM_FLOOR, barsPlayed, waveformBars } from '../src/player/waveform.ts';

/** A placeholder song, long enough to seek about in. */
const SONG_SECONDS = 200;

describe('the audio clock', () => {
  it('starts stopped at the beginning', () => {
    expect(clockPosition(pausedClock(), 0, SONG_SECONDS)).toBe(0);
    expect(pausedClock().running).toBe(false);
  });

  it('stays put while it is not running, however far the audio clock goes', () => {
    const clock = pausedClock(30);

    expect(clockPosition(clock, 100, SONG_SECONDS)).toBe(30);
    expect(clockPosition(clock, 4000, SONG_SECONDS)).toBe(30);
  });

  it('counts forward from the point it was started at', () => {
    const clock = startClock(pausedClock(30), 100, SONG_SECONDS);

    expect(clockPosition(clock, 100, SONG_SECONDS)).toBe(30);
    expect(clockPosition(clock, 110, SONG_SECONDS)).toBe(40);
  });

  it('picks up where it was paused, whenever that was', () => {
    const paused = pauseClock(startClock(pausedClock(30), 100, SONG_SECONDS), 110, SONG_SECONDS);

    expect(paused.running).toBe(false);
    expect(clockPosition(paused, 400, SONG_SECONDS)).toBe(40);

    const again = startClock(paused, 500, SONG_SECONDS);

    expect(clockPosition(again, 505, SONG_SECONDS)).toBe(45);
  });

  it('seeks without deciding whether the song is playing', () => {
    const running = startClock(pausedClock(), 100, SONG_SECONDS);
    const moved = seekClock(running, 120, 110, SONG_SECONDS);

    expect(moved.running).toBe(true);
    expect(clockPosition(moved, 115, SONG_SECONDS)).toBe(125);

    const stopped = seekClock(pausedClock(5), 120, 110, SONG_SECONDS);

    expect(stopped.running).toBe(false);
    expect(clockPosition(stopped, 115, SONG_SECONDS)).toBe(120);
  });

  it('never leaves the song', () => {
    expect(seekClock(pausedClock(), -10, 0, SONG_SECONDS).atSeconds).toBe(0);
    expect(seekClock(pausedClock(), 4000, 0, SONG_SECONDS).atSeconds).toBe(SONG_SECONDS);

    const running = startClock(pausedClock(SONG_SECONDS - 5), 100, SONG_SECONDS);

    expect(clockPosition(running, 400, SONG_SECONDS)).toBe(SONG_SECONDS);
  });

  it('leaves the end to the caller while the length is unknown', () => {
    const running = startClock(pausedClock(), 0, Number.NaN);

    expect(clockPosition(running, 10, Number.NaN)).toBe(10);
    expect(clockEnded(running, 10, Number.NaN)).toBe(false);
    expect(clockEnded(running, 10, 0)).toBe(false);
  });

  it('does not run backwards if the audio clock is read early', () => {
    const running = startClock(pausedClock(30), 100, SONG_SECONDS);

    expect(clockPosition(running, 99, SONG_SECONDS)).toBe(30);
  });

  it('survives a clock reading that is not a number', () => {
    const running = startClock(pausedClock(30), Number.NaN, SONG_SECONDS);

    expect(clockPosition(running, Number.NaN, SONG_SECONDS)).toBe(30);
    expect(clockPosition(pausedClock(Number.NaN), 0, SONG_SECONDS)).toBe(0);
  });

  it('ends at the end, and then starts the song over', () => {
    const running = startClock(pausedClock(SONG_SECONDS - 2), 100, SONG_SECONDS);

    expect(clockEnded(running, 101, SONG_SECONDS)).toBe(false);
    expect(clockEnded(running, 102, SONG_SECONDS)).toBe(true);

    // What the player does at the end: stop there, then press play again.
    const over = pauseClock(running, 102, SONG_SECONDS);

    expect(over.atSeconds).toBe(SONG_SECONDS);
    expect(startClock(over, 200, SONG_SECONDS).atSeconds).toBe(0);
  });
});

describe('waveformBars', () => {
  it('draws one bar per stretch of the song, scaled to the loudest', () => {
    const samples = new Float32Array([1, -1, 1, -1, 0.25, -0.25, 0.25, -0.25]);

    expect(waveformBars(samples, 2)).toEqual([1, 0.25]);
  });

  it('draws a quiet stretch as a line rather than nothing', () => {
    const samples = new Float32Array([1, 1, 0, 0]);

    expect(waveformBars(samples, 2)).toEqual([1, WAVEFORM_FLOOR]);
  });

  it('draws silence, and an empty buffer, flat', () => {
    expect(waveformBars(new Float32Array(4), 2)).toEqual([WAVEFORM_FLOOR, WAVEFORM_FLOOR]);
    expect(waveformBars(new Float32Array(0), 2)).toEqual([WAVEFORM_FLOOR, WAVEFORM_FLOOR]);
  });

  it('samples rather than reading every frame of a long stem', () => {
    const samples = new Float32Array(10_000);
    // Two frames in the second half, one of them past where sampling looks.
    samples[5000] = 0.5;
    samples[7001] = 1;

    const bars = waveformBars(samples, 2, 1);

    expect(bars).toEqual([WAVEFORM_FLOOR, 1]);
  });

  it('has nothing to draw when no bars are asked for', () => {
    expect(waveformBars(new Float32Array([1]), 0)).toEqual([]);
    expect(waveformBars(new Float32Array([1]), Number.NaN)).toEqual([]);
  });

  it('ignores a sample that is not a number', () => {
    expect(waveformBars(new Float32Array([Number.NaN, 0.5]), 1)).toEqual([1]);
  });
});

describe('barsPlayed', () => {
  it('lights the bars the playhead has passed', () => {
    expect(barsPlayed(0, SONG_SECONDS, 10)).toBe(0);
    expect(barsPlayed(100, SONG_SECONDS, 10)).toBe(5);
    expect(barsPlayed(199, SONG_SECONDS, 10)).toBe(9);
    expect(barsPlayed(SONG_SECONDS, SONG_SECONDS, 10)).toBe(10);
  });

  it('never lights more bars than there are', () => {
    expect(barsPlayed(4000, SONG_SECONDS, 10)).toBe(10);
    expect(barsPlayed(100, SONG_SECONDS, 0)).toBe(0);
  });

  it('lights nothing it cannot work out', () => {
    expect(barsPlayed(10, Number.NaN, 10)).toBe(0);
    expect(barsPlayed(10, 0, 10)).toBe(0);
    expect(barsPlayed(Number.NaN, SONG_SECONDS, 10)).toBe(0);
    expect(barsPlayed(-5, SONG_SECONDS, 10)).toBe(0);
  });
});
