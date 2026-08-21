import type { FotmobEvent, FotmobPayload, FotmobShot } from '../types/fotmob.ts';
import { PARAMS } from './params.ts';
import type { GoalEvent, MatchSnapshot, RedCardEvent, ShotEvent, TableRow } from './types.ts';

/**
 * Raw FotMob payload -> `MatchSnapshot`.
 *
 * This is the only module that knows FotMob's field names. It assumes nothing is
 * present, records a warning for anything it cannot find, and prefers structural
 * searches over hardcoded paths where the payload shape is known to move around.
 * When FotMob renames a field, this file is the only one that changes.
 */

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * When an event happened, both ways round.
 *
 * `minute` folds added time in (90 +3 becomes 93) because that is how much
 * football has been played, which is what the model needs. `added` is kept
 * alongside it because the fold is not reversible: minute 46 is 45+1 in first
 * half stoppage and plain 46 early in the second, and nothing downstream can
 * tell which without being told.
 */
function eventTiming(ev: FotmobEvent): { minute: number; added: number } | null {
  const base = num(ev.time) ?? num(ev.min);
  if (base === null) return null;
  const added = Math.max(0, num(ev.timeAdded) ?? num(ev.overloadTime) ?? 0);
  return { minute: base + added, added };
}

/** First of several candidate fields that actually holds a name. */
function firstName(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * The player an event belongs to.
 *
 * `nameStr` first because it is the string FotMob renders in its own match
 * facts — matching it keeps the popup reading like the page behind it. The rest
 * are fallbacks for payloads that carry only the structured player object.
 */
function eventPlayer(ev: FotmobEvent): string | null {
  return firstName(ev.nameStr, ev.player?.name, ev.fullName, ev.shortName);
}

/**
 * FotMob's assist fields arrive pre-phrased — "assist by K. De Bruyne" — while
 * the structured ones hold a bare name. Strip the phrasing so this field is
 * what it claims to be, and the one place that displays it can word it once.
 */
const ASSIST_PHRASING = /^assist(ed)?\s*(by)?\s*[:–—-]?\s*/i;

/**
 * Who set the goal up, where that is known.
 *
 * FotMob only collects assists for some competitions — the Premier League has
 * them, plenty of leagues do not — so nothing is warned about when this comes
 * back empty. It is absent data, not missing data.
 */
function eventAssist(ev: FotmobEvent): string | null {
  const raw = firstName(ev.assistStr, ev.assistInput, ev.assistantPlayer?.name, ev.assist?.name);
  return raw === null ? null : (firstName(raw.replace(ASSIST_PHRASING, '')) ?? null);
}

function shotMinute(shot: FotmobShot): number | null {
  const base = num(shot.min);
  if (base === null) return null;
  return base + (num(shot.minAdded) ?? 0);
}

/**
 * Collapse repeated entries for the same team, keeping the fullest record.
 *
 * Competitions with a group stage list a team more than once — MLS returns 60
 * rows for 30 teams, an overall table plus the two conferences. Left as-is,
 * a lookup could land on a partial record, and the league average would be
 * computed over a mix of scopes.
 */
function dedupeRows(rows: TableRow[]): TableRow[] {
  const byTeam = new Map<number, TableRow>();
  for (const row of rows) {
    const existing = byTeam.get(row.teamId);
    if (!existing || row.played > existing.played) byTeam.set(row.teamId, row);
  }
  return [...byTeam.values()];
}

/**
 * Parse FotMob's standings file.
 *
 * Not JSON: `content.table.url` points at a gzipped XML document of the form
 *
 *   <t name="Arsenal" id="9825" p="20" w="12" d="5" l="3" g="38" c="22"
 *      hp="10" hw="7" hd="2" hl="1" hg="21" hc="9" change="" />
 *
 * where `p` is played, `g` goals for and `c` goals conceded. The `h*` variants
 * are the home-only splits — unused for now, but they would support separate
 * home and away strengths rather than one blended figure.
 *
 * Hand-rolled rather than DOMParser: MV3 service workers do not have one.
 */
export function parseStandingsXml(xml: string): TableRow[] | null {
  const rows: TableRow[] = [];

  for (const match of xml.matchAll(/<t\s([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[attr[1]!] = attr[2]!;
    }

    const teamId = num(attrs['id']);
    const played = num(attrs['p']);
    const goalsFor = num(attrs['g']);
    const goalsAgainst = num(attrs['c']);
    if (teamId === null || played === null || goalsFor === null || goalsAgainst === null) continue;

    rows.push({ teamId, played, goalsFor, goalsAgainst });
  }

  const unique = dedupeRows(rows);
  return unique.length >= 4 ? unique : null;
}

/**
 * Read a standings document, whichever form it arrives in. XML is what FotMob
 * currently serves; JSON is accepted so a captured API response works too.
 */
export function parseStandings(body: string): TableRow[] | null {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) return parseStandingsXml(trimmed);
  try {
    return findTableRows(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Truncated JSON, for showing a small unrecognised value in a warning. */
function safeJson(value: unknown, limit: number): string {
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return '(unserialisable)';
  }
}

/**
 * Compact structural description of a node: which arrays it contains and what
 * keys their rows have.
 *
 * When a field rename breaks extraction, the useful question is "what is
 * actually there?" — and the answer has to reach whoever is looking at the
 * popup, not require a console session on the page.
 */
function describeShape(node: unknown, path = '', depth = 0, out: string[] = []): string[] {
  if (out.length >= 4 || depth > 6 || node === null || typeof node !== 'object') return out;

  if (Array.isArray(node)) {
    const first = node.find(isRecord);
    if (node.length >= 3 && first) {
      out.push(`${path || 'root'}[${node.length}]: ${Object.keys(first).slice(0, 12).join(',')}`);
    }
    for (let i = 0; i < Math.min(node.length, 3); i++) {
      describeShape(node[i], `${path}[${i}]`, depth + 1, out);
    }
    return out;
  }

  for (const [key, value] of Object.entries(node)) {
    describeShape(value, path ? `${path}.${key}` : key, depth + 1, out);
  }
  return out;
}

/**
 * Try to read one league-table row, accepting the several shapes FotMob has
 * used for goals scored and conceded.
 */
function parseTableRow(row: Record<string, unknown>): TableRow | null {
  const played = num(row['played']);
  const teamId = num(row['id']) ?? num((row['team'] as Record<string, unknown>)?.['id']);
  if (played === null || teamId === null || played <= 0) return null;

  // "45-20" in a single string, or "45:20" — both separators have been used.
  const scores = typeof row['scoresStr'] === 'string' ? row['scoresStr'] : '';
  const [gfRaw, gaRaw] = scores.split(/[-:]/);
  let goalsFor = num(gfRaw);
  let goalsAgainst = num(gaRaw);

  // ...or as separate fields under one of a few names.
  if (goalsFor === null || goalsAgainst === null) {
    goalsFor = num(row['goalsFor']) ?? num(row['scored']) ?? num(row['gf']);
    goalsAgainst = num(row['goalsAgainst']) ?? num(row['conceded']) ?? num(row['ga']);
  }

  if (goalsFor === null || goalsAgainst === null) return null;
  return { teamId, played, goalsFor, goalsAgainst };
}

/**
 * Walk the payload for arrays that look like league-table rows.
 *
 * `content.table` has been nested under `data.table.all`, `data.tables[0]…`, and
 * a few other arrangements over time, and on some pages the standings are not
 * under `content.table` at all. Matching on row shape and searching the whole
 * payload survives all of that — a four-row minimum keeps head-to-head and
 * form widgets from being mistaken for a division.
 */
export function findTableRows(payload: unknown): TableRow[] | null {
  let best: TableRow[] | null = null;
  const seen = new Set<unknown>();

  const visit = (node: unknown, depth: number) => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      const rows = node
        .filter(isRecord)
        .map(parseTableRow)
        .filter((r): r is TableRow => r !== null);

      const unique = dedupeRows(rows);
      if (unique.length >= 4 && (!best || unique.length > best.length)) best = unique;
      for (const child of node) visit(child, depth + 1);
      return;
    }

    for (const value of Object.values(node)) visit(value, depth + 1);
  };

  visit(payload, 0);
  return best;
}

/** Fall back to a structural search if the usual events path has moved. */
function findEvents(payload: FotmobPayload): FotmobEvent[] {
  const direct = payload.content?.matchFacts?.events?.events;
  if (Array.isArray(direct) && direct.length) return direct;

  let best: FotmobEvent[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const looksLikeEvents = node.filter(
        (e) => isRecord(e) && typeof e['type'] === 'string' && ('time' in e || 'min' in e),
      );
      if (looksLikeEvents.length > best.length) best = looksLikeEvents as FotmobEvent[];
      for (const child of node) visit(child, depth + 1);
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(payload, 0);
  return best;
}

/**
 * The live clock, in the same folded minutes the events use: "90+5'" is 95.
 *
 * Reading only the leading number leaves the clock stuck on 90 for the whole of
 * stoppage time, and that is the worst place to lose minutes: the game-state
 * adjustments sharpen as the match runs out, so a side protecting a lead would
 * be priced with most of five minutes still to survive right up to the whistle.
 */
function parseLiveMinute(payload: FotmobPayload): number | null {
  const short = payload.header?.status?.liveTime?.short;
  if (typeof short !== 'string') return null;
  const match = /(\d+)(?:\s*\+\s*(\d+))?/.exec(short);
  if (!match) return null;
  return Number(match[1]!) + Number(match[2] ?? 0);
}

export function extractSnapshot(payload: FotmobPayload, matchIdHint?: string): MatchSnapshot {
  const warnings: string[] = [];
  const general = payload.general ?? {};
  const headerTeams = payload.header?.teams ?? [];

  const matchId = String(general.matchId ?? matchIdHint ?? '');
  if (!matchId) warnings.push('general.matchId missing');

  const homeId = num(general.homeTeam?.id) ?? num(headerTeams[0]?.id);
  const awayId = num(general.awayTeam?.id) ?? num(headerTeams[1]?.id);
  const homeName = general.homeTeam?.name ?? headerTeams[0]?.name ?? 'Home';
  const awayName = general.awayTeam?.name ?? headerTeams[1]?.name ?? 'Away';
  if (homeId === null || awayId === null) warnings.push('team ids missing');

  const colorSet = general.teamColors?.darkMode ?? general.teamColors ?? {};
  const colors = {
    home: typeof colorSet.home === 'string' ? colorSet.home : '#3b82f6',
    away: typeof colorSet.away === 'string' ? colorSet.away : '#ef4444',
  };

  // `parentLeagueId` is the competition (Premier League); `leagueId` can be a
  // season- or stage-specific id that will not match our baseline table.
  const leagueId = num(general.parentLeagueId) ?? num(general.leagueId);
  const leagueName =
    (typeof general.parentLeagueName === 'string' ? general.parentLeagueName : null) ??
    (typeof general.leagueName === 'string' ? general.leagueName : null);

  // --- events -------------------------------------------------------------
  const rawEvents = findEvents(payload);
  if (!rawEvents.length) warnings.push('no events found (content.matchFacts.events.events)');

  const goals: GoalEvent[] = [];
  const redCards: RedCardEvent[] = [];
  let maxEventMinute = 0;

  for (const ev of rawEvents) {
    const timing = eventTiming(ev);
    if (timing === null) continue;
    const { minute, added } = timing;
    const type = String(ev.type ?? '').toLowerCase();
    const isHome = ev.isHome === true;
    maxEventMinute = Math.max(maxEventMinute, minute);

    if (type.includes('goal')) {
      goals.push({
        minute,
        added,
        isHome,
        ownGoal: ev.ownGoal === true || ev.isOwnGoal === true,
        scorer: eventPlayer(ev),
        assist: eventAssist(ev),
      });
    } else if (type.includes('card')) {
      const card = String(ev.card ?? ev.cardType ?? '').toLowerCase();
      if (card.includes('red')) redCards.push({ minute, added, isHome });
    }
  }

  goals.sort((a, b) => a.minute - b.minute);
  redCards.sort((a, b) => a.minute - b.minute);

  // Scorers are display-only, so a missing name degrades to the bare scoreline
  // rather than failing. Every goal missing one is a different matter — that is
  // a rename, and the popup should say so.
  if (goals.length && goals.every((g) => g.scorer === null)) {
    warnings.push('goal events carry no player name (nameStr/player.name)');
  }

  // --- own-goal attribution self-check ------------------------------------
  // FotMob's `isHome` on a goal event is ambiguous for own goals: it can mean
  // the scoring player's side rather than the side the goal counts for. Rather
  // than guess, check the derived score against the scoreline the payload
  // reports, and flip own goals only if that fixes the mismatch.
  const reportedHome = num(headerTeams[0]?.score) ?? num(general.homeTeam?.score);
  const reportedAway = num(headerTeams[1]?.score) ?? num(general.awayTeam?.score);
  if (reportedHome !== null && reportedAway !== null && goals.length) {
    const tally = (list: GoalEvent[]) => ({
      home: list.filter((g) => g.isHome).length,
      away: list.filter((g) => !g.isHome).length,
    });
    const asIs = tally(goals);
    if (asIs.home !== reportedHome || asIs.away !== reportedAway) {
      const flipped = goals.map((g) => (g.ownGoal ? { ...g, isHome: !g.isHome } : g));
      const after = tally(flipped);
      if (after.home === reportedHome && after.away === reportedAway) {
        goals.splice(0, goals.length, ...flipped);
      } else {
        warnings.push(
          `derived score ${asIs.home}-${asIs.away} != reported ${reportedHome}-${reportedAway}`,
        );
      }
    }
  }

  // --- shotmap ------------------------------------------------------------
  const rawShots = payload.content?.shotmap?.shots ?? [];
  if (!Array.isArray(rawShots) || rawShots.length === 0) {
    warnings.push('no shotmap (content.shotmap.shots) — model will run on the prior alone');
  }
  const shots: ShotEvent[] = [];
  for (const shot of Array.isArray(rawShots) ? rawShots : []) {
    const minute = shotMinute(shot);
    const xg = num(shot.expectedGoals);
    const teamId = num(shot.teamId);
    if (minute === null || xg === null || teamId === null) continue;
    shots.push({
      minute,
      isHome: teamId === homeId,
      xg,
      isGoal: String(shot.eventType ?? '').toLowerCase() === 'goal',
    });
    maxEventMinute = Math.max(maxEventMinute, minute);
  }
  shots.sort((a, b) => a.minute - b.minute);

  // --- status -------------------------------------------------------------
  const started = general.started === true || payload.header?.status?.started === true;
  const finished = general.finished === true || payload.header?.status?.finished === true;
  const cancelled = payload.header?.status?.cancelled === true;
  const liveMinute = finished ? null : parseLiveMinute(payload);

  // Search the whole payload, not just `content.table`: that key can exist as
  // an empty wrapper while the standings live elsewhere, and scoping the search
  // to it would then find nothing and stop looking.
  const kickoffRaw = general.matchTimeUTCDate ?? general.matchTimeUTC;
  const kickoffParsed = typeof kickoffRaw === 'string' ? Date.parse(kickoffRaw) : NaN;
  const kickoffUtc = Number.isFinite(kickoffParsed) ? kickoffParsed : null;

  const table = findTableRows(payload);
  // The stub carries a pointer to the real standings file; the worker fetches
  // it, since nothing on the page necessarily requests it.
  const rawTable = payload.content?.table;
  const stubUrl = isRecord(rawTable) && typeof rawTable['url'] === 'string' ? rawTable['url'] : null;
  const standingsUrl = stubUrl && /^https:\/\/[\w.-]*fotmob\.com\//.test(stubUrl) ? stubUrl : null;

  if (!table) {
    if (standingsUrl) {
      warnings.push('standings not loaded yet — fetching them separately');
    } else if (rawTable != null) {
      // Report what is actually in there, so a rename can be fixed from the
      // popup alone rather than needing a console session on the page.
      const shape = describeShape(rawTable).join(' | ').slice(0, 400);
      warnings.push(
        shape
          ? `content.table rows not recognised — found: ${shape}`
          : // No row arrays at all: the key is a stub and FotMob loads
            // standings separately. Show the stub so that is unambiguous.
            `content.table holds no standings (stub: ${safeJson(rawTable, 200)}) — ` +
              'waiting to capture them from the page',
      );
    } else {
      warnings.push('no standings in payload — falling back to league-average baseline');
    }
  }

  return {
    matchId,
    home: { id: homeId, name: homeName },
    away: { id: awayId, name: awayName },
    colors,
    leagueId,
    leagueName,
    status: { started, finished, cancelled, liveMinute },
    goals,
    redCards,
    shots,
    table,
    // Extraction only reports what the payload said. Substituting a
    // point-in-time table is the worker's job, since it needs the bundled
    // results file.
    tableAsOfDay: null,
    tablePriorOnly: false,
    standingsUrl,
    fullTime: Math.max(PARAMS.expectedFullTime, Math.ceil(maxEventMinute)),
    kickoffUtc,
    capturedAt: Date.now(),
    warnings,
  };
}
