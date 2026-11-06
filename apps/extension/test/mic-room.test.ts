import { describe, expect, it } from 'vitest';

import { DEFAULT_MIC_FX } from '../src/audio/mic-fx.ts';
import { MicRoom } from '../src/offscreen/mic-room.ts';

/**
 * The microphone room's device lifecycle, with a fake Web Audio context.
 *
 * No sound is made here: the point is who holds the stream. Monitor and
 * practice both take a reference, the stream is opened once, and the last
 * release is what stops the tracks.
 */

interface Param {
  value: number;
  setTargetAtTime: (value: number, at: number) => void;
}

function param(): Param {
  return {
    value: 0,
    setTargetAtTime(next: number) {
      this.value = next;
    },
  };
}

function node(): Record<string, unknown> {
  return {
    gain: param(),
    frequency: param(),
    Q: param(),
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
    delayTime: param(),
    type: '',
    buffer: null,
    connect: (to: unknown) => to,
    disconnect: () => undefined,
  };
}

function fakeContext(): AudioContext {
  const context = {
    sampleRate: 48_000,
    currentTime: 0,
    destination: node(),
    createGain: () => node(),
    createBiquadFilter: () => node(),
    createDynamicsCompressor: () => node(),
    createConvolver: () => node(),
    createDelay: () => node(),
    createBuffer: (channels: number, length: number, rate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        getChannelData: (channel: number) => data[channel] as Float32Array,
      } as unknown as AudioBuffer;
    },
    createMediaStreamDestination: () => ({
      stream: {},
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    createMediaStreamSource: () => ({
      connect: () => undefined,
      disconnect: () => undefined,
    }),
  };
  return context as unknown as AudioContext;
}

function fakeStream(stops: number[]): MediaStream {
  return {
    getTracks: () => [
      {
        stop: () => {
          stops.push(1);
        },
      },
    ],
  } as unknown as MediaStream;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('MicRoom', () => {
  it('opens the stream for the monitor and closes it when the switch goes off', async () => {
    const stops: number[] = [];
    let opened = 0;
    let reports = 0;
    const room = new MicRoom({
      context: fakeContext(),
      videoId: 'video',
      nowMs: () => 0,
      openStream: () => {
        opened += 1;
        return Promise.resolve(fakeStream(stops));
      },
      onStatus: () => {
        reports += 1;
      },
      onDownload: () => undefined,
    });

    room.setFx({ ...DEFAULT_MIC_FX, monitor: true });
    await settle();

    expect(opened).toBe(1);
    expect(room.status().enabled).toBe(true);
    expect(room.status().monitor).toBe(true);
    expect(reports).toBeGreaterThan(0);

    room.setFx({ ...DEFAULT_MIC_FX, monitor: false });

    expect(room.status().enabled).toBe(false);
    expect(room.status().monitor).toBe(false);
    expect(stops).toHaveLength(1);
  });

  it('shares one stream between practice and the monitor', async () => {
    const stops: number[] = [];
    let opened = 0;
    const room = new MicRoom({
      context: fakeContext(),
      videoId: 'video',
      nowMs: () => 0,
      openStream: () => {
        opened += 1;
        return Promise.resolve(fakeStream(stops));
      },
      onStatus: () => undefined,
      onDownload: () => undefined,
    });

    const shared = await room.acquire('practice');
    expect(shared.context).not.toBeNull();
    expect(opened).toBe(1);

    room.setFx({ ...DEFAULT_MIC_FX, monitor: true });
    await settle();
    expect(opened).toBe(1);
    expect(room.status().monitor).toBe(true);

    // The monitor lets go, but practice is still listening.
    room.setFx({ ...DEFAULT_MIC_FX, monitor: false });
    expect(room.status().enabled).toBe(true);
    expect(room.status().monitor).toBe(false);
    expect(stops).toHaveLength(0);

    room.release('practice');
    expect(room.status().enabled).toBe(false);
    expect(stops).toHaveLength(1);
  });

  it('keeps the monitor shut while the microphone is opened for practice', async () => {
    const room = new MicRoom({
      context: fakeContext(),
      videoId: 'video',
      nowMs: () => 0,
      openStream: () => Promise.resolve(fakeStream([])),
      onStatus: () => undefined,
      onDownload: () => undefined,
    });

    await room.acquire('practice');

    expect(room.status().enabled).toBe(true);
    expect(room.status().monitor).toBe(false);
    expect(room.status().fx.monitor).toBe(false);
  });

  it('reports a refused microphone and leaves the monitor off', async () => {
    const refused = new Error('Permission denied');
    refused.name = 'NotAllowedError';
    const room = new MicRoom({
      context: fakeContext(),
      videoId: 'video',
      nowMs: () => 0,
      openStream: () => Promise.reject(refused),
      onStatus: () => undefined,
      onDownload: () => undefined,
    });

    room.setFx({ ...DEFAULT_MIC_FX, monitor: true });
    await settle();

    expect(room.status().enabled).toBe(false);
    expect(room.status().monitor).toBe(false);
    expect(room.status().fx.monitor).toBe(false);
    expect(room.status().error).toContain('Enable microphone');
  });
});
