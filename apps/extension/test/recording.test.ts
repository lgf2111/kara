import { describe, expect, it } from 'vitest';

import {
  IDLE_RECORDING,
  nextRecording,
  normaliseRecording,
  recordingFileName,
  recordingSlug,
  recordingStamp,
  recordingTimer,
  type RecordingStatus,
} from '../src/audio/recording.ts';

const at = Date.UTC(2026, 10, 6, 14, 25, 30);

function started(): RecordingStatus {
  return nextRecording(IDLE_RECORDING, {
    type: 'start',
    atMs: at,
    filename: 'kara-dqw4w9wgxcq-20261106-142530.webm',
  });
}

describe('nextRecording', () => {
  it('counts from the click and freezes when stopped', () => {
    const recording = started();
    const ticked = nextRecording(recording, { type: 'tick', atMs: at + 3450 });
    const stopped = nextRecording(ticked, { type: 'stop', atMs: at + 4000 });
    const later = nextRecording(stopped, { type: 'tick', atMs: at + 9000 });

    expect(recording.state).toBe('recording');
    expect(recording.seconds).toBe(0);
    expect(ticked.seconds).toBeCloseTo(3.45);
    expect(stopped.state).toBe('saving');
    expect(stopped.seconds).toBeCloseTo(4);
    expect(later.seconds).toBeCloseTo(4);
  });

  it('refuses a second start while the first take is live', () => {
    const recording = started();
    const again = nextRecording(recording, {
      type: 'start',
      atMs: at + 10_000,
      filename: 'other.webm',
    });

    expect(again).toBe(recording);
  });

  it('ignores a stop with no take to stop', () => {
    expect(nextRecording(IDLE_RECORDING, { type: 'stop', atMs: at })).toBe(IDLE_RECORDING);
  });

  it('only marks saved after the flush', () => {
    const saving = nextRecording(started(), { type: 'stop', atMs: at + 1000 });
    const saved = nextRecording(saving, { type: 'saved' });

    expect(saved.state).toBe('saved');
    expect(saved.filename).toBe('kara-dqw4w9wgxcq-20261106-142530.webm');
    expect(nextRecording(started(), { type: 'saved' }).state).toBe('recording');
  });

  it('keeps the time already sung when the recorder fails', () => {
    const ticked = nextRecording(started(), { type: 'tick', atMs: at + 2200 });
    const failed = nextRecording(ticked, {
      type: 'failed',
      atMs: at + 2500,
      detail: 'The recorder stopped.',
    });

    expect(failed.state).toBe('error');
    expect(failed.seconds).toBeCloseTo(2.5);
    expect(failed.detail).toBe('The recorder stopped.');
    expect(failed.startedAtMs).toBeNull();
  });

  it('starts cleanly again after a save or an error', () => {
    const saved = nextRecording(
      nextRecording(started(), { type: 'stop', atMs: at + 1000 }),
      { type: 'saved' },
    );
    const restarted = nextRecording(saved, {
      type: 'start',
      atMs: at + 60_000,
      filename: 'second.webm',
    });

    expect(restarted.state).toBe('recording');
    expect(restarted.seconds).toBe(0);
    expect(restarted.filename).toBe('second.webm');
    expect(restarted.detail).toBeNull();
  });
});

describe('recordingTimer', () => {
  it('reads as a timer rather than a decimal', () => {
    expect(recordingTimer(0)).toBe('0:00');
    expect(recordingTimer(9.9)).toBe('0:09');
    expect(recordingTimer(65)).toBe('1:05');
    expect(recordingTimer(3661)).toBe('1:01:01');
  });

  it('does not invent a negative or infinite time', () => {
    expect(recordingTimer(-4)).toBe('0:00');
    expect(recordingTimer(Number.NaN)).toBe('0:00');
    expect(recordingTimer(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('recordingFileName', () => {
  it('is built from a lower-case video id and a UTC stamp', () => {
    expect(recordingStamp(at)).toBe('20261106-142530');
    expect(recordingFileName('dQw4w9WgXcQ', at)).toBe('kara-dqw4w9wgxcq-20261106-142530.webm');
  });

  it('folds anything a filename cannot hold into one dash', () => {
    expect(recordingSlug('  ../My Song?.mp4  ')).toBe('my-song-mp4');
    expect(recordingSlug('///')).toBe('performance');
    expect(recordingSlug('')).toBe('performance');
    expect(recordingSlug(null)).toBe('performance');
  });

  it('caps a very long id so the name stays usable', () => {
    const slug = recordingSlug('a'.repeat(100));

    expect(slug).toHaveLength(48);
    expect(recordingFileName('a'.repeat(100), at)).toBe(`kara-${slug}-20261106-142530.webm`);
  });

  it('survives an unreadable timestamp', () => {
    expect(recordingStamp(Number.NaN)).toBe('19700101-000000');
  });
});

describe('normaliseRecording', () => {
  it('drops an unknown state and keeps a readable number', () => {
    const status = normaliseRecording({
      state: 'recording-ish',
      seconds: -3,
      startedAtMs: -1,
      filename: '  ',
      detail: '  ',
    });

    expect(status).toEqual(IDLE_RECORDING);
  });

  it('keeps a live take with its filename', () => {
    const status = normaliseRecording({
      state: 'recording',
      startedAtMs: at,
      seconds: 12,
      filename: 'kara-x.webm',
    });

    expect(status.state).toBe('recording');
    expect(status.startedAtMs).toBe(at);
    expect(status.seconds).toBe(12);
    expect(status.filename).toBe('kara-x.webm');
  });
});
