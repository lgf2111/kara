import { describe, expect, it } from 'vitest';

import { MAX_TRACKED_FILE_BYTES, classifyPath, classifySize, extensionOf } from './media.mjs';

describe('extensionOf', () => {
  it('lowercases and keeps the dot', () => {
    expect(extensionOf('fixtures/Tone.WAV')).toBe('.wav');
    expect(extensionOf('apps/web/src/App.tsx')).toBe('.tsx');
  });

  it('returns nothing for dotfiles and extensionless names', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('.githooks/commit-msg')).toBe('');
    expect(extensionOf('Makefile')).toBe('');
  });
});

describe('classifyPath', () => {
  it('rejects audio and video containers', () => {
    for (const path of ['song.mp3', 'a/b/take.wav', 'clip.webm', 'movie.MKV', 'stream.m2ts']) {
      expect(classifyPath(path)?.rule, path).toBe('media');
    }
  });

  it('rejects model weights', () => {
    for (const path of [
      'models/separator.onnx',
      'models/separator.onnx_data',
      'w.safetensors',
      'w.bin',
      'models/tessdata/eng.traineddata',
    ]) {
      expect(classifyPath(path)?.rule, path).toBe('model-weights');
    }
  });

  it('allows source, config and docs', () => {
    for (const path of ['apps/web/src/App.tsx', 'docs/DESIGN.md', 'package.json', 'scripts/lib/media.mjs']) {
      expect(classifyPath(path), path).toBeNull();
    }
  });

  it('treats .ts as TypeScript, not as a transport stream', () => {
    expect(classifyPath('workers/relay/src/index.ts')).toBeNull();
  });
});

describe('classifySize', () => {
  it('allows files up to the cap', () => {
    expect(classifySize(0)).toBeNull();
    expect(classifySize(MAX_TRACKED_FILE_BYTES)).toBeNull();
  });

  it('rejects anything larger', () => {
    expect(classifySize(MAX_TRACKED_FILE_BYTES + 1)?.rule).toBe('oversized');
  });
});
