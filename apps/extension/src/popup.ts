import { canNudge, KEY_DEFAULT, nudgeKey } from './audio/key.ts';
import { normaliseDuetConfig } from './audio/duet.ts';
import {
  MIC_CONSTRAINTS,
  microphoneErrorText,
  stopMicrophone,
} from './audio/microphone.ts';
import { debugReportText } from './debug-report.ts';
import { clearCache, usage as readCacheUsage, type CacheUsage } from './cache/index.ts';
import { isRunning } from './audio/status.ts';
import { cacheUsageView, popupView, type PopupView } from './popup/popup-view.ts';
import { readDuetConfig, writeDuetConfig } from './duet-store.ts';
import {
  SCORE_HISTORY_KEY,
  SCORE_SINGER_KEY,
  bestScores,
  formatRunDate,
  normaliseScoreHistory,
  normaliseSinger,
  recentRuns,
  type PracticeRun,
} from './practice/history.ts';
import {
  readScoreHistory,
  readSingerName,
  writeSingerName,
} from './practice/score-store.ts';
import {
  DEBUG_KEY,
  packet,
  STATUS_KEY,
  type PipelineDebug,
  type Request,
  type StatusReport,
  type StoredDebug,
  type StoredStatus,
} from './protocol.ts';
import { reasonText } from './reason.ts';
import { DEFAULT_SETTINGS, SETTINGS_KEY, parseSettings } from './settings.ts';
import { readSettings, writeSettings } from './settings-store.ts';

/**
 * The toolbar popup: the state of the session, its start and stop, and the
 * one setting.
 *
 * There is no capture gesture any more, so this is not the only place that
 * can start anything — the panel in the page starts just as well. What it is
 * is the one window that exists even when the person is not on a video: the
 * state, the stop button, the remembered key and the debug report all live
 * here.
 *
 * Plain DOM, no framework, and every decision about what to say is in
 * `popup/popup-view.ts` where it can be tested. What is left here is reading
 * two pieces of storage, drawing, and the listeners.
 *
 * The state it shows is the last status report, which the service worker
 * leaves in `chrome.storage.session` as it routes it. A popup cannot have been
 * listening when the report went past — it did not exist — so it reads the
 * last one and then follows `chrome.storage.onChanged`, which is a push: the
 * progress bar moves on its own, four times a second, with nobody polling
 * anything.
 */

/** How often the debug state is fetched while the popup is open, in ms. */
const DEBUG_TICK_MS = 2000;

function need<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`the popup has no ${selector}`);
  }
  return found;
}

const headline = need<HTMLParagraphElement>('#headline');
const detail = need<HTMLParagraphElement>('#detail');
const bar = need<HTMLDivElement>('#bar');
const barFill = need<HTMLSpanElement>('#bar-fill');
const stateDot = need<HTMLSpanElement>('#state-dot');
const action = need<HTMLButtonElement>('#action');
const keyValue = need<HTMLSpanElement>('#key-value');
const keyDown = need<HTMLButtonElement>('#key-down');
const keyUp = need<HTMLButtonElement>('#key-up');
const keyClear = need<HTMLButtonElement>('#key-clear');
const diagnosticsToggle = need<HTMLButtonElement>('#diagnostics-toggle');
const diagnosticsLabel = need<HTMLSpanElement>('#diagnostics-label');
const diagnosticsBox = need<HTMLElement>('#diagnostics');
const diagnosticsTabs = need<HTMLDivElement>('#diagnostics-tabs');
const diagnosticsGroups = need<HTMLDivElement>('#diagnostics-groups');
const copyDebug = need<HTMLButtonElement>('#copy-debug');
const copyNote = need<HTMLParagraphElement>('#copy-note');
const debugDump = need<HTMLTextAreaElement>('#debug-dump');
const duetUrl = need<HTMLInputElement>('#duet-url');
const duetToken = need<HTMLInputElement>('#duet-token');
const duetSave = need<HTMLButtonElement>('#duet-save');
const duetTest = need<HTMLButtonElement>('#duet-test');
const duetStatus = need<HTMLParagraphElement>('#duet-status');
const micEnable = need<HTMLButtonElement>('#mic-enable');
const micStatus = need<HTMLParagraphElement>('#mic-status');
const singerName = need<HTMLInputElement>('#singer-name');
const scoresEmpty = need<HTMLParagraphElement>('#scores-empty');
const scoresBody = need<HTMLDivElement>('#scores-body');
const scoresBest = need<HTMLOListElement>('#scores-best');
const scoresRecent = need<HTMLOListElement>('#scores-recent');
const cacheUsage = need<HTMLParagraphElement>('#cache-usage');
const cacheClear = need<HTMLButtonElement>('#cache-clear');
const cacheStatus = need<HTMLParagraphElement>('#cache-status');

