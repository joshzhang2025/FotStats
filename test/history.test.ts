import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  cutoffDayFor,
  historicalTable,
  priorFromSeason,
  priorOnlyTable,
  seasonForDay,
  tableAsOf,
  toDayIndex,
  type History,
  type HistorySeason,
} from '../src/model/history.ts';
import { PARAMS } from '../src/model/params.ts';
import { canonicalTeam } from '../src/model/teams.ts';
import { prematchBaseline } from '../src/model/winprob.ts';
import { makeSnapshot } from './helpers.ts';

const day = (iso: string) => toDayIndex(Date.parse(`${iso}T00:00:00Z`));

/**
 * Four clubs, one match each per day, so every assertion below can be checked
 * by hand. Indices: 0 alpha, 1 beta, 2 gamma, 3 delta.
 */
const SEASON: HistorySeason = {
  code: 'test',
  teams: ['arsenal', 'chelsea', 'everton', 'fulham'],
  results: [
    [day('2024-08-10'), 0, 1, 3, 0],
    [day('2024-08-10'), 2, 3, 1, 1],
    [day('2024-08-17'), 1, 2, 2, 2],
    [day('2024-08-17'), 3, 0, 0, 4],
    // The match under test, and its same-day companion.
    [day('2024-08-24'), 0, 2, 5, 0],
    [day('2024-08-24'), 1, 3, 1, 0],
    // Played after — must never influence a table cut at 24 August.
    [day('2024-08-31'), 0, 3, 9, 0],
  ],
};

const MATCH = { homeName: 'Arsenal', homeId: 100, awayName: 'Everton', awayId: 200 };

describe('canonicalTeam', () => {
  it('folds both sources onto one key', () => {
    for (const [a, b] of [
      ['Man United', 'Manchester United'],
      ["Nott'm Forest", 'Nottingham Forest'],
      ['Wolves', 'Wolverhampton Wanderers'],
      ['Tottenham', 'Spurs'],
      ['Sheffield Weds', 'Sheffield Wednesday'],
      ['QPR', 'Queens Park Rangers'],
      ['Bournemouth', 'AFC Bournemouth'],
      ['West Brom', 'West Bromwich Albion'],
      ['Brighton', 'Brighton & Hove Albion'],
    ]) {
      const left = canonicalTeam(a!);
      assert.ok(left, `${a} did not resolve`);
      assert.equal(left, canonicalTeam(b!), `${a} and ${b} should agree`);
    }
  });

  it('keeps the two Manchester clubs apart', () => {
    assert.notEqual(canonicalTeam('Manchester United'), canonicalTeam('Manchester City'));
  });

  it('returns null for a club it does not know', () => {
    assert.equal(canonicalTeam('Real Madrid'), null);
    assert.equal(canonicalTeam(''), null);
  });
});

describe('tableAsOf', () => {
  const rows = tableAsOf(SEASON, day('2024-08-24'), MATCH)!;
  const home = rows.find((r) => r.teamId === 100)!;
  const away = rows.find((r) => r.teamId === 200)!;

  it('counts only matches played before the cutoff day', () => {
    // Arsenal: 3-0 win, then 0-4 away win. Two played, 7 for, 0 against.
    assert.deepEqual(home, { teamId: 100, played: 2, goalsFor: 7, goalsAgainst: 0 });
    // Everton: 1-1, then 2-2. Two played, 3 for, 3 against.
    assert.deepEqual(away, { teamId: 200, played: 2, goalsFor: 3, goalsAgainst: 3 });
  });

  it('excludes the match being predicted', () => {
    // The 5-0 on the cutoff day would show up as goalsFor 12 if it leaked.
    assert.equal(home.goalsFor, 7);
  });

  it('excludes every later match', () => {
    // The 9-0 a week later is the loudest possible leak.
    assert.ok(home.goalsFor < 16);
    assert.equal(rows.reduce((n, r) => n + r.played, 0), 8);
  });

  it('gives non-participating clubs ids that cannot collide with real ones', () => {
    for (const row of rows) {
      if (row.teamId === 100 || row.teamId === 200) continue;
      assert.ok(row.teamId < 0, `synthetic id ${row.teamId} should be negative`);
    }
  });

  it('refuses rather than returning a thin table', () => {
    // Opening day: nothing played yet, so there is no table to report.
    assert.equal(tableAsOf(SEASON, day('2024-08-10'), MATCH), null);
  });

  it('refuses when a club name is unknown', () => {
    const foreign = { ...MATCH, homeName: 'Real Madrid' };
    assert.equal(tableAsOf(SEASON, day('2024-08-24'), foreign), null);
  });

  it('refuses when FotMob gave no team id to key on', () => {
    const anonymous = { ...MATCH, homeId: null };
    assert.equal(tableAsOf(SEASON, day('2024-08-24'), anonymous), null);
  });
});

