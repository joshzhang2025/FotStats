import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractSnapshot, parseStandings, parseStandingsXml } from '../src/model/extract.ts';
import type { FotmobPayload } from '../src/types/fotmob.ts';
import { matchIdFromApiUrl, matchIdFromPageUrl } from '../src/shared/protocol.ts';

/**
 * These exercise the adapter's logic against a synthetic payload shaped like
 * FotMob's. They cannot prove the field names are still correct upstream — only
 * a captured fixture does that — but they do prove the parsing, the own-goal
 * reconciliation, and the structural table search behave as intended.
 */

function payload(overrides: Partial<FotmobPayload> = {}): FotmobPayload {
  return {
    general: {
      matchId: 4193843,
      started: true,
      finished: true,
      parentLeagueId: 47,
      parentLeagueName: 'Premier League',
      homeTeam: { id: 8650, name: 'Liverpool' },
      awayTeam: { id: 8456, name: 'Manchester City' },
      teamColors: { darkMode: { home: '#d00027', away: '#6cabdd' } },
    },
    header: {
      teams: [
        { id: 8650, name: 'Liverpool', score: 2 },
        { id: 8456, name: 'Manchester City', score: 1 },
      ],
      status: { started: true, finished: true },
    },
    content: {
      matchFacts: {
        events: {
          events: [
            { type: 'Goal', time: 23, isHome: true, nameStr: 'M. Salah' },
            { type: 'Card', time: 40, isHome: false, card: 'Yellow' },
            { type: 'Goal', time: 58, isHome: false, nameStr: 'E. Haaland' },
            { type: 'Card', time: 72, isHome: false, card: 'Red' },
            { type: 'Goal', time: 90, timeAdded: 3, isHome: true, nameStr: 'D. Núñez' },
          ],
        },
      },
      shotmap: {
        shots: [
          { min: 23, teamId: 8650, expectedGoals: 0.42, eventType: 'Goal' },
          { min: 31, teamId: 8456, expectedGoals: 0.08, eventType: 'AttemptSaved' },
          { min: 58, teamId: 8456, expectedGoals: 0.55, eventType: 'Goal' },
          { min: 90, minAdded: 3, teamId: 8650, expectedGoals: 0.71, eventType: 'Goal' },
        ],
      },
    },
    ...overrides,
  };
}

