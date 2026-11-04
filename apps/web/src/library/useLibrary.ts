import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { describeRead, readLyricsFromVideo, type RunningLyricsRead } from '../lyrics/read.ts';
import { jobIdFor, jobPaths } from '../separation/job.ts';
import {
  analysisKeyFor,
  drop,
  emptyQueue,
  enqueue,
  finish,
  startNext,
  updateQueued,
  type AnalysisItem,
  type AnalysisJob,
  type JobQueue,
} from '../separation/queue.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';
import { decodeFile, startSeparation, type RunningSeparation } from './ingest.ts';
import { createIdbSongStore } from './idb-song-store.ts';
import { deleteSong, songSizes, sourcePathFor } from './storage.ts';
import {
  sourceKindFor,
  titleFromFileName,
  withLyrics,
  withoutLyrics,
  type SongRecord,
} from './songs.ts';

/** The library's state and the things it can do, for the player and the drawer. */

/** A lyric read in flight, which belongs to exactly one song. */
export interface LyricsJob {
  readonly songId: string;
  readonly stage: string;
  readonly framesDone: number;
  readonly framesTotal: number;
  readonly etaMs: number | null;
}

/** Told once a picked file has a record, which is when its stems can be found. */
export type Identified = (song: SongRecord, key: string) => void;

