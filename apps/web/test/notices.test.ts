import { describe, expect, it } from 'vitest';

import {
  TroubleError,
  describeTrouble,
  reasonText,
  troubleFrom,
  type TroubleArea,
} from '../src/notices/notices.ts';

const AREAS: TroubleArea[] = ['ingest', 'analysis', 'playback', 'lyrics', 'storage'];

describe('reasonText', () => {
  it('keeps the exception name when it says something', () => {
    const refused = new Error('user denied');
    refused.name = 'NotAllowedError';
    expect(reasonText(refused)).toBe('NotAllowedError: user denied');
  });

  it('leaves out a name that says nothing', () => {
    expect(reasonText(new Error('the worker stopped'))).toBe('the worker stopped');
  });

  it('leaves out the name of a failure that already knows its area', () => {
    expect(reasonText(new TroubleError('storage', 'no writer here'))).toBe('no writer here');
  });

  it('takes a thrown string as it stands', () => {
    expect(reasonText('odd but legal')).toBe('odd but legal');
  });

  it('is never empty, whatever was thrown', () => {
    expect(reasonText(new Error(''))).toBe('no reason given');
    expect(reasonText('')).toBe('no reason given');
    expect(reasonText(null)).toBe('no reason given');
    expect(reasonText(undefined)).toBe('no reason given');
    expect(reasonText({ odd: true })).toBe('no reason given');
  });

  it('keeps a bare name for an exception with no message', () => {
    const empty = new Error('');
    empty.name = 'AbortError';
    expect(reasonText(empty)).toBe('AbortError: no reason given');
  });
});

describe('troubleFrom', () => {
  it('files a plain failure under whoever caught it', () => {
    expect(troubleFrom('ingest', new Error('bad container'))).toEqual({
      area: 'ingest',
      reason: 'bad container',
    });
  });

  it('lets a failure that knows its own area keep it', () => {
    // A write the filesystem refused is a storage failure even when it was
    // asked for in the middle of taking in a file.
    expect(troubleFrom('ingest', new TroubleError('storage', 'nowhere to write'))).toEqual({
      area: 'storage',
      reason: 'nowhere to write',
    });
  });
});

describe('describeTrouble', () => {
  it('leads with what happened to the song and keeps the reason underneath', () => {
    const text = describeTrouble({ area: 'playback', reason: 'NotSupportedError: no decoder' });
    expect(text.headline).toBe('That song could not be played');
    expect(text.detail).toBe('NotSupportedError: no decoder');
  });

  it('has a plain line for every part of the app', () => {
    for (const area of AREAS) {
      const text = describeTrouble({ area, reason: 'because' });
      expect(text.headline.length).toBeGreaterThan(0);
      // Plain language: no API names in the line a person reads first.
      expect(text.headline).not.toMatch(/Error|OPFS|createWritable/u);
    }
  });

  it('adds nothing when there is no reason to add', () => {
    expect(describeTrouble({ area: 'lyrics', reason: '' }).detail).toBeNull();
  });
});