describe('extractSnapshot', () => {
  it('reads teams, colours and competition', () => {
    const s = extractSnapshot(payload());
    assert.equal(s.matchId, '4193843');
    assert.equal(s.home.name, 'Liverpool');
    assert.equal(s.away.id, 8456);
    assert.equal(s.colors.home, '#d00027');
    assert.equal(s.leagueId, 47);
  });

  it('folds added time into the minute', () => {
    const s = extractSnapshot(payload());
    assert.deepEqual(s.goals.map((g) => g.minute), [23, 58, 93]);
    assert.equal(s.shots.at(-1)!.minute, 93);
  });

  it('reads the scorer, preferring the string FotMob itself renders', () => {
    const p = payload();
    p.content!.matchFacts!.events!.events = [
      { type: 'Goal', time: 23, isHome: true, nameStr: 'M. Salah', fullName: 'Mohamed Salah' },
      { type: 'Goal', time: 58, isHome: false, player: { id: 7, name: 'Erling Haaland' } },
      { type: 'Goal', time: 90, timeAdded: 3, isHome: true, fullName: 'Darwin Núñez' },
    ];
    const s = extractSnapshot(p);
    assert.deepEqual(s.goals.map((g) => g.scorer), ['M. Salah', 'Erling Haaland', 'Darwin Núñez']);
    assert.equal(s.warnings.filter((w) => w.includes('player name')).length, 0);
  });

  it('reads the assist where the competition has one', () => {
    const p = payload();
    p.content!.matchFacts!.events!.events = [
      // FotMob phrases this field itself; only the name belongs in the model.
      { type: 'Goal', time: 23, isHome: true, nameStr: 'M. Salah', assistStr: 'assist by T. Alexander-Arnold' },
      { type: 'Goal', time: 58, isHome: false, nameStr: 'E. Haaland', assistantPlayer: { name: 'K. De Bruyne' } },
      // Assists are only collected for some competitions: absent, not missing.
      { type: 'Goal', time: 90, timeAdded: 3, isHome: true, nameStr: 'D. Núñez' },
    ];
    const s = extractSnapshot(p);
    assert.deepEqual(s.goals.map((g) => g.assist), [
      'T. Alexander-Arnold',
      'K. De Bruyne',
      null,
    ]);
    assert.deepEqual(s.warnings.filter((w) => w.includes('assist')), [], 'no assist is normal');
  });

  it('strips whichever wording the assist field arrived with', () => {
    const p = payload();
    p.content!.matchFacts!.events!.events = [
      { type: 'Goal', time: 23, isHome: true, assistStr: 'Assisted by M. Ødegaard' },
      { type: 'Goal', time: 58, isHome: false, assistStr: 'assist: K. De Bruyne' },
      { type: 'Goal', time: 90, timeAdded: 3, isHome: true, assistStr: 'B. Saka' },
    ];
    assert.deepEqual(extractSnapshot(p).goals.map((g) => g.assist), [
      'M. Ødegaard',
      'K. De Bruyne',
      'B. Saka',
    ]);
  });

  it('leaves the scorer null and warns when no goal names anybody', () => {
    const p = payload();
    p.content!.matchFacts!.events!.events = [
      { type: 'Goal', time: 23, isHome: true },
      { type: 'Goal', time: 58, isHome: false },
      { type: 'Goal', time: 90, timeAdded: 3, isHome: true },
    ];
    const s = extractSnapshot(p);
    assert.deepEqual(s.goals.map((g) => g.scorer), [null, null, null]);
    // Display-only, so extraction still succeeds — but it is a rename signal.
    assert.ok(s.warnings.some((w) => w.includes('player name')), s.warnings.join('; '));
  });

  it('keeps red cards and discards yellows', () => {
    const s = extractSnapshot(payload());
    assert.equal(s.redCards.length, 1);
    assert.deepEqual(s.redCards[0], { minute: 72, isHome: false });
  });

  it('attributes shots to the right side by team id', () => {
    const s = extractSnapshot(payload());
    const homeXg = s.shots.filter((x) => x.isHome).reduce((sum, x) => sum + x.xg, 0);
    assert.ok(Math.abs(homeXg - 1.13) < 1e-9, `home xG was ${homeXg}`);
  });

  it('extends full time past 90 when the match ran long', () => {
    assert.equal(extractSnapshot(payload()).fullTime, 95);
  });

  it('reports a clean payload with no warnings', () => {
    const s = extractSnapshot(payload());
    // No table is present in the fixture, so exactly one warning is expected.
    assert.deepEqual(
      s.warnings.filter((w) => !w.includes('standings')),
      [],
    );
  });
});

describe('own-goal reconciliation', () => {
  it('flips own-goal attribution when that reconciles the scoreline', () => {
    const p = payload();
    // Same match, but the winner came via an own goal recorded against the
    // scoring player's own side.
    p.content!.matchFacts!.events!.events = [
      { type: 'Goal', time: 23, isHome: true },
      { type: 'Goal', time: 58, isHome: false },
      { type: 'Goal', time: 80, isHome: false, ownGoal: true },
    ];
    const s = extractSnapshot(p);
    assert.equal(s.goals.filter((g) => g.isHome).length, 2, 'own goal should count for Liverpool');
    assert.equal(s.warnings.filter((w) => w.includes('derived score')).length, 0);
  });

  it('warns rather than guessing when the scoreline cannot be reconciled', () => {
    const p = payload();
    p.content!.matchFacts!.events!.events = [{ type: 'Goal', time: 23, isHome: true }];
    const s = extractSnapshot(p);
    assert.ok(s.warnings.some((w) => w.includes('derived score')), s.warnings.join('; '));
  });
});