export interface Library {
  readonly songs: readonly SongRecord[];
  /** The first read of the records is done, so an empty list means empty. */
  readonly loaded: boolean;
  /** Bytes each song occupies in OPFS, keyed by song id. */
  readonly sizes: ReadonlyMap<string, number>;
  readonly usageBytes: number | null;
  readonly quotaBytes: number | null;
  /** What is being analysed and what is behind it. */
  readonly queue: JobQueue<AnalysisItem>;
  readonly active: AnalysisJob | null;
  /** Cancel was asked for; the worker stops after the segment it is on. */
  readonly cancelling: boolean;
  readonly lyricsJob: LyricsJob | null;
  readonly cancellingLyrics: boolean;
  readonly error: string | null;
  /** Queues a picked file for analysis. Playing it is the player's business. */
  add(file: File, onIdentified?: Identified): void;
  cancel(): void;
  /**
   * The key a stopped job can be carried on under, found by file or by song,
   * or null when this tab no longer holds the file it was reading.
   */
  resumeKeyFor(key: string | null, songId: string | null): string | null;
  /** Puts a stopped job back in the queue; it carries on where it left off. */
  resume(key: string): void;
  /** Takes a job out of the queue before it starts. */
  forget(key: string): void;
  remove(song: SongRecord): void;
  readLyrics(song: SongRecord): void;
  cancelLyrics(): void;
  removeLyrics(song: SongRecord): void;
  dismissError(): void;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useLibrary(): Library {
  const fileStore = useMemo(() => createOpfsStore(), []);
  const songStore = useMemo(() => createIdbSongStore(), []);
  const [songs, setSongs] = useState<readonly SongRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [usageBytes, setUsageBytes] = useState<number | null>(null);
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const [queue, setQueue] = useState<JobQueue<AnalysisItem>>(emptyQueue);
  const [active, setActive] = useState<AnalysisJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [lyricsJob, setLyricsJob] = useState<LyricsJob | null>(null);
  const [cancellingLyrics, setCancellingLyrics] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<RunningSeparation | null>(null);
  const reading = useRef<RunningLyricsRead | null>(null);
  /**
   * The queue twice over: once where the next job can be worked out without
   * waiting for a render, and once in state for whatever is drawing it.
   */
  const order = useRef<JobQueue<AnalysisItem>>(emptyQueue());
  /**
   * The files themselves, for as long as this tab lives. A File is a handle,
   * not bytes, and holding one is what lets a stopped job be resumed without
   * asking the person to find it again.
   */
  const files = useRef(new Map<string, File>());
  const identified = useRef(new Map<string, Identified>());
  /** Song id back to the file it was decoded from, for the resume button. */
  const keys = useRef(new Map<string, string>());

  const commit = useCallback((next: JobQueue<AnalysisItem>): void => {
    order.current = next;
    setQueue(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await songStore.list();
    setSongs(list);
    setLoaded(true);
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

  /**
   * One file, decoded and separated. Never rejects: a job that goes wrong
   * leaves its record marked failed and its reason on screen, and the queue
   * carries on to the next song either way.
   */
  const analyse = useCallback(
    async (item: AnalysisItem, file: File): Promise<void> => {
      let record: SongRecord | null = null;
      setActive({
        ...item,
        stage: 'decoding',
        segmentsDone: 0,
        segmentsTotal: 0,
        etaMs: null,
        resumedFrom: 0,
      });

      try {
        const decoded = await decodeFile(file);
        const id = jobIdFor(decoded.source);
        const { directory } = jobPaths(id);
        const kind = sourceKindFor(file.name, file.type);
        // The same file picked again is the same song: keep its title, the
        // date it first arrived and any lyrics read off it, and let the worker
        // carry on with its job.
        const previous = await songStore.get(id);
        const fresh: SongRecord = {
          id,
          title: previous?.title ?? item.title,
          durationMs: Math.round((decoded.source.samples / decoded.source.sampleRate) * 1000),
          sourceBytes: file.size,
          sourceKind: kind,
          status: 'separating',
          stemsDirectory: directory,
          // Audio as well as video. The file the person handed over is what
          // the stage plays, from the second it is in until long after this
          // tab is closed, so its bytes are kept whatever is in them.
          sourcePath: sourcePathFor(directory, file.name),
          createdAt: previous?.createdAt ?? new Date().toISOString(),
        };
        // Lyrics read off this song before are kept: resuming a stopped job
        // writes the record again, and reading them again takes minutes.
        const lyrics = previous?.lyrics;
        record = lyrics === undefined ? fresh : withLyrics(fresh, lyrics);

        const sourcePath = record.sourcePath;
        if (sourcePath !== null && (await fileStore.sizeOf(sourcePath)) === null) {
          await fileStore.writeBlob(sourcePath, file);
        }
        await songStore.put(record);

        // The stage is already playing these bytes from a URL of its own; this
        // is how it learns which record is its own, so the vocal toggle knows
        // where to look for stems.
        identified.current.get(item.key)?.(record, item.key);
        keys.current.set(id, item.key);
        commit(updateQueued(order.current, item.key, (queued) => ({ ...queued, songId: id })));
        await refresh();

        const title = record.title;
        const run = startSeparation(decoded, (progress) => {
          setActive({
            key: item.key,
            title,
            songId: id,
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
        identified.current.delete(item.key);
        await refresh();
      }
    },
    [commit, fileStore, refresh, songStore],
  );

  /**
   * Starts the next job if the machine is free, and again when it finishes.
   * A lyric read holds the machine too: it decodes video frames and runs OCR,
   * and the two together would take longer than either alone.
   */
  const pump = useCallback(
    function pump(): void {
      // The queue is what says whether the machine is busy, not the worker
      // handle: a job spends its first seconds decoding, before any worker
      // exists, and a second job started in that gap would be two.
      if (order.current.running !== null || reading.current !== null) {
        return;
      }
      const started = startNext(order.current);
      const item = started.running;
      if (item === null) {
        return;
      }
      commit(started);
      const file = files.current.get(item.key);
      if (file === undefined) {
        // The file went with a tab that closed. Dropping the same one in
        // again picks the job up from where it stopped.
        commit(finish(order.current, item.key));
        return;
      }
      void (async () => {
        await analyse(item, file);
        commit(finish(order.current, item.key));
        pump();
      })();
    },
    [analyse, commit],
  );

  const add = useCallback(
    (file: File, onIdentified?: Identified): void => {
      const key = analysisKeyFor(file.name, file.size, file.lastModified);
      files.current.set(key, file);
      if (onIdentified !== undefined) {
        identified.current.set(key, onIdentified);
      }
      setError(null);
      commit(
        enqueue(order.current, { key, title: titleFromFileName(file.name), songId: null }),
      );
      pump();
    },
    [commit, pump],
  );

  const cancel = useCallback((): void => {
    if (running.current === null) {
      return;
    }
    setCancelling(true);
    running.current.cancel();
  }, []);

  const resumeKeyFor = useCallback((key: string | null, songId: string | null): string | null => {
    if (key !== null && files.current.has(key)) {
      return key;
    }
    const known = songId === null ? undefined : keys.current.get(songId);
    return known !== undefined && files.current.has(known) ? known : null;
  }, []);

  const resume = useCallback(
    (key: string): void => {
      const file = files.current.get(key);
      if (file === undefined) {
        setError('that file is no longer open in this tab: drop the same one in again');
        return;
      }
      add(file);
    },
    [add],
  );

  const forget = useCallback(
    (key: string): void => {
      commit(drop(order.current, key));
    },
    [commit],
  );

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

  const readLyrics = useCallback(
    (song: SongRecord): void => {
      const path = song.sourcePath;
      if (path === null) {
        setError(`${song.title} has no kept video to read lyrics from`);
        return;
      }
      if (order.current.running !== null || reading.current !== null) {
        setError('one job at a time: this machine cannot analyse and read at once');
        return;
      }
      setError(null);
      setLyricsJob({
        songId: song.id,
        stage: 'reading the file',
        framesDone: 0,
        framesTotal: 0,
        etaMs: null,
      });

      const run = readLyricsFromVideo({
        store: fileStore,
        path,
        onProgress: (progress) => {
          setLyricsJob({ songId: song.id, ...progress });
        },
      });
      reading.current = run;

      void (async () => {
        try {
          const outcome = await run.finished;
          // Counts and timings. The lines themselves never reach the console.
          console.info(describeRead(outcome));
          if (outcome.cancelled) {
            return;
          }
          if (outcome.lines.length === 0) {
            setError(`no words could be read from the picture of ${song.title}`);
            return;
          }
          // Read back rather than written over: the record may have been
          // touched while the video was being read.
          const current = (await songStore.get(song.id)) ?? song;
          await songStore.put(
            withLyrics(current, {
              lines: outcome.lines,
              source: 'video-ocr',
              readAt: new Date().toISOString(),
            }),
          );
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          reading.current = null;
          setLyricsJob(null);
          setCancellingLyrics(false);
          await refresh();
          // Anything that queued itself while the read held the machine.
          pump();
        }
      })().catch((cause: unknown) => {
        setError(errorText(cause));
      });
    },
    [fileStore, pump, refresh, songStore],
  );

  const cancelLyrics = useCallback((): void => {
    if (reading.current === null) {
      return;
    }
    setCancellingLyrics(true);
    reading.current.cancel();
  }, []);

  const removeLyrics = useCallback(
    (song: SongRecord): void => {
      void songStore
        .put(withoutLyrics(song))
        .then(refresh)
        .catch((cause: unknown) => {
          setError(errorText(cause));
        });
    },
    [refresh, songStore],
  );

  const dismissError = useCallback((): void => {
    setError(null);
  }, []);

  return {
    songs,
    loaded,
    sizes,
    usageBytes,
    quotaBytes,
    queue,
    active,
    cancelling,
    lyricsJob,
    cancellingLyrics,
    error,
    add,
    cancel,
    resumeKeyFor,
    resume,
    forget,
    remove,
    readLyrics,
    cancelLyrics,
    removeLyrics,
    dismissError,
  };
}
