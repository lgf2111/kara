/**
 * The one call that needs a user gesture, in the one place both halves can
 * reach it from.
 *
 * `chrome.tabCapture.getMediaStreamId` is granted off the back of a click in
 * one of the extension's own contexts and refused everywhere else. The popup
 * is where that click lands now, so the popup is where this is called; the
 * service worker still calls it for a start the page asked for, which it will
 * almost always be refused, and that refusal is what the panel's hint is made
 * of.
 *
 * The callback form is named here rather than taken from the typings: every
 * Chrome with this API has it, the promise form arrived later, and a refusal
 * lands in `lastError` either way.
 */

interface StreamIdApi {
  getMediaStreamId: (
    options: { readonly targetTabId: number },
    callback: (streamId: string) => void,
  ) => void;
}

export function mediaStreamId(targetTabId: number): Promise<string> {
  const api = chrome.tabCapture as unknown as StreamIdApi;
  return new Promise((resolve, reject) => {
    api.getMediaStreamId({ targetTabId }, (streamId) => {
      const failure = chrome.runtime.lastError;
      if (failure !== undefined) {
        reject(new Error(failure.message ?? 'this tab could not be captured'));
        return;
      }
      resolve(streamId);
    });
  });
}