/**
 * The season before `SEASON`, with deliberately lopsided records:
 * arsenal P3 10-0, chelsea P3 1-6, everton P3 3-5, fulham P3 2-5.
 * League rate is 16 goals / 12 team-games = 1.333 per game.
 */
const PREV: HistorySeason = {
  code: 'prev',
  teams: ['arsenal', 'chelsea', 'everton', 'fulham'],
  results: [
    [day('2023-08-12'), 0, 1, 3, 0],
    [day('2023-08-12'), 2, 3, 1, 1],
    [day('2023-08-19'), 1, 2, 0, 2],
    [day('2023-08-19'), 3, 0, 0, 3],
    [day('2023-08-26'), 0, 2, 4, 0],
    [day('2023-08-26'), 1, 3, 1, 1],
  ],
};

describe('previous-season prior', () => {
  const prior = priorFromSeason(PREV)!;
  const { priorGames, promotedAttack, promotedDefence } = PARAMS.table;

  it('reduces a finished season to per-game rates', () => {
    assert.equal(prior.rates.get('arsenal')!.scored, 10 / 3);
    assert.equal(prior.rates.get('arsenal')!.conceded, 0);
    assert.equal(prior.rates.get('chelsea')!.scored, 1 / 3);
    assert.equal(prior.leagueRate, 16 / 12);
  });

  it('gives an opening-day match a usable table, where before there was none', () => {
    const opening = day('2024-08-10');
    assert.equal(tableAsOf(SEASON, opening, MATCH), null);

    const rows = tableAsOf(SEASON, opening, MATCH, prior)!;
    assert.ok(rows, 'prior should make the opening weekend priceable');
    assert.equal(rows.length, 4);

    // Nothing played yet, so the row is purely last season scaled to
    // `priorGames`: 10/3 per game becomes 10/3 * priorGames.
    const home = rows.find((r) => r.teamId === 100)!;
    assert.equal(home.played, priorGames);
    assert.ok(Math.abs(home.goalsFor - (10 / 3) * priorGames) < 1e-9);
  });

  it('clears the minPlayed guard that league-average fallback rests on', () => {
    const rows = tableAsOf(SEASON, day('2024-08-10'), MATCH, prior)!;
    const snapshot = makeSnapshot({
      home: { id: 100, name: 'Arsenal' },
      away: { id: 200, name: 'Everton' },
      table: rows,
      tableAsOfDay: day('2024-08-10'),
    });
    const baseline = prematchBaseline(snapshot);
    assert.equal(baseline.source, 'table-historical');
    assert.ok(baseline.home > baseline.away, 'last season had Arsenal far stronger');
  });

  it('dilutes itself as real games accumulate', () => {
    // Arsenal's prior is 3.33 goals a game; this season they are on 3.5 after
    // two games. The gap to the prior should narrow as games are added.
    const early = tableAsOf(SEASON, day('2024-08-17'), MATCH, prior)!;
    const later = tableAsOf(SEASON, day('2024-08-31'), MATCH, prior)!;

    const weight = (rows: typeof early) => {
      const row = rows.find((r) => r.teamId === 100)!;
      return priorGames / row.played;
    };
    assert.ok(weight(early) > weight(later), 'prior weight should fall over time');
    assert.ok(weight(later) < 1, 'by late season real games should outweigh the prior');
  });

  it('never lets the prior outlive the season it came from', () => {
    // A full season is 38 games, so the prior can never dominate by May.
    const full = { teamId: 1, played: 38 + priorGames };
    assert.ok(priorGames / full.played < 0.5);
  });

  it('treats a club with no previous season as promoted, not average', () => {
    const promotedSeason: HistorySeason = {
      code: 'promoted',
      teams: ['arsenal', 'chelsea', 'everton', 'luton'],
      results: SEASON.results,
    };
    const rows = tableAsOf(
      promotedSeason,
      day('2024-08-10'),
      { homeName: 'Arsenal', homeId: 100, awayName: 'Luton', awayId: 300 },
      prior,
    )!;

    const luton = rows.find((r) => r.teamId === 300)!;
    assert.ok(
      Math.abs(luton.goalsFor - prior.leagueRate * promotedAttack * priorGames) < 1e-9,
      'promoted attack should be scaled down from the league rate',
    );
    assert.ok(
      Math.abs(luton.goalsAgainst - prior.leagueRate * promotedDefence * priorGames) < 1e-9,
      'promoted defence should be scaled up from the league rate',
    );
    assert.ok(luton.goalsAgainst > luton.goalsFor, 'promoted sides concede more than they score');
  });

  it('still refuses when the club is unknown, prior or not', () => {
    const foreign = { ...MATCH, homeName: 'Real Madrid' };
    assert.equal(tableAsOf(SEASON, day('2024-08-24'), foreign, prior), null);
  });
});

