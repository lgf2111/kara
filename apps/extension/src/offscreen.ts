import { clampKey, KEY_DEFAULT } from './audio/key.ts';
import { normaliseMix, type StemMix } from './audio/stems.ts';
import { startEngine, type Engine } from './offscreen/engine.ts';
import {
  IDLE_REPORT,
  isCommand,
  packet,
  packetFor,
  type Command,
  type MediaSample,
  type PlayMode,
  type Report,
} from './protocol.ts';
import { reasonText } from './reason.ts';
import { RUNTIME_PATH, WEIGHTS_PATH } from './separation/model.ts';

/**
 * The offscreen document: where the audio lives.
 *
 * It exists because of what a Manifest V3 service worker cannot do: it has no
 * `AudioContext` and no guarantee of being alive in a second's time, and this
 * extension needs the first for as long as a song lasts. So the service worker
 * owns the tab and the popup owns the person's click, and a session is handed
 * over to this page, which owns the audio and nothing else.
 *
 * Everything it loads — the graph's pieces, the ONNX runtime's wasm, the
 * playback worklet — comes from `chrome.runtime.getURL`, which is to say from
 * the packed extension. The one thing it fetches from the world is the audio
 * stream the page itself reported, which is read onto the device and never
 * sent anywhere.
 */

let engine: Engine | null = null;
let tabId: number | null = null;
/** Serialises start and stop, which both take a while and must not interleave. */
let turn: Promise<void> = Promise.resolve();
/**
 * What the person asked for while the engine was still being built.
 *
 * `startEngine` is awaited for the fetch, the decode and the worker's setup,
 * and `engine` is nought until it returns. A key button pressed during that
 * wait used to be dropped; the last value of each is kept and applied to the
 * engine the moment there is one.
 */
let pendingMode: PlayMode | null = null;
let pendingMix: StemMix | null = null;
let pendingKey: number | null = null;
/** The last place the page said the video was, for the same reason. */
let lastSample: MediaSample | null = null;

function tell(report: Report): void {
  // The service worker may be asleep; sending wakes it. A send with nothing
  // listening rejects, and there is nothing useful to do about that.
  chrome.runtime.sendMessage(packet('background', report, tabId)).catch(() => undefined);
}

function tellFailure(cause: unknown): void {
  tell({ ...IDLE_REPORT, status: 'error', reason: reasonText(cause) });
}

async function start(command: Extract<Command, { type: 'start' }>): Promise<void> {
  await stop();
  tabId = command.tabId;
  engine = await startEngine({
    stream: command.stream,
    weightsBase: chrome.runtime.getURL(WEIGHTS_PATH),
    runtimePath: chrome.runtime.getURL(RUNTIME_PATH),
    playbackWorkletUrl: chrome.runtime.getURL('stem-player.js'),
    pitchWorkletUrl: chrome.runtime.getURL('signalsmith-stretch.js'),
    // The remembered default, handed over by the service worker with the
    // start. From here on the key belongs to the session and only a command
    // moves it.
    key: clampKey(command.key ?? KEY_DEFAULT),
    onStatus: (report) => {
      tell(report);
    },
    onMetrics: (metrics) => {
      tell({ type: 'metrics', metrics });
    },
    onPractice: (report) => {
      tell(report);
    },
  });
  const started = engine;
  if (started !== null) {
    if (pendingMode !== null) {
      started.setMode(pendingMode);
    }
    if (pendingMix !== null) {
      started.setMix(pendingMix);
    }
    if (pendingKey !== null) {
      started.setKey(pendingKey);
    }
    if (lastSample !== null) {
      started.media(lastSample);
    }
  }
  pendingMode = null;
  pendingMix = null;
  pendingKey = null;
}

async function stop(): Promise<void> {
  const running = engine;
  engine = null;
  pendingMode = null;
  pendingMix = null;
  pendingKey = null;
  lastSample = null;
  if (running !== null) {
    await running.stop();
  }
}

function accept(command: Command): void {
  switch (command.type) {
    case 'start':
      turn = turn.then(() => start(command)).catch(tellFailure);
      return;
    case 'stop':
      turn = turn.then(stop).catch(tellFailure);
      return;
    case 'mode':
      if (engine === null) {
        pendingMode = command.mode;
      } else {
        engine.setMode(command.mode);
      }
      return;
    case 'mix':
      if (engine === null) {
        pendingMix = normaliseMix(command.mix);
      } else {
        engine.setMix(command.mix);
      }
      return;
    case 'duet-start':
      engine?.startDuet();
      return;
    case 'duet-mix':
      engine?.setDuetMix(command.mix);
      return;
    case 'duet-swap':
      engine?.swapDuet();
      return;
    case 'duet-anchor':
      engine?.anchorDuet(command.voice, command.seconds);
      return;
    case 'duet-clear':
      engine?.clearDuet();
      return;
    case 'practice-start':
      if (engine === null) {
        tell({
          type: 'practice-analysis',
          state: 'error',
          progress: null,
          notes: null,
          detail: 'Start karaoke before starting practice.',
        });
      } else {
        engine.startPractice();
      }
      return;
    case 'practice-stop':
      engine?.stopPractice();
      return;
    case 'key':
      if (engine === null) {
        pendingKey = command.semitones;
      } else {
        engine.setKey(command.semitones);
      }
      return;
    case 'media':
      lastSample = command.sample;
      engine?.media(command.sample);
      return;
    case 'debug': {
      const running = engine;
      if (running !== null) {
        tell({ type: 'debug-log', pipeline: running.debug() });
      }
      return;
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const received = packetFor('offscreen', message);
  if (received === null) {
    return false;
  }
  const body = received.body;
  if (!isCommand(body)) {
    // A report or a request addressed here is nothing to act on.
    return false;
  }
  accept(body);
  return false;
});
