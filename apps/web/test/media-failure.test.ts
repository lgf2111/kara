import { describe, expect, it } from 'vitest';

import {
  describeMediaFailure,
  readMediaFailure,
  readPlayRefusal,
  videoRemedy,
  type MediaFailure,
} from '../src/player/media-failure.ts';

/** A DOMException as the browser throws it, which Node has no constructor for. */
function thrown(name: string): Error {
  const error = new Error('refused');
  error.name = name;
  return error;
}

describe('readPlayRefusal', () => {
  it('reads Safari refusing to start a song nobody asked for', () => {
    expect(readPlayRefusal(thrown('NotAllowedError'))).toBe('needs-a-tap');
  });

  it('reads a file with nothing playable in it', () => {
    expect(readPlayRefusal(thrown('NotSupportedError'))).toBe('unsupported');
  });

  it('reads a play cut short by a pause or a new source', () => {
    expect(readPlayRefusal(thrown('AbortError'))).toBe('interrupted');
  });

  it('admits it does not know rather than guessing', () => {
    expect(readPlayRefusal(thrown('InvalidStateError'))).toBe('unknown');
    expect(readPlayRefusal(new Error('something'))).toBe('unknown');
    expect(readPlayRefusal('a string')).toBe('unknown');
    expect(readPlayRefusal(undefined)).toBe('unknown');
  });
});

describe('readMediaFailure', () => {
  it('names each code the element can report', () => {
    expect(readMediaFailure(1)).toBe('aborted');
    expect(readMediaFailure(2)).toBe('network');
    expect(readMediaFailure(3)).toBe('decode');
    expect(readMediaFailure(4)).toBe('unsupported');
  });

  it('reads no error at all as no failure', () => {
    expect(readMediaFailure(null)).toBe('none');
    expect(readMediaFailure(undefined)).toBe('none');
    expect(readMediaFailure(0)).toBe('none');
    expect(readMediaFailure(99)).toBe('none');
  });
});

describe('describeMediaFailure', () => {
  const failures: MediaFailure[] = ['none', 'aborted', 'network', 'decode', 'unsupported'];

  it('says something for every failure, in words and not in error codes', () => {
    for (const failure of failures) {
      const said = describeMediaFailure(failure);
      expect(said.length).toBeGreaterThan(0);
      expect(said).not.toMatch(/MEDIA_ERR|\d/u);
    }
  });

  it('points an undecodable file at the browser rather than the file', () => {
    expect(describeMediaFailure('unsupported')).toContain('this browser');
  });
});

describe('videoRemedy', () => {
  it('drops the picture for a video this browser cannot decode', () => {
    // Safari opening an MP4 whose AV1 track its chip has no decoder for.
    expect(videoRemedy({ kind: 'video', failure: 'unsupported', played: false })).toBe(
      'audio-only',
    );
    expect(videoRemedy({ kind: 'video', failure: 'decode', played: false })).toBe('audio-only');
  });

  it('keeps the person their place once a picture has played', () => {
    // A file that fails after a minute has a damaged track somewhere in the
    // middle; restarting it as sound alone would lose where they were.
    expect(videoRemedy({ kind: 'video', failure: 'unsupported', played: true })).toBe('report');
    expect(videoRemedy({ kind: 'video', failure: 'decode', played: true })).toBe('report');
  });

  it('has nothing to fall back to for a song that is already sound alone', () => {
    expect(videoRemedy({ kind: 'audio', failure: 'unsupported', played: false })).toBe('report');
    expect(videoRemedy({ kind: 'audio', failure: 'decode', played: false })).toBe('report');
  });

  it('reports a read that failed partway, which sound alone would not mend', () => {
    expect(videoRemedy({ kind: 'video', failure: 'network', played: false })).toBe('report');
  });

  it('says nothing about a load that was cancelled or never failed', () => {
    expect(videoRemedy({ kind: 'video', failure: 'aborted', played: false })).toBe('ignore');
    expect(videoRemedy({ kind: 'video', failure: 'none', played: false })).toBe('ignore');
    expect(videoRemedy({ kind: 'audio', failure: 'aborted', played: true })).toBe('ignore');
  });
});
