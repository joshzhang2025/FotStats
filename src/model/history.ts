/**
 * League tables reconstructed from historical results.
 *
 * FotMob's standings endpoint serves *today's* table and carries no date, so
 * using it for a match played in January prices that match with knowledge of
 * how the season finished — including the result of the match itself. This
 * module removes that leak by deriving the table from a results list, cut off
 * at the day the match was played.
 *
 * Results, not tables, are the thing worth storing: a table is a fold over
 * results at one instant, and matchday-indexed tables are ambiguous anyway
 * (postponements mean teams within a "matchday" have played different numbers
 * of games). A date cutoff is exact.
 */

import { PARAMS } from './params.ts';
import { canonicalTeam } from './teams.ts';
import type { TableRow } from './types.ts';

/**
 * One season of results, stored column-wise to keep the shipped file small.
 *
 * `teams` is the season's clubs by canonical key; each result references them
 * by index. `results` rows are `[dayIndex, homeIdx, awayIdx, homeGoals,
 * awayGoals]` where `dayIndex` is whole days since the Unix epoch — dates in
 * the source are day-resolution, so storing ms would be false precision.
 */
export interface HistorySeason {
  /** Source season code, e.g. `"2526"` for 2025/26. */
  code: string;
  teams: string[];
  results: [number, number, number, number, number][];
}

export interface History {
  generatedAt: number;
  /** FotMob league id these seasons belong to. */
  leagueId: number;
  seasons: HistorySeason[];
}

const DAY_MS = 86_400_000;

/** Whole days since the epoch, in UTC. */
export const toDayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

/**
 * The day a match was played, as a cutoff.
 *
 * Deliberately the *start* of the kickoff day rather than the kickoff instant.
 * Stored dates have no time component, so an instant cutoff would rank the
 * match's own stored date (midnight) as earlier than its kickoff and fold the
 * result being predicted into its own baseline. Cutting at day start drops
 * every same-day fixture instead: it costs a handful of matches from the
 * league-average denominator and cannot leak.
 */
export const cutoffDayFor = (kickoffUtc: number): number => toDayIndex(kickoffUtc);

export interface MatchTeams {
  homeName: string;
  homeId: number | null;
  awayName: string;
  awayId: number | null;
}

/** A club's scoring rates over a completed season, per game. */
interface Rates {
  scored: number;
  conceded: number;
}

/**
 * Last season, reduced to the per-game rates each club finished on.
 *
 * This is what a table cut at matchday 3 is missing: three games say almost
 * nothing about a side, but they are not the only thing known about it at
 * kickoff — last season happened, and everyone had seen it.
 */
export interface PriorSeason {
  rates: Map<string, Rates>;
  /** Season-wide goals per game, the starting point for a promoted club. */
  leagueRate: number;
}

export function priorFromSeason(season: HistorySeason): PriorSeason | null {
  const played = new Array<number>(season.teams.length).fill(0);
  const scored = new Array<number>(season.teams.length).fill(0);
  const conceded = new Array<number>(season.teams.length).fill(0);

  for (const [, h, a, hg, ag] of season.results) {
    played[h]!++;
    played[a]!++;
    scored[h]! += hg;
    conceded[h]! += ag;
    scored[a]! += ag;
    conceded[a]! += hg;
  }

  const totalPlayed = played.reduce((sum, p) => sum + p, 0);
  const totalGoals = scored.reduce((sum, g) => sum + g, 0);
  if (totalPlayed <= 0 || totalGoals <= 0) return null;

  const rates = new Map<string, Rates>();
  for (let i = 0; i < season.teams.length; i++) {
    if (played[i]! <= 0) continue;
    rates.set(season.teams[i]!, {
      scored: scored[i]! / played[i]!,
      conceded: conceded[i]! / played[i]!,
    });
  }

  return { rates, leagueRate: totalGoals / totalPlayed };
}

/**
 * What a club's record is assumed to have been, before this season started.
 *
 * A club with no previous top-flight season was promoted, and promoted clubs
 * are reliably worse than average rather than average — see
 * `PARAMS.table.promotedAttack`.
 */
function priorRates(prior: PriorSeason, team: string): Rates {
  const known = prior.rates.get(team);
  if (known) return known;

  const { promotedAttack, promotedDefence } = PARAMS.table;
  return {
    scored: prior.leagueRate * promotedAttack,
    conceded: prior.leagueRate * promotedDefence,
  };
}

