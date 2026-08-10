import { DEFAULT_BASELINE, LEAGUE_BASELINES, PARAMS } from './params.ts';
import { outcomeProbabilities } from './poisson.ts';
import type { MatchSnapshot, StateAtMinute, WinProb } from './types.ts';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Rebuild the match situation as it stood at `minute`.
 *
 * This is what lets one function serve both the live readout and the timeline:
 * every input the model needs is recoverable at any minute from the event list
 * and the shotmap, so nothing has to be accumulated as the match streams in.
 */
export function stateAt(snapshot: MatchSnapshot, minute: number): StateAtMinute {
  const state: StateAtMinute = {
    minute,
    homeGoals: 0,
    awayGoals: 0,
    homeRedMinutes: [],
    awayRedMinutes: [],
    homeXg: 0,
    awayXg: 0,
  };

  for (const goal of snapshot.goals) {
    if (goal.minute > minute) continue;
    if (goal.isHome) state.homeGoals++;
    else state.awayGoals++;
  }

  for (const card of snapshot.redCards) {
    if (card.minute > minute) continue;
    if (card.isHome) state.homeRedMinutes.push(card.minute);
    else state.awayRedMinutes.push(card.minute);
  }

  for (const shot of snapshot.shots) {
    if (shot.minute > minute) continue;
    if (shot.isHome) state.homeXg += shot.xg;
    else state.awayXg += shot.xg;
  }

  return state;
}

/**
 * Integral of the minute-weight curve over [from, to].
 *
 * w(m) = 1 + tilt * (m/T - 0.5) is normalised so that integrating across the
 * whole match returns exactly T. That means it redistributes goal risk toward
 * the closing stages without inflating the expected total.
 */
export function weightedMinutes(from: number, to: number, fullTime: number): number {
  if (to <= from) return 0;
  const { tilt } = PARAMS.minuteWeight;
  const linear = to - from;
  const quadratic = (to * to - from * from) / (2 * fullTime) - linear / 2;
  return Math.max(0, linear + tilt * quadratic);
}

export interface Baseline {
  home: number;
  away: number;
  /** Where the numbers came from, surfaced in the UI so the model is legible. */
  source: 'table' | 'league-average';
  /** Why the table was not used, when one was available but unusable. */
  reason?: string;
}

/**
 * Pre-match expected goals for each side.
 *
 * Uses the standings snapshot the match page already carries: a team's goals
 * for and against per game, relative to the league average, give crude attack
 * and defence multipliers applied to a home/away baseline.
 */
export function prematchBaseline(snapshot: MatchSnapshot): Baseline {
  const fallback =
    (snapshot.leagueId !== null ? LEAGUE_BASELINES[String(snapshot.leagueId)] : undefined) ??
    DEFAULT_BASELINE;

  const rows = snapshot.table;
  const homeRow = rows?.find((r) => r.teamId === snapshot.home.id);
  const awayRow = rows?.find((r) => r.teamId === snapshot.away.id);

  if (!rows || !homeRow || !awayRow) {
    return { home: fallback.homeLambda, away: fallback.awayLambda, source: 'league-average' };
  }

  const { minPlayed, minStrength, maxStrength, shrink, minLambda, maxLambda } = PARAMS.table;
  const played = Math.min(homeRow.played, awayRow.played);
  if (played < minPlayed) {
    // Early in a season — or before it starts — per-team rates are noise.
    return {
      home: fallback.homeLambda,
      away: fallback.awayLambda,
      source: 'league-average',
      reason:
        played === 0
          ? 'season has not started'
          : `only ${played} game${played === 1 ? '' : 's'} played`,
    };
  }

  const totalPlayed = rows.reduce((sum, r) => sum + r.played, 0);
  const totalGoals = rows.reduce((sum, r) => sum + r.goalsFor, 0);
  if (totalPlayed <= 0 || totalGoals <= 0) {
    return { home: fallback.homeLambda, away: fallback.awayLambda, source: 'league-average' };
  }
  const leagueAvg = totalGoals / totalPlayed;

  const strength = (value: number, played: number) =>
    clamp(value / played / leagueAvg, minStrength, maxStrength) ** shrink;

  const homeAtk = strength(homeRow.goalsFor, homeRow.played);
  const homeDef = strength(homeRow.goalsAgainst, homeRow.played);
  const awayAtk = strength(awayRow.goalsFor, awayRow.played);
  const awayDef = strength(awayRow.goalsAgainst, awayRow.played);

  return {
    home: clamp(fallback.homeLambda * homeAtk * awayDef, minLambda, maxLambda),
    away: clamp(fallback.awayLambda * awayAtk * homeDef, minLambda, maxLambda),
    source: 'table',
  };
}

