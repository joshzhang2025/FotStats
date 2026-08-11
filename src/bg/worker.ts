import { parseStandings } from '../model/extract.ts';
import { historicalTable, type History } from '../model/history.ts';
import type { MatchSnapshot, TableRow } from '../model/types.ts';
import { matchIdFromPageUrl, type RuntimeMessage, type SnapshotResponse } from '../shared/protocol.ts';

/**
 * Service worker: holds the latest snapshot per tab.
 *
 * The popup is its own document with no access to page state, so it asks here.
 * MV3 workers are killed aggressively, which is why the cache lives in
 * `chrome.storage.session` rather than a module variable — a worker restart
 * between a poll landing and the popup opening would otherwise lose the match.
 */

interface CacheEntry {
  snapshot: MatchSnapshot;
  /**
   * The match key taken from the *page* URL when this snapshot was stored.
   *
   * Deliberately not `snapshot.matchId`: the page URL carries a short slug id
   * (`.../liverpool-vs-arsenal/2ovmp3`) while the payload carries the numeric
   * one (`4193843`). Comparing across the two would never match, and would
   * evict the cache on every in-page navigation.
   */
  pageKey: string | null;
}

const keyFor = (tabId: number) => `snapshot:${tabId}`;
/**
 * Standings live under their own key.
 *
 * `matchDetails` carries only a `content.table` stub, so the table arrives from
 * a separate request on its own schedule — sometimes before the match payload,
 * sometimes after. Storing them independently and merging at serve time makes
 * the arrival order irrelevant.
 */
const standingsKeyFor = (tabId: number) => `standings:${tabId}`;

async function store(tabId: number, entry: CacheEntry): Promise<void> {
  await chrome.storage.session.set({ [keyFor(tabId)]: entry });
}

async function load(tabId: number): Promise<CacheEntry | null> {
  const key = keyFor(tabId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as CacheEntry | undefined) ?? null;
}

async function loadStandings(tabId: number): Promise<TableRow[] | null> {
  const key = standingsKeyFor(tabId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as TableRow[] | undefined) ?? null;
}

// --- standings fetched from the pointer in content.table --------------------

/** Standings move at most once a day; a failure should not be retried hard. */
const STANDINGS_TTL_MS = 6 * 60 * 60 * 1000;
const STANDINGS_FAILURE_TTL_MS = 5 * 60 * 1000;

interface StandingsCacheEntry {
  rows: TableRow[] | null;
  fetchedAt: number;
}

/** Deduplicates concurrent fetches — the popup polls every 10 seconds. */
const inFlight = new Map<string, Promise<TableRow[] | null>>();

const urlCacheKey = (url: string) => `standings-url:${url}`;

/**
 * The standings URL ends in `.gz`, but FotMob serves it with
 * `Content-Encoding: gzip`, so the browser has already decompressed it by the
 * time we see the body. Decompress by hand only if it really is gzip bytes.
 */
