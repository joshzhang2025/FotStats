import type { MatchSnapshot } from '../model/types.ts';
import { matchIdFromPageUrl } from './protocol.ts';

/**
 * The overlay's decisions about *when* to do work, kept as pure functions so
 * they can be tested without a browser. The controller in `content/overlay.ts`
 * is then thin enough to check by reading it.
 */

/**
 * How long to wait before asking the worker again, or null to stop entirely.
 *
 * Every request wakes the MV3 service worker, so a hidden tab polls not at all:
 * somebody with six FotMob tabs open would otherwise keep the worker alive
 * forever for pixels nobody is looking at. A finished match stops for the
 * simpler reason that nothing about it can change again.
 */
export function nextPollDelay(snapshot: MatchSnapshot | null, visible: boolean): number | null {
  if (!visible) return null;
  if (snapshot === null) return 5_000; // nothing yet — probe faster than steady state
  if (snapshot.status.cancelled || snapshot.status.finished) return null;
  if (!snapshot.status.started) return 60_000; // pre-match: only the clock moves
  return 10_000; // live, matching FotMob's own polling rhythm
}

/**
 * Everything that would change what the card looks like, in one string.
 *
 * Rewriting the card's markup on a tick that changed nothing is not a
 * performance problem so much as a rudeness one: it drops the user's text
 * selection and interrupts a hover, on a page that is not ours to interrupt.
 *
 * Cumulative xG is in here because it moves the probability with no event
 * firing at all — a signature of goals and cards alone would freeze the card
 * through a spell of pressure.
 */
export function renderSignature(
  snapshot: MatchSnapshot,
  minute: number,
  expanded: boolean,
): string {
  const xg = snapshot.shots.reduce((total, shot) => total + shot.xg, 0);
  return [
    snapshot.matchId,
    minute,
    expanded ? 'x' : 'c',
    snapshot.status.finished ? 'F' : snapshot.status.started ? 'L' : 'P',
    snapshot.goals.length,
    snapshot.goals.filter((g) => g.isHome).length,
    snapshot.redCards.length,
    snapshot.table === null ? 0 : 1,
    snapshot.tableAsOfDay ?? -1,
    Math.round(xg * 100),
  ].join('|');
}

/**
 * The match this URL is showing, or null for anywhere else on FotMob.
 *
 * The overlay mounts on exactly the pages where this is non-null. Note the
 * content script itself is registered for the whole site: content scripts are
 * injected on document load and never on a client-side route change, so
 * narrowing the manifest pattern to match pages would mean the overlay never
 * appeared when you navigated to one from anywhere else.
 */
export function overlayRoute(url: string): string | null {
  return matchIdFromPageUrl(url);
}
