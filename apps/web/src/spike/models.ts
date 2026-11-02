/**
 * The spike's candidates. Sizes are the bytes actually downloaded by
 * `scripts/spike/models.mjs`, and `largestFileBytes` is what decides whether a
 * model could ship from Cloudflare Pages, which caps one asset at 25 MiB.
 */

export interface MdxContract {
  readonly nFft: number;
  readonly hop: number;
  readonly dimF: number;
  readonly dimT: number;
  readonly compensate: number;
  readonly primaryStem: 'Instrumental' | 'Vocals';
}

export interface DemucsContract {
  readonly manifest: string;
  readonly mixSamples: number;
  readonly magChannels: number;
  readonly magBins: number;
  readonly magFrames: number;
}

export interface SeparationModel {
  readonly id: string;
  readonly label: string;
  readonly family: 'demucs' | 'mdx';
  readonly repo: string;
  readonly licence: string;
  readonly totalBytes: number;
  readonly largestFileBytes: number;
  readonly fileCount: number;
  readonly sampleRate: number;
  /** Samples fed to the graph per segment. */
  readonly segmentSamples: number;
  /** Fraction of a segment shared with the next one. */
  readonly overlap: number;
  readonly mdx?: MdxContract;
  readonly demucs?: DemucsContract;
  /** Whether this spike can produce real audio for it, not just timings. */
  readonly audioImplemented: boolean;
}

const MIB = 1024 * 1024;

export const SEPARATION_MODELS: readonly SeparationModel[] = [
  {
    id: 'mdx-inst-hq5',
    label: 'UVR-MDX-NET-Inst_HQ_5 (MDX-Net, 56 MiB)',
    family: 'mdx',
    repo: 'raydotac/AudioSeparatorONNX',
    licence: 'MIT (repo); upstream UVR weight provenance undocumented',
    totalBytes: Math.round(56.3 * MIB),
    largestFileBytes: Math.round(56.3 * MIB),
    fileCount: 1,
    sampleRate: 44100,
    segmentSamples: 261120, // hop * (dimT - 1)
    overlap: 0.25,
    mdx: {
      nFft: 7680,
      hop: 1024,
      dimF: 3072,
      dimT: 256,
      compensate: 1.021,
      primaryStem: 'Instrumental',
    },
    audioImplemented: true,
  },
  {
    id: 'htdemucs-web',
    label: 'htdemucs 4-stem, fp16 21-piece chain (120 MiB)',
    family: 'demucs',
    repo: 'monteslu/htdemucs-web-onnx',
    licence: 'MIT',
    totalBytes: Math.round(120.1 * MIB),
    largestFileBytes: Math.round(21.0 * MIB),
    fileCount: 21,
    sampleRate: 44100,
    segmentSamples: 343980, // 7.8 s, the export's fixed segment
    overlap: 0.25,
    demucs: {
      manifest: 'htdemucs_split_manifest.json',
      mixSamples: 343980,
      magChannels: 4,
      magBins: 2048,
      magFrames: 336,
    },
    audioImplemented: false,
  },
];

export function separationModel(id: string): SeparationModel {
  const found = SEPARATION_MODELS.find((model) => model.id === id);
  if (found === undefined) {
    throw new Error(`unknown separation model: ${id}`);
  }
  return found;
}

export interface TranscriptionModel {
  readonly id: string;
  readonly label: string;
  readonly repo: string;
  readonly licence: string;
  readonly totalBytes: number;
  readonly largestFileBytes: number;
}

export const TRANSCRIPTION_MODELS: readonly TranscriptionModel[] = [
  {
    id: 'whisper-base',
    label: 'whisper-base, int8 encoder and merged decoder (73 MiB)',
    repo: 'onnx-community/whisper-base',
    licence: 'Apache-2.0 (ONNX repo); upstream openai/whisper weights MIT',
    totalBytes: Math.round(73.3 * MIB),
    largestFileBytes: Math.round(51.2 * MIB),
  },
];

/** Dev-only route where the Vite plugin serves the gitignored models folder. */
export const MODEL_BASE = '/spike-models';

/** One asset may not exceed this on Cloudflare Pages. */
export const PAGES_FILE_LIMIT_BYTES = 25 * MIB;
