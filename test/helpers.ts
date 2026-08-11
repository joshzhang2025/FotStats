import { PARAMS } from '../src/model/params.ts';
import type { GoalEvent, MatchSnapshot, RedCardEvent, ShotEvent } from '../src/model/types.ts';

/** Build a snapshot for tests without going through a real FotMob payload. */
export function makeSnapshot(overrides: Partial<MatchSnapshot> = {}): MatchSnapshot {
  return {
    matchId: 'test',
    home: { id: 1, name: 'Home' },
    away: { id: 2, name: 'Away' },
    colors: { home: '#3b82f6', away: '#ef4444' },
    leagueId: 47,
    leagueName: 'Premier League',
    status: { started: true, finished: true, cancelled: false, liveMinute: null },
    goals: [],
    redCards: [],
    shots: [],
    table: null,
    tableAsOfDay: null,
    standingsUrl: null,
    fullTime: PARAMS.expectedFullTime,
    kickoffUtc: null,
    capturedAt: 0,
    warnings: [],
    ...overrides,
  };
}

export const goal = (
  minute: number,
  isHome: boolean,
  scorer: string | null = null,
  assist: string | null = null,
): GoalEvent => ({
  minute,
  isHome,
  ownGoal: false,
  scorer,
  assist,
});

export const red = (minute: number, isHome: boolean): RedCardEvent => ({ minute, isHome });

export const shot = (minute: number, isHome: boolean, xg: number): ShotEvent => ({
  minute,
  isHome,
  xg,
  isGoal: false,
});

/** Spread `total` xG evenly across `count` shots, so tests can set a match tone. */
export function shotSeries(isHome: boolean, total: number, count = 10, until = 90): ShotEvent[] {
  const shots: ShotEvent[] = [];
  for (let i = 1; i <= count; i++) {
    shots.push(shot(Math.round((i / count) * until), isHome, total / count));
  }
  return shots;
}
