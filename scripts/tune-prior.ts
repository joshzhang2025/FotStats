/**
 * Sweep `PARAMS.table.priorGames` against the historical archive.
 *
 *   npm run tune-prior
 *
 * Every match in `public/data/pl-history.json` is priced at minute 0 from the
 * table as it stood that morning, then scored against what actually happened.
 * No xG and no in-play state are involved: this measures the *baseline* alone,
 * which is the only thing the prior touches.
 *
 * Strictly out-of-sample by construction — the table is cut at the day of
 * kickoff, so no match contributes to its own prediction.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { historicalTable, type History } from '../src/model/history.ts';
import { PARAMS } from '../src/model/params.ts';
import type { MatchSnapshot } from '../src/model/types.ts';
import { winProb } from '../src/model/winprob.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const history: History = JSON.parse(
  readFileSync(resolve(root, 'public/data/pl-history.json'), 'utf8'),
);

const DAY_MS = 86_400_000;

const snapshotFor = (rows: MatchSnapshot['table'], day: number): MatchSnapshot => ({
  matchId: 'tune',
  home: { id: 1, name: 'Home' },
  away: { id: 2, name: 'Away' },
  colors: { home: '#000', away: '#fff' },
  leagueId: 47,
  leagueName: 'Premier League',
  status: { started: false, finished: false, cancelled: false, liveMinute: null },
  goals: [],
  redCards: [],
  shots: [],
  table: rows,
  tableAsOfDay: day,
  tablePriorOnly: false,
  standingsUrl: null,
  fullTime: PARAMS.expectedFullTime,
  kickoffUtc: day * DAY_MS,
  capturedAt: 0,
  warnings: [],
});

interface Score {
  n: number;
  brier: number;
  logLoss: number;
  /** Matches the sweep value could price at all, before any common-subset cut. */
  covered: number;
  /** Priced, but with too few games to trust the table. */
  fellBack: number;
}

const matchKey = (seasonIndex: number, resultIndex: number) => `${seasonIndex}:${resultIndex}`;

/**
 * @param only  Restrict scoring to these matches. Higher prior values cover
 *              more of the archive — opening weekend has no table without one —
 *              so comparing raw scores would compare different samples. The
 *              coverage gain is reported separately instead.
 * @param seasons Restrict to these season indices, for the split-half check.
 */
function evaluate(priorGames: number, only?: Set<string>, seasons?: (i: number) => boolean): Score {
  PARAMS.table.priorGames = priorGames;

  let n = 0;
  let brier = 0;
  let logLoss = 0;
  let covered = 0;
  let fellBack = 0;

  for (let si = 0; si < history.seasons.length; si++) {
    if (seasons && !seasons(si)) continue;
    const season = history.seasons[si]!;

    for (let ri = 0; ri < season.results.length; ri++) {
      const [day, hi, ai, hg, ag] = season.results[ri]!;
      const resolved = historicalTable(history, 47, day * DAY_MS, {
        homeName: season.teams[hi]!,
        homeId: 1,
        awayName: season.teams[ai]!,
        awayId: 2,
      });
      if (!resolved) continue;
      covered++;

      if (only && !only.has(matchKey(si, ri))) continue;

      const rows = resolved.rows;
      const home = rows.find((r) => r.teamId === 1);
      const away = rows.find((r) => r.teamId === 2);
      if (!home || !away || Math.min(home.played, away.played) < PARAMS.table.minPlayed) {
        fellBack++;
      }

      const p = winProb(snapshotFor(rows, resolved.day), 0);
      const actual = hg > ag ? 'home' : hg < ag ? 'away' : 'draw';
      for (const key of ['home', 'draw', 'away'] as const) {
        brier += (p[key] - (actual === key ? 1 : 0)) ** 2;
      }
      logLoss -= Math.log(Math.max(p[actual], 1e-12));
      n++;
    }
  }

  return { n, brier: brier / n, logLoss: logLoss / n, covered, fellBack };
}

/** Matches priceable with no prior at all — the common subset for comparison. */
function baselineCoverage(): Set<string> {
  PARAMS.table.priorGames = 0;
  const keys = new Set<string>();
  for (let si = 0; si < history.seasons.length; si++) {
    const season = history.seasons[si]!;
    for (let ri = 0; ri < season.results.length; ri++) {
      const [day, hi, ai] = season.results[ri]!;
      const resolved = historicalTable(history, 47, day * DAY_MS, {
        homeName: season.teams[hi]!,
        homeId: 1,
        awayName: season.teams[ai]!,
        awayId: 2,
      });
      if (resolved) keys.add(matchKey(si, ri));
    }
  }
  return keys;
}

const original = PARAMS.table.priorGames;
const sweep = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 30];
const common = baselineCoverage();

console.log('\n  Baseline-only scoring over the historical archive.');
console.log('  priorGames 0 = no previous season, i.e. before this change.');
console.log(`  Scored on the ${common.size} matches every sweep value can price.\n`);
console.log('  prior     Brier       log-loss   covered   thin table');

const results = sweep.map((priorGames) => ({ priorGames, score: evaluate(priorGames, common) }));
const baseline = results[0]!.score;
const best = results.reduce((a, b) => (b.score.brier < a.score.brier ? b : a));

for (const { priorGames, score } of results) {
  const delta = score.brier - baseline.brier;
  console.log(
    `  ${String(priorGames).padStart(5)}   ${score.brier.toFixed(5)} ` +
      `${(delta >= 0 ? '+' : '') + delta.toFixed(5)}   ${score.logLoss.toFixed(5)}   ` +
      `${String(score.covered).padStart(5)}   ` +
      `${((score.fellBack / score.n) * 100).toFixed(1).padStart(5)}%` +
      (priorGames === best.priorGames ? '  <- best' : ''),
  );
}

// A flat optimum invites reading precision that is not there. Fit each half of
// the archive separately: if the two halves disagree, the exact value is noise
// and the smaller one is the honest choice.
const mid = Math.floor(history.seasons.length / 2);
const halves = [
  { label: `seasons 1-${mid}`, pick: (i: number) => i < mid },
  { label: `seasons ${mid + 1}-${history.seasons.length}`, pick: (i: number) => i >= mid },
] as const;

console.log('\n  Stability — best value fitted on each half separately:');
for (const { label, pick } of halves) {
  const scored = sweep.map((p) => ({ p, s: evaluate(p, common, pick) }));
  const top = scored.reduce((a, b) => (b.s.brier < a.s.brier ? b : a));
  const within = scored
    .filter((x) => x.s.brier - top.s.brier < 0.001)
    .map((x) => x.p);
  console.log(
    `    ${label.padEnd(12)} best ${String(top.p).padStart(3)}   ` +
      `within 0.001 of best: ${within.join(', ')}`,
  );
}

console.log(
  `\n  Best overall at priorGames=${best.priorGames}; params.ts ships ${original}.\n` +
    '  Lower is better. Where the halves disagree, prefer the smaller value —\n' +
    '  it leans less on a season that is already over.\n',
);

PARAMS.table.priorGames = original;
