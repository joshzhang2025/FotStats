/**
 * Render a 1280x800 Chrome Web Store screenshot from the real card.
 *
 * Uses `renderCard` and the shipped stylesheets rather than a mockup, so the
 * listing image cannot drift from what the extension actually draws.
 *
 *   npm run store-shot
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MatchSnapshot } from '../src/model/types.ts';
import { PARAMS } from '../src/model/params.ts';
import { buildView, renderCard } from '../src/view/card.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const goal = (
  minute: number,
  isHome: boolean,
  scorer: string | null = null,
  assist: string | null = null,
  added = 0,
) => ({ minute, added, isHome, ownGoal: false, scorer, assist });

// A match with somewhere to travel, so the timeline shows what it is for.
const snapshot: MatchSnapshot = {
  matchId: 'store',
  home: { id: 1, name: 'Liverpool' },
  away: { id: 2, name: 'Man City' },
  colors: { home: '#d00027', away: '#6cabdd' },
  leagueId: 47,
  leagueName: 'Premier League',
  status: { started: true, finished: true, cancelled: false, liveMinute: null },
  goals: [
    goal(8, false, 'E. Haaland', 'K. De Bruyne'),
    goal(55, true, 'M. Salah', 'T. Alexander-Arnold'),
    goal(92, true, 'D. Núñez', null, 2),
  ],
  redCards: [{ minute: 66, added: 0, isHome: false }],
  shots: [
    { minute: 6, isHome: false, xg: 0.62, isGoal: true },
    { minute: 14, isHome: true, xg: 0.09, isGoal: false },
    { minute: 27, isHome: false, xg: 0.11, isGoal: false },
    { minute: 38, isHome: true, xg: 0.24, isGoal: false },
    { minute: 53, isHome: true, xg: 0.44, isGoal: true },
    { minute: 61, isHome: true, xg: 0.17, isGoal: false },
    { minute: 74, isHome: true, xg: 0.31, isGoal: false },
    { minute: 82, isHome: false, xg: 0.08, isGoal: false },
    { minute: 88, isHome: true, xg: 0.21, isGoal: false },
    { minute: 92, isHome: true, xg: 0.35, isGoal: true },
  ],
  table: [
    { teamId: 1, played: 21, goalsFor: 46, goalsAgainst: 19 },
    { teamId: 2, played: 21, goalsFor: 44, goalsAgainst: 21 },
    { teamId: -3, played: 21, goalsFor: 30, goalsAgainst: 28 },
    { teamId: -4, played: 21, goalsFor: 24, goalsAgainst: 33 },
    { teamId: -5, played: 21, goalsFor: 19, goalsAgainst: 38 },
  ],
  tableAsOfDay: null,
  tablePriorOnly: false,
  standingsUrl: null,
  fullTime: PARAMS.expectedFullTime,
  kickoffUtc: null,
  capturedAt: 0,
  warnings: [],
};

const css = [
  readFileSync(join(root, 'src/view/theme.css'), 'utf8'),
  readFileSync(join(root, 'src/view/card.css'), 'utf8'),
].join('\n');

const view = buildView(snapshot, snapshot.fullTime);
const card = renderCard(snapshot, view, { footer: true });

const html = `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>FotStats</title>
<style>
${css}
html, body { margin: 0; padding: 0; }
body {
  width: 1280px; height: 800px; overflow: hidden;
  background: radial-gradient(1100px 700px at 78% 18%, #16233a 0%, #0b0f17 62%, #070a10 100%);
  color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; align-items: center; gap: 68px; padding: 0 86px;
  box-sizing: border-box;
}
.copy { width: 430px; flex: none; }
.mark {
  font-size: 15px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
  color: #6ea8fe; margin-bottom: 22px;
}
.copy h1 { font-size: 45px; line-height: 1.1; margin: 0 0 20px; letter-spacing: -.022em; font-weight: 660; }
.copy h1 em { font-style: normal; color: #6ea8fe; }
.copy p { margin: 0; font-size: 17px; line-height: 1.62; color: #9fb0c9; }
.copy ul { margin: 26px 0 0; padding: 0; list-style: none; font-size: 15.5px; color: #c3d0e2; }
.copy li { padding-left: 22px; position: relative; margin-bottom: 11px; }
.copy li::before {
  content: ""; position: absolute; left: 0; top: .52em;
  width: 7px; height: 7px; border-radius: 50%; background: #6ea8fe;
}
.stage { flex: none; transform: scale(1.34); transform-origin: left center; }
.shot {
  width: 392px; border-radius: 12px; padding: 6px 10px 10px;
  background: var(--bg); border: 1px solid rgba(255,255,255,.09);
  box-shadow: 0 26px 70px rgba(0,0,0,.6), 0 3px 12px rgba(0,0,0,.4);
}
</style></head>
<body>
  <div class="copy">
    <div class="mark">FotStats</div>
    <h1>Win probability, <em>every minute</em>.</h1>
    <p>A live read on who is actually winning &mdash; and the whole story of how the match got there.</p>
    <ul>
      <li>Updates live as the match plays</li>
      <li>Goal and red-card markers on the timeline</li>
      <li>Works on finished matches too</li>
      <li>Nothing leaves your browser</li>
    </ul>
  </div>
  <div class="stage"><div class="shot">${card}</div></div>
</body></html>`;

const out = join(root, 'store-shot.html');
writeFileSync(out, html, 'utf8');
console.log(`[fotstats] wrote ${out}`);
