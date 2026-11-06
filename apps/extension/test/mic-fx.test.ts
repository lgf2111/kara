import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIC_FX,
  IDLE_MIC_STATUS,
  MONITOR_WARNING,
  micFxParams,
  normaliseMicFx,
  normaliseMicStatus,
  withMicFx,
  type MicFx,
} from '../src/audio/mic-fx.ts';

const full: MicFx = {
  level: 1,
  monitor: true,
  reverb: 1,
  echo: 1,
  tone: 1,
  compression: 1,
};

const quiet: MicFx = {
  level: 0,
  monitor: false,
  reverb: 0,
  echo: 0,
  tone: 0,
  compression: 0,
};

describe('normaliseMicFx', () => {
  it('starts with the monitor off', () => {
    expect(DEFAULT_MIC_FX.monitor).toBe(false);
    expect(normaliseMicFx(undefined).monitor).toBe(false);
    expect(MONITOR_WARNING).toContain('headphones');
    expect(MONITOR_WARNING).toContain('feedback');
  });

  it('clamps a readable number and falls back only for an unreadable one', () => {
    const fx = normaliseMicFx({
      level: 4,
      monitor: 'yes',
      reverb: -2,
      echo: 0.25,
      tone: null,
      compression: Number.NaN,
    });

    expect(fx.level).toBe(1);
    expect(fx.monitor).toBe(false);
    expect(fx.reverb).toBe(0);
    expect(fx.echo).toBeCloseTo(0.25);
    expect(fx.tone).toBe(DEFAULT_MIC_FX.tone);
    expect(fx.compression).toBe(DEFAULT_MIC_FX.compression);
  });

  it('does not let a missing field move the rest of the desk', () => {
    const fx = normaliseMicFx({ echo: 0.4 });

    expect(fx.echo).toBeCloseTo(0.4);
    expect(fx.level).toBe(DEFAULT_MIC_FX.level);
    expect(fx.reverb).toBe(DEFAULT_MIC_FX.reverb);
  });

  it('moves one control without resetting the others', () => {
    const fx = withMicFx({ ...DEFAULT_MIC_FX, monitor: true, echo: 0.6 }, { reverb: 0.9 });

    expect(fx.monitor).toBe(true);
    expect(fx.echo).toBeCloseTo(0.6);
    expect(fx.reverb).toBeCloseTo(0.9);
  });
});

describe('micFxParams', () => {
  it('maps the quiet desk to no compression, no reverb and a closed monitor', () => {
    const params = micFxParams(quiet);

    expect(params.inputGain).toBe(0);
    expect(params.compressorRatio).toBe(1);
    expect(params.compressorThresholdDb).toBeCloseTo(0);
    expect(params.reverbWet).toBe(0);
    expect(params.echoWet).toBe(0);
    expect(params.echoFeedback).toBeCloseTo(0.15);
    expect(params.toneGainDb).toBe(-6);
    expect(params.monitorGain).toBe(0);
  });

  it('maps the full desk to the top of every range', () => {
    const params = micFxParams(full);

    expect(params.inputGain).toBe(1);
    expect(params.toneGainDb).toBe(6);
    expect(params.compressorThresholdDb).toBe(-36);
    expect(params.compressorRatio).toBe(8);
    expect(params.reverbWet).toBeCloseTo(0.8);
    expect(params.reverbSeconds).toBeCloseTo(2.4);
    expect(params.echoWet).toBeCloseTo(0.65);
    expect(params.echoSeconds).toBeCloseTo(0.4);
    expect(params.echoFeedback).toBeCloseTo(0.55);
    expect(params.monitorGain).toBe(1);
  });

  it('leaves tone flat and the monitor shut in the middle', () => {
    const params = micFxParams({ ...DEFAULT_MIC_FX, tone: 0.5, monitor: false });

    expect(params.toneGainDb).toBe(0);
    expect(params.monitorGain).toBe(0);
    expect(params.highpassHz).toBe(90);
    expect(params.toneHz).toBe(3200);
  });

  it('makes monitor audible only when the switch says so', () => {
    expect(micFxParams({ ...DEFAULT_MIC_FX, monitor: true }).monitorGain).toBe(1);
    expect(micFxParams({ ...DEFAULT_MIC_FX, monitor: false }).monitorGain).toBe(0);
  });
});

describe('normaliseMicStatus', () => {
  it('is the idle desk with nothing in it', () => {
    const status = normaliseMicStatus(undefined);

    expect(status.fx).toEqual(DEFAULT_MIC_FX);
    expect(status.enabled).toBe(false);
    expect(status.monitor).toBe(false);
    expect(status.error).toBeNull();
    expect(status.recording.state).toBe('idle');
  });

  it('never reports a monitor without an open microphone', () => {
    const closed = normaliseMicStatus({
      fx: { ...DEFAULT_MIC_FX, monitor: true },
      enabled: false,
      monitor: true,
    });
    const open = normaliseMicStatus({
      fx: { ...DEFAULT_MIC_FX, monitor: true },
      enabled: true,
      monitor: true,
    });

    expect(closed.monitor).toBe(false);
    expect(open.monitor).toBe(true);
  });

  it('keeps a recorder error and drops blank words', () => {
    const status = normaliseMicStatus({
      enabled: true,
      error: '  ',
      recording: { state: 'error', seconds: 3.4, detail: 'The recorder stopped.' },
    });

    expect(status.error).toBeNull();
    expect(status.recording.state).toBe('error');
    expect(status.recording.seconds).toBeCloseTo(3.4);
    expect(status.recording.detail).toBe('The recorder stopped.');
    expect(IDLE_MIC_STATUS.recording.state).toBe('idle');
  });
});
