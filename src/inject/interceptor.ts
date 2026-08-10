import { findTableRows } from '../model/extract.ts';
import { CHANNEL, matchIdFromApiUrl, type PagePayloadMessage } from '../shared/protocol.ts';

/**
 * MAIN-world interceptor.
 *
 * FotMob's `matchDetails` endpoint rejects requests without a signed header its
 * own obfuscated bundle generates per call. Rather than reproduce that, we run
 * inside the page and read the responses FotMob already fetched successfully —
 * so a change to the signing scheme cannot break us.
 *
 * Two rules govern everything here:
 *   1. Never consume a body the page is waiting on. Always clone.
 *   2. Never throw. A failure in this file would break fotmob.com itself, so
 *      every path falls through to the original implementation.
 */

const isMatchDetails = (url: string) => url.includes('matchDetails');

/**
 * Other FotMob JSON endpoints, worth inspecting only for standings.
 * `matchDetails` carries a `content.table` stub with no rows in it, so the
 * league table has to be picked up from whichever request actually loads it.
 */
const isFotmobApi = (url: string) =>
  /fotmob\.com\/api\//.test(url) || /apigw\.fotmob\.com/.test(url);

/** Stop inspecting once we have a table — this runs on every API response. */
let standingsFound = false;

function post(message: PagePayloadMessage) {
  try {
    window.postMessage(message, window.location.origin);
  } catch {
    // A payload that will not structured-clone is not worth breaking the page.
  }
}

function publish(
  origin: Extract<PagePayloadMessage, { kind: 'payload' }>['origin'],
  url: string,
  payload: unknown,
) {
  post({ channel: CHANNEL, kind: 'payload', origin, url, matchId: matchIdFromApiUrl(url), payload });
}

/**
 * Reduce to rows here in the page context rather than shipping the whole
 * response across: league and fixture payloads are large, and all we want is
 * the standings.
 */
function publishStandingsIfPresent(url: string, payload: unknown) {
  if (standingsFound) return;
  try {
    const rows = findTableRows(payload);
    if (!rows) return;
    standingsFound = true;
    post({ channel: CHANNEL, kind: 'standings', url, rows });
  } catch {
    /* never let instrumentation affect the page */
  }
}

function urlOf(input: unknown): string {
  try {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
  } catch {
    /* fall through */
  }
  return '';
}

// --- fetch ------------------------------------------------------------------
const originalFetch = window.fetch;
window.fetch = function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>) {
  const promise = originalFetch.apply(this as never, args);
  try {
    const url = urlOf(args[0]);
    const wantsMatch = isMatchDetails(url);
    const wantsStandings = !standingsFound && !wantsMatch && isFotmobApi(url);
    if (wantsMatch || wantsStandings) {
      promise
        .then((response) => {
          // clone() so the page's own consumer still gets an unread body.
          response
            .clone()
            .json()
            .then((data) => {
              if (wantsMatch) publish('fetch', url, data);
              else publishStandingsIfPresent(url, data);
            })
            .catch(() => undefined);
        })
        .catch(() => undefined);
    }
  } catch {
    /* never let instrumentation affect the request */
  }
  return promise;
};

// --- XMLHttpRequest ---------------------------------------------------------
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const trackedUrl = new WeakMap<XMLHttpRequest, string>();

XMLHttpRequest.prototype.open = function patchedOpen(
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  try {
    trackedUrl.set(this, urlOf(url));
  } catch {
    /* ignore */
  }
  return (originalOpen as (...a: unknown[]) => unknown).call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, ...args: unknown[]) {
  try {
    const url = trackedUrl.get(this) ?? '';
    const wantsMatch = isMatchDetails(url);
    const wantsStandings = !standingsFound && !wantsMatch && isFotmobApi(url);
    if (wantsMatch || wantsStandings) {
      this.addEventListener('load', () => {
        try {
          // responseText is a copy; reading it does not disturb the page.
          const raw = this.responseType === '' || this.responseType === 'text'
            ? this.responseText
            : null;
          const data = raw ? JSON.parse(raw) : this.responseType === 'json' ? this.response : null;
          if (data === null) return;
          if (wantsMatch) publish('xhr', url, data);
          else publishStandingsIfPresent(url, data);
        } catch {
          /* ignore */
        }
      });
    }
  } catch {
    /* ignore */
  }
  return (originalSend as (...a: unknown[]) => unknown).call(this, ...args);
};

// --- cold start -------------------------------------------------------------
/**
 * If the popup opens before any poll fires — extension just reloaded, or a
 * finished match that never polls — there would be nothing to show. FotMob
 * server-renders the initial match payload into __NEXT_DATA__, which covers it.
 */
function readNextData() {
  try {
    const nextData = (window as unknown as { __NEXT_DATA__?: unknown }).__NEXT_DATA__;
    if (!nextData || typeof nextData !== 'object') return;
    const pageProps = (nextData as { props?: { pageProps?: unknown } }).props?.pageProps;
    if (!pageProps || typeof pageProps !== 'object') return;

    // Standings are sometimes server-rendered even when the match payload
    // itself carries only a stub.
    publishStandingsIfPresent(window.location.href, pageProps);

    // The match payload sits under one of a few keys depending on the route.
    const candidates = ['matchDetails', 'initialState', 'match', 'detail'] as const;
    const props = pageProps as Record<string, unknown>;
    for (const key of candidates) {
      const value = props[key];
      if (value && typeof value === 'object' && 'general' in (value as object)) {
        publish('next-data', window.location.href, value);
        return;
      }
    }
    if ('general' in props) publish('next-data', window.location.href, pageProps);
  } catch {
    /* ignore */
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', readNextData, { once: true });
} else {
  readNextData();
}
