import type { MatchSnapshot, TableRow } from '../model/types.ts';

/** Tag on every window.postMessage we send, so we ignore everyone else's. */
export const CHANNEL = 'fotstats';

/** MAIN world -> ISOLATED world, over window.postMessage. */
export type PagePayloadMessage =
  | {
      channel: typeof CHANNEL;
      kind: 'payload';
      /** Where the payload came from, for debugging capture problems. */
      origin: 'fetch' | 'xhr' | 'next-data';
      url: string;
      matchId: string | null;
      payload: unknown;
    }
  | {
      channel: typeof CHANNEL;
      kind: 'standings';
      url: string;
      /**
       * Already reduced to rows in the page context. FotMob does not ship
       * standings in `matchDetails`, so they are captured from whichever
       * response does carry them — and sending the rows rather than the whole
       * payload keeps the message small.
       */
      rows: TableRow[];
    };

/** Content script / popup -> service worker. */
export type RuntimeMessage =
  | { type: 'snapshot'; snapshot: MatchSnapshot }
  | { type: 'standings'; rows: TableRow[] }
  | { type: 'get-snapshot'; tabId?: number }
  | { type: 'get-raw'; tabId: number };

export type SnapshotResponse =
  | { ok: true; snapshot: MatchSnapshot }
  | { ok: false; reason: 'no-tab' | 'not-fotmob' | 'not-a-match' | 'waiting' };

/**
 * A FotMob match URL looks like /matches/<slug>/<matchId> or carries ?matchId=.
 * Used by the popup to tell "not on a match page" apart from "no data yet".
 */
export function matchIdFromPageUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('fotmob.com')) return null;
    const fromQuery = parsed.searchParams.get('matchId');
    if (fromQuery) return fromQuery;
    // Match pages are localised (/en/matches/…, /ru/matches/…), so look for the
    // segment rather than assuming a fixed position.
    const segments = parsed.pathname.split('/').filter(Boolean);
    const index = segments.indexOf('matches');
    if (index === -1) return null;
    const id = segments[index + 2];
    return id && /^[a-z0-9]+$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function matchIdFromApiUrl(url: string): string | null {
  try {
    return new URL(url, 'https://www.fotmob.com').searchParams.get('matchId');
  } catch {
    return null;
  }
}
