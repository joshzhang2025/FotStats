# FotStats

A Chrome extension that adds a live win-probability layer to FotMob match pages.

Two features:

- **Live win probability** — P(home win / draw / away win), updating as the match plays.
- **"How did we get here"** — win probability across every minute, with goal and red-card markers.

Open a specific match on fotmob.com, then open the extension popup.

## Install

```bash
npm install
npm run build:dev     # includes the fixture-capture button
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.

Use `npm run watch` while developing; hit the reload icon on the extension card after a rebuild.
`npm run build` produces the production bundle (no dev affordances).

## How it gets the data

FotMob's `matchDetails` endpoint rejects requests without a signed header its own obfuscated
bundle generates per call. Rather than reverse that, FotStats runs **inside** the page and reads
the responses FotMob already fetched successfully:

```
MAIN world (interceptor.ts)     patches fetch + XHR, clones matchDetails responses
        │  window.postMessage
ISOLATED world (bridge.ts)      reduces the payload to a compact MatchSnapshot
        │  chrome.runtime.sendMessage
service worker (worker.ts)      caches the snapshot per tab in storage.session
        │  request/response
popup                           runs the model, draws the chart
```

The one rule that matters: **never reproduce a FotMob request, only observe one.** A change to
their signing scheme cannot break us. Two consequences fall out of that:

- The interceptor always `clone()`s before reading a body, so the page's own consumer is untouched.
- Every path is wrapped in try/catch and falls through to the original. A throw here would break
  fotmob.com itself.

Cold start (extension just reloaded, or a finished match that never polls) is covered by reading
the payload FotMob server-renders into `__NEXT_DATA__`.

FotMob renames fields periodically. All of that is absorbed by [`src/model/extract.ts`](src/model/extract.ts) —
the only module that knows their field names. It records a `warnings` entry for anything it
cannot find, surfaced in the popup footer, rather than failing silently.

### Standings

`matchDetails` does **not** contain the league table. `content.table` is a stub:

```json
{ "leagueId": "47", "url": "https://data.fotmob.com/tables.ext.47.fot.gz", "parentLeagueId": 47 }
```

The real standings are gzipped **XML** on a different host, one row per team:

```xml
<t name="Arsenal" id="9825" p="20" w="12" d="5" l="3" g="38" c="22"
   hp="10" hw="7" hd="2" hl="1" hg="21" hc="9" change="" />
```

`p` is played, `g` goals for, `c` goals conceded; the `h*` attributes are home-only splits (unused
so far — they would support separate home and away strengths instead of one blended figure).

The worker follows that pointer itself rather than waiting for the page to request it, and caches
per URL for 6 hours. Parsing is hand-rolled in `parseStandingsXml` because **MV3 service workers
have no `DOMParser`**. Rows are deduplicated by team id, keeping the fullest record: competitions
with groups list a team more than once, and MLS returns 60 rows for 30 teams.

Note that a table with 0 games played — a season that has not started — is correctly *rejected*,
and the popup says so ("season has not started") rather than pretending it has information.

## The model

One pure function does all the work:

```ts
winProb(snapshot, minute) => { home, draw, away }
```

Everything it needs at minute *t* is recoverable from data already in the payload — score from the
event list, red cards from the event list, cumulative xG from the shotmap (every shot carries a
minute). So the live readout is `winProb(snapshot, now)` and the timeline is the same function in a
loop.

That has a useful consequence: **the timeline works on matches that finished last season, and on
matches you opened at minute 70.** There is no accumulated state to have missed.

How a probability is built, in order:

1. **Pre-match baseline** — goals for/against per game from the league standings, relative to the
   league average, applied to a home/away baseline. Falls back to league averages when there is no
   table or fewer than 5 games have been played.
2. **Live xG blending** — shrink the prior toward what this match is actually producing, with the
   live signal gaining weight as minutes accrue (equal weight at minute 45).
3. **Adjustments** — red cards (down a man: creates less, concedes more), game state (trailing
   sides push, leading sides sit, both sharpening as the clock runs down), and a minute-weight
   curve that tilts goal risk toward the closing stages without changing the expected total.
4. **Outcome distribution** — remaining goals as independent Poisson over a 9×9 grid, folded into
   win/draw/loss by the *final* scoreline. Dixon–Coles corrects the low-score cells, faded out in
   proportion to how much match is left, since the correction is defined over a whole match.

Every tunable number lives in [`src/model/params.ts`](src/model/params.ts). Nothing else hardcodes a
value that affects a probability.

### What the model does not know

It has no player-level information, no lineup strength, no substitutions, no injuries, and no
market odds. Two teams with identical league records start identical. It is a game-state model with
an xG feed, not a scouting model — and at minute 0 with no table it is saying little more than
"generic home match in this league".

## Tests

```bash
npm test          # sanity + adapter (fast, no browser, no fixtures needed)
npm run scenarios # print the model's output for familiar match situations
npm run calibrate # reliability against captured matches
```

The sanity suite proves the model is *coherent*: probabilities sum to 1 at every minute, converge
on the actual result by full time, move up when a side scores and down when it goes a man down, and
replay deterministically. That catches real bugs but says nothing about whether 65% means 65%.

`npm run scenarios` is the fastest feedback loop when tuning `PARAMS` — it prints win probabilities
for situations you already have intuitions about (1-0 at 30', two goals up, a man down on 10') next
to rough real-world reference prices. Coherent-but-absurd output shows up here immediately; the
lambda cap in `PARAMS.table` exists because this is how it was caught.

### Calibration

Only real matches answer that, and the API is unreachable from outside the page — so the extension
is also the collection tool.

1. `npm run build:dev` and load unpacked.
2. Open finished Premier League and MLS matches, click **Save fixture** in the popup footer.
3. Move the downloaded JSON into `test/fixtures/`.
4. `npm run calibrate`.

Aim for 60–100 matches. The harness buckets every prediction at minutes 0/15/30/45/60/75 and
compares predicted probability against observed frequency:

```
  bucket        n     predicted   observed   gap
  0-10        412       0.061      0.068    +0.007
  10-30       288       0.194      0.212    +0.018
  ...
  Brier score: 0.1732
