/**
 * The HTTP side of a duet job.
 *
 * The engine owns the session and the worklet; this owns the conversation
 * with the local helper: start, poll, fetch the two WAVs, add an anchor, and
 * cancel. Fetch and decode are injected so the protocol can be tested without
 * a bridge, an audio context, or a browser.
 */

import { duetPhaseOf, type DuetConfig, type DuetPhase } from './duet.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type DecodeStereo = (
  bytes: ArrayBuffer,
  sampleRate?: number,
) => Promise<[Float32Array, Float32Array]>;

export interface RemoteDuetStatus {
  readonly state: 'running' | 'done' | 'error';
  readonly phase: DuetPhase;
  readonly done: number;
  readonly total: number;
  readonly error: string | null;
  readonly version: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

/** Normalise whatever the bridge sent into the shape the engine acts on. */
export function remoteDuetStatus(value: unknown): RemoteDuetStatus {
  const body = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const state =
    body['state'] === 'done' || body['state'] === 'error' ? body['state'] : 'running';
  return {
    state,
    phase: duetPhaseOf(body['phase']),
    done: count(body['done']),
    total: count(body['total']),
    error: typeof body['error'] === 'string' ? body['error'] : null,
    version: count(body['version']),
  };
}

export async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // A non-JSON error body is still an error; the status is enough.
  }
  return `the helper returned ${String(response.status)}`;
}

export class DuetClient {
  constructor(
    private readonly config: DuetConfig,
    private readonly decode: DecodeStereo,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = { 'X-Kara-Token': this.config.token };
    if (json) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private async checked(response: Response): Promise<Response> {
    if (!response.ok) {
      throw new Error(await errorText(response));
    }
    return response;
  }

  async start(wav: Blob): Promise<string> {
    const response = await this.checked(
      await this.fetchImpl(`${this.config.url}/v1/jobs`, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'audio/wav',
        },
        body: wav,
      }),
    );
    const body = (await response.json()) as { jobId?: unknown };
    if (typeof body.jobId !== 'string') {
      throw new Error('the helper did not return a job');
    }
    return body.jobId;
  }

  async status(jobId: string): Promise<RemoteDuetStatus> {
    const response = await this.checked(
      await this.fetchImpl(`${this.config.url}/v1/jobs/${jobId}`, {
        headers: this.headers(),
      }),
    );
    return remoteDuetStatus(await response.json());
  }

  async anchor(jobId: string, voice: 1 | 2, start: number, end: number): Promise<void> {
    await this.checked(
      await this.fetchImpl(`${this.config.url}/v1/jobs/${jobId}/anchors`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ voice, start, end }),
      }),
    );
  }

  async cancel(jobId: string): Promise<void> {
    await this.checked(
      await this.fetchImpl(`${this.config.url}/v1/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: this.headers(),
      }),
    );
  }

  async voices(jobId: string, sampleCount: number): Promise<[Float32Array, Float32Array]> {
    const [first, second] = await Promise.all([
      this.checked(
        await this.fetchImpl(`${this.config.url}/v1/jobs/${jobId}/voice1.wav`, {
          headers: this.headers(),
        }),
      ),
      this.checked(
        await this.fetchImpl(`${this.config.url}/v1/jobs/${jobId}/voice2.wav`, {
          headers: this.headers(),
        }),
      ),
    ]);
    const [firstBytes, secondBytes] = await Promise.all([
      first.arrayBuffer(),
      second.arrayBuffer(),
    ]);
    const [firstLeft] = await this.decode(firstBytes);
    const [secondLeft] = await this.decode(secondBytes);
    const length = Math.min(firstLeft.length, secondLeft.length, sampleCount);
    if (length <= 0) {
      throw new Error('the helper returned empty voices');
    }
    return [firstLeft.slice(0, length), secondLeft.slice(0, length)];
  }

  async lowConfidence(jobId: string): Promise<number | null> {
    try {
      const response = await this.fetchImpl(`${this.config.url}/v1/jobs/${jobId}/map.json`, {
        headers: this.headers(),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        quality?: { lowConfidence?: unknown };
      };
      const value = body.quality?.lowConfidence;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      // The map is diagnostic; a missing one must not fail the split.
      return null;
    }
  }
}
