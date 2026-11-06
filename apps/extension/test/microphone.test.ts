import { describe, expect, it } from 'vitest';

import {
  MIC_CONSTRAINTS,
  microphoneErrorText,
  stopMicrophone,
  type MicrophoneStream,
} from '../src/audio/microphone.ts';

describe('microphoneErrorText', () => {
  it('points a practice refusal at the popup button', () => {
    const refused = new Error('Permission denied');
    refused.name = 'NotAllowedError';

    expect(microphoneErrorText(refused, 'practice')).toContain('Enable microphone');
    expect(microphoneErrorText(refused, 'practice')).toContain('popup');
  });

  it('points the popup refusal at Chrome’s own permission', () => {
    const refused = new Error('Permission denied');
    refused.name = 'NotAllowedError';

    expect(microphoneErrorText(refused, 'popup')).toContain('Chrome blocked');
  });

  it('says what to do when there is no microphone', () => {
    const missing = new Error('Requested device not found');
    missing.name = 'NotFoundError';

    expect(microphoneErrorText(missing, 'practice')).toContain('No microphone');
  });

  it('falls back to the cause without going blank', () => {
    expect(microphoneErrorText('nope', 'practice')).toContain('nope');
    expect(microphoneErrorText(null, 'practice')).toContain('no reason given');
  });
});

describe('MIC_CONSTRAINTS', () => {
  it('asks for mono, echo cancellation and no automatic gain', () => {
    expect(MIC_CONSTRAINTS.channelCount).toBe(1);
    expect(MIC_CONSTRAINTS.echoCancellation).toBe(true);
    expect(MIC_CONSTRAINTS.noiseSuppression).toBe(true);
    expect(MIC_CONSTRAINTS.autoGainControl).toBe(false);
  });
});

describe('stopMicrophone', () => {
  it('stops every track a permission click opened', () => {
    const stopped: string[] = [];
    const stream = {
      getTracks: () => [
        { stop: () => stopped.push('one') },
        { stop: () => stopped.push('two') },
      ],
    } as unknown as MicrophoneStream;

    stopMicrophone(stream);

    expect(stopped).toEqual(['one', 'two']);
  });
});