describe('table discovery', () => {
  it('finds the standings and ignores small lookalike arrays', () => {
    const p = payload();
    p.content!.table = {
      data: {
        table: {
          all: Array.from({ length: 20 }, (_, i) => ({
            id: 8650 + i,
            name: `Team ${i}`,
            played: 20,
            scoresStr: `${30 + i}-${25 - i}`,
          })),
        },
      },
      // A two-row head-to-head widget must not be mistaken for a league table.
      h2h: [
        { id: 8650, played: 2, scoresStr: '3-1' },
        { id: 8456, played: 2, scoresStr: '1-3' },
      ],
    };
    const s = extractSnapshot(p);
    assert.equal(s.table?.length, 20);
    assert.deepEqual(s.table?.[0], { teamId: 8650, played: 20, goalsFor: 30, goalsAgainst: 25 });
  });

  it('warns when there is no table at all', () => {
    const s = extractSnapshot(payload());
    assert.ok(s.warnings.some((w) => w.includes('standings')));
  });

  it('reports the actual row shape when standings are present but unreadable', () => {
    // The warning has to carry enough to fix the parser from the popup alone.
    const p = payload();
    p.content!.table = {
      data: {
        table: {
          all: Array.from({ length: 20 }, (_, i) => ({
            teamIdentifier: 8650 + i,
            matchesPlayed: 20,
            goalsScored: 30,
          })),
        },
      },
    };
    const s = extractSnapshot(p);
    const warning = s.warnings.find((w) => w.includes('not recognised'));
    assert.ok(warning, s.warnings.join('; '));
    assert.ok(warning!.includes('data.table.all[20]'), warning);
    assert.ok(warning!.includes('teamIdentifier'), warning);
    assert.ok(warning!.includes('matchesPlayed'), warning);
  });

  it('accepts a colon separator in scoresStr', () => {
    const p = payload();
    p.content!.table = {
      all: Array.from({ length: 20 }, (_, i) => ({ id: 8650 + i, played: 20, scoresStr: '30:25' })),
    };
    const s = extractSnapshot(p);
    assert.deepEqual(s.table?.[0], { teamId: 8650, played: 20, goalsFor: 30, goalsAgainst: 25 });
  });

  it('reads standings given as separate goals-for and goals-against fields', () => {
    const p = payload();
    p.content!.table = {
      all: Array.from({ length: 20 }, (_, i) => ({
        id: 8650 + i,
        played: 20,
        goalsFor: 30 + i,
        goalsAgainst: 25 - i,
      })),
    };
    const s = extractSnapshot(p);
    assert.equal(s.table?.length, 20);
    assert.deepEqual(s.table?.[0], { teamId: 8650, played: 20, goalsFor: 30, goalsAgainst: 25 });
  });

  it('finds standings even when they sit outside content.table', () => {
    const p = payload() as Record<string, unknown>;
    p['standings'] = {
      grouped: [
        {
          rows: Array.from({ length: 20 }, (_, i) => ({
            id: 8650 + i,
            played: 20,
            scoresStr: '30-25',
          })),
        },
      ],
    };
    const s = extractSnapshot(p as FotmobPayload);
    assert.equal(s.table?.length, 20);
  });
});

describe('standings file', () => {
  // Exactly the format served at content.table.url, mid-season.
  const xml = `<table name="Premier League" ccode="ENG" lid="47" wp="1">
  <t name="Arsenal" id="9825" p="20" w="12" d="5" l="3" g="38" c="22" hp="10" hw="7" hd="2" hl="1" hg="21" hc="9" change="" />
  <t name="Brighton &amp; Hove Albion" id="10204" p="20" w="8" d="6" l="6" g="30" c="28" hp="10" hw="5" hd="3" hl="2" hg="17" hc="12" change="" />
  <t name="Chelsea" id="8455" p="20" w="10" d="4" l="6" g="33" c="25" hp="10" hw="6" hd="2" hl="2" hg="18" hc="11" change="" />
  <t name="Everton" id="8668" p="20" w="5" d="7" l="8" g="19" c="27" hp="10" hw="3" hd="4" hl="3" hg="11" hc="12" change="" />
  <t name="Fulham" id="9879" p="20" w="7" d="5" l="8" g="24" c="26" hp="10" hw="4" hd="3" hl="3" hg="14" hc="12" change="" />
</table>`;

  it('reads played, goals for and goals against from the attributes', () => {
    const rows = parseStandingsXml(xml);
    assert.equal(rows?.length, 5);
    assert.deepEqual(rows?.[0], { teamId: 9825, played: 20, goalsFor: 38, goalsAgainst: 22 });
  });

  it('is not confused by escaped entities in team names', () => {
    assert.deepEqual(parseStandingsXml(xml)?.[1], {
      teamId: 10204,
      played: 20,
      goalsFor: 30,
      goalsAgainst: 28,
    });
  });

  it('reads a preseason table with every figure at zero', () => {
    const preseason = `<table name="Premier League" lid="47">
  <t name="Arsenal" id="9825" p="0" w="0" d="0" l="0" g="0" c="0" change="" />
  <t name="Chelsea" id="8455" p="0" w="0" d="0" l="0" g="0" c="0" change="" />
  <t name="Everton" id="8668" p="0" w="0" d="0" l="0" g="0" c="0" change="" />
  <t name="Fulham" id="9879" p="0" w="0" d="0" l="0" g="0" c="0" change="" />
</table>`;
    const rows = parseStandingsXml(preseason);
    assert.equal(rows?.length, 4, 'a zeroed table is still a valid table');
    assert.equal(rows?.[0]!.played, 0);
  });

  it('collapses a team listed in more than one table, keeping the fullest row', () => {
    // MLS returns 60 rows for 30 teams — an overall table plus conferences.
    const grouped = `<table name="MLS" lid="130">
  <t name="A" id="1" p="34" g="50" c="30" /><t name="B" id="2" p="34" g="45" c="35" />
  <t name="C" id="3" p="34" g="40" c="40" /><t name="D" id="4" p="34" g="35" c="45" />
  <t name="A" id="1" p="17" g="25" c="15" /><t name="B" id="2" p="17" g="22" c="18" />
</table>`;
    const rows = parseStandingsXml(grouped);
    assert.equal(rows?.length, 4, 'one row per team');
    assert.deepEqual(rows?.find((r) => r.teamId === 1), {
      teamId: 1,
      played: 34,
      goalsFor: 50,
      goalsAgainst: 30,
    });
  });

  it('rejects a document with too few rows to be a division', () => {
    assert.equal(parseStandingsXml('<table><t name="A" id="1" p="1" g="1" c="1"/></table>'), null);
    assert.equal(parseStandingsXml('not xml at all'), null);
  });

  it('dispatches on document type, accepting XML or JSON', () => {
    assert.equal(parseStandings(xml)?.length, 5);
    assert.equal(
      parseStandings(
        JSON.stringify({
          all: Array.from({ length: 20 }, (_, i) => ({ id: i, played: 20, scoresStr: '30-25' })),
        }),
      )?.length,
      20,
    );
    assert.equal(parseStandings('garbage'), null);
  });
});