async function readMaybeGzipped(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return new TextDecoder().decode(buffer);

  return new Response(
    new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
}

async function fetchStandings(url: string): Promise<TableRow[] | null> {
  const key = urlCacheKey(url);
  const cached = (await chrome.storage.local.get(key))[key] as StandingsCacheEntry | undefined;
  if (cached) {
    const ttl = cached.rows ? STANDINGS_TTL_MS : STANDINGS_FAILURE_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.rows;
  }

  const existing = inFlight.get(url);
  if (existing) return existing;

  const request = (async (): Promise<TableRow[] | null> => {
    let rows: TableRow[] | null = null;
    try {
      const response = await fetch(url);
      if (response.ok) rows = parseStandings(await readMaybeGzipped(response));
    } catch {
      // Offline, blocked, or a shape we cannot read — the league-average
      // baseline covers it, so this is never fatal.
    }
    await chrome.storage.local.set({ [key]: { rows, fetchedAt: Date.now() } });
    inFlight.delete(url);
    return rows;
  })();

  inFlight.set(url, request);
  return request;
}

// --- point-in-time tables for past matches ----------------------------------

/**
 * Bundled historical results, loaded once per worker lifetime.
 *
 * This is a packaged file read through `runtime.getURL`, so there is no host
 * permission, no network, and no failure mode worth retrying — but a miss is
 * still non-fatal, because the live table remains as a fallback.
 */
let historyPromise: Promise<History | null> | null = null;

function loadHistory(): Promise<History | null> {
  historyPromise ??= (async () => {
    try {
      const response = await fetch(chrome.runtime.getURL('data/pl-history.json'));
      return response.ok ? ((await response.json()) as History) : null;
    } catch {
      return null;
    }
  })();
  return historyPromise;
}

/**
 * Replace the live table with the one that was true at kickoff.
 *
 * Applies even when the payload already carried standings: an in-payload table
 * is FotMob's current one, which for a past match has seen the result it is
 * being used to predict. Returns the snapshot untouched when there is no
 * historical table to substitute.
 */
async function withHistoricalTable(snapshot: MatchSnapshot): Promise<MatchSnapshot> {
  if (snapshot.kickoffUtc === null) return snapshot;

  const history = await loadHistory();
  if (!history) return snapshot;

  const resolved = historicalTable(history, snapshot.leagueId, snapshot.kickoffUtc, {
    homeName: snapshot.home.name,
    homeId: snapshot.home.id,
    awayName: snapshot.away.name,
    awayId: snapshot.away.id,
  });
  if (!resolved) return snapshot;

  return {
    ...snapshot,
    table: resolved.rows,
    tableAsOfDay: resolved.day,
    warnings: snapshot.warnings.filter((w) => !w.includes('standings')),
  };
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message?.type === 'snapshot') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      void store(tabId, {
        snapshot: message.snapshot,
        pageKey: matchIdFromPageUrl(sender.tab?.url ?? ''),
      });
    }
    return false;
  }

  if (message?.type === 'standings') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number' && message.rows.length) {
      void chrome.storage.session.set({ [standingsKeyFor(tabId)]: message.rows });
    }
    return false;
  }

  if (message?.type === 'get-snapshot') {
    void (async () => {
      // A content script does not know its own tab id, but the sender does.
      sendResponse(await resolveSnapshot(message.tabId ?? sender.tab?.id));
    })();
    return true; // response is async
  }

  return false;
});

/**
 * The popup resolves its own tab and passes the id, rather than letting the
 * worker guess: `currentWindow` from a service worker means "last focused",
 * which is not reliably the window the popup was opened from. The in-page
 * overlay has the opposite problem — it cannot know its tab id at all — so it
 * sends none and the worker reads `sender.tab`. Both paths land here, which is
 * what lets the overlay inherit the historical table and the standings fetch.
 */
async function resolveSnapshot(tabId?: number): Promise<SnapshotResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = typeof tabId === 'number' ? await chrome.tabs.get(tabId) : undefined;
  } catch {
    return { ok: false, reason: 'no-tab' };
  }
  if (!tab?.id || !tab.url) return { ok: false, reason: 'no-tab' };
  if (!tab.url.includes('fotmob.com')) return { ok: false, reason: 'not-fotmob' };

  const cached = await load(tab.id);
  if (cached) {
    // A point-in-time table outranks everything else, including a table the
    // payload already carried — that one is today's, and for a past match
    // today's table has already seen the result.
    const snapshot = await withHistoricalTable(cached.snapshot);
    if (snapshot.tableAsOfDay !== null) return { ok: true, snapshot };

    // Merge in separately-captured standings only when the payload itself had
    // none, so a real in-payload table always wins.
    if (snapshot.table === null) {
      // Prefer standings the page happened to load; otherwise follow the
      // pointer the match payload gave us.
      const standings =
        (await loadStandings(tab.id)) ??
        (snapshot.standingsUrl ? await fetchStandings(snapshot.standingsUrl) : null);

      if (standings?.length) {
        return {
          ok: true,
          snapshot: {
            ...snapshot,
            table: standings,
            warnings: snapshot.warnings.filter((w) => !w.includes('standings')),
          },
        };
      }
    }
    return { ok: true, snapshot };
  }

  // Nothing cached. Distinguish "you are not on a match" from "the first poll
  // has not landed yet", because the popup shows very different things.
  return matchIdFromPageUrl(tab.url)
    ? { ok: false, reason: 'waiting' }
    : { ok: false, reason: 'not-a-match' };
}

// Snapshots are per-tab; drop them when the tab goes away or moves to a
// different match, so the popup can never show a stale fixture.
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove([keyFor(tabId), standingsKeyFor(tabId)]);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void (async () => {
    const cached = await load(tabId);
    if (!cached) return;
    // Moving between tabs *within* a match page changes the URL but not the
    // match, so only evict when the match key itself changes.
    if (matchIdFromPageUrl(changeInfo.url!) !== cached.pageKey) {
      // Standings survive: moving to another match in the same competition is
      // the common case, and a stale table is corrected by the next capture.
      await chrome.storage.session.remove(keyFor(tabId));
    }
  })();
});