let tabId: number | null = null;
let url: string | undefined;
let report: StatusReport | null = null;
/** The remembered default, until a report says what is actually playing. */
let key = DEFAULT_SETTINGS.key;
/** A start that has been asked for and not yet answered. */
let starting = false;
let failure: string | null = null;
/** The debug state as the offscreen document last sent it, or null for none. */
let pipeline: PipelineDebug | null = null;
/** Whether the diagnostics disclosure is open. It starts closed every time. */
let diagnosticsOpen = false;
/** The local score history, newest first once `normaliseScoreHistory` has run. */
let scores: PracticeRun[] = [];
/** The stem cache's usage, or null when it could not be read. */
let cacheStats: CacheUsage | null = null;
let cacheKnown = true;
let cacheBusy = false;
/** A transient clear message, kept above the section's own detail line. */
let cacheNote: string | null = null;

function send(body: Request): void {
  chrome.runtime.sendMessage(packet('background', body, tabId)).catch(() => undefined);
}

function view(): PopupView {
  return popupView({ report, url, key, pipeline });
}

/** Which diagnostics group is showing; the three titles are stable. */
let diagnosticsTab = 0;
/** The group titles last used to build the tab buttons. */
let diagnosticsSignature = '';

function renderDiagnostics(diagnostics: PopupView['diagnostics']): void {
  if (diagnostics === null) {
    diagnosticsTabs.replaceChildren();
    diagnosticsGroups.replaceChildren();
    diagnosticsSignature = '';
    return;
  }
  const signature = diagnostics.groups.map((group) => group.title).join('|');
  if (signature !== diagnosticsSignature) {
    diagnosticsTab = Math.min(diagnosticsTab, diagnostics.groups.length - 1);
    diagnosticsTabs.replaceChildren();
    diagnostics.groups.forEach((group, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'diag-tab';
      tab.id = `kara-diag-tab-${String(index)}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'diagnostics-groups');
      tab.setAttribute('aria-selected', String(index === diagnosticsTab));
      tab.textContent = group.title;
      tab.addEventListener('click', () => {
        diagnosticsTab = index;
        renderDiagnostics(view().diagnostics);
      });
      diagnosticsTabs.append(tab);
    });
    diagnosticsSignature = signature;
  } else {
    for (const [index, tab] of Array.from(diagnosticsTabs.children).entries()) {
      tab.setAttribute('aria-selected', String(index === diagnosticsTab));
    }
  }
  const active = diagnostics.groups[diagnosticsTab] ?? diagnostics.groups[0];
  diagnosticsGroups.replaceChildren();
  if (active === undefined) {
    return;
  }
  diagnosticsGroups.setAttribute(
    'aria-labelledby',
    `kara-diag-tab-${String(diagnosticsTab)}`,
  );
  const list = document.createElement('dl');
  for (const row of active.rows) {
    const item = document.createElement('div');
    item.className = row.wide === true ? 'diag-row wide' : 'diag-row';
    const term = document.createElement('dt');
    term.textContent = row.label;
    const value = document.createElement('dd');
    value.textContent = row.value;
    item.append(term, value);
    list.append(item);
  }
  diagnosticsGroups.append(list);
}

function setDiagnostics(open: boolean): void {
  diagnosticsOpen = open;
  diagnosticsBox.hidden = !open;
  diagnosticsToggle.setAttribute('aria-expanded', String(open));
  diagnosticsLabel.textContent = open ? 'Hide diagnostics' : 'View diagnostics';
  if (open) {
    renderDiagnostics(view().diagnostics);
  } else {
    copyNote.hidden = true;
    debugDump.hidden = true;
  }
}

function draw(): void {
  const shown = view();
  stateDot.dataset['state'] = shown.state;
  headline.textContent = starting ? 'Starting…' : shown.headline;
  detail.textContent = failure ?? shown.detail ?? '';
  detail.hidden = detail.textContent === '';
  bar.hidden = shown.progress === null;
  if (shown.progress !== null) {
    const percent = Math.round(shown.progress * 100);
    barFill.style.width = `${String(percent)}%`;
    bar.setAttribute('aria-valuenow', String(percent));
    bar.setAttribute('aria-valuetext', shown.detail ?? `${String(percent)}%`);
  }
  action.dataset['action'] = shown.action;
  action.textContent = shown.actionLabel;
  action.disabled = shown.action === 'none' || starting;
  keyValue.textContent = shown.keyLabel;
  keyDown.disabled = !canNudge(shown.semitones, -1);
  keyUp.disabled = !canNudge(shown.semitones, 1);
  keyClear.hidden = shown.semitones === KEY_DEFAULT;

  diagnosticsToggle.hidden = shown.diagnostics === null;
  if (shown.diagnostics === null) {
    if (diagnosticsOpen) {
      setDiagnostics(false);
    }
  } else if (diagnosticsOpen) {
    renderDiagnostics(shown.diagnostics);
  }
  drawCache();
}

/** One row of the local leaderboard: rank, song, the words under it, score. */
function scoreItem(run: PracticeRun, rank: number | null, meta: string): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'score-row';
  if (rank !== null) {
    const rankEl = document.createElement('span');
    rankEl.className = 'score-rank';
    rankEl.textContent = String(rank);
    item.append(rankEl);
  }
  const label = document.createElement('div');
  label.className = 'score-label';
  const song = document.createElement('span');
  song.className = 'score-song';
  song.textContent = run.title;
  song.title = run.artist === null ? run.title : `${run.title} — ${run.artist}`;
  const line = document.createElement('span');
  line.className = 'score-meta';
  line.textContent = meta;
  label.append(song, line);
  const value = document.createElement('span');
  value.className = 'score-value';
  value.textContent = String(Math.round(run.score));
  value.title = 'Score out of 100';
  item.append(label, value);
  return item;
}

/** The compact leaderboard: best per song above the newest runs. */
function drawScores(): void {
  const best = bestScores(scores, 3);
  const recent = recentRuns(scores, 4);
  scoresEmpty.hidden = scores.length > 0;
  scoresBody.hidden = scores.length === 0;
  scoresBest.replaceChildren(
    ...best.map((run, index) =>
      scoreItem(
        run,
        index + 1,
        run.artist === null ? formatRunDate(run.at) : run.artist,
      ),
    ),
  );
  scoresRecent.replaceChildren(
    ...recent.map((run) =>
      scoreItem(
        run,
        null,
        `${formatRunDate(run.at)} · ${String(Math.round(run.accuracy))}%${
          run.singer === null ? '' : ` · ${run.singer}`
        }`,
      ),
    ),
  );
}

/**
 * The cache section: usage, and one button that removes only the stems.
 *
 * It reads the same OPFS index the offscreen document writes. The clear is
 * refused while a session runs so the popup never deletes the entry being
 * written; scores and settings live in other stores and are untouched.
 */
function drawCache(): void {
  const view = cacheUsageView(cacheKnown ? cacheStats : null, {
    busy: cacheBusy,
    running: report !== null && isRunning(report.status),
  });
  cacheUsage.textContent = view.label;
  cacheClear.disabled = view.clearDisabled;
  cacheClear.textContent = view.clearLabel;
  const detail = cacheNote ?? view.detail;
  cacheStatus.hidden = detail === null;
  cacheStatus.textContent = detail ?? '';
}

async function refreshCache(): Promise<void> {
  try {
    cacheStats = await readCacheUsage();
    cacheKnown = true;
  } catch {
    cacheStats = null;
    cacheKnown = false;
  }
  drawCache();
}

function clearStemCache(): void {
  if (cacheBusy) {
    return;
  }
  cacheBusy = true;
  cacheNote = 'Clearing the saved stems…';
  drawCache();
  void clearCache()
    .then(() => {
      cacheNote = 'Saved stems removed. Scores and settings are untouched.';
    })
    .catch(() => {
      cacheNote = 'The cache could not be cleared.';
    })
    .finally(() => {
      cacheBusy = false;
      void refreshCache();
    });
}

/**
 * The key, in two places at once: the session that is playing, by command, and
 * the remembered default, by storage.
 *
 * Both, because the popup is where a decision rather than a nudge is made. The
 * command goes through the service worker's relay rather than being left to
 * the offscreen document's storage watcher on purpose — the panel in the page
 * can move the key too, without touching the default, and a watcher pushing
 * the stored value would undo that.
 */
function setKey(semitones: number): void {
  key = semitones;
  if (report !== null) {
    report = { ...report, semitones };
  }
  draw();
  if (tabId !== null) {
    chrome.runtime
      .sendMessage(packet('offscreen', { type: 'key', semitones }, tabId))
      .catch(() => undefined);
  }
  writeSettings({ key: semitones }).catch(() => undefined);
}

/** The stored report, if it belongs to the tab this popup was opened over. */
function take(stored: unknown): void {
  const value = stored as StoredStatus | undefined;
  report = value !== undefined && value.tabId === tabId ? value.report : null;
}

function takeDebug(stored: unknown): void {
  const value = stored as StoredDebug | undefined;
  pipeline = value !== undefined && value.tabId === tabId ? value.pipeline : null;
  draw();
}

/**
 * Asks the offscreen document for its debug state, which comes back through
 * the service worker into session storage.
 *
 * Asked for in advance rather than on the button, because the clipboard is
 * only granted inside the click that pressed it: a copy that awaited a
 * message first would have lost the gesture by the time it had anything to
 * copy.
 */
function askForDebug(): void {
  chrome.runtime
    .sendMessage(packet('offscreen', { type: 'debug' }, tabId))
    .catch(() => undefined);
}

/**
 * Copies the report, redacted by `debug-report.ts`: an origin and no page
 * address beyond it, no video id, and nothing that is or was audio.
 */
function copyReport(): void {
  const text = debugReportText(
    {
      atMs: Date.now(),
      url,
      status: report,
      pipeline,
      version: chrome.runtime.getManifest().version,
    },
    navigator.userAgent,
  );
  copyNote.hidden = false;
  copyNote.textContent = 'Copied.';
  navigator.clipboard.writeText(text).catch(() => {
    // No clipboard, which some Chrome builds and policies answer with. The
    // text itself is the fallback: selected, so one keystroke takes it.
    copyNote.textContent = 'Select the text below and copy it.';
    debugDump.hidden = false;
    debugDump.value = text;
    debugDump.select();
  });
}

function start(): void {
  if (tabId === null) {
    return;
  }
  starting = true;
  failure = null;
  draw();
  send({ type: 'request-start', tabId });
  starting = false;
  draw();
}

keyDown.addEventListener('click', () => {
  setKey(nudgeKey(view().semitones, -1));
});

keyUp.addEventListener('click', () => {
  setKey(nudgeKey(view().semitones, 1));
});

keyClear.addEventListener('click', () => {
  setKey(KEY_DEFAULT);
});

action.addEventListener('click', () => {
  if (view().action === 'stop') {
    send({ type: 'request-stop' });
    report = null;
    draw();
    return;
  }
  start();
});

copyDebug.addEventListener('click', copyReport);

cacheClear.addEventListener('click', clearStemCache);

/**
 * The microphone permission has to be asked for under a click, and an
 * offscreen document cannot show that click. So the popup does it once, stops
 * the tracks it opened, and leaves Chrome's grant behind for the practice
 * room to use later.
 */
micEnable.addEventListener('click', () => {
  micEnable.disabled = true;
  micStatus.hidden = false;
  micStatus.textContent = 'Asking for the microphone…';
  navigator.mediaDevices
    .getUserMedia({ audio: MIC_CONSTRAINTS })
    .then((stream) => {
      stopMicrophone(stream);
      micStatus.textContent = 'Microphone enabled. Use Monitor or Record in the player.';
      micEnable.textContent = 'Microphone enabled';
    })
    .catch((cause: unknown) => {
      micStatus.textContent = microphoneErrorText(cause, 'popup');
    })
    .finally(() => {
      micEnable.disabled = false;
    });
});

singerName.addEventListener('change', () => {
  singerName.value = normaliseSinger(singerName.value);
  void writeSingerName(singerName.value);
});

function showDuetStatus(text: string): void {
  duetStatus.hidden = text === '';
  duetStatus.textContent = text;
  if (text !== '') {
    const shown = text;
    window.setTimeout(() => {
      if (duetStatus.textContent === shown) {
        duetStatus.hidden = true;
      }
    }, 4000);
  }
}

async function loadDuetConfig(): Promise<void> {
  const config = await readDuetConfig();
  duetUrl.value = config.url;
  duetToken.value = config.token;
}

duetSave.addEventListener('click', () => {
  const config = normaliseDuetConfig({ url: duetUrl.value, token: duetToken.value });
  duetUrl.value = config.url;
  duetToken.value = config.token;
  // The service worker watches this key and hands the new connection to a
  // session that is already running.
  writeDuetConfig(config)
    .then(() => {
      showDuetStatus('Saved.');
    })
    .catch((cause: unknown) => {
      showDuetStatus(reasonText(cause));
    });
});

duetTest.addEventListener('click', () => {
  const config = normaliseDuetConfig({ url: duetUrl.value, token: duetToken.value });
  showDuetStatus('Checking…');
  fetch(`${config.url}/v1/health`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`the helper answered ${String(response.status)}`);
      }
      const body = (await response.json()) as { ok?: unknown };
      if (body.ok !== true) {
        throw new Error('the helper did not say it is ready');
      }
      showDuetStatus('Helper found.');
    })
    .catch(() => {
      showDuetStatus('Helper not reachable. Start bridge.py first.');
    });
});

diagnosticsToggle.addEventListener('click', () => {
  setDiagnostics(!diagnosticsOpen);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.hasOwn(changes, STATUS_KEY)) {
    take(changes[STATUS_KEY]?.newValue);
    draw();
  }
  if (area === 'session' && Object.hasOwn(changes, DEBUG_KEY)) {
    takeDebug(changes[DEBUG_KEY]?.newValue);
  }
  if (area === 'sync' && Object.hasOwn(changes, SETTINGS_KEY)) {
    key = parseSettings(changes[SETTINGS_KEY]?.newValue).key;
    draw();
  }
  if (area === 'local' && Object.hasOwn(changes, SCORE_HISTORY_KEY)) {
    scores = normaliseScoreHistory(changes[SCORE_HISTORY_KEY]?.newValue);
    drawScores();
  }
  if (area === 'local' && Object.hasOwn(changes, SCORE_SINGER_KEY)) {
    const next = normaliseSinger(changes[SCORE_SINGER_KEY]?.newValue);
    if (document.activeElement !== singerName) {
      singerName.value = next;
    }
  }
});

async function open(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  url = tab?.url;
  const settings = await readSettings();
  key = settings.key;
  const [history, singer] = await Promise.all([readScoreHistory(), readSingerName()]);
  scores = history;
  singerName.value = singer;
  drawScores();
  await refreshCache();
  await loadDuetConfig();
  take((await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY]);
  takeDebug((await chrome.storage.session.get(DEBUG_KEY))[DEBUG_KEY]);
  draw();
  // And keep it fresh while this window is open, so the button always has
  // something current to copy.
  askForDebug();
  setInterval(askForDebug, DEBUG_TICK_MS);
}

open().catch((cause: unknown) => {
  failure = reasonText(cause);
  draw();
});
