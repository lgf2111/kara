/**
 * Everything the pipeline writes goes through this interface, so the resume
 * logic can be tested without a browser. The OPFS implementation lives in
 * `opfs-store.ts`; this file stays free of browser APIs so tests can import it.
 *
 * Stems are raw interleaved float32 at the source sample rate. The point of
 * streaming them is that a stem never has to exist in memory in full.
 */

export interface AppendableFile {
  readonly path: string;
  /** Bytes already in the file. */
  size(): number;
  append(data: Float32Array<ArrayBuffer>): Promise<void>;
  /** Drops anything past `bytes`, which recovers from a half-written chunk. */
  truncate(bytes: number): Promise<void>;
  close(): Promise<void>;
}

export interface Store {
  openAppend(path: string): Promise<AppendableFile>;
  readJson(path: string): Promise<unknown>;
  writeJson(path: string, value: unknown): Promise<void>;
  readFloat32(path: string): Promise<Float32Array | null>;
  writeFloat32(path: string, data: Float32Array<ArrayBuffer>): Promise<void>;
  /**
   * Copies a picked file in as it stands, streamed rather than buffered. This
   * is how a video's own bytes are kept for the room background; a long video
   * never has to sit in memory.
   */
  writeBlob(path: string, blob: Blob): Promise<void>;
  /**
   * One byte range, so a stem can be copied out in pieces. Reading a whole
   * four-minute stem costs 80 MB, which this target cannot spare.
   */
  readBytes(path: string, offset: number, length: number): Promise<Uint8Array | null>;
  sizeOf(path: string): Promise<number | null>;
  remove(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Total bytes the store holds, for the library's storage readout. */
  usedBytes(): Promise<number>;
}

export function createMemoryStore(initial: Readonly<Record<string, Uint8Array>> = {}): Store {
  const files = new Map<string, Uint8Array>(Object.entries(initial));

  const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
    const out = new Uint8Array(left.byteLength + right.byteLength);
    out.set(left, 0);
    out.set(right, left.byteLength);
    return out;
  };

  return {
    openAppend(path) {
      files.set(path, files.get(path) ?? new Uint8Array(0));
      return Promise.resolve({
        path,
        size() {
          return files.get(path)?.byteLength ?? 0;
        },
        append(data) {
          const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          files.set(path, concat(files.get(path) ?? new Uint8Array(0), view));
          return Promise.resolve();
        },
        truncate(limit) {
          files.set(path, (files.get(path) ?? new Uint8Array(0)).slice(0, limit));
          return Promise.resolve();
        },
        close() {
          return Promise.resolve();
        },
      });
    },
    readJson(path) {
      const bytes = files.get(path);
      if (bytes === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    },
    writeJson(path, value) {
      files.set(path, new TextEncoder().encode(JSON.stringify(value)));
      return Promise.resolve();
    },
    readFloat32(path) {
      const bytes = files.get(path);
      if (bytes === undefined) {
        return Promise.resolve(null);
      }
      const copy = new Uint8Array(bytes);
      return Promise.resolve(new Float32Array(copy.buffer));
    },
    writeFloat32(path, data) {
      files.set(path, new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
      return Promise.resolve();
    },
    async writeBlob(path, blob) {
      files.set(path, new Uint8Array(await blob.arrayBuffer()));
    },
    readBytes(path, offset, length) {
      const bytes = files.get(path);
      if (bytes === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve(bytes.slice(offset, offset + length));
    },
    sizeOf(path) {
      return Promise.resolve(files.get(path)?.byteLength ?? null);
    },
    remove(path) {
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) {
          files.delete(key);
        }
      }
      return Promise.resolve();
    },
    list(prefix) {
      return Promise.resolve([...files.keys()].filter((key) => key.startsWith(prefix)).sort());
    },
    usedBytes() {
      let total = 0;
      for (const bytes of files.values()) {
        total += bytes.byteLength;
      }
      return Promise.resolve(total);
    },
  };
}
