/**
 * Build `public/data/pl-history.json` from football-data.co.uk.
 *
 *   node scripts/fetch-history.ts [--from 2014] [--to 2025]
 *
 * `--from`/`--to` are the years a season *starts* in, so 2014 means 2014/15.
 * Defaults to the last 12 completed-or-current seasons.
 *
 * Run this by hand when you want fresher data; it is deliberately not part of
 * `npm run build`, because a build should not depend on a third-party host
 * being up. The generated file is committed.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { canonicalTeam } from '../src/model/teams.ts';
import { toDayIndex, type History, type HistorySeason } from '../src/model/history.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'public/data/pl-history.json');

/** FotMob's league id for the Premier League — matches `LEAGUE_BASELINES`. */
const PREMIER_LEAGUE_ID = 47;
/** football-data.co.uk's division code for the Premier League. */
const DIVISION = 'E0';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const now = new Date();
// A season is labelled by the year it starts in; before August we are still
// inside the season that started last calendar year.
const currentSeasonStart = now.getUTCFullYear() - (now.getUTCMonth() < 7 ? 1 : 0);
const toYear = Number(arg('to') ?? currentSeasonStart);
const fromYear = Number(arg('from') ?? toYear - 11);

/** 2025 -> "2526", the directory football-data uses. */
const seasonCode = (startYear: number): string =>
  `${String(startYear % 100).padStart(2, '0')}${String((startYear + 1) % 100).padStart(2, '0')}`;

/**
 * Minimal CSV reader. football-data does not normally quote fields, but
 * referee and team names are free text, so quotes are handled rather than
 * assumed away.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }

  fields.push(field);
  return fields;
}

/**
 * `dd/mm/yy` and `dd/mm/yyyy` both appear — the column layout changed over the
 * years. Two-digit years split at 90 because the data starts in 1993.
 */
function parseDate(value: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value.trim());
  if (!m) return null;

  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (m[3]!.length === 2) year += year >= 90 ? 1900 : 2000;

  const ms = Date.UTC(year, month - 1, day);
  return Number.isFinite(ms) ? ms : null;
}

async function fetchSeason(startYear: number): Promise<HistorySeason | null> {
  const code = seasonCode(startYear);
  const url = `https://www.football-data.co.uk/mmz4281/${code}/${DIVISION}.csv`;

  const response = await fetch(url);
  if (!response.ok) {
    console.warn(`  ${code}: HTTP ${response.status} — skipped`);
    return null;
  }

  // The files carry a UTF-8 BOM, which would otherwise ride along on the first
  // header name and break the `Div` lookup.
  const raw = await response.text();
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    console.warn(`  ${code}: empty — skipped`);
    return null;
  }

  // Look columns up by name. Older seasons have fewer columns and no `Time`,
  // so anything positional would silently read the wrong field.
  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iDiv = col('Div');
  const iDate = col('Date');
  const iHome = col('HomeTeam');
  const iAway = col('AwayTeam');
  const iHg = col('FTHG');
  const iAg = col('FTAG');

  if ([iDate, iHome, iAway, iHg, iAg].some((i) => i < 0)) {
    console.warn(`  ${code}: missing required columns — skipped`);
    return null;
  }

  // Confirm we were actually served the division we asked for. For a season
  // that has not started, the host 301s E0.csv to whichever division file does
  // exist — 2026/27 currently redirects to EC (National League). `fetch`
  // follows that silently, and a redirect to E1 would be undetectable by club
  // name alone, since Championship sides share the Premier League's alias map.
  const served = iDiv >= 0 ? (splitCsvLine(lines[1]!)[iDiv] ?? '').trim() : '';
  if (served !== DIVISION) {
    console.warn(`  ${code}: served "${served || 'unknown'}", not ${DIVISION} — skipped`);
    return null;
  }

  const teams: string[] = [];
  const teamIndex = (key: string): number => {
    const existing = teams.indexOf(key);
    if (existing >= 0) return existing;
    teams.push(key);
    return teams.length - 1;
  };

  const results: HistorySeason['results'] = [];
  const unknown = new Set<string>();
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const rawHome = (f[iHome] ?? '').trim();
    const rawAway = (f[iAway] ?? '').trim();
    const ms = parseDate(f[iDate] ?? '');
    const hg = Number(f[iHg]);
    const ag = Number(f[iAg]);

    // Abandoned and not-yet-played fixtures appear with blank scores.
    if (!rawHome || !rawAway || ms === null || !Number.isFinite(hg) || !Number.isFinite(ag)) {
      skipped++;
      continue;
    }

    const home = canonicalTeam(rawHome);
    const away = canonicalTeam(rawAway);
    if (!home) unknown.add(rawHome);
    if (!away) unknown.add(rawAway);
    if (!home || !away) continue;

    results.push([toDayIndex(ms), teamIndex(home), teamIndex(away), hg, ag]);
  }

  if (unknown.size) {
    throw new Error(
      `${code}: club names not in src/model/teams.ts: ${[...unknown].sort().join(', ')}\n` +
        'Add them to ALIASES — an unmapped club would silently lose its table.',
    );
  }

  results.sort((a, b) => a[0] - b[0]);
  console.log(
    `  ${code}: ${results.length} matches, ${teams.length} clubs` +
      (skipped ? ` (${skipped} rows without a score)` : ''),
  );

  return { code, teams, results };
}

console.log(`Fetching ${DIVISION} seasons ${fromYear}/${fromYear + 1} … ${toYear}/${toYear + 1}`);

const seasons: HistorySeason[] = [];
for (let year = fromYear; year <= toYear; year++) {
  const season = await fetchSeason(year);
  if (season) seasons.push(season);
}

if (!seasons.length) throw new Error('No seasons fetched — refusing to write an empty history.');

const history: History = {
  generatedAt: Date.now(),
  leagueId: PREMIER_LEAGUE_ID,
  seasons,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(history));

const bytes = Buffer.byteLength(JSON.stringify(history));
console.log(
  `\nWrote ${OUT}\n` +
    `  ${seasons.length} seasons, ` +
    `${seasons.reduce((n, s) => n + s.results.length, 0)} matches, ` +
    `${(bytes / 1024).toFixed(0)} KB`,
);
