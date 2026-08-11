import { extractSnapshot } from '../model/extract.ts';
import type { FotmobPayload } from '../types/fotmob.ts';
import { CHANNEL, type PagePayloadMessage } from '../shared/protocol.ts';
import { notifyWorker } from '../shared/runtime.ts';

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
    notifyWorker({ type: 'standings', rows: event.data.rows });
    return;
  }

  const { payload, matchId } = event.data;
  if (!payload || typeof payload !== 'object') return;

  try {
    const snapshot = extractSnapshot(payload as FotmobPayload, matchId ?? undefined);
    if (!snapshot.matchId) return;

    lastRaw = payload;
    lastMatchId = snapshot.matchId;

    notifyWorker({ type: 'snapshot', snapshot });
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
