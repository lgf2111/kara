import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { jobIdFor, jobPaths } from '../separation/job.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';
import { decodeFile, startSeparation, type RunningSeparation } from './ingest.ts';
import { createIdbSongStore } from './idb-song-store.ts';
import { deleteSong, songSizes, sourcePathFor } from './storage.ts';
import { sourceKindFor, titleFromFileName, type SongRecord } from './songs.ts';

/** The library screen's state and the three things it can do. */

export interface ActiveJob {
  readonly title: string;
  /** The worker's stage, or `decoding` before the worker exists. */
  readonly stage: string;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly etaMs: number | null;
  readonly resumedFrom: number;
}

export interface Library {
  readonly songs: readonly SongRecord[];
  /** Bytes each song occupies in OPFS, keyed by song id. */
  readonly sizes: ReadonlyMap<string, number>;
  readonly usageBytes: number | null;
  readonly quotaBytes: number | null;
  readonly active: ActiveJob | null;
  /** Cancel was asked for; the worker stops after the segment it is on. */
  readonly cancelling: boolean;
  readonly error: string | null;
  add(file: File): void;
  cancel(): void;
  remove(song: SongRecord): void;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useLibrary(): Library {
  const fileStore = useMemo(() => createOpfsStore(), []);
  const songStore = useMemo(() => createIdbSongStore(), []);
  const [songs, setSongs] = useState<readonly SongRecord[]>([]);
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [usageBytes, setUsageBytes] = useState<number | null>(null);
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const [active, setActive] = useState<ActiveJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<RunningSeparation | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await songStore.list();
    setSongs(list);
    setSizes(await songSizes(fileStore, list));
    const estimate = await navigator.storage.estimate();
    setUsageBytes(estimate.usage ?? null);
    setQuotaBytes(estimate.quota ?? null);
  }, [fileStore, songStore]);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(errorText(cause));
    });
  }, [refresh]);

  const add = useCallback(
    (file: File): void => {
      if (running.current !== null) {
        setError('one song at a time: this machine cannot separate two at once');
        return;
      }
      setError(null);
      setActive({
        title: titleFromFileName(file.name),
        stage: 'decoding',
        segmentsDone: 0,
        segmentsTotal: 0,
        etaMs: null,
        resumedFrom: 0,
      });

      void (async () => {
        let record: SongRecord | null = null;
        try {
          const decoded = await decodeFile(file);
          const id = jobIdFor(decoded.source);
          const { directory } = jobPaths(id);
          const kind = sourceKindFor(file.name, file.type);
          // The same file picked again is the same song: keep its title and
          // the date it first arrived, and let the worker resume its job.
          const previous = await songStore.get(id);
          record = {
            id,
            title: previous?.title ?? titleFromFileName(file.name),
            durationMs: Math.round((decoded.source.samples / decoded.source.sampleRate) * 1000),
            sourceBytes: file.size,
            sourceKind: kind,
            status: 'separating',
            stemsDirectory: directory,
            sourcePath: kind === 'video' ? sourcePathFor(directory, file.name) : null,
            createdAt: previous?.createdAt ?? new Date().toISOString(),
          };

          // A video's picture becomes the room background, so its own bytes
          // are kept. An audio file is not copied: the stems replace it.
          const sourcePath = record.sourcePath;
          if (sourcePath !== null && (await fileStore.sizeOf(sourcePath)) === null) {
            await fileStore.writeBlob(sourcePath, file);
          }
          await songStore.put(record);
          await refresh();

          const title = record.title;
          const run = startSeparation(decoded, (progress) => {
            setActive({
              title,
              stage: progress.stage,
              segmentsDone: progress.segmentsDone,
              segmentsTotal: progress.segmentsTotal,
              etaMs: progress.etaMs,
              resumedFrom: progress.resumedFrom,
            });
          });
          running.current = run;

          const outcome = await run.finished;
          await songStore.put({ ...record, status: outcome.cancelled ? 'cancelled' : 'ready' });
        } catch (cause) {
          setError(errorText(cause));
          if (record !== null) {
            await songStore.put({ ...record, status: 'failed' });
          }
        } finally {
          running.current = null;
          setActive(null);
          setCancelling(false);
          await refresh();
        }
      })().catch((cause: unknown) => {
        setError(errorText(cause));
      });
    },
    [fileStore, refresh, songStore],
  );

  const cancel = useCallback((): void => {
    if (running.current === null) {
      return;
    }
    setCancelling(true);
    running.current.cancel();
  }, []);

  const remove = useCallback(
    (song: SongRecord): void => {
      void deleteSong(fileStore, songStore, song)
        .then(refresh)
        .catch((cause: unknown) => {
          setError(errorText(cause));
        });
    },
    [fileStore, refresh, songStore],
  );

  return {
    songs,
    sizes,
    usageBytes,
    quotaBytes,
    active,
    cancelling,
    error,
    add,
    cancel,
    remove,
  };
}
