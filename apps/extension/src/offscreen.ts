import { startPipeline, type Pipeline } from './offscreen/pipeline.ts';
import { packet, packetFor, type Command, type Report } from './protocol.ts';
import { reasonText } from './reason.ts';
import { RUNTIME_PATH, WEIGHTS_PATH } from './separation/model.ts';

/**
 * The offscreen document: where the audio lives.
 *
 * It exists because of what a Manifest V3 service worker cannot do. It has no
 * `getUserMedia`, no `AudioContext` and no guarantee of being alive in a
 * second's time, and this extension needs all three for about as long as a
 * song lasts. So the service worker owns the user's click and the tab, and
 * hands a capture over to this page, which owns the audio and nothing else.
 *
 * Everything it loads — the graph's pieces, the ONNX runtime's wasm, both
 * worklets, the separation worker — comes from `chrome.runtime.getURL`, which
 * is to say from the packed extension. There is no code path here that can
 * reach the network, and the captured audio never leaves this document.
 */

let pipeline: Pipeline | null = null;
let tabId: number | null = null;
/** Serialises start and stop, which both take a while and must not interleave. */
let turn: Promise<void> = Promise.resolve();

function tell(report: Report): void {
  // The service worker may be asleep; sending wakes it. A send with nothing
  // listening rejects, and there is nothing useful to do about that.
  chrome.runtime.sendMessage(packet('background', report, tabId)).catch(() => undefined);
}

function tellFailure(cause: unknown): void {
  tell({
    type: 'status',
    status: 'error',
    reason: reasonText(cause),
    secondsLeft: null,
    delaySeconds: null,
    mode: 'instrumental',
    guide: 0,
  });
}

/**
 * The tab's audio, by stream id.
 *
 * `chromeMediaSource: 'tab'` is not in the standard constraints, hence the
 * cast. It is also the only audio source in this extension: nothing here
 * fetches a stream, a file or a URL, and the id is one the service worker was
 * handed for a tab the person clicked on.
 */
async function tabAudio(streamId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  } as unknown as MediaStreamConstraints);
}

async function start(command: Extract<Command, { type: 'start' }>): Promise<void> {
  await stop();
  tabId = command.tabId;
  const stream = await tabAudio(command.streamId);
  pipeline = await startPipeline({
    stream,
    weightsBase: chrome.runtime.getURL(WEIGHTS_PATH),
    runtimePath: chrome.runtime.getURL(RUNTIME_PATH),
    captureWorkletUrl: chrome.runtime.getURL('capture-worklet.js'),
    playbackWorkletUrl: chrome.runtime.getURL('playback-worklet.js'),
    onStatus: (report) => {
      tell(report);
    },
    onMetrics: (metrics) => {
      tell({ type: 'metrics', metrics });
    },
  });
}

async function stop(): Promise<void> {
  const running = pipeline;
  pipeline = null;
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
    case 'reset':
      pipeline?.reset();
      return;
    case 'mode':
      pipeline?.setMode(command.mode);
      return;
    case 'guide':
      pipeline?.setGuide(command.level);
      return;
    case 'passthrough':
      pipeline?.setPassthrough(command.enabled);
      return;
  }
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const received = packetFor('offscreen', message);
  if (received === null) {
    return false;
  }
  const body = received.body;
  if (body.type === 'status' || body.type === 'metrics') {
    // A report addressed to the audio side is nothing to act on.
    return false;
  }
  accept(body);
  return false;
});
