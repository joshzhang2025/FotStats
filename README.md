# FotStats

A Chrome extension that adds a live win-probability layer to FotMob match pages.

- **Live win probability** — P(home win / draw / away win), updating as the match plays.
- **Minute by minute** — how the win probability moved across the match, with goal and red-card markers.

Open a match on fotmob.com and a small pill appears in the corner with the score and the current
probabilities; click it for the full card. The extension popup shows the same thing plus diagnostics.

## Install

```bash
npm install
npm run build:dev     # includes the fixture-capture button
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.

Use `npm run watch` while developing; hit the reload icon on the extension card after a rebuild.
`npm run build` produces the production bundle.

## How it works

FotMob's `matchDetails` endpoint requires a signed header their obfuscated bundle generates per
call. Rather than reverse that, FotStats runs **inside** the page and reads responses FotMob already
fetched successfully:

```
MAIN world (interceptor.ts)     patches fetch + XHR, clones matchDetails responses
        │  window.postMessage
ISOLATED world (bridge.ts)      reduces the payload to a compact MatchSnapshot
        │  chrome.runtime.sendMessage
service worker (worker.ts)      caches the snapshot per tab in storage.session
        │  request/response
popup  +  overlay.ts            run the model, draw the chart
```

Two rules the code holds to:

- **Never reproduce a FotMob request, only observe one.** The interceptor always `clone()`s before
  reading a body, and every path is wrapped in try/catch that falls through to the original — a
  throw there would break fotmob.com itself.
- **The overlay never reads, modifies, or depends on FotMob's DOM.** It appends one
  `<fotstats-overlay>` to `body`, outside their React tree, and draws in a closed shadow root. The
  host is `pointer-events: none`, it renders nothing at all without real data, and it stops polling
  on hidden tabs and finished matches.

Both surfaces ask the worker the same question and render with the same code ([`src/view/`](src/view/)),
so they cannot disagree. FotMob is client-routed, so both content scripts poll `location.href` once a
second to notice navigation. Cold start is covered by reading `__NEXT_DATA__`.

FotMob renames fields periodically; [`src/model/extract.ts`](src/model/extract.ts) is the only module
that knows their field names, and it records a `warnings` entry for anything missing.

### Standings

`matchDetails` does not contain the league table — only a pointer to gzipped **XML** on another host.
The worker follows it, parses it by hand (MV3 service workers have no `DOMParser`), and caches per
URL for 6 hours. Rows are deduplicated by team id, and a table with 0 games played is rejected rather
than used.

### Historical tables

That standings file is always *today's* table. For a match played last January it describes a season
that hadn't happened yet — including the result being predicted. So for the Premier League the table
is rebuilt from results, cut off at the **start of the kickoff day** (source dates have no time
component, so an instant cutoff would leak the match into its own baseline).
[`src/model/history.ts`](src/model/history.ts) folds results into the same `TableRow[]` the live path
produces, so the rest of the model doesn't know the difference.

```bash
npm run fetch-history                        # last 12 seasons
npm run fetch-history -- --from 2000         # further back
```

That writes `public/data/pl-history.json` (~80 KB) from
[football-data.co.uk](https://www.football-data.co.uk/englandm.php). It is not part of `npm run build`,
so the generated file is committed. Club names are reconciled in
[`src/model/teams.ts`](src/model/teams.ts); an unmapped club fails the fetch script loudly — expect to
add two or three names each August. Everything else declines to null, which means "use the live table".

### Carrying last season forward

Cutting the table at kickoff means there is no table in August, and 13.2% of matches fall below
`PARAMS.table.minPlayed`. So last season's finished rates are carried in as **pseudo-games**: a club
that scored 1.8 a game last year starts this one credited with `priorGames` matches at 1.8. Expressed
as games rather than a weight, it dilutes itself — `priorGames / (priorGames + played)` — with no decay
schedule to tune.

Promoted clubs have no top-flight record, and treating them as average is wrong in a measurable
direction: across 33 promoted clubs they scored **0.71x** and conceded **1.23x** the league average.
Those are `promotedAttack` and `promotedDefence`.

`npm run tune-prior` sweeps `priorGames` over the archive. The shipped value is **10, not the
best-scoring 15**: the optimum is flat and the two halves of the archive pick 20 and 12, so the peak
is noise. 10 is the smallest value inside both error bands, at a cost of 0.0004 Brier.

## The model

One pure function does all the work:

```ts
winProb(snapshot, minute) => { home, draw, away }
```

Everything it needs at minute *t* is recoverable from the payload — score and red cards from the
event list, cumulative xG from the shotmap. So the live readout is `winProb(snapshot, now)` and the
timeline is the same function in a loop, which means **it works on matches that finished last season,
and on matches you opened at minute 70.**

How a probability is built, in order:

1. **Pre-match baseline** — goals for/against per game from the standings, relative to the league
   average, applied to a home/away baseline. Falls back to league averages with no table or under 5
   games played.
2. **Live xG blending** — shrink the prior toward what this match is producing, the live signal
   gaining weight as minutes accrue (equal weight at minute 45).
3. **Adjustments** — red cards, game state (trailing sides push, leading sides sit), and a
   minute-weight curve tilting goal risk toward the closing stages.
4. **Outcome distribution** — remaining goals as independent Poisson over a 9×9 grid, folded into
   win/draw/loss by the final scoreline. Dixon–Coles corrects the low-score cells, faded out in
   proportion to how much match is left.

Every tunable number lives in [`src/model/params.ts`](src/model/params.ts).

**What it does not know:** no player-level information, lineups, substitutions, injuries, or market
odds. Two teams with identical league records start identical.

## Tests

```bash
npm test           # sanity + adapter (fast, no browser, no fixtures needed)
npm run scenarios  # print the model's output for familiar match situations
npm run tune-prior # sweep the previous-season prior over the results archive
npm run calibrate  # reliability against captured matches
```

The sanity suite proves the model is *coherent* — probabilities sum to 1, converge on the actual
result, move the right way on a goal or a red card, replay deterministically. That says nothing about
whether 65% means 65%.

`npm run scenarios` is the fastest feedback loop when tuning `PARAMS`: it prints probabilities for
situations you already have intuitions about (1-0 at 30', a man down on 10') next to rough real-world
reference prices.

For calibration, the extension is also the collection tool: `npm run build:dev`, open finished
matches, click **Save fixture** in the popup footer, move the JSON into `test/fixtures/`, then
`npm run calibrate`. Aim for 60–100 matches. Fixtures are gitignored. Predictions from the same match
are correlated, so a small set is indicative rather than significant.

Scoring the baseline alone at minute 0 across the archive:

```
final table (leaky, sees result)   Brier 0.55985   log-loss 0.94539
as-of kickoff, no prior            Brier 0.60064   log-loss 1.00542
as-of kickoff + previous season    Brier 0.58583   log-loss 0.98423
```

Expect PL numbers to look slightly worse than other competitions — that is the leak being removed,
not a regression. Other competitions still use today's table and are flattered accordingly.

## Checking it in the browser

Start with a **finished** Premier League match — deterministic, no waiting, exercises every path.
The popup footer should read "Baseline from league table as of *the match date*"; if it says "league
table form", the historical lookup declined. Then check a live match (numbers move within ~30s), a
league page and a non-FotMob site (nothing renders, no errors), and that FotMob itself still works
normally with the extension on.

For the overlay specifically, the risks unit tests can't see: navigation (match → match, back/forward),
persistence (expand, reload, dismiss with `✕`), that nothing on the page becomes unclickable, a 375px
window, print preview, and reloading the extension with a tab open.

### Where to look when something is wrong

| Layer | Console |
| --- | --- |
| `interceptor.ts`, `bridge.ts`, `overlay.ts` | DevTools on the FotMob page |
| `worker.ts` | `chrome://extensions` → FotStats → **service worker** |
| `popup.ts` | right-click inside the popup → **Inspect** |

