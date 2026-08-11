import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { nextPollDelay, overlayRoute, renderSignature } from '../src/shared/schedule.ts';
import { buildView, renderCard, renderPill } from '../src/view/card.ts';
import { goal, makeSnapshot, red, shot } from './helpers.ts';

/**
 * The overlay's decisions, tested where they are decidable without a browser.
 *
 * Mounting, shadow roots, stylesheet adoption and pointer-events pass-through
 * need a real page and are covered by the checklist in the README instead —
 * adding jsdom for them would model exactly the parts (constructed stylesheets,
 * shadow DOM) it is worst at.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const live = makeSnapshot({
  status: { started: true, finished: false, cancelled: false, liveMinute: 60 },
  goals: [goal(23, true, 'M. Salah')],
});

describe('poll cadence', () => {
  it('polls a live match on FotMob’s own rhythm', () => {
    assert.equal(nextPollDelay(live, true), 10_000);
  });

  it('stops entirely on a hidden tab', () => {
    // Every request wakes the service worker; background tabs must not.
    assert.equal(nextPollDelay(live, false), null);
    assert.equal(nextPollDelay(null, false), null);
  });

  it('stops on a match that can no longer change', () => {
    assert.equal(nextPollDelay(makeSnapshot(), true), null, 'finished');
    assert.equal(
      nextPollDelay(
        makeSnapshot({ status: { started: true, finished: false, cancelled: true, liveMinute: 20 } }),
        true,
      ),
      null,
      'cancelled',
    );
  });

  it('waits a minute before kickoff and probes faster with nothing yet', () => {
    const pre = makeSnapshot({
      status: { started: false, finished: false, cancelled: false, liveMinute: null },
    });
    assert.equal(nextPollDelay(pre, true), 60_000);
    assert.equal(nextPollDelay(null, true), 5_000);
  });
});

describe('render signature', () => {
  const sig = (s = live, minute = 60, expanded = false) => renderSignature(s, minute, expanded);

  it('is stable when a re-poll returns the same match', () => {
    assert.equal(sig(), sig(makeSnapshot({ ...live })));
  });

  it('changes on a goal, a red card, and the clock', () => {
    assert.notEqual(sig(), sig(makeSnapshot({ ...live, goals: [...live.goals, goal(61, false)] })));
    assert.notEqual(sig(), sig(makeSnapshot({ ...live, redCards: [red(55, true)] })));
    assert.notEqual(sig(), sig(live, 61));
  });

  it('changes on xG alone, which moves the probability with no event at all', () => {
    const pressure = makeSnapshot({ ...live, shots: [shot(58, true, 0.44)] });
    assert.notEqual(sig(), sig(pressure));
  });

  it('separates a goal for one side from a goal for the other', () => {
    const homeScores = makeSnapshot({ ...live, goals: [...live.goals, goal(61, true)] });
    const awayScores = makeSnapshot({ ...live, goals: [...live.goals, goal(61, false)] });
    assert.notEqual(sig(homeScores), sig(awayScores));
  });

  it('changes when the card is expanded', () => {
    assert.notEqual(sig(live, 60, false), sig(live, 60, true));
  });
});

describe('overlay route', () => {
  it('mounts on a match page and nowhere else', () => {
    assert.equal(overlayRoute('https://www.fotmob.com/matches/liverpool-vs-man-city/2ovmp3'), '2ovmp3');
    assert.equal(overlayRoute('https://www.fotmob.com/leagues/47/overview'), null);
    assert.equal(overlayRoute('https://www.fotmob.com/'), null);
    assert.equal(overlayRoute('https://example.com/matches/a/b/c'), null);
  });
});

describe('overlay markup', () => {
  it('draws no chart when collapsed and exactly one when expanded', () => {
    const view = buildView(live);
    assert.ok(!renderPill(live, view).includes('<svg'), 'the pill is the small thing');
    assert.equal(renderCard(live, view).match(/<svg/g)?.length, 1);
  });

  it('shows the score and clock in the pill', () => {
    const html = renderPill(live, buildView(live));
    assert.match(html, /1&ndash;0/);
    assert.match(html, /60'/);
    assert.ok(!html.includes('NaN') && !html.includes('undefined'), html);
  });

  it('says FT rather than a minute once the match is over', () => {
    const done = makeSnapshot({ goals: [goal(23, true)] });
    assert.match(renderPill(done, buildView(done)), /FT/);
  });

  it('keeps the footer out of the overlay', () => {
    const view = buildView(live);
    assert.ok(!renderCard(live, view).includes('<footer'), 'diagnostics belong in the popup');
    assert.ok(renderCard(live, view, { footer: true }).includes('<footer'));
  });

  it('escapes names, which come from FotMob', () => {
    const hostile = makeSnapshot({
      ...live,
      home: { id: 1, name: '<img src=x onerror=alert(1)>' },
      goals: [goal(23, true, '"><script>alert(1)</script>')],
    });
    const html = renderCard(hostile, buildView(hostile), { footer: true });
    assert.ok(!html.includes('<img'), html);
    assert.ok(!html.includes('<script'), html);
  });
});

describe('next-goal swing', () => {
  it('prices what a goal would be worth to each side', () => {
    const html = renderCard(live, buildView(live));
    assert.match(html, /If they score next/);
    // Scoring can only improve your own chances.
    const view = buildView(live);
    const percents = [...html.matchAll(/<b>([\d.]+)%<\/b>/g)].map((m) => Number(m[1]));
    assert.ok(percents.length >= 5, 'three current figures plus two hypotheticals');
    assert.ok(percents[3]! > view.detail.home * 100, 'home scoring must help home');
    assert.ok(percents[4]! > view.detail.away * 100, 'away scoring must help away');
  });

  it('says nothing about a next goal once there cannot be one', () => {
    const done = makeSnapshot({ goals: [goal(23, true)] });
    assert.ok(!renderCard(done, buildView(done)).includes('If they score next'));
  });
});

describe('stylesheet contract', () => {
  // Comments explain these rules and would otherwise trip every check in here.
  const read = (name: string) =>
    readFileSync(join(root, 'src/view', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('declares the theme tokens for shadow roots as well as documents', () => {
    // A ShadowRoot is not an element, so `:root` alone never matches inside one
    // and every colour in the overlay would fall back to its initial value.
    const theme = read('theme.css');
    for (const block of theme.matchAll(/([^{}]+)\{[^{}]*--bg:/g)) {
      assert.match(block[1]!, /:host/, `token block without :host — ${block[1]!.trim()}`);
    }
  });

  it('references no external resources', () => {
    // The overlay bundles these as strings and the extension declares no
    // web_accessible_resources, so a url() would simply fail to load.
    for (const name of ['theme.css', 'card.css']) {
      assert.ok(!read(name).includes('url('), `${name} must not fetch anything`);
    }
  });

  it('keeps document-only selectors out of the shared card styles', () => {
    const card = read('card.css');
    assert.ok(!/^\s*body\s*[{,]/m.test(card), 'card.css is adopted into a shadow root');
    assert.ok(!/:root/.test(card), 'tokens belong in theme.css');
  });
});