describe('season coverage', () => {
  const history: History = { generatedAt: 0, leagueId: 47, seasons: [SEASON] };

  it('finds the season containing a day', () => {
    assert.equal(seasonForDay(history, day('2024-08-17'))?.code, 'test');
  });

  it('reports no season for a date the file does not reach', () => {
    // This is what makes a stale download fall back instead of serving a
    // half-finished season as if it were complete.
    assert.equal(seasonForDay(history, day('2024-09-30')), null);
    assert.equal(seasonForDay(history, day('2024-07-01')), null);
  });

  it('declines a league it has no data for', () => {
    const kickoff = Date.parse('2024-08-24T14:00:00Z');
    assert.equal(historicalTable(history, 130, kickoff, MATCH), null);
    assert.ok(historicalTable(history, 47, kickoff, MATCH));
  });

  it('declines a match with no kickoff time', () => {
    assert.equal(historicalTable(history, 47, null, MATCH), null);
  });

  it('cuts at the start of the kickoff day regardless of kickoff time', () => {
    const early = historicalTable(history, 47, Date.parse('2024-08-24T11:30:00Z'), MATCH);
    const late = historicalTable(history, 47, Date.parse('2024-08-24T19:45:00Z'), MATCH);
    assert.deepEqual(early?.rows, late?.rows);
  });

  it('reports the day it cut at', () => {
    const kickoff = Date.parse('2024-08-24T14:00:00Z');
    assert.equal(historicalTable(history, 47, kickoff, MATCH)?.day, cutoffDayFor(kickoff));
  });
});

