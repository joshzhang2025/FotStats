import { extractSnapshot } from '../model/extract.ts';
import type { FotmobPayload } from '../types/fotmob.ts';
import { CHANNEL, type PagePayloadMessage } from '../shared/protocol.ts';

/**
 * ISOLATED-world bridge.
 *
 * Receives raw payloads from the MAIN-world interceptor, reduces them to a
 * `MatchSnapshot`, and forwards that to the service worker. Reducing here rather
 * than in the worker matters: a `matchDetails` payload runs to megabytes, and a
 * snapshot is a few kilobytes.
 *
 * The raw payload is kept in memory for the fixture-capture path, which needs
 * the unreduced JSON.
 */

let lastRaw: unknown = null;
let lastMatchId: string | null = null;

/**
 * Reloading the extension orphans the content scripts already running in open
 * tabs: their `chrome.runtime` handle is dead, and using it throws
 * "Extension context invalidated" *synchronously* — so a `.catch()` on the
 * returned promise never sees it. Detect the orphaned state and go quiet
 * instead of logging on every poll until the tab is reloaded.
 */
let orphaned = false;

function send(message: unknown): void {
  if (orphaned) return;
  // `chrome.runtime.id` is undefined once the context is gone.
  if (!chrome.runtime?.id) {
    orphaned = true;
    return;
  }
  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      // The worker sleeps between messages; a rejected send just means it was
      // waking up and the next poll will land.
    });
  } catch {
    orphaned = true;
  }
}

function isPagePayload(data: unknown): data is PagePayloadMessage {
  if (typeof data !== 'object' || data === null) return false;
  if ((data as { channel?: unknown }).channel !== CHANNEL) return false;
  const kind = (data as { kind?: unknown }).kind;
  return kind === 'payload' || kind === 'standings';
}

window.addEventListener('message', (event) => {
  // Only trust messages this page posted to itself — anything cross-origin or
  // from a frame is not ours.
  if (event.source !== window) return;
  if (!isPagePayload(event.data)) return;

  if (event.data.kind === 'standings') {
    send({ type: 'standings', rows: event.data.rows });
    return;
  }

  const { payload, matchId } = event.data;
  if (!payload || typeof payload !== 'object') return;

  try {
    const snapshot = extractSnapshot(payload as FotmobPayload, matchId ?? undefined);
    if (!snapshot.matchId) return;

    lastRaw = payload;
    lastMatchId = snapshot.matchId;

    send({ type: 'snapshot', snapshot });
  } catch (error) {
    console.warn('[fotstats] failed to reduce payload', error);
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message === 'object' && message !== null && (message as { type?: string }).type === 'get-raw') {
    sendResponse({ ok: lastRaw !== null, matchId: lastMatchId, raw: lastRaw });
    return true;
  }
  return undefined;
});
