import { describe, expect, it } from 'vitest';

import {
  analyseSong,
  analyseVocalRange,
  chromaFromSamples,
  detectTempo,
  estimateTempo,
  keyFromChroma,
  keyName,
  normaliseSongAnalysis,
  percentile,
  rangeLabel,
  rangePercentiles,
  type SongFacts,
  type SongKey,
} from '../src/audio/song-analysis.ts';
import { midiToHz } from '../src/audio/pitch.ts';

const RATE = 16_000;

function sine(midi: number, seconds: number, sampleRate = RATE, amplitude = 0.4): Float32Array {
  const length = Math.round(seconds * sampleRate);
  const samples = new Float32Array(length);
  const hz = midiToHz(midi);
  for (let index = 0; index < length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / sampleRate);
  }
  return samples;
}

function chord(midis: readonly number[], seconds: number): Float32Array {
  const length = Math.round(seconds * RATE);
  const samples = new Float32Array(length);
  for (const midi of midis) {
    const hz = midiToHz(midi);
    for (let index = 0; index < length; index += 1) {
      samples[index] = (samples[index] ?? 0) + (0.25 * Math.sin((2 * Math.PI * hz * index) / RATE));
    }
  }
  return samples;
}

function progression(chords: readonly (readonly number[])[], secondsEach: number): Float32Array {
  const pieces = chords.map((notes) => chord(notes, secondsEach));
  const samples = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    samples.set(piece, at);
    at += piece.length;
  }
  return samples;
}

function pulses(bpm: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  const gap = Math.round((60 / bpm) * RATE);
  const click = Math.round(0.012 * RATE);
  for (let start = 0; start < samples.length; start += gap) {
    for (let index = 0; index < click && start + index < samples.length; index += 1) {
      samples[start + index] = 0.9 * Math.sin((2 * Math.PI * 1800 * index) / RATE);
    }
  }
  return samples;
}

function sweep(startMidi: number, endMidi: number, seconds: number): Float32Array {
  const length = Math.round(seconds * RATE);
  const samples = new Float32Array(length);
  let phase = 0;
  for (let index = 0; index < length; index += 1) {
    const place = index / length;
    const midi = startMidi + (endMidi - startMidi) * place;
    phase += (2 * Math.PI * midiToHz(midi)) / RATE;
    samples[index] = 0.4 * Math.sin(phase);
  }
  return samples;
}

function chromaOf(key: SongKey): Float32Array {
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const profile = key.mode === 'major' ? major : minor;
  const chroma = new Float32Array(12);
  for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
    chroma[pitchClass] = profile[((pitchClass - key.tonic) % 12 + 12) % 12] ?? 0;
  }
  return chroma;
}

describe('chroma and key profiles', () => {
  it('reads a C major chord progression as C major', () => {
    const samples = progression(
      [
        [48, 52, 55],
        [53, 57, 60],
        [55, 59, 62],
        [48, 52, 55],
      ],
      1.2,
    );
    const key = keyFromChroma(chromaFromSamples(samples, RATE));

    expect(key?.tonic).toBe(0);
    expect(key?.mode).toBe('major');
    expect(key?.confidence).toBeGreaterThan(0.2);
    expect(key === null ? '' : keyName(key)).toBe('C major');
  });

  it('reads an A minor progression as A minor', () => {
    const samples = progression(
      [
        [45, 48, 52],
        [50, 53, 57],
        [52, 56, 59],
        [45, 48, 52],
      ],
      1.2,
    );
    const key = keyFromChroma(chromaFromSamples(samples, RATE));

    expect(key?.tonic).toBe(9);
    expect(key?.mode).toBe('minor');
  });

  it('matches every rotated profile to its own tonic', () => {
    for (let tonic = 0; tonic < 12; tonic += 1) {
      for (const mode of ['major', 'minor'] as const) {
        const key = keyFromChroma(chromaOf({ tonic, mode, confidence: 1 }));

        expect(key).toEqual({ tonic, mode, confidence: 1 });
      }
    }
  });

  it('has no key for silence', () => {
    expect(keyFromChroma(chromaFromSamples(new Float32Array(RATE), RATE))).toBeNull();
    expect(keyFromChroma(new Float32Array(12))).toBeNull();
  });
});

describe('tempo estimation', () => {
  it('finds a 120 BPM pulse', () => {
    const tempo = detectTempo(pulses(120, 12), RATE);

    expect(tempo?.bpm).toBeCloseTo(120, 0);
    expect(tempo?.confidence).toBeGreaterThan(0.5);
  });

  it('finds a 90 BPM pulse', () => {
    const tempo = detectTempo(pulses(90, 12), RATE);

    expect(tempo?.bpm).toBeCloseTo(90, 0);
    expect(tempo?.confidence).toBeGreaterThan(0.5);
  });

  it('keeps the octave ambiguity on the side a person taps', () => {
    const tempo = detectTempo(pulses(150, 12), RATE);

    expect(tempo?.bpm).toBeCloseTo(150, 0);
  });

  it('has no tempo for silence or a flat envelope', () => {
    expect(detectTempo(new Float32Array(RATE * 4), RATE)).toBeNull();
    expect(estimateTempo(new Array<number>(200).fill(0), 0.016)).toBeNull();
  });

  it('reports a weak confidence for noise', () => {
    const noise = new Float32Array(RATE * 8);
    let seed = 0x2468;
    for (let index = 0; index < noise.length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[index] = ((seed / 0xffffffff) * 2 - 1) * 0.3;
    }
    const tempo = detectTempo(noise, RATE);

    expect(tempo === null || tempo.confidence < 0.3).toBe(true);
  });
});

