/**
 * Render the chart for a few match shapes into a standalone HTML file.
 *
 * Iterating on chart design through the extension means rebuild, reload
 * extension, reload tab, open popup, find a match in the right state. This
 * shows every state side by side in a browser, using the popup's own stylesheet
 * so what you see is what the popup renders.
 *
 *   npm run preview
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MatchSnapshot } from '../src/model/types.ts';
import { PARAMS } from '../src/model/params.ts';
import { buildView, renderCard } from '../src/view/card.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const snapshot = (overrides: Partial<MatchSnapshot> = {}): MatchSnapshot => ({
  matchId: 'preview',
  home: { id: 1, name: 'Tottenham Hotspur' },
  away: { id: 2, name: 'Newcastle United' },
  colors: { home: '#ffffff', away: '#241f20' }, // deliberately unusable kit colours
  leagueId: 47,
  leagueName: 'Premier League',
  status: { started: true, finished: true, cancelled: false, liveMinute: null },
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

const goal = (
  minute: number,
  isHome: boolean,
  scorer: string | null = null,
  assist: string | null = null,
  added = 0,
) => ({ minute, added, isHome, ownGoal: false, scorer, assist });

const cases: Array<{ title: string; snapshot: MatchSnapshot; upTo?: number }> = [
  {
    title: 'Tottenham 1–2 Newcastle (full time)',
    snapshot: snapshot({
      goals: [
        goal(50, false, 'A. Isak'),
        goal(64, true, 'H. Son'),
        // Left unnamed on purpose: FotMob does not always carry a scorer, and
        // the row has to still make sense without one.
        goal(68, false),
      ],
    }),
  },
  {
    title: 'Live, 63′ — home leading',
    snapshot: snapshot({
      status: { started: true, finished: false, cancelled: false, liveMinute: 63 },
      goals: [goal(31, true)],
    }),
    upTo: 63,
  },
  {
    title: 'Goalless full time',
    snapshot: snapshot(),
  },
  {
    title: 'Comeback: 0–2 down, wins 3–2',
    snapshot: snapshot({
      goals: [
        goal(8, false),
        goal(19, false),
        goal(55, true),
        goal(71, true),
        // A winner in stoppage time, listed as 90+3 but plotted at 93.
        goal(93, true, null, null, 3),
      ],
    }),
  },
  {
    title: 'Red card on 20′, still 0–0',
    snapshot: snapshot({ redCards: [{ minute: 20, added: 0, isHome: true }] }),
  },
  {
    title: 'Distinguishable kit colours (kept as-is)',
    snapshot: snapshot({
      home: { id: 1, name: 'Liverpool' },
      away: { id: 2, name: 'Man City' },
      colors: { home: '#d00027', away: '#6cabdd' },
      goals: [
        // The Premier League is one of the competitions FotMob records assists
        // for; most are not, so the row above shows the shape without one.
        goal(35, true, 'M. Salah', 'T. Alexander-Arnold'),
        goal(80, false, 'E. Haaland', 'K. De Bruyne'),
      ],
    }),
  },
];

// The real stylesheets, so the preview cannot drift from what ships. Read as
// files rather than scraped out of popup.html, which could silently yield ''.
const css = [
  readFileSync(join(root, 'src/view/theme.css'), 'utf8'),
  readFileSync(join(root, 'src/view/card.css'), 'utf8'),
].join('\n');

// Exactly what both surfaces render, so the preview shows the real thing rather
// than a copy of it.
const panels = cases
  .map(({ title, snapshot: s, upTo }) => {
    const view = buildView(s, upTo ?? s.fullTime);
    return `
      <div class="panel">
        <h3>${title}</h3>
        ${renderCard(s, view, { footer: true })}
      </div>`;
  })
  .join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>FotStats chart preview</title>
<style>
${css}
/* The popup's own shell rules live in popup.html; the preview needs the same
   base so the cards sit on the right background. */
body {
  margin: 0;
  padding: 20px;
  background: var(--bg);
  color: var(--fg);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.grid-wrap { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 22px; }
.panel { width: 380px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; }
.panel h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; }
.toggle { margin-bottom: 18px; font-size: 12px; }
</style></head>
<body>
  <div class="toggle">
    Theme follows your OS setting — switch it to check both.
  </div>
  <div class="grid-wrap">${panels}</div>
</body></html>`;

const out = join(root, 'preview.html');
writeFileSync(out, html, 'utf8');
console.log(`[fotstats] wrote ${out}`);
