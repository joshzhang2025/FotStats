import type { MatchSnapshot } from '../model/types.ts';
import type { SnapshotResponse } from '../shared/protocol.ts';
import { askWorker, isOrphaned } from '../shared/runtime.ts';
import { nextPollDelay, overlayRoute, renderSignature } from '../shared/schedule.ts';
import { buildView, renderCard, renderPill } from '../view/card.ts';
import { attachScrub } from '../view/scrub.ts';

import cardCss from '../view/card.css';
import themeCss from '../view/theme.css';
import overlayCss from './overlay.css';

/**
 * The in-page overlay.
 *
 * The interceptor's rule is "never reproduce a FotMob request, only observe
 * one". This is the same rule for their DOM: the overlay never reads, queries
 * or modifies anything FotMob rendered. It mounts one element of its own,
 * outside their React tree, draws inside a closed shadow root, and lets every
 * pointer event that is not aimed at the card itself pass straight through. A
 * FotMob redesign cannot break it, because there is nothing of theirs to break.
 *
 * It also stays quiet: nothing is rendered at all unless there is a real
 * snapshot to render. The popup has empty states because you opened it on
 * purpose and are owed an answer — an overlay you did not ask for owes the page
 * silence.
 */

const HOST_TAG = 'fotstats-overlay';
const SENTINEL = '__fotstatsOverlay';
const STORAGE_KEY = 'fotstats:overlay';
const ROUTE_POLL_MS = 1_000;

interface Prefs {
  expanded: boolean;
  /** Only one value today; in the schema so adding corners is not a migration. */
  position: 'bottom-right';
}

let prefs: Prefs = { expanded: false, position: 'bottom-right' };

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let snapshot: MatchSnapshot | null = null;
let signature = '';
/** Dismissed for this page only — deliberately not persisted. */
let dismissed = false;
let pollTimer: number | undefined;
let routeTimer: number | undefined;
let lastUrl = location.href;

// ---------------------------------------------------------------------------
// mounting

function stop(): void {
  clearTimeout(pollTimer);
  clearTimeout(routeTimer);
  pollTimer = undefined;
  routeTimer = undefined;
}

function unmount(): void {
  host?.remove();
  host = null;
  shadow = null;
  signature = '';
}

function mount(): ShadowRoot {
  if (shadow && host?.isConnected) return shadow;

  // A custom-element tag rather than a div: FotMob selectors like `body > div`
  // or a bare `div { … }` rule cannot reach it, and it is unmistakable in
  // DevTools. It never needs to be a defined element to take a shadow root.
  host = document.createElement(HOST_TAG);
  host.setAttribute('role', 'complementary');
  host.setAttribute('aria-label', 'FotStats win probability');
  shadow = host.attachShadow({ mode: 'closed' });
  adoptStyles(shadow);
  document.body.appendChild(host);
  return shadow;
}

/**
 * Constructed stylesheets rather than a `<style>` element: CSP has no hook for
 * CSSOM-built sheets at all, so this keeps working whatever policy FotMob adds
 * later. The `<style>` fallback is for the same reason in reverse — if the
 * constructor is ever unavailable, a missing stylesheet is a broken card.
 */
function adoptStyles(root: ShadowRoot): void {
  const css = `${themeCss}\n${cardCss}\n${overlayCss}`;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
  }
}

// ---------------------------------------------------------------------------
// rendering

function draw(current: MatchSnapshot): void {
  const view = buildView(current);
  const next = renderSignature(current, view.minute, prefs.expanded);
  // Rewriting the markup when nothing changed drops the user's text selection
  // and interrupts a hover — on a page that is not ours to interrupt.
  if (next === signature && host?.isConnected) return;
  signature = next;

  const root = mount();
  root.innerHTML = prefs.expanded
    ? `<div class="card">
         <div class="head">
           <button class="icon" data-act="collapse" aria-expanded="true" title="Collapse">▾</button>
           <button class="icon" data-act="dismiss" title="Hide until you navigate">✕</button>
         </div>
         ${renderCard(current, view)}
       </div>`
    : `<div class="pill" data-act="expand" role="button" tabindex="0"
             aria-expanded="false" title="FotStats — expand">${renderPill(current, view)}</div>`;

  if (prefs.expanded) attachScrub(root, view.timeline, current);
  bindActions(root);
}

