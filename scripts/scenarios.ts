/**
 * Print the model's output for a set of familiar match situations.
 *
 * The test suite proves the model is coherent; this is for judging whether the
 * numbers are *plausible* — compare them against what you know in-play markets
 * price these spots at. Run after touching anything in src/model/params.ts.
 *
 *   npm run scenarios
 */

import { prematchBaseline, winProb } from '../src/model/winprob.ts';
import type { MatchSnapshot, ShotEvent, TableRow } from '../src/model/types.ts';
import { PARAMS } from '../src/model/params.ts';

const snapshot = (overrides: Partial<MatchSnapshot> = {}): MatchSnapshot => ({
  matchId: 'scenario',
  home: { id: 1, name: 'Home' },
  away: { id: 2, name: 'Away' },
  colors: { home: '#3b82f6', away: '#ef4444' },
  leagueId: 47,
  leagueName: 'Premier League',
  status: { started: true, finished: false, cancelled: false, liveMinute: null },
  goals: [],
  redCards: [],
  shots: [],
  table: null,
  tableAsOfDay: null,
  tablePriorOnly: false,
  standingsUrl: null,
  fullTime: PARAMS.expectedFullTime,
  kickoffUtc: null,
  capturedAt: 0,
  warnings: [],
  ...overrides,
});

const goal = (minute: number, isHome: boolean) => ({
  minute,
  added: 0,
  isHome,
  ownGoal: false,
  scorer: null,
  assist: null,
});
const red = (minute: number, isHome: boolean) => ({ minute, isHome });

const xg = (isHome: boolean, total: number, count = 10, until = 90): ShotEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    minute: Math.round(((i + 1) / count) * until),
    isHome,
    xg: total / count,
    isGoal: false,
  }));

const flatTable = (): TableRow[] =>
  Array.from({ length: 20 }, (_, i) => ({
    teamId: i + 1,
    played: 20,
    goalsFor: 28,
    goalsAgainst: 28,
  }));

const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(6);

function row(label: string, s: MatchSnapshot, minute: number) {
  const p = winProb(s, minute);
  const clock = `${minute}'`.padStart(4);
  console.log(`  ${label.padEnd(38)}${clock}   ${pct(p.home)} ${pct(p.draw)} ${pct(p.away)}`);
}

function heading(text: string) {
  console.log(`\n${text}`);
  console.log(`  ${'situation'.padEnd(38)}${'min'.padStart(4)}   ${'home'.padStart(6)} ${'draw'.padStart(6)} ${'away'.padStart(6)}`);
}

heading('Nothing happening (0-0, no shots)');
for (const m of [0, 30, 60, 80, 90]) row('goalless, no chances', snapshot(), m);

heading('Home leads 1-0 from 30\'');
const lead = snapshot({ goals: [goal(30, true)] });
for (const m of [30, 45, 60, 75, 85, 90]) row('1-0 home', lead, m);

heading('Away leads 1-0 from 30\'');
const awayLead = snapshot({ goals: [goal(30, false)] });
for (const m of [30, 60, 85]) row('0-1 away', awayLead, m);

heading('Home two goals up');
const twoUp = snapshot({ goals: [goal(20, true), goal(40, true)] });
for (const m of [40, 60, 80]) row('2-0 home', twoUp, m);

heading('Home down to ten men on 10\' (still 0-0)');
const tenMen = snapshot({ redCards: [red(10, true)] });
for (const m of [10, 30, 60, 85]) row('home a man down', tenMen, m);

heading('Chance creation, still 0-0 at 60\'');
row('home 2.5 xG vs away 0.2 xG', snapshot({ shots: [...xg(true, 2.5, 10, 60), ...xg(false, 0.2, 4, 60)] }), 60);
row('even, 1.0 xG each', snapshot({ shots: [...xg(true, 1.0, 8, 60), ...xg(false, 1.0, 8, 60)] }), 60);
row('away 2.5 xG vs home 0.2 xG', snapshot({ shots: [...xg(false, 2.5, 10, 60), ...xg(true, 0.2, 4, 60)] }), 60);

heading('Pre-match, baseline from the league table');
const even = flatTable();
row('two mid-table sides', snapshot({ table: even }), 0);

const moderate = flatTable();
moderate[0] = { teamId: 1, played: 20, goalsFor: 38, goalsAgainst: 22 };
moderate[1] = { teamId: 2, played: 20, goalsFor: 26, goalsAgainst: 30 };
row('good home side vs mid-table', snapshot({ table: moderate }), 0);

const extreme = flatTable();
extreme[0] = { teamId: 1, played: 20, goalsFor: 52, goalsAgainst: 16 };
extreme[1] = { teamId: 2, played: 20, goalsFor: 16, goalsAgainst: 44 };
const extremeSnapshot = snapshot({ table: extreme });
row('title side vs relegation side', extremeSnapshot, 0);

const baseline = prematchBaseline(extremeSnapshot);
console.log(
  `\n  Extreme fixture lambdas: home ${baseline.home.toFixed(2)}, away ${baseline.away.toFixed(2)} ` +
    `(capped at ${PARAMS.table.maxLambda})`,
);
console.log('\n  Compare against real in-play prices. Rough reference points:');
console.log('    kickoff, even teams .............. 45 / 26 / 29');
console.log("    1-0 home at 30' .................. 72-76 / 18-20 / 6-8");
console.log("    2-0 home at 40' .................. 92-94");
console.log('    strongest realistic home favourite  85-90\n');