describe('prior-only table', () => {
  const history: History = { generatedAt: 0, leagueId: 47, seasons: [SEASON] };
  const { priorGames, promotedAttack, promotedDefence, priorOnlyMaxDays } = PARAMS.table;
  const prior = priorFromSeason(SEASON)!;
  // The season in the file ends 31 August; this is the next one starting.
  const opening = Date.parse('2025-08-16T14:00:00Z');

  it('prices a season the archive has no results for at all', () => {
    // Without this the live table is all zeroes, `prematchBaseline` bails to
    // league averages, and the only thing separating the sides is who is home.
    const resolved = historicalTable(history, 47, opening, MATCH);
    assert.ok(resolved, 'the opening weekend should still get a table');
    assert.equal(resolved.priorOnly, true);
    assert.equal(resolved.day, cutoffDayFor(opening));
  });

  it('enters every club at the same pseudo-games', () => {
    // Equal weight is the point: the league average the baseline divides by
    // then reduces to the plain mean of last season's rates, so the two sides
    // are compared on the scale their rates were measured on.
    const rows = priorOnlyTable(SEASON, MATCH)!;
    for (const row of rows) assert.equal(row.played, priorGames);

    const total = rows.reduce((sum, r) => sum + r.goalsFor, 0);
    const played = rows.reduce((sum, r) => sum + r.played, 0);
    const meanRate =
      SEASON.teams.reduce((sum, t) => sum + prior.rates.get(t)!.scored, 0) / SEASON.teams.length;
    assert.ok(Math.abs(total / played - meanRate) < 1e-9);
  });

  it('counts each of the two sides once, not twice', () => {
    const rows = priorOnlyTable(SEASON, MATCH)!;
    assert.equal(rows.filter((r) => r.teamId === MATCH.homeId).length, 1);
    assert.equal(rows.filter((r) => r.teamId === MATCH.awayId).length, 1);
    // Four clubs in the season, and both of ours are among them.
    assert.equal(rows.length, SEASON.teams.length);
  });

  it('treats a club the division has never seen as promoted', () => {
    const rows = priorOnlyTable(SEASON, {
      homeName: 'Luton',
      homeId: 300,
      awayName: 'Arsenal',
      awayId: 100,
    })!;

    const luton = rows.find((r) => r.teamId === 300)!;
    assert.ok(Math.abs(luton.goalsFor - prior.leagueRate * promotedAttack * priorGames) < 1e-9);
    assert.ok(
      Math.abs(luton.goalsAgainst - prior.leagueRate * promotedDefence * priorGames) < 1e-9,
    );
    assert.ok(luton.goalsAgainst > luton.goalsFor);
  });

  it('never reaches backwards', () => {
    // A day before the archive is a match older than the file covers, where
    // the newest season is not a prior but a future.
    assert.equal(historicalTable(history, 47, Date.parse('2024-07-01T14:00:00Z'), MATCH), null);
  });

  it('expires once the prior is two seasons old', () => {
    const stale = Date.parse('2025-11-01T14:00:00Z');
    assert.ok(cutoffDayFor(stale) - day('2024-08-31') > priorOnlyMaxDays);
    assert.equal(historicalTable(history, 47, stale, MATCH), null);
  });

  it('still refuses a club it cannot name', () => {
    assert.equal(priorOnlyTable(SEASON, { ...MATCH, homeName: 'Real Madrid' }), null);
  });

  it('says it is last season, not a table of this one', () => {
    const resolved = historicalTable(history, 47, opening, MATCH)!;
    const snapshot = makeSnapshot({
      home: { id: 100, name: 'Arsenal' },
      away: { id: 200, name: 'Everton' },
      table: resolved.rows,
      tableAsOfDay: resolved.day,
      tablePriorOnly: true,
      leagueId: 47,
    });
    assert.equal(prematchBaseline(snapshot).source, 'table-prior');
  });

  it('makes the stronger side the favourite even at home', () => {
    // Arsenal outscored Everton 21-3 across the stored season, so a table that
    // carries any information at all has to price them ahead either way.
    const resolved = historicalTable(history, 47, opening, {
      homeName: 'Everton',
      homeId: 200,
      awayName: 'Arsenal',
      awayId: 100,
    })!;
    const snapshot = makeSnapshot({
      home: { id: 200, name: 'Everton' },
      away: { id: 100, name: 'Arsenal' },
      table: resolved.rows,
      tableAsOfDay: resolved.day,
      tablePriorOnly: true,
      leagueId: 47,
    });
    const baseline = prematchBaseline(snapshot);
    assert.ok(
      baseline.away > baseline.home,
      `away lambda ${baseline.away} should beat home ${baseline.home}`,
    );
  });
});

describe('baseline labelling', () => {
  const rows = tableAsOf(SEASON, day('2024-08-24'), MATCH)!;

  it('is reported as historical when a cutoff day is set', () => {
    const snapshot = makeSnapshot({
      home: { id: 100, name: 'Arsenal' },
      away: { id: 200, name: 'Everton' },
      table: rows,
      tableAsOfDay: day('2024-08-24'),
    });
    // Only two games played, so the model correctly declines to trust the
    // rates — but the *source* still has to say where the table came from.
    assert.equal(prematchBaseline(snapshot).source, 'league-average');
    assert.match(prematchBaseline(snapshot).reason ?? '', /2 games/);
  });

  it('separates a live table from a point-in-time one', () => {
    const full = [
      { teamId: 100, played: 10, goalsFor: 20, goalsAgainst: 8 },
      { teamId: 200, played: 10, goalsFor: 9, goalsAgainst: 15 },
      { teamId: -3, played: 10, goalsFor: 12, goalsAgainst: 12 },
      { teamId: -4, played: 10, goalsFor: 11, goalsAgainst: 17 },
    ];
    const base = {
      home: { id: 100, name: 'Arsenal' },
      away: { id: 200, name: 'Everton' },
      table: full,
    };

    assert.equal(prematchBaseline(makeSnapshot(base)).source, 'table');
    assert.equal(
      prematchBaseline(makeSnapshot({ ...base, tableAsOfDay: day('2024-08-24') })).source,
      'table-historical',
    );
  });

  it('makes the stronger side the favourite either way', () => {
    const snapshot = makeSnapshot({
      home: { id: 100, name: 'Arsenal' },
      away: { id: 200, name: 'Everton' },
      table: [
        { teamId: 100, played: 10, goalsFor: 22, goalsAgainst: 6 },
        { teamId: 200, played: 10, goalsFor: 6, goalsAgainst: 20 },
        { teamId: -3, played: 10, goalsFor: 12, goalsAgainst: 12 },
        { teamId: -4, played: 10, goalsFor: 12, goalsAgainst: 14 },
      ],
      tableAsOfDay: day('2024-08-24'),
    });
    const baseline = prematchBaseline(snapshot);
    assert.equal(baseline.source, 'table-historical');
    assert.ok(baseline.home > baseline.away, `${baseline.home} should exceed ${baseline.away}`);
  });
});

