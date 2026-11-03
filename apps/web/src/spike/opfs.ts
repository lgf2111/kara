/**
 * Stems stream to OPFS as raw interleaved float32 at the source sample rate.
 * The point of the spike is that a stem never has to exist in memory in full:
 * each segment is appended and dropped.
 */

const SPIKE_DIR = 'spike';

async function spikeDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SPIKE_DIR, { create: true });
}

export interface StemWriter {
  readonly path: string;
  append(interleaved: Float32Array<ArrayBuffer>): Promise<void>;
  close(): Promise<number>;
}

export async function createStemWriter(name: string): Promise<StemWriter> {
  const directory = await spikeDirectory();
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable({ keepExistingData: false });
  let bytes = 0;

  return {
    path: `${SPIKE_DIR}/${name}`,
    async append(interleaved) {
      const view = new Uint8Array(
        interleaved.buffer,
        interleaved.byteOffset,
        interleaved.byteLength,
      );
      await stream.write(view);
      bytes += view.byteLength;
    },
    async close() {
      await stream.close();
      return bytes;
    },
  };
}

/** Reads a stem back for playback. Only used for the ear check. */
export async function readStem(name: string): Promise<Float32Array> {
  const directory = await spikeDirectory();
  const handle = await directory.getFileHandle(name);
  const file = await handle.getFile();
  return new Float32Array(await file.arrayBuffer());
}

export async function listStems(): Promise<string[]> {
  const directory = await spikeDirectory();
  const names: string[] = [];
  for await (const key of directory.keys()) {
    names.push(key);
  }
  return names.sort();
}

export async function clearStems(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(SPIKE_DIR, { recursive: true });
  } catch {
    // nothing written yet
  }
}