describe('standings pointer', () => {
  it('records the url the stub points at', () => {
    const p = payload();
    p.content!.table = {
      leagueId: '47',
      url: 'https://data.fotmob.com/tables.ext.47.fot.gz',
      teams: [10252, 8586],
      parentLeagueId: 47,
    };
    const s = extractSnapshot(p);
    assert.equal(s.standingsUrl, 'https://data.fotmob.com/tables.ext.47.fot.gz');
    assert.ok(s.warnings.some((w) => w.includes('fetching them separately')));
  });

  it('refuses a pointer to somewhere other than fotmob', () => {
    const p = payload();
    p.content!.table = { url: 'https://evil.example.com/tables.gz' };
    assert.equal(extractSnapshot(p).standingsUrl, null);
  });
});

describe('degraded payloads', () => {
  it('survives an empty object', () => {
    const s = extractSnapshot({} as FotmobPayload, '123');
    assert.equal(s.matchId, '123');
    assert.equal(s.goals.length, 0);
    assert.ok(s.warnings.length >= 2);
  });

  it('falls back to a structural event search when the usual path moves', () => {
    const s = extractSnapshot({
      general: { matchId: 1, homeTeam: { id: 1 }, awayTeam: { id: 2 } },
      content: {
        // events relocated under an unexpected key
        matchFacts: { infoBox: {} },
        somewhereElse: { list: [{ type: 'Goal', time: 10, isHome: true }] },
      },
    } as FotmobPayload);
    assert.equal(s.goals.length, 1);
    assert.equal(s.goals[0]!.minute, 10);
  });

  it('warns but still produces a snapshot with no shotmap', () => {
    const p = payload();
    p.content!.shotmap = { shots: [] };
    const s = extractSnapshot(p);
    assert.equal(s.shots.length, 0);
    assert.ok(s.warnings.some((w) => w.includes('shotmap')));
  });

  it('reads a live clock from the header', () => {
    const p = payload();
    p.general!.finished = false;
    p.header!.status = { started: true, finished: false, liveTime: { short: "67'" } };
    const s = extractSnapshot(p);
    assert.equal(s.status.liveMinute, 67);
  });
});

describe('url parsing', () => {
  it('pulls a match id from a localised match page url', () => {
    assert.equal(
      matchIdFromPageUrl('https://www.fotmob.com/matches/liverpool-vs-man-city/2ovmp3'),
      '2ovmp3',
    );
    assert.equal(
      matchIdFromPageUrl('https://www.fotmob.com/ru/matches/eupen-vs-francs-borains/2g8x57h'),
      '2g8x57h',
    );
  });

  it('returns null off a match page', () => {
    assert.equal(matchIdFromPageUrl('https://www.fotmob.com/leagues/47/overview'), null);
    assert.equal(matchIdFromPageUrl('https://example.com/matches/a/b/c'), null);
  });

  it('reads the id from an api url', () => {
    assert.equal(
      matchIdFromApiUrl('https://www.fotmob.com/api/matchDetails?matchId=4193843'),
      '4193843',
    );
  });
});
