/**
 * The internal match representation. Everything downstream of `extract.ts`
 * speaks this and only this — the model never sees raw FotMob JSON.
 */

export interface TeamRef {
  id: number | null;
  name: string;
}

export interface GoalEvent {
  /** Minutes played, with added time folded in: 90 +3 is minute 93. */
  minute: number;
  /**
   * How much of that minute was added time, so the clock can be written the
   * way football writes it. Kept because the fold cannot be undone: 46 is 45+1
   * in first-half stoppage and plain 46 just after the restart.
   */
  added: number;
  isHome: boolean;
  /** Own goals still credit the scoring side; recorded for display only. */
  ownGoal: boolean;
  /**
   * Scorer, as FotMob names them. Display only — the model never reads it.
   * Null when the payload named nobody, which the UI has to survive.
   */
  scorer: string | null;
  /**
   * Assisting player, same terms. FotMob only records assists for some
   * competitions, so null here is ordinary rather than a sign of a problem.
   */
  assist: string | null;
}

export interface RedCardEvent {
  minute: number;
  /** See {@link GoalEvent.added}. */
  added: number;
  isHome: boolean;
}

export interface ShotEvent {
  minute: number;
  isHome: boolean;
  xg: number;
  isGoal: boolean;
}

/** A league-table row, used to build the pre-match baseline. */
export interface TableRow {
  teamId: number;
  played: number;
  goalsFor: number;
  goalsAgainst: number;
}

export interface MatchSnapshot {
  matchId: string;
  home: TeamRef;
  away: TeamRef;
  colors: { home: string; away: string };
  leagueId: number | null;
  leagueName: string | null;
  status: {
    started: boolean;
    finished: boolean;
    cancelled: boolean;
    /** Best-effort live clock in minutes; null pre-match or when unknown. */
    liveMinute: number | null;
  };
  goals: GoalEvent[];
  redCards: RedCardEvent[];
  shots: ShotEvent[];
  /** Null when the payload carried no usable standings. */
  table: TableRow[] | null;
  /**
   * Set when `table` was rebuilt from historical results as it stood on this
   * day (days since the epoch), rather than taken from FotMob's live table.
   *
   * FotMob's standings file carries no date, so for a past match it describes
   * a season that had not happened yet at kickoff. This records that we
   * substituted a point-in-time table, so the UI can say which it used.
   */
  tableAsOfDay: number | null;
  /**
   * Set when `table` is last season's rates carried forward rather than a
   * table of this season's results — the opening weeks, before the archive
   * covers the season in play. `tableAsOfDay` is still the kickoff day, so
   * this is what separates "the table on that date" from "no table yet".
   */
  tablePriorOnly: boolean;
  /**
   * Where the standings actually live. `matchDetails` ships only a stub for
   * `content.table` — `{ leagueId, url, … }` — pointing at a separate file.
   */
  standingsUrl: string | null;
  /** Minute the match is expected to (or did) end, including stoppage. */
  fullTime: number;
  /** Kickoff as epoch ms, used to estimate the clock when none is reported. */
  kickoffUtc: number | null;
  capturedAt: number;
  /** Field paths that could not be located, for diagnosing upstream renames. */
  warnings: string[];
}

/** The match situation at a single minute, reconstructed by `stateAt()`. */
export interface StateAtMinute {
  minute: number;
  homeGoals: number;
  awayGoals: number;
  /** Minutes at which each side went down to 10 (or fewer). */
  homeRedMinutes: number[];
  awayRedMinutes: number[];
  homeXg: number;
  awayXg: number;
}

export interface WinProb {
  home: number;
  draw: number;
  away: number;
}

export interface TimelinePoint extends WinProb {
  minute: number;
}