/** The season covering `day`, or null when the file does not reach that far. */
export function seasonForDay(history: History, day: number): HistorySeason | null {
  return history.seasons[seasonIndexForDay(history, day)] ?? null;
}

/** Index of the season covering `day`, or -1. */
function seasonIndexForDay(history: History, day: number): number {
  for (let i = 0; i < history.seasons.length; i++) {
    const season = history.seasons[i]!;
    if (!season.results.length) continue;
    let first = Infinity;
    let last = -Infinity;
    for (const [d] of season.results) {
      if (d < first) first = d;
      if (d > last) last = d;
    }
    // `last >= day` is what makes a stale current-season file disqualify
    // itself: if the download predates the match, we have no table for it and
    // the caller must fall back rather than serve a half-season.
    if (day >= first && day <= last) return i;
  }
  return -1;
}

/**
 * The league table as it stood at the start of `day`.
 *
 * Only the two teams in the match get their real FotMob ids — those are the
 * only rows `prematchBaseline` looks up. Every other row exists solely to feed
 * the league-average denominator, so it gets a synthetic negative id that
 * cannot collide with a real one.
 *
 * Returns null when the table would not be usable: unknown club names, missing
 * ids, or too few rows to average over. Null means "fall back", never "empty
 * table" — an empty table would silently read as a season that has not started.
 */
export function tableAsOf(
  season: HistorySeason,
  day: number,
  match: MatchTeams,
  prior: PriorSeason | null = null,
): TableRow[] | null {
  const homeKey = canonicalTeam(match.homeName);
  const awayKey = canonicalTeam(match.awayName);
  if (!homeKey || !awayKey) return null;
  if (match.homeId === null || match.awayId === null) return null;

  const homeIdx = season.teams.indexOf(homeKey);
  const awayIdx = season.teams.indexOf(awayKey);
  if (homeIdx < 0 || awayIdx < 0) return null;

  const played = new Array<number>(season.teams.length).fill(0);
  const goalsFor = new Array<number>(season.teams.length).fill(0);
  const goalsAgainst = new Array<number>(season.teams.length).fill(0);

  for (const [resultDay, h, a, hg, ag] of season.results) {
    if (resultDay >= day) continue;
    played[h]!++;
    played[a]!++;
    goalsFor[h]! += hg;
    goalsAgainst[h]! += ag;
    goalsFor[a]! += ag;
    goalsAgainst[a]! += hg;
  }

  // Carry last season in as pseudo-games. Because the prior is expressed as
  // games rather than a weight, it dilutes itself: `priorGames / (priorGames +
  // played)` shrinks on its own as real matches accumulate, and by May the
  // table is overwhelmingly this season. Adding it to every club keeps the
  // league average — a ratio of these same totals — consistent.
  const priorGames = prior ? PARAMS.table.priorGames : 0;

  const rows: TableRow[] = [];
  for (let i = 0; i < season.teams.length; i++) {
    let p = played[i]!;
    let gf = goalsFor[i]!;
    let ga = goalsAgainst[i]!;

    if (prior && priorGames > 0) {
      const rates = priorRates(prior, season.teams[i]!);
      p += priorGames;
      gf += rates.scored * priorGames;
      ga += rates.conceded * priorGames;
    }

    if (p <= 0) continue;
    const teamId = i === homeIdx ? match.homeId : i === awayIdx ? match.awayId : -(i + 1);
    rows.push({ teamId, played: p, goalsFor: gf, goalsAgainst: ga });
  }

  // Matches the guard in `parseStandingsXml`: too few rows and the league
  // average is not an average of anything.
  return rows.length >= 4 ? rows : null;
}

/**
 * Full lookup: results file + kickoff -> the table that was true at kickoff.
 *
 * Null whenever any link in the chain is missing, which the worker treats as
 * "keep whatever standings FotMob gave us".
 */
export function historicalTable(
  history: History,
  leagueId: number | null,
  kickoffUtc: number | null,
  match: MatchTeams,
): { rows: TableRow[]; day: number } | null {
  if (leagueId !== history.leagueId || kickoffUtc === null) return null;

  const day = cutoffDayFor(kickoffUtc);
  const index = seasonIndexForDay(history, day);
  if (index < 0) return null;

  // The season before it, when the file has one. Its absence is not a failure:
  // the oldest season in the file simply has no prior to lean on, which is the
  // pre-blending behaviour.
  const previous = history.seasons[index - 1];
  const prior = previous ? priorFromSeason(previous) : null;

  const rows = tableAsOf(history.seasons[index]!, day, match, prior);
  return rows ? { rows, day } : null;
}
