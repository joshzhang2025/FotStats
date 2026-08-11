/**
 * Loose shapes for the parts of FotMob's `matchDetails` payload we read.
 *
 * These are deliberately permissive: FotMob renames and reshapes fields without
 * notice, and a strict interface here would turn a cosmetic upstream change into
 * a compile error. Everything is optional; `src/model/extract.ts` is the single
 * place allowed to reach into these shapes, and it defends against each field
 * being absent. Nothing else in the codebase may import this file.
 */

export interface FotmobTeam {
  id?: number | string;
  name?: string;
  score?: number;
}

export interface FotmobEvent {
  type?: string;
  /** Some payloads use `time`, others `min`; both are minutes-from-kickoff. */
  time?: number;
  min?: number;
  /** Added-time offset, e.g. time=45 timeAdded=2 -> 45+2. */
  timeAdded?: number;
  overloadTime?: number;
  isHome?: boolean;
  card?: string;
  cardType?: string;
  ownGoal?: boolean;
  isOwnGoal?: boolean;
  /** The name FotMob itself renders in match facts, e.g. "B. Saka". */
  nameStr?: string;
  fullName?: string;
  shortName?: string;
  player?: { id?: number | string; name?: string };
  /** Only populated for competitions FotMob collects assists for. */
  assistStr?: string;
  assistInput?: string;
  assistantPlayer?: { id?: number | string; name?: string };
  assist?: { name?: string };
}

export interface FotmobShot {
  min?: number;
  minAdded?: number;
  teamId?: number | string;
  expectedGoals?: number | null;
  expectedGoalsOnTarget?: number | null;
  eventType?: string;
  isBlocked?: boolean;
  isOnTarget?: boolean;
  situation?: string;
  isOwnGoal?: boolean;
}

export interface FotmobTableRow {
  id?: number | string;
  name?: string;
  played?: number;
  scoresStr?: string;
  goalConDiff?: number;
  pts?: number;
}

export interface FotmobPayload {
  general?: {
    matchId?: number | string;
    started?: boolean;
    finished?: boolean;
    matchTimeUTC?: string;
    matchTimeUTCDate?: string;
    leagueId?: number | string;
    leagueName?: string;
    parentLeagueId?: number | string;
    parentLeagueName?: string;
    homeTeam?: FotmobTeam;
    awayTeam?: FotmobTeam;
    teamColors?: {
      darkMode?: { home?: string; away?: string };
      lightMode?: { home?: string; away?: string };
      home?: string;
      away?: string;
    };
  };
  header?: {
    teams?: Array<{ id?: number | string; name?: string; score?: number; imageUrl?: string }>;
    status?: { started?: boolean; finished?: boolean; cancelled?: boolean; liveTime?: { short?: string; long?: string } };
  };
  content?: {
    matchFacts?: {
      matchStatus?: unknown;
      events?: { events?: FotmobEvent[] };
      infoBox?: Record<string, unknown>;
      momentum?: { main?: { data?: Array<{ minute?: number; value?: number }> } };
    };
    shotmap?: { shots?: FotmobShot[] };
    table?: unknown;
    stats?: unknown;
  };
  [key: string]: unknown;
}