export interface WinProbDetail extends WinProb {
  state: StateAtMinute;
  baseline: Baseline;
  /** Expected goals still to come for each side, after every adjustment. */
  lambdaRemaining: { home: number; away: number };
}

/**
 * Win/draw/loss probability for the match as it stood at `minute`.
 *
 * Pure: same snapshot and minute always give the same answer. The live readout
 * calls this once; the timeline calls it for every minute.
 */
export function winProbDetailed(snapshot: MatchSnapshot, minute: number): WinProbDetail {
  const fullTime = snapshot.fullTime;
  const t = clamp(minute, 0, fullTime);
  const state = stateAt(snapshot, t);
  const baseline = prematchBaseline(snapshot);

  const elapsed = weightedMinutes(0, t, fullTime);
  const remaining = weightedMinutes(t, fullTime, fullTime);

  // Prior rate per weighted minute. Total weight over a full match is fullTime,
  // so this is just the season-implied lambda spread evenly across the clock.
  const priorRateHome = baseline.home / fullTime;
  const priorRateAway = baseline.away / fullTime;

  const { k, rateFloorFraction, rateCeilFraction } = PARAMS.liveXg;
  const blend = (priorRate: number, xg: number): number => {
    // Below a minute of football there is no live signal worth reading, and
    // dividing by the elapsed weight would blow up.
    if (t < 1 || elapsed <= 0) return priorRate;
    const observed = clamp(
      xg / elapsed,
      priorRate * rateFloorFraction,
      priorRate * rateCeilFraction,
    );
    const w = k / (k + t);
    return w * priorRate + (1 - w) * observed;
  };

  let lambdaHome = blend(priorRateHome, state.homeXg) * remaining;
  let lambdaAway = blend(priorRateAway, state.awayXg) * remaining;

  // Red cards: a side down to 10 creates less and concedes more for every
  // remaining minute. Earlier cards matter more automatically, because more
  // weighted minutes remain for the multiplier to act on.
  const { attackMult, concedeMult, maxCards } = PARAMS.redCard;
  const homeReds = Math.min(state.homeRedMinutes.length, maxCards);
  const awayReds = Math.min(state.awayRedMinutes.length, maxCards);
  if (homeReds || awayReds) {
    lambdaHome *= attackMult ** homeReds * concedeMult ** awayReds;
    lambdaAway *= attackMult ** awayReds * concedeMult ** homeReds;
  }

  // Game state: trailing sides push, leading sides sit, and both effects
  // sharpen as the clock runs down.
  const diff = state.homeGoals - state.awayGoals;
  if (diff !== 0) {
    const { trailPush, leadSit, maxDeficit, earlyFactor } = PARAMS.gameState;
    const timeFactor = earlyFactor + (1 - earlyFactor) * (t / fullTime);
    const deficit = Math.min(Math.abs(diff), maxDeficit);
    const push = 1 + trailPush * deficit * timeFactor;
    const sit = Math.max(0.1, 1 - leadSit * deficit * timeFactor);
    if (diff < 0) {
      lambdaHome *= push;
      lambdaAway *= sit;
    } else {
      lambdaAway *= push;
      lambdaHome *= sit;
    }
  }

  // A level match late on tends to stay level — both sides stop risking it.
  if (PARAMS.lateDraw.enabled && diff === 0 && t >= PARAMS.lateDraw.fromMinute) {
    const span = Math.max(1, fullTime - PARAMS.lateDraw.fromMinute);
    const damp = 1 - PARAMS.lateDraw.damp * clamp((t - PARAMS.lateDraw.fromMinute) / span, 0, 1);
    lambdaHome *= damp;
    lambdaAway *= damp;
  }

  // The Dixon-Coles correction is defined over a whole match, so fade it out in
  // proportion to how much of the match is still to be played.
  const rho = PARAMS.dixonColes.enabled
    ? PARAMS.dixonColes.rho * (remaining / fullTime)
    : 0;

  const probs = outcomeProbabilities(lambdaHome, lambdaAway, {
    homeGoals: state.homeGoals,
    awayGoals: state.awayGoals,
    gridMax: PARAMS.gridMax,
    rho,
  });

  return {
    ...probs,
    state,
    baseline,
    lambdaRemaining: { home: lambdaHome, away: lambdaAway },
  };
}

export function winProb(snapshot: MatchSnapshot, minute: number): WinProb {
  const { home, draw, away } = winProbDetailed(snapshot, minute);
  return { home, draw, away };
}
