import {
  DEFAULT_DUET_CONFIG,
  DUET_CONFIG_KEY,
  normaliseDuetConfig,
  type DuetConfig,
} from './audio/duet.ts';

/**
 * The duet helper connection, in `chrome.storage.local`.
 *
 * Local rather than sync: the helper runs on this machine, and its token is a
 * secret this profile was given, not a preference to carry to another one.
 *
 * Kept apart from `audio/duet.ts` so that the shape, the default and the parse
 * can be tested without a `chrome` to mock. The offscreen document cannot read
 * storage, so the service worker reads this and puts it on the start command.
 */

export async function readDuetConfig(): Promise<DuetConfig> {
  try {
    const stored = await chrome.storage.local.get(DUET_CONFIG_KEY);
    return normaliseDuetConfig(stored[DUET_CONFIG_KEY]);
  } catch {
    return DEFAULT_DUET_CONFIG;
  }
}

export async function writeDuetConfig(config: DuetConfig): Promise<void> {
  await chrome.storage.local.set({ [DUET_CONFIG_KEY]: normaliseDuetConfig(config) });
}

/**
 * Calls back whenever the connection changes, so that a session already
 * running follows a Save without being restarted.
 */
export function watchDuetConfig(onChange: (config: DuetConfig) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local' || !Object.hasOwn(changes, DUET_CONFIG_KEY)) {
      return;
    }
    onChange(normaliseDuetConfig(changes[DUET_CONFIG_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
