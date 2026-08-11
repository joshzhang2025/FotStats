# FotStats

A Chrome extension that adds a live win-probability layer to FotMob match pages.

Two features:

- **Live win probability** — P(home win / draw / away win), updating as the match plays.
- **"How did we get here"** — win probability across every minute, with goal and red-card markers.

Open a specific match on fotmob.com. A small pill appears in the corner of the page with the score and
the current probabilities; click it for the full card. The extension popup shows the same thing plus
diagnostics.

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
popup  +  overlay.ts            run the model, draw the chart
```

Both surfaces ask the worker the same question and render with the same code
([`src/view/`](src/view/)), so they cannot disagree. The popup passes its own tab id, because
`currentWindow` from a service worker means "last focused"; the overlay passes none and the worker
reads `sender.tab`. Everything the worker does in between — substituting a point-in-time table,
fetching standings — happens for both.

The one rule that matters: **never reproduce a FotMob request, only observe one.** A change to
their signing scheme cannot break us. Two consequences fall out of that:

- The interceptor always `clone()`s before reading a body, so the page's own consumer is untouched.
- Every path is wrapped in try/catch and falls through to the original. A throw here would break
  fotmob.com itself.

Cold start (extension just reloaded, or a finished match that never polls) is covered by reading
the payload FotMob server-renders into `__NEXT_DATA__`. FotMob is client-routed, so moving between
matches never reloads the page and nothing re-runs on its own; both content scripts poll
`location.href` once a second to notice. That is also the only navigation signal available to us —
patching `history.pushState` from the ISOLATED world intercepts nothing, because the page's own calls
run in a different JS realm with its own prototypes.

### The overlay

[`src/content/overlay.ts`](src/content/overlay.ts) puts the card on the match page itself. It applies
the same rule as the interceptor, one layer up: **never read, modify, or depend on FotMob's DOM.** It
appends one `<fotstats-overlay>` element to `body`, outside their React tree, and draws inside a
closed shadow root. There is nothing of theirs to break.

What keeps it from being in the way:

- **It renders nothing at all unless there is real data.** No spinner, no "waiting" box, no empty
  frame — off a match page or before the payload lands, it unmounts. The popup has empty states
  because you opened it deliberately and are owed an answer; an overlay you did not ask for owes the
  page silence.
- **The host is `pointer-events: none`** and only the card takes input, so nothing on FotMob becomes
  unclickable. `contain: layout style` keeps our reflows out of their layout tree, and the `z-index`
  leaves headroom above us for a genuine page modal.
- **No listeners on their document or window for input** — no key handlers, no `preventDefault`, no
  focus stealing. Only `visibilitychange`, `popstate` and `pageshow`.
- **A hidden tab polls not at all,** and a finished match stops for good. Every request wakes the MV3
  service worker, so six background FotMob tabs must not keep it alive.
- **Markup is only rewritten when something changed** ([`renderSignature`](src/shared/schedule.ts)).
  Rebuilding on a tick that changed nothing drops the user's text selection mid-hover, on a page that
  is not ours to interrupt.

Styling is delivered as constructed `CSSStyleSheet`s rather than a `<style>` element: CSP has no hook
for CSSOM-built sheets at all, so it keeps working whatever policy FotMob adds later. The theme
tokens are declared on `:root, :host` — a `ShadowRoot` is not an element, so `:root` alone never
matches inside one, and there is a test pinning that.

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

### Historical tables

That standings file has no date in it: it is always *today's* table. For a live match that is
exactly right, but for a match played last January it describes a season that had not happened yet
— including the result of the match being predicted. The baseline was reading its own answer.

So for the Premier League the table is rebuilt from results instead, cut off at the day of kickoff.
[`src/model/history.ts`](src/model/history.ts) folds a results list into the same `TableRow[]` the
live path produces, so `prematchBaseline` is unchanged and does not know the difference.

Results rather than tables, for two reasons. A table is just a fold over results at one instant, so
one 380-row file yields every table that season ever had. And matchday-indexed tables are ambiguous
anyway — postponements mean teams within "matchday 21" have played different numbers of games,
while a date cutoff is exact.

```bash
npm run fetch-history                        # last 12 seasons
npm run fetch-history -- --from 2000         # further back
```

That writes `public/data/pl-history.json` (12 seasons ≈ 80 KB) from
[football-data.co.uk](https://www.football-data.co.uk/englandm.php), which publishes one CSV per
season back to 1993/94 with no key and no auth. It is **not** part of `npm run build` — a build
should not depend on a third-party host — so the generated file is committed.

Two details that are load-bearing:

- **The cutoff is the start of the kickoff day, not the kickoff instant.** Source dates have no time
  component, so an instant cutoff would rank the match's own stored date (midnight) as earlier than
  its kickoff and fold the result into its own baseline. Cutting at day start drops every same-day
  fixture — a handful of matches off the league-average denominator, and no way to leak.
- **Only the two teams playing need real FotMob ids.** `prematchBaseline` looks up exactly two rows;
  every other row exists solely to compute the league average. So the other rows get synthetic
  negative ids, and no FotMob team-id database is needed at all.

The results file identifies clubs by name, so the two sources are reconciled onto a canonical key in
[`src/model/teams.ts`](src/model/teams.ts). An unmapped club **fails the fetch script loudly** rather
than silently losing its table — expect to add two or three names each August when the promoted
clubs arrive.

Everything declines to null rather than guessing: unknown club, missing team id, a season the file
does not cover, fewer than four rows. Null means "use the live table", so a stale download degrades
to today's behaviour instead of serving half a season as if it were whole.

### Carrying last season forward

Cutting the table at kickoff creates a new problem at the other end of the season: in August there
is no table. Three games say almost nothing about a side, and below `PARAMS.table.minPlayed` the
model bails to league averages entirely. Measured over the archive, **13.2% of matches** had no
usable table — every one of which previously got a full-season one.

But a thin table is not all that was known at kickoff. Last season had happened, and everyone had
seen it. So last season's finished rates are carried in as **pseudo-games**: a club that scored 1.8
a game last year starts this one credited with `priorGames` matches at 1.8.

Expressing the prior as *games* rather than a weight means it dilutes itself. The implied weight is
`priorGames / (priorGames + played)` — dominant on the opening weekend, about a third by midwinter,
a fifth by May — with no decay schedule to write or tune. Adding it to every club keeps the league
average, a ratio of those same totals, consistent.

A promoted club has no previous top-flight record. Treating it as average is wrong in a measurable
direction: across 33 promoted clubs in 11 seasons they scored **0.71x** and conceded **1.23x** the
league average, and the sign held in every single season. Those are `promotedAttack` and
`promotedDefence`.

`npm run tune-prior` sweeps `priorGames` over the archive, scoring each match at minute 0 against
what actually happened — out-of-sample by construction, since the table is cut at kickoff:

```
  prior     Brier       log-loss   covered   thin table
      0   0.60064 +0.00000   1.00542    4479    11.7%
      5   0.58860 -0.01204   0.98804    4553     1.0%
     10   0.58664 -0.01400   0.98531    4553     1.0%
     15   0.58624 -0.01440   0.98480    4553     1.0%  <- best
     30   0.58709 -0.01355   0.98608    4553     1.0%