```

A well-calibrated model has 70% predictions come true about 70% of the time. Tune `PARAMS` against
the gap column. Fixtures are gitignored — large, and not ours to redistribute.

One caveat the harness prints for itself: predictions from the same match are correlated, so a
small fixture set is indicative rather than significant.

## Testing it in the browser

Load `dist/` as an unpacked extension (see Install), then work through these in order. Start with a
**finished** match — it is deterministic, needs no waiting, and exercises every code path.

**1. A finished Premier League match.** Open any result from the last few weeks
(`fotmob.com` → Matches → pick a past date → click a match). Open the popup. You should see the
final score, the full-time probability sitting on the actual winner, and a timeline whose goal
markers line up with when the goals went in.

**2. Check the footer.** It reports the xG totals and where the baseline came from. Any data
warnings appear here — that is the first place a FotMob field rename shows up.

**3. A live match.** Probabilities should shift within ~30s as FotMob polls, and the timeline should
stop at the current minute rather than running to 90.

**4. The inert states.** A FotMob league page should say "No match selected"; a non-FotMob site,
"Not on FotMob". Neither should log errors.

**5. FotMob itself must be unaffected.** Browse the site normally with the extension on. Scores,
lineups, and stats must all still load — the interception is only correct if it is invisible.

### Where to look when something is wrong

Three separate consoles, and the right one depends on the layer:

| Layer | Console |
| --- | --- |
| `interceptor.ts`, `bridge.ts` | DevTools on the FotMob page |
| `worker.ts` | `chrome://extensions` → FotStats → **service worker** |
| `popup.ts` | right-click inside the popup → **Inspect** |

**After any rebuild, reload the extension *and* the FotMob tab.** Content scripts are injected at
`document_start`, so an already-open tab keeps running the old build.

To confirm interception independently of everything downstream, paste this into the FotMob page
console and reload:

```js
window.addEventListener('message', (e) => {
  if (e.data?.channel === 'fotstats') console.log(e.data.origin, e.data.payload);
});
```

A `fetch` or `next-data` line means capture works and any problem is in extraction or the model. No
line at all means the interceptor did not attach — check the extension is enabled and the tab was
reloaded after loading it.

If the popup says **"Waiting for match data"** and stays there, the page loaded before the extension
did. Reload the tab. If it persists on a live match past ~30s, capture is genuinely broken.

If the numbers look wrong but the score and markers are right, the bug is in the model, not the
plumbing — reach for `npm run scenarios`.

## Layout

```
public/manifest.json          MV3 — MAIN + ISOLATED content scripts
public/popup.html             popup shell and styles
src/inject/interceptor.ts     MAIN world: fetch/XHR patch, __NEXT_DATA__ fallback
src/content/bridge.ts         ISOLATED: payload -> snapshot -> worker
src/bg/worker.ts              per-tab snapshot cache
src/shared/protocol.ts        message shapes, match-id parsing
src/types/fotmob.ts           raw payload shapes (imported only by extract.ts)
src/model/extract.ts          the only file that knows FotMob's field names
src/model/params.ts           every tunable constant
src/model/poisson.ts          pmf, outcome grid, Dixon-Coles
src/model/winprob.ts          winProb(snapshot, minute) — pure
src/model/replay.ts           minute-by-minute driver, timeline markers
src/popup/                    popup logic and hand-rolled SVG chart
```

## Not built yet

`nextGoalSwing()` in [`src/model/replay.ts`](src/model/replay.ts) already computes "a goal here takes
them from 20% to 48%" — it just isn't surfaced. The luck meter (score vs. cumulative xG) needs no new
model work either; both values are already on the snapshot. Table impact would need standings data
the model does not currently keep.