function bindActions(root: ShadowRoot): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-act]')) {
    const act = el.dataset['act'];
    el.addEventListener('click', () => {
      if (act === 'dismiss') {
        dismissed = true;
        unmount();
        return;
      }
      setExpanded(act === 'expand');
    });
    // Keyboard reachability for the pill only — a real <button> already does
    // this natively, and adding it there would swallow the click Space fires.
    // Listeners live on our own nodes; never on the page's document.
    if (el.tagName !== 'BUTTON') {
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setExpanded(true);
        }
      });
    }
  }
}

function setExpanded(expanded: boolean): void {
  prefs = { ...prefs, expanded };
  try {
    // Storage throws synchronously once the context is orphaned, and losing the
    // preference matters far less than the toggle still working.
    void chrome.storage.local.set({ [STORAGE_KEY]: prefs });
  } catch {
    /* not worth failing the click over */
  }
  if (snapshot) draw(snapshot);
}

// ---------------------------------------------------------------------------
// polling

async function tick(): Promise<void> {
  if (isOrphaned()) {
    // The extension was reloaded under us. Leave nothing behind.
    stop();
    unmount();
    return;
  }

  if (dismissed || overlayRoute(location.href) === null) {
    unmount();
    snapshot = null;
  } else {
    const response = await askWorker<SnapshotResponse>({ type: 'get-snapshot' });
    if (response?.ok) {
      snapshot = response.snapshot;
      draw(snapshot);
    } else {
      // No data is not an error worth drawing a box about.
      snapshot = null;
      unmount();
    }
  }

  schedule();
}

function schedule(): void {
  clearTimeout(pollTimer);
  const delay = nextPollDelay(snapshot, document.visibilityState === 'visible');
  if (delay === null) return;
  pollTimer = setTimeout(() => void tick(), delay) as unknown as number;
}

/**
 * FotMob is a client-routed app, and `location.href` polling is the only way to
 * see that from here: patching `history.pushState` in the ISOLATED world would
 * intercept nothing, because the page's own calls run in a different JS realm
 * with its own prototypes. A string compare on a 1s timer costs nothing.
 */
function watchRoute(): void {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // A new page is a new match and a fresh chance to be wanted.
      dismissed = false;
      snapshot = null;
      signature = '';
      unmount();
      void tick();
    }
    watchRoute();
  }, ROUTE_POLL_MS) as unknown as number;
}

// ---------------------------------------------------------------------------
// start

async function start(): Promise<void> {
  // The sentinel lives on the isolated world's `window`, so it is invisible to
  // the page. Checked before anything is touched, so a double injection cannot
  // tear down the copy that is already running.
  const flags = window as unknown as Record<string, boolean>;
  if (flags[SENTINEL]) return;
  flags[SENTINEL] = true;

  // Reloading the extension leaves the old host in the DOM with a dead runtime
  // handle; without this the fresh injection simply adds a second one.
  for (const stale of document.querySelectorAll(HOST_TAG)) stale.remove();

  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Prefs | undefined;
    // Collapsed by default, and on a narrow window regardless of what was
    // stored: a 360px card on a 375px screen is the whole screen.
    prefs = { ...prefs, ...stored, expanded: (stored?.expanded ?? false) && window.innerWidth >= 600 };
  } catch {
    // Storage is unavailable in an orphaned context; defaults are fine.
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      // Every request wakes the service worker; a tab nobody is looking at has
      // no business keeping it alive.
      stop();
      return;
    }
    // Refresh on the frame the user actually sees, then resume the cadence.
    watchRoute();
    void tick();
  });
  window.addEventListener('popstate', () => void tick());
  window.addEventListener('pageshow', () => void tick());

  watchRoute();
  await tick();
}

void start();
