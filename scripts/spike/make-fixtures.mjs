#!/usr/bin/env node
// Synthesises the spike's audio fixtures with ffmpeg into fixtures/generated/,
// which is gitignored. No copyrighted audio ever enters this repository.
//
// The fixture is sine tones plus pink noise, different per channel. It is
// broadband and 4 minutes long, which is all the models need in order to cost
// what they cost: inference time and memory depend on tensor shapes, not on
// whether the input sounds like music. It proves nothing about separation
// quality. Judging that needs a real song, played through the page by hand.
//
//   node scripts/spike/make-fixtures.mjs [seconds...]
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';

const OUTPUT_DIR = 'fixtures/generated';
const SAMPLE_RATE = 44100;

/**
 * @param {number} seconds
 * @returns {string[]}
 */
function ffmpegArgs(seconds) {
  const duration = String(seconds);
  /** @type {string[]} */
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const sources = [
    `sine=frequency=110:duration=${duration}:sample_rate=${String(SAMPLE_RATE)}`,
    `sine=frequency=220:duration=${duration}:sample_rate=${String(SAMPLE_RATE)}`,
    `sine=frequency=220:duration=${duration}:sample_rate=${String(SAMPLE_RATE)}`,
    `sine=frequency=330:duration=${duration}:sample_rate=${String(SAMPLE_RATE)}`,
    `anoisesrc=color=pink:duration=${duration}:sample_rate=${String(SAMPLE_RATE)}:amplitude=0.3`,
    `anoisesrc=color=pink:duration=${duration}:sample_rate=${String(SAMPLE_RATE)}:amplitude=0.3`,
  ];
  for (const source of sources) {
    args.push('-f', 'lavfi', '-i', source);
  }
  args.push(
    '-filter_complex',
    [
      '[0][1][4]amix=inputs=3:normalize=0:weights=0.40 0.30 0.30[left]',
      '[2][3][5]amix=inputs=3:normalize=0:weights=0.30 0.40 0.30[right]',
      '[left][right]join=inputs=2:channel_layout=stereo[out]',
    ].join(';'),
    '-map',
    '[out]',
    '-c:a',
    'pcm_s16le',
    '-ar',
    String(SAMPLE_RATE),
  );
  return args;
}

const requested = process.argv.slice(2).map(Number);
const durations = requested.length > 0 ? requested : [240, 15];

mkdirSync(OUTPUT_DIR, { recursive: true });

for (const seconds of durations) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`bad duration: ${String(seconds)}`);
  }
  const target = `${OUTPUT_DIR}/tone-${String(seconds)}s.wav`;
  const result = spawnSync('ffmpeg', [...ffmpegArgs(seconds), target], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${String(result.status)}): ${result.stderr.trim()}`);
  }
  const { size } = statSync(target);
  console.log(`${target}: ${String(seconds)}s stereo ${String(SAMPLE_RATE)}Hz, ${(size / 1024 / 1024).toFixed(1)} MiB`);
}
