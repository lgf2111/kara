/**
 * The buffer separated audio waits in until its moment arrives.
 *
 * Blocks come back from the separator in hops of nearly six seconds, each one
 * stamped with the sample it starts at. The player wants a hundred and
 * twenty-eight frames at a time, and it wants them at the exact moment the
 * delay says. So the blocks are written into a ring by absolute sample index
 * and read out of it by absolute sample index, and the two never speak.
 *
 * Indexing by absolute sample rather than by arrival order is what makes this
 * honest about failure. A read past what has been written is an underrun and
 * is counted; a block that turns up after its frames were already due is late
 * and is counted; a gap between blocks is filled with silence rather than with
 * whatever the ring held one lap ago. Those three counters are the difference
 * between audio that is wrong and audio that is wrong in a way nobody can see.
 *
 * Nothing here knows about Web Audio, so a test can push blocks in by hand and
 * read them back out of order.
 */

export interface PlayRing {
  readonly channels: number;
  /** Frames the ring holds. Older frames than this are gone. */
  readonly capacity: number;
  /** One past the highest frame written. */
  readonly writtenTo: number;
  /** One past the highest frame read. */
  readonly readTo: number;
  /** Frames asked for that nothing had written. */
  readonly underrunFrames: number;
  /** Frames arriving after they were due, or too far ahead to keep. */
  readonly lateFrames: number;
  readonly aheadFrames: number;
  /** Frames of silence written to cover a gap between blocks. */
  readonly gapFrames: number;
  /** Frames written that have not been read yet. */
  readonly queuedFrames: number;
  /**
   * Writes a block at an absolute frame, one array per channel. Returns the
   * frames taken, which is fewer than the block when part of it was late or
   * further ahead than the ring can hold.
   */
  write(startFrame: number, data: readonly Float32Array[]): number;
  /**
   * Fills `frames` of each target from an absolute frame, zeroing whatever is
   * not there. Returns how many of them were real.
   */
  read(startFrame: number, frames: number, into: readonly Float32Array[]): number;
  /**
   * Moves the read mark back to `frame`, so blocks for frames past it are
   * accepted again.
   *
   * This exists for one failure and is the whole of its cure. Writes below the
   * read mark are refused as late, which is right — audio already handed to
   * the person cannot be changed — but it means that an output which has run
   * past the frontier of finalised audio refuses every block that follows, and
   * so plays silence for ever rather than for a moment. The player's answer is
   * to grow the delay, which steps the read position backwards; this is what
   * lets the ring believe it.
   *
   * Never forwards: a read mark that could be moved on would silently skip
   * audio nobody heard.
   */
  rewind(frame: number): void;
  /** Empties the ring and starts the timeline again at frame zero. */
  reset(): void;
}

/** Walks a span of frames as runs that do not cross the ring's seam. */
function eachRun(
  capacity: number,
  startFrame: number,
  frames: number,
  visit: (at: number, offset: number, length: number) => void,
): void {
  let done = 0;
  while (done < frames) {
    const at = (startFrame + done) % capacity;
    const length = Math.min(frames - done, capacity - at);
    visit(at, done, length);
    done += length;
  }
}

export function createPlayRing(channels: number, capacity: number): PlayRing {
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error(`a ring needs at least one channel, not ${String(channels)}`);
  }
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`a ring of ${String(capacity)} frames holds nothing`);
  }

  const lanes = Array.from({ length: channels }, () => new Float32Array(capacity));
  let writtenTo = 0;
  let readTo = 0;
  let underrunFrames = 0;
  let lateFrames = 0;
  let aheadFrames = 0;
  let gapFrames = 0;

  /** Oldest frame the ring still holds: anything before it has been lapped. */
  const oldest = (): number => Math.max(0, writtenTo - capacity);

  return {
    channels,
    capacity,
    get writtenTo() {
      return writtenTo;
    },
    get readTo() {
      return readTo;
    },
    get underrunFrames() {
      return underrunFrames;
    },
    get lateFrames() {
      return lateFrames;
    },
    get aheadFrames() {
      return aheadFrames;
    },
    get gapFrames() {
      return gapFrames;
    },
    get queuedFrames() {
      return Math.max(0, writtenTo - readTo);
    },

    write(startFrame, data) {
      if (data.length !== channels) {
        throw new Error(
          `a block brought ${String(data.length)} channels for a ring of ${String(channels)}`,
        );
      }
      const frames = data[0]?.length ?? 0;
      for (const lane of data) {
        if (lane.length !== frames) {
          throw new Error('a block gave its channels different lengths');
        }
      }
      if (!Number.isInteger(startFrame) || startFrame < 0) {
        throw new Error(`a block at frame ${String(startFrame)} is not on the timeline`);
      }
      if (frames === 0) {
        return 0;
      }

      // Frames already handed to the player cannot be changed, and frames
      // further ahead than the ring is long have nowhere to sit.
      const from = Math.max(startFrame, readTo);
      const to = Math.min(startFrame + frames, readTo + capacity);
      lateFrames += Math.max(0, from - startFrame);
      aheadFrames += Math.max(0, startFrame + frames - Math.max(to, from));
      if (to <= from) {
        return 0;
      }

      // A gap means a block never arrived. Silence is the honest filler: what
      // is in the ring there is audio from one lap ago.
      const gapFrom = Math.max(writtenTo, readTo);
      if (from > gapFrom) {
        const span = Math.min(from - gapFrom, capacity);
        eachRun(capacity, from - span, span, (at, _offset, length) => {
          for (const lane of lanes) {
            lane.fill(0, at, at + length);
          }
        });
        gapFrames += from - gapFrom;
      }

      eachRun(capacity, from, to - from, (at, offset, length) => {
        for (let channel = 0; channel < channels; channel += 1) {
          const lane = lanes[channel];
          const source = data[channel];
          if (lane === undefined || source === undefined) {
            return;
          }
          const take = from - startFrame + offset;
          lane.set(source.subarray(take, take + length), at);
        }
      });
      writtenTo = Math.max(writtenTo, to);
      return to - from;
    },

    read(startFrame, frames, into) {
      if (into.length !== channels) {
        throw new Error(
          `a read wants ${String(into.length)} channels from a ring of ${String(channels)}`,
        );
      }
      for (const lane of into) {
        if (lane.length < frames) {
          throw new Error(`a read of ${String(frames)} frames has no room for them`);
        }
        lane.fill(0, 0, frames);
      }
      if (frames <= 0) {
        return 0;
      }

      const from = Math.max(startFrame, oldest());
      const to = Math.min(startFrame + frames, writtenTo);
      const delivered = Math.max(0, to - from);
      if (delivered > 0) {
        eachRun(capacity, from, delivered, (at, offset, length) => {
          for (let channel = 0; channel < channels; channel += 1) {
            const lane = lanes[channel];
            const target = into[channel];
            if (lane === undefined || target === undefined) {
              return;
            }
            target.set(lane.subarray(at, at + length), from - startFrame + offset);
          }
        });
      }
      underrunFrames += frames - delivered;
      readTo = Math.max(readTo, startFrame + frames);
      return delivered;
    },

    rewind(frame) {
      if (!Number.isFinite(frame)) {
        return;
      }
      readTo = Math.max(0, Math.min(readTo, Math.round(frame)));
    },

    reset() {
      for (const lane of lanes) {
        lane.fill(0);
      }
      writtenTo = 0;
      readTo = 0;
      underrunFrames = 0;
      lateFrames = 0;
      aheadFrames = 0;
      gapFrames = 0;
    },
  };
}
