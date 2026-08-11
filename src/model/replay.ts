import type { MatchSnapshot, TimelinePoint } from './types.ts';
import { winProb } from './winprob.ts';

export type MarkerKind = 'goal' | 'red';

export interface TimelineMarker {
  kind: MarkerKind;
  /** Folded minute, which is what the chart plots against. */
  minute: number;
  /** The same instant written for a reader: "90+3". */
  minuteLabel: string;
  isHome: boolean;
  label: string;
  /** Home win probability at that minute, so markers sit on the curve. */
  homeProb: number;
}

export interface Timeline {
  points: TimelinePoint[];
  markers: TimelineMarker[];
  /** Last minute actually plotted — the live clock, or full time if finished. */
  through: number;
  fullTime: number;
}

/**
 * The clock as football writes it: a goal three minutes into stoppage at the
 * end is "90+3", not "93". Only labels split the minute back up — everything
 * that measures the match keeps counting football played.
 */
export function formatMinute(minute: number, added: number): string {
  return added > 0 ? `${minute - added}+${added}` : `${minute}`;
}

/**
 * How far along the match is, for plotting purposes.
 *
 * A live match must not be drawn out to full time: the curve past the current
 * minute would be a flat extrapolation that reads as though the match is over.
 */
export function currentMinute(snapshot: MatchSnapshot, now = Date.now()): number {
  if (snapshot.status.finished) return snapshot.fullTime;
  if (!snapshot.status.started) return 0;
  if (snapshot.status.liveMinute !== null) {
    return Math.min(snapshot.status.liveMinute, snapshot.fullTime);
  }

  // No reported clock. Estimate from kickoff — a match with few events would
  // otherwise appear stuck at the minute of the last shot, which both stalls
  // the timeline and freezes the probability an hour in the past.
  if (snapshot.kickoffUtc !== null) {
    const elapsed = (now - snapshot.kickoffUtc) / 60_000;
    if (elapsed > 0) {
      const HALF_TIME_BREAK = 15;
      const estimated = elapsed <= 45 ? elapsed : Math.max(45, elapsed - HALF_TIME_BREAK);
      return Math.min(Math.round(estimated), snapshot.fullTime);
    }
  }

  // Last resort: the latest thing we have any evidence for.
  const lastEvent = Math.max(
    0,
    ...snapshot.goals.map((g) => g.minute),
    ...snapshot.redCards.map((c) => c.minute),
    ...snapshot.shots.map((s) => s.minute),
  );
  return Math.min(lastEvent, snapshot.fullTime);
}

/**
 * Run the model across every minute of the match.
 *
 * Because `winProb` reconstructs its own state from the event list, this works
 * identically on a match that finished last season and on one the user opened
 * at minute 70 — there is no accumulated state to have missed.
 */
export function buildTimeline(snapshot: MatchSnapshot, upTo?: number): Timeline {
  const through = Math.round(upTo ?? currentMinute(snapshot));
  const points: TimelinePoint[] = [];

  for (let minute = 0; minute <= through; minute++) {
    points.push({ minute, ...winProb(snapshot, minute) });
  }
  // A match that has not kicked off still needs one point to render against.
  if (points.length === 0) {
    points.push({ minute: 0, ...winProb(snapshot, 0) });
  }

  const probAt = (minute: number) =>
    points[Math.min(Math.max(minute, 0), points.length - 1)]?.home ?? 0.5;

  const markers: TimelineMarker[] = [];
  let homeScore = 0;
  let awayScore = 0;
  for (const goal of [...snapshot.goals].sort((a, b) => a.minute - b.minute)) {
    if (goal.minute > through) continue;
    if (goal.isHome) homeScore++;
    else awayScore++;
    // Scoreline first so the numbers stay in a column, then the scorer the way
    // FotMob names them. An unnamed scorer just leaves the bare scoreline.
    const scorer = goal.scorer ? ` — ${goal.scorer}` : '';
    // Worded here and only here — `assist` holds a bare name, whichever field
    // it came out of. A second name in brackets on its own is only unambiguous
    // if you already know the convention. An own goal has no assist worth
    // showing even if the payload carries one.
    const assist = goal.assist && !goal.ownGoal ? ` (Assist by ${goal.assist})` : '';
    markers.push({
      kind: 'goal',
      minute: goal.minute,
      minuteLabel: formatMinute(goal.minute, goal.added),
      isHome: goal.isHome,
      label: `${homeScore}-${awayScore}${scorer}${goal.ownGoal ? ' (OG)' : ''}${assist}`,
      homeProb: probAt(goal.minute),
    });
  }
  for (const card of snapshot.redCards) {
    if (card.minute > through) continue;
    markers.push({
      kind: 'red',
      minute: card.minute,
      minuteLabel: formatMinute(card.minute, card.added),
      isHome: card.isHome,
      label: `Red card — ${card.isHome ? snapshot.home.name : snapshot.away.name}`,
      homeProb: probAt(card.minute),
    });
  }
  markers.sort((a, b) => a.minute - b.minute);

  return { points, markers, through, fullTime: snapshot.fullTime };
}

/**
 * Marginal impact of the next goal — "a goal here takes them from 20% to 48%".
 * Not shown in v1, but it falls straight out of the same pure function.
 */
export function nextGoalSwing(snapshot: MatchSnapshot, minute: number) {
  const base = winProb(snapshot, minute);
  const withGoal = (isHome: boolean) => {
    const hypothetical: MatchSnapshot = {
      ...snapshot,
      goals: [
        ...snapshot.goals,
        { minute, added: 0, isHome, ownGoal: false, scorer: null, assist: null },
      ],
    };
    return winProb(hypothetical, minute);
  };
  return { base, ifHomeScores: withGoal(true), ifAwayScores: withGoal(false) };
}
