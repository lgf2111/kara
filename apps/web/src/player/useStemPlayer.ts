import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SongRecord } from '../library/songs.ts';
import { jobPaths } from '../separation/job.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';
import {
  clockEnded,
  clockPosition,
  pauseClock,
  pausedClock,
  seekClock,
  startClock,
  type AudioClock,
} from './audio-clock.ts';
import { createStemMixer, loadStemBuffers, type StemMixer } from './stem-audio.ts';
import {
  audioStemGains,
  stemSampleRate,
  type StemMixState,
  type VocalChoice,
} from './stem-mix.ts';
import { seekTo } from './time.ts';
import { waveformBars } from './waveform.ts';

/**
 * The stems as the whole song, for a file that kept no picture of its own.
 *
 * Nothing else here can keep time, so the clock in `audio-clock.ts` is it:
 * the stems are started from whatever it says, and it is what the controls
 * read. That is the one real difference from the video path, where the
 * element keeps time and the stems chase it. Here the two count the same
 * audio clock, so there is nothing to chase and no drift to mend.
 *
 * It does not start on its own. The sound is Web Audio, which a browser will
 * not let out until someone has asked for it, and a song that silently
 * pretends to be playing is worse than one waiting on a button.
 */

/** How often the clock is read for the controls. Smooth enough to read. */
const TICK_MS = 100;

export interface StemPlayer {
  readonly state: StemMixState;
  readonly error: string | null;
  readonly playing: boolean;
  readonly currentSeconds: number;
  /** NaN until the stems are in: nothing else knows how long they are. */
  readonly durationSeconds: number;
  /** One height per bar, 0 to 1, of the song's own shape. */
  readonly bars: readonly number[];
  toggle(): void;
  skip(seconds: number): void;
  /** An absolute time, from dragging the bar. */
  seek(seconds: number): void;
}

interface StemPlayerOptions {
  readonly song: SongRecord;
  readonly choice: VocalChoice;
  readonly volume: number;
  readonly muted: boolean;
}

export function useStemPlayer({ song, choice, volume, muted }: StemPlayerOptions): StemPlayer {
  const store = useMemo(() => createOpfsStore(), []);
  const audio = useRef<AudioContext | null>(null);
  const mixer = useRef<StemMixer | null>(null);
  const clock = useRef<AudioClock>(pausedClock());
  // The same length as the state below, where the controls can reach it
  // without waiting for a render.
  const length = useRef(Number.NaN);
  const [state, setState] = useState<StemMixState>('absent');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(Number.NaN);
  const [bars, setBars] = useState<readonly number[]>([]);

  useEffect(() => {
    if (song.status !== 'ready') {
      // Nothing was separated, and there is no file of its own to fall back
      // on. The library does not offer such a song to play.
      setState('absent');
      return;
    }
    let dropped = false;
    let context: AudioContext | null = null;
    let built: StemMixer | null = null;
    setError(null);
    setState('loading');
    setPlaying(false);
    setCurrentSeconds(0);
    setDurationSeconds(Number.NaN);
    setBars([]);
    clock.current = pausedClock();
    length.current = Number.NaN;

    void (async () => {
      try {
        const paths = jobPaths(song.id);
        const sampleRate = stemSampleRate(await store.readJson(paths.state));
        if (dropped) {
          return;
        }
        const opened = new AudioContext();
        context = opened;
        const buffers = await loadStemBuffers(
          opened,
          store,
          { instrumental: paths.stem('instrumental'), vocals: paths.stem('vocals') },
          sampleRate,
          () => dropped,
        );
        if (dropped || buffers === null) {
          void opened.close().catch(() => undefined);
          return;
        }
        built = createStemMixer(opened, buffers);
        mixer.current = built;
        audio.current = opened;
        length.current = buffers.instrumental.duration;
        setDurationSeconds(buffers.instrumental.duration);
        // The backing alone: one stem carries the song's shape, and its
        // channel is already in memory.
        setBars(waveformBars(buffers.instrumental.getChannelData(0)));
        setState('ready');
      } catch (cause) {
        if (!dropped) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setState('failed');
        }
      }
    })();

    return () => {
      // Leaving the player lets go of all of it: two stems are a hundred-odd
      // megabytes of buffer, and a context left open holds the output device.
      dropped = true;
      mixer.current = null;
      audio.current = null;
      length.current = Number.NaN;
      const closing = built === null ? context?.close() : built.close();
      void closing?.catch(() => undefined);
    };
  }, [song.id, song.status, store]);

  useEffect(() => {
    if (state === 'ready') {
      mixer.current?.setGains(audioStemGains(choice, volume, muted));
    }
  }, [choice, muted, state, volume]);

  const toggle = useCallback((): void => {
    const context = audio.current;
    const current = mixer.current;
    if (context === null || current === null) {
      // Still reading the stems off this device. The note below says so.
      return;
    }
    if (clock.current.running) {
      clock.current = pauseClock(clock.current, context.currentTime, length.current);
      current.stop();
      setCurrentSeconds(clock.current.atSeconds);
      setPlaying(false);
      return;
    }
    const next = startClock(clock.current, context.currentTime, length.current);
    clock.current = next;
    // The mixer resumes the context, which the browser kept suspended until
    // this press.
    current.start(next.atSeconds, 1);
    setCurrentSeconds(next.atSeconds);
    setPlaying(true);
  }, []);

  const seek = useCallback((seconds: number): void => {
    const context = audio.current;
    if (context === null) {
      return;
    }
    const next = seekClock(clock.current, seconds, context.currentTime, length.current);
    clock.current = next;
    setCurrentSeconds(next.atSeconds);
    if (next.running) {
      // A buffer source cannot be moved once it is running: it is thrown away
      // and started again from the new point.
      mixer.current?.start(next.atSeconds, 1);
    }
  }, []);

  const skip = useCallback(
    (seconds: number): void => {
      const context = audio.current;
      if (context === null) {
        return;
      }
      const at = clockPosition(clock.current, context.currentTime, length.current);
      seek(seekTo(at, seconds, length.current));
    },
    [seek],
  );

  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setInterval(() => {
      const context = audio.current;
      if (context === null) {
        return;
      }
      const at = context.currentTime;
      setCurrentSeconds(clockPosition(clock.current, at, length.current));
      if (clockEnded(clock.current, at, length.current)) {
        // The buffers have run out. The clock is left stopped at the end, so
        // pressing play starts the song over rather than nothing.
        clock.current = pauseClock(clock.current, at, length.current);
        mixer.current?.stop();
        setPlaying(false);
      }
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [playing]);

  return { state, error, playing, currentSeconds, durationSeconds, bars, toggle, skip, seek };
}
