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
import { waveformBars } from './waveform.ts';

/**
 * The stems, playing alongside the file the song came from.
 *
 * The media element stays the clock: it has the only timeline the person can
 * drag, and for a video it is what they are watching. The stems follow it,
 * which means being started from its time, stopped whenever it stops, and
 * started again whenever it moves on its own.
 *
 * That is also what makes the switch free. The element plays the song as it
 * arrived from the moment the file is in; when the stems are ready and
 * somebody asks for the instrumental, they start at the element's current
 * time and the element is muted. Nothing restarts and nothing is reloaded.
 *
 * The volume is the exception. With the vocals out the sound comes from the
 * stems, so what the person asked for is held by the stage and pointed at
 * whichever is playing.
 */

export interface StemMix extends StemReadiness {
  /** The file must carry no sound: the stems are the sound. */
  readonly silenceSource: boolean;
  /**
   * The backing's own shape, for a song with no picture to look at. Empty
   * until the stems are in, which is the only place the samples come from.
   */
  readonly bars: readonly number[];
}

interface StemMixOptions {
  readonly media: RefObject<HTMLMediaElement | null>;
  /** Null for a file that has no record yet, which has no stems either. */
  readonly song: SongRecord | null;
  readonly choice: VocalChoice;
  /** The room's volume, which the stems answer to in instrumental mode. */
  readonly volume: number;
  readonly muted: boolean;
}

export function useStemMix({ media, song, choice, volume, muted }: StemMixOptions): StemMix {
  const store = useMemo(() => createOpfsStore(), []);
  const mixer = useRef<StemMixer | null>(null);
  const [state, setState] = useState<StemMixState>('absent');
  const [error, setError] = useState<string | null>(null);
  const [bars, setBars] = useState<readonly number[]>([]);
  const songId = song === null ? null : song.id;
  const separated = song?.status === 'ready';
  const instrumental = choice.mode === 'instrumental';

  useEffect(() => {
    if (!separated || songId === null) {
      setState('absent');
      setBars([]);
      return;
    }
    let dropped = false;
    let context: AudioContext | null = null;
    let built: StemMixer | null = null;
    setError(null);
    setState('loading');

    void (async () => {
      try {
        const paths = jobPaths(songId);
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
      // Leaving the song lets go of all of it: two stems are a hundred-odd
      // megabytes of buffer, and a context left open holds the output device.
      dropped = true;
      mixer.current = null;
      const closing = built === null ? context?.close() : built.close();
      void closing?.catch(() => undefined);
    };
  }, [separated, songId, store]);

  useEffect(() => {
    if (state === 'ready') {
      mixer.current?.setGains(stemGains(choice, volume, muted));
    }
  }, [choice, muted, state, volume]);

  useEffect(() => {
    const element = media.current;
    const current = mixer.current;
    if (element === null || current === null || state !== 'ready' || !instrumental) {
      // Including the switch back to original: the stems go quiet and the
      // file's own sound comes back.
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

    // The song is already playing by now, from the file itself: this is the
    // moment the stems take over, at whatever time it has reached.
    sync();

    return () => {
      clearInterval(timer);
      for (const [name, handler] of events) {
        element.removeEventListener(name, handler);
      }
      current.stop();
    };
  }, [instrumental, media, state]);

  return {
    state,
    error,
    bars,
    // Only once the stems can take over. Until then the file's own sound
    // plays, rather than the song going silent while it loads.
    silenceSource: instrumental && state === 'ready',
  };
}