**After any rebuild, reload the extension *and* the FotMob tab.** Content scripts are injected at
`document_start`, so an open tab keeps running the old build.

To confirm interception independently of everything downstream, paste this into the FotMob page
console and reload:

```js
window.addEventListener('message', (e) => {
  if (e.data?.channel === 'fotstats') console.log(e.data.origin, e.data.payload);
});
```

A `fetch` or `next-data` line means capture works and any problem is in extraction or the model. No
line means the interceptor did not attach.

If the numbers look wrong but the score and markers are right, the bug is in the model, not the
plumbing — reach for `npm run scenarios`.

## Layout

```
public/manifest.json          MV3 — MAIN + ISOLATED content scripts
public/popup.html             popup shell (card styles live in src/view/)
src/inject/interceptor.ts     MAIN world: fetch/XHR patch, __NEXT_DATA__ fallback
src/content/bridge.ts         ISOLATED: payload -> snapshot -> worker
src/content/overlay.ts        ISOLATED: the in-page card, in a shadow root
src/content/overlay.css       overlay-only chrome: host, pill, print, mobile
src/bg/worker.ts              per-tab snapshot cache
src/shared/protocol.ts        message shapes, match-id parsing
src/shared/runtime.ts         talking to the worker, and surviving an orphaned context
src/shared/schedule.ts        when to poll, and when a redraw is worth doing
src/types/fotmob.ts           raw payload shapes (imported only by extract.ts)
src/model/extract.ts          the only file that knows FotMob's field names
src/model/history.ts          league table rebuilt as of a given day
src/model/teams.ts            club-name reconciliation between the two sources
src/model/params.ts           every tunable constant
src/model/poisson.ts          pmf, outcome grid, Dixon-Coles
src/model/winprob.ts          winProb(snapshot, minute) — pure
src/model/replay.ts           minute-by-minute driver, timeline markers
src/view/chart.ts             hand-rolled SVG: timeline, bar, goal summary
src/view/card.ts              the card both surfaces render
src/view/scrub.ts             chart hover, scoped to a root so it works in a shadow
src/view/theme.css            colour tokens, on :root *and* :host
src/view/card.css             card styles, shared by popup and overlay
src/popup/popup.ts            popup shell: empty states, fixture capture
public/data/pl-history.json   generated: PL results, one entry per season
scripts/fetch-history.ts      regenerates the above from football-data.co.uk
scripts/tune-prior.ts         sweeps the previous-season prior against it
```