```

The shipped value is **10, not the best-scoring 15**. The optimum is flat, and fitting each half of
the archive separately picks 20 and 12 — they disagree, so the precise peak is noise. 10 is the
smallest value inside both halves' error bands: it leans least on a season already over, and costs
0.0004 Brier. The script prints that stability check for exactly this reason.

Two things the sweep is honest about. Scores are computed on the 4,479 matches *every* value can
price, since higher priors cover more of the archive and comparing different samples would flatter
them. And coverage is reported separately rather than folded into the score.

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

The one thing a past match *can* get wrong is the pre-match baseline, since the league table it
rests on is dated. That is what [Historical tables](#historical-tables) fixes.

How a probability is built, in order:

1. **Pre-match baseline** — goals for/against per game from the league standings, relative to the
   league average, applied to a home/away baseline. For a past Premier League match the standings
   are rebuilt as of the day of kickoff (see [Historical tables](#historical-tables)); otherwise
   they are FotMob's current ones. Falls back to league averages when there is no table or fewer
   than 5 games have been played.
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
npm test           # sanity + adapter (fast, no browser, no fixtures needed)
npm run scenarios  # print the model's output for familiar match situations
npm run tune-prior # sweep the previous-season prior over the results archive
npm run calibrate  # reliability against captured matches
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

Expect Premier League numbers to get slightly *worse* now that the baseline no longer sees the
finished season — that is the fix working. Other competitions still use today's table and are
flattered accordingly, so do not compare their Brier scores against the PL's.

Scoring the baseline alone at minute 0 across the archive puts numbers on that trade:

```
final table (leaky, sees result)   Brier 0.55985   log-loss 0.94539
as-of kickoff, no prior            Brier 0.60064   log-loss 1.00542
as-of kickoff + previous season    Brier 0.58583   log-loss 0.98423
```

The previous-season prior recovers about **36%** of what removing the leak cost. The other 64% is
not a defect to chase: the leaky row contains the answer to the question it is being asked, and no
honest model reaches it. It is on the table as a reminder of how much of the old accuracy was
borrowed rather than earned.

## Testing it in the browser

Load `dist/` as an unpacked extension (see Install), then work through these in order. Start with a
**finished** match — it is deterministic, needs no waiting, and exercises every code path.

**1. A finished Premier League match.** Open any result from the last few weeks
(`fotmob.com` → Matches → pick a past date → click a match). Open the popup. You should see the
final score, the full-time probability sitting on the actual winner, and a timeline whose goal
markers line up with when the goals went in.

**2. Check the footer.** It reports the xG totals and where the baseline came from. On a past
Premier League match it should read "Baseline from league table as of *the match date*" — if it
says "league table form" instead, the historical lookup declined and you are seeing today's table.
Any data warnings appear here — that is the first place a FotMob field rename shows up.

**3. A live match.** Probabilities should shift within ~30s as FotMob polls, and the timeline should
stop at the current minute rather than running to 90.

**4. The inert states.** A FotMob league page should say "No match selected"; a non-FotMob site,
"Not on FotMob". Neither should log errors.

**5. FotMob itself must be unaffected.** Browse the site normally with the extension on. Scores,
lineups, and stats must all still load — the interception is only correct if it is invisible.

### The overlay checklist

The overlay's remaining risks are all things a unit test cannot see: shadow attachment, stylesheet
adoption, stacking, pointer pass-through and real client-side navigation. The pure parts
(`nextPollDelay`, `renderSignature`, `overlayRoute`, the markup, the stylesheet contract) are covered
by `npm test`; these are not, so walk them.

1. **Live match** — the pill appears bottom-right, expands on click, the chart hover works inside it,
   and the numbers move within ~30s.
2. **Finished match** — renders once, then stops polling. The service-worker console should go quiet.
3. **Pre-match, a league page, the homepage** — *nothing renders at all.* Not an empty frame.
4. **Navigation** — match → match, match → homepage → match, and browser back/forward. The card
   follows, and the baseline in the popup footer changes with the competition (that last one is the
   `standingsFound` latch, which is what the interceptor's URL poll exists for).
5. **Persistence** — expand, reload: still expanded. Dismiss with `✕`: gone until you navigate.
6. **Nothing is blocked** — click through FotMob normally with the card up. Their nav, modals and
   links must all still work, including directly around the card.
7. **Edge cases** — a 375px-wide window (defaults to collapsed), print preview (no card on the page),
   reloading the extension with a tab open (no dead card left behind), popup and overlay open at once.

### Where to look when something is wrong

Three separate consoles, and the right one depends on the layer:

| Layer | Console |
| --- | --- |
| `interceptor.ts`, `bridge.ts`, `overlay.ts` | DevTools on the FotMob page |
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

## Not built yet

The luck meter (score vs. cumulative xG) needs no new model work — both values are already on the
snapshot. Table impact would need standings data the model does not currently keep.

Two more that the historical results file has now put within reach:

- **Calibration against the market.** The football-data.co.uk CSVs carry closing odds (`PSH/PSD/PSA`
  from Pinnacle, `AvgH/AvgD/AvgA` across books). De-vig those and `npm run calibrate` could score
  the model against a real benchmark instead of against nothing — a far stronger test than the
  hand-written reference prices in `scenarios.ts`. `fetch-history.ts` currently drops these columns;
  keeping them is a few lines.
- **Separate home and away strengths.** The `h*` split above needs no new source: home and away
  records fall straight out of a results list.

Other competitions still use FotMob's live table. Extending coverage is mostly data entry —
football-data.co.uk uses the same URL shape for other divisions (`E1` Championship, `SP1` La Liga,
`D1` Bundesliga), so it is a division code, a FotMob league id, and the club names for that league.
