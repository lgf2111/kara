import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { SongRecord } from '../library/songs.ts';
import { jobPaths } from '../separation/job.ts';
import { createOpfsStore } from '../storage/opfs-store.ts';
import { createStemMixer, loadStemBuffers, type StemMixer } from './stem-audio.ts';
import {
  DRIFT_CHECK_MS,
  driftAction,
  stemGains,
  stemSampleRate,
  type StemMixState,
  type StemReadiness,
  type VocalChoice,
} from './stem-mix.ts';

/**
 * The stems, playing alongside the song's own picture.
 *
 * The video element stays the clock: it has the only timeline the person can
 * drag, and the picture is what they are watching. The stems follow it, which
 * means being started from its time, stopped whenever it stops, and started
 * again whenever it moves on its own.
 */

export interface StemMix extends StemReadiness {
  /** The picture must carry no sound: the stems are the sound. */
  readonly silenceVideo: boolean;
}

interface StemMixOptions {
  readonly video: RefObject<HTMLVideoElement | null>;
  readonly song: SongRecord;
  readonly choice: VocalChoice;
  /** The player's own volume, which the stems answer to in instrumental mode. */
  readonly volume: number;
  readonly muted: boolean;
}

export function useStemMix({ video, song, choice, volume, muted }: StemMixOptions): StemMix {
  const store = useMemo(() => createOpfsStore(), []);
  const mixer = useRef<StemMixer | null>(null);
  const [state, setState] = useState<StemMixState>('absent');
  const [error, setError] = useState<string | null>(null);
  const separated = song.status === 'ready';
  const instrumental = choice.mode === 'instrumental';

  useEffect(() => {
    if (!separated) {
      setState('absent');
      return;
    }
    let dropped = false;
    let context: AudioContext | null = null;
    let built: StemMixer | null = null;
    setError(null);
    setState('loading');

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
      const closing = built === null ? context?.close() : built.close();
      void closing?.catch(() => undefined);
    };
  }, [separated, song.id, store]);

  useEffect(() => {
    if (state === 'ready') {
      mixer.current?.setGains(stemGains(choice, volume, muted));
    }
  }, [choice, muted, state, volume]);

  useEffect(() => {
    const element = video.current;
    const current = mixer.current;
    if (element === null || current === null || state !== 'ready' || !instrumental) {
      // Including the switch back to original: the stems go quiet and the
      // element's own sound comes back.
      current?.stop();
      return;
    }

    const sync = (): void => {
      if (element.paused || element.ended || element.seeking) {
        current.stop();
        return;
      }
      current.start(element.currentTime, element.playbackRate);
    };
    const stop = (): void => {
      current.stop();
    };

    const events: readonly [string, () => void][] = [
      ['play', sync],
      ['playing', sync],
      ['seeked', sync],
      ['ratechange', sync],
      ['pause', stop],
      ['seeking', stop],
      ['waiting', stop],
      ['ended', stop],
    ];
    for (const [name, handler] of events) {
      element.addEventListener(name, handler);
    }

    // A buffer source cannot be asked to follow another clock, so the two are
    // compared and the stems restarted once they are further apart than an
    // ear would let pass. Dropped frames and a throttled tab both land here.
    const timer = setInterval(() => {
      if (element.paused || element.seeking) {
        return;
      }
      const at = current.position();
      if (at === null || driftAction(element.currentTime, at) === 'resync') {
        sync();
      }
    }, DRIFT_CHECK_MS);

    // The song is already playing by now: it autoplays while the stems are
    // still being read.
    sync();

    return () => {
      clearInterval(timer);
      for (const [name, handler] of events) {
        element.removeEventListener(name, handler);
      }
      current.stop();
    };
  }, [instrumental, state, video]);

  return {
    state,
    error,
    // Only once the stems can take over. Until then the file's own sound
    // plays, rather than the song going silent while it loads.
    silenceVideo: instrumental && state === 'ready',
  };
}
