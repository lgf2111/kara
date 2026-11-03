import { describe, expect, it } from 'vitest';

import {
  describeStage,
  describeStatus,
  describeStorage,
  formatBytes,
  formatDuration,
  formatEta,
  formatPercent,
} from '../src/library/format.ts';

describe('formatBytes', () => {
  it('counts in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(85 * 1024 * 1024)).toBe('85.0 MiB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GiB');
  });

  it('drops the decimal once the number is long enough', () => {
    expect(formatBytes(170 * 1024 * 1024)).toBe('170 MiB');
  });

  it('shows nothing as nothing', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatDuration', () => {
  it('reads as a track length', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(214_300)).toBe('3:34');
  });

  it('adds hours when there are any', () => {
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});

describe('formatEta', () => {
  it('counts seconds under a minute', () => {
    expect(formatEta(45_000)).toBe('45 s');
  });

  it('rounds to whole minutes above that, because the estimate is rough', () => {
    expect(formatEta(200_000)).toBe('3 min');
    expect(formatEta(7_200_000)).toBe('2 h 0 min');
  });

  it('admits when there is no estimate yet', () => {
    expect(formatEta(null)).toBe('an unknown time');
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('an unknown time');
  });
});

describe('formatPercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatPercent(0.1234)).toBe('12%');
    expect(formatPercent(1)).toBe('100%');
  });
});

describe('describeStorage', () => {
  it('reports what is stored against what is allowed', () => {
    expect(describeStorage(1024 ** 3, 4 * 1024 ** 3)).toBe(
      '1.0 GiB stored for this site, 25% of the 4.0 GiB it will allow.',
    );
  });

  it('leaves the quota out when the browser does not give one', () => {
    expect(describeStorage(1024, null)).toBe('1.0 KiB stored for this site.');
    expect(describeStorage(1024, 0)).toBe('1.0 KiB stored for this site.');
  });

  it('says so when the browser reports nothing at all', () => {
    expect(describeStorage(null, null)).toContain('will not say');
  });
});

describe('describeStage', () => {
  it('turns worker stage names into something readable', () => {
    expect(describeStage('plan: resuming after segment 10 of 40')).toBe(
      'checking for earlier progress',
    );
    expect(describeStage('loading model')).toBe('loading the separation model');
  });

  it('passes anything else through', () => {
    expect(describeStage('separating')).toBe('separating');
    expect(describeStage('decoding')).toBe('decoding');
  });
});

describe('describeStatus', () => {
  it('says what a person can do about each state', () => {
    expect(describeStatus('ready')).toBe('ready');
    expect(describeStatus('separating')).toBe('separating');
    expect(describeStatus('cancelled')).toContain('drop the same file again');
    expect(describeStatus('failed')).toBe('failed');
  });
});