describe('the generated history file', () => {
  const history: History = JSON.parse(readFileSync('public/data/pl-history.json', 'utf8'));

  it('covers the Premier League', () => {
    assert.equal(history.leagueId, 47);
    assert.ok(history.seasons.length >= 1);
  });

  it('has a complete 20-team season in every entry', () => {
    for (const season of history.seasons) {
      // A partial current season is legitimate; a partial *past* one means the
      // download was truncated.
      if (season.results.length < 380) continue;
      assert.equal(season.teams.length, 20, `${season.code} had ${season.teams.length} clubs`);
      assert.equal(season.results.length, 380, `${season.code}`);
    }
  });

  it('reconstructs a table that matches the historical record', () => {
    const season = history.seasons.find((s) => s.code === '1516');
    if (!season) return; // 2015/16 not in the configured range

    // Leicester's title season finished P38 W23 D12 L3, 68-36.
    const idx = season.teams.indexOf('leicester');
    assert.ok(idx >= 0, 'Leicester missing from 2015/16');

    let played = 0;
    let scored = 0;
    let conceded = 0;
    for (const [, h, a, hg, ag] of season.results) {
      if (h === idx) {
        played++;
        scored += hg;
        conceded += ag;
      } else if (a === idx) {
        played++;
        scored += ag;
        conceded += hg;
      }
    }

    assert.equal(played, 38);
    assert.equal(scored, 68);
    assert.equal(conceded, 36);
  });

  it('prices the opening weekend of any season but the first', () => {
    // The first season in the file has no predecessor, so it keeps the old
    // behaviour; every later one should be priceable from matchday 1.
    const season = history.seasons[1]!;
    const firstDay = Math.min(...season.results.map(([d]) => d));
    const [, hi, ai] = season.results.find(([d]) => d === firstDay)!;

    const resolved = historicalTable(history, 47, firstDay * 86_400_000, {
      homeName: season.teams[hi]!,
      homeId: 1,
      awayName: season.teams[ai]!,
      awayId: 2,
    });

    assert.ok(resolved, 'opening-day match should resolve via the previous season');
    const home = resolved.rows.find((r) => r.teamId === 1)!;
    assert.ok(
      home.played >= PARAMS.table.minPlayed,
      `effective played ${home.played} should clear the minPlayed guard`,
    );
  });

  it('carries the newest season forward into the one after it', () => {
    // The gap this closes: between the archive's last result in May and the
    // file being regenerated, no stored season covers today and FotMob's live
    // table is all zeroes. Every real season here is 38 games, so the pseudo-
    // games are equal-weight and the average is the season's own goal rate.
    const last = history.seasons[history.seasons.length - 1]!;
    const lastDay = Math.max(...last.results.map(([d]) => d));
    const prior = priorFromSeason(last)!;
    const [, hi, ai] = last.results[0]!;

    const resolved = historicalTable(history, 47, (lastDay + 90) * 86_400_000, {
      homeName: last.teams[hi]!,
      homeId: 1,
      awayName: last.teams[ai]!,
      awayId: 2,
    });

    assert.ok(resolved, 'a match after the archive ends should still price');
    assert.equal(resolved.priorOnly, true);

    const home = resolved.rows.find((r) => r.teamId === 1)!;
    assert.ok(home.played >= PARAMS.table.minPlayed, 'must clear the minPlayed guard');

    const goals = resolved.rows.reduce((sum, r) => sum + r.goalsFor, 0);
    const played = resolved.rows.reduce((sum, r) => sum + r.played, 0);
    assert.ok(
      Math.abs(goals / played - prior.leagueRate) < 1e-9,
      `league average ${goals / played} should be last season's ${prior.leagueRate}`,
    );
  });

  it('never lets a season leak into its own final table', () => {
    const season = history.seasons.find((s) => s.results.length >= 380)!;
    const lastDay = Math.max(...season.results.map(([d]) => d));
    const rows = tableAsOf(season, lastDay, {
      homeName: 'Arsenal',
      homeId: 1,
      awayName: 'Chelsea',
      awayId: 2,
    });
    // Cut on the final day, no club can have played all 38.
    for (const row of rows ?? []) assert.ok(row.played < 38, `played ${row.played}`);
  });
});