describe('vocal range percentiles', () => {
  it('interpolates between neighbours', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 0.5)).toBe(20);
    expect(percentile([10, 20, 30], 0.25)).toBe(15);
    expect(percentile([10, 20, 30], 1)).toBe(30);
  });

  it('takes the fifth and ninety-fifth percentiles, not the extremes', () => {
    const midis: number[] = [];
    for (let midi = 48; midi <= 72; midi += 1) {
      midis.push(midi);
    }
    midis.push(30, 100);
    const range = rangePercentiles(midis);

    expect(range?.lowMidi).toBe(48);
    expect(range?.highMidi).toBe(72);
    expect(range?.frames).toBe(27);
  });

  it('needs enough confident frames', () => {
    expect(rangePercentiles([60, 61, 62])).toBeNull();
  });

  it('follows a stepped sweep through the detector', () => {
    const notes = [48, 52, 55, 60, 64, 67, 72];
    const pieces = notes.map((midi) => sine(midi, 0.8));
    const samples = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
    let at = 0;
    for (const piece of pieces) {
      samples.set(piece, at);
      at += piece.length;
    }
    const range = analyseVocalRange(samples, RATE);

    expect(range).not.toBeNull();
    expect(range?.lowMidi).toBeLessThanOrEqual(49);
    expect(range?.highMidi).toBeGreaterThanOrEqual(71);
    expect(rangeLabel(range as NonNullable<typeof range>)).toContain('–');
  });

  it('reads a continuous sweep without inventing an octave', () => {
    const range = analyseVocalRange(sweep(48, 72, 8), RATE);

    expect(range).not.toBeNull();
    expect(range?.lowMidi).toBeLessThanOrEqual(51);
    expect(range?.highMidi).toBeGreaterThanOrEqual(69);
    expect(range?.highMidi).toBeLessThan(84);
  });
});

describe('analyseSong', () => {
  it('gives key, tempo and range from separated stems', () => {
    const harmonic = progression(
      [
        [48, 52, 55],
        [53, 57, 60],
        [55, 59, 62],
        [48, 52, 55],
      ],
      1.2,
    );
    const percussive = pulses(120, 4.8);
    const vocals = new Float32Array(harmonic.length);
    // A singer around C4 to E4, leaving the low chord notes to the harmony.
    let at = 0;
    for (let index = 0; index < 4; index += 1) {
      const note = sine(index % 2 === 0 ? 60 : 64, 1.2);
      vocals.set(note, at);
      at += note.length;
    }
    const facts = analyseSong({ harmonic, percussive, vocals }, RATE);

    expect(facts.key?.tonic).toBe(0);
    expect(facts.key?.mode).toBe('major');
    expect(facts.bpm).toBeCloseTo(120, 0);
    expect(facts.range?.lowMidi).toBe(60);
    expect(facts.range?.highMidi).toBe(64);
  });

  it('reports no key and no bpm when the confidence is not there', () => {
    const facts = analyseSong(
      {
        harmonic: new Float32Array(RATE * 4),
        percussive: new Float32Array(RATE * 4),
        vocals: new Float32Array(RATE * 4),
      },
      RATE,
    );

    expect(facts.key).toBeNull();
    expect(facts.bpm).toBeNull();
    expect(facts.range).toBeNull();
  });
});

describe('normaliseSongAnalysis', () => {
  const facts: SongFacts = {
    key: { tonic: 7, mode: 'major', confidence: 0.8 },
    bpm: 128.4,
    bpmConfidence: 0.7,
    range: { lowMidi: 48, highMidi: 64, confidence: 0.6, frames: 120 },
  };

  it('keeps a ready report and its facts', () => {
    const analysis = normaliseSongAnalysis({
      state: 'ready',
      progress: 1,
      facts,
      detail: null,
    });

    expect(analysis.state).toBe('ready');
    expect(analysis.facts).toEqual(facts);
  });

  it('omits a key and a tempo the report itself is unsure of', () => {
    const analysis = normaliseSongAnalysis({
      state: 'ready',
      progress: 1,
      facts: {
        ...facts,
        key: { tonic: 7, mode: 'major', confidence: 0.05 },
        bpmConfidence: 0.02,
      },
    });

    expect(analysis.facts?.key).toBeNull();
    expect(analysis.facts?.bpm).toBeNull();
  });

  it('has no facts before it is ready', () => {
    const analysis = normaliseSongAnalysis({ state: 'analyzing', progress: 0.4, facts });

    expect(analysis.state).toBe('analyzing');
    expect(analysis.progress).toBeCloseTo(0.4);
    expect(analysis.facts).toBeNull();
  });

  it('bounds every number it is handed', () => {
    const analysis = normaliseSongAnalysis({
      state: 'ready',
      progress: 4,
      facts: {
        key: { tonic: 19, mode: 'dorian', confidence: 8 },
        bpm: 900,
        bpmConfidence: -2,
        range: { lowMidi: 200, highMidi: 100, confidence: 9, frames: -1 },
      },
      detail: '',
    });

    expect(analysis.progress).toBe(1);
    expect(analysis.facts?.key).toBeNull();
    expect(analysis.facts?.bpm).toBeNull();
    expect(analysis.facts?.bpmConfidence).toBe(0);
    expect(analysis.facts?.range).toBeNull();
    expect(analysis.detail).toBeNull();
  });

  it('reads malformed input as an analysis still starting', () => {
    const analysis = normaliseSongAnalysis('not a report');

    expect(analysis.state).toBe('analyzing');
    expect(analysis.progress).toBeNull();
    expect(analysis.facts).toBeNull();
  });
});
