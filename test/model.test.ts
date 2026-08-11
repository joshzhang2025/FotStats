import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { poissonPmf } from '../src/model/poisson.ts';
import { buildTimeline, currentMinute, nextGoalSwing } from '../src/model/replay.ts';
import { prematchBaseline, weightedMinutes, winProb, winProbDetailed } from '../src/model/winprob.ts';
import { goal, makeSnapshot, red, shotSeries } from './helpers.ts';

const FT = makeSnapshot().fullTime;

describe('poisson', () => {
  it('pmf sums to ~1 over a generous grid', () => {
    for (const lambda of [0.1, 1, 2.5, 6]) {
      let total = 0;
      for (let k = 0; k <= 40; k++) total += poissonPmf(k, lambda);
      assert.ok(Math.abs(total - 1) < 1e-9, `lambda=${lambda} summed to ${total}`);
    }
  });

  it('is degenerate at zero lambda', () => {
    assert.equal(poissonPmf(0, 0), 1);
    assert.equal(poissonPmf(1, 0), 0);
  });
});

describe('minute weighting', () => {
  it('integrates to exactly the match length', () => {
    assert.ok(Math.abs(weightedMinutes(0, FT, FT) - FT) < 1e-9);
  });

  it('loads more weight into the closing stages than the opening', () => {
    const first15 = weightedMinutes(0, 15, FT);
    const last15 = weightedMinutes(FT - 15, FT, FT);
    assert.ok(last15 > first15, `${last15} should exceed ${first15}`);
  });

  it('returns zero for an empty or inverted window', () => {
    assert.equal(weightedMinutes(50, 50, FT), 0);
    assert.equal(weightedMinutes(60, 50, FT), 0);
  });
});

describe('winProb invariants', () => {
  const snapshot = makeSnapshot({
    goals: [goal(23, true), goal(58, false), goal(77, true)],
    redCards: [red(65, false)],
    shots: [...shotSeries(true, 2.1), ...shotSeries(false, 1.4)],
  });

  it('sums to 1 at every minute', () => {
    for (let m = 0; m <= FT; m++) {
      const p = winProb(snapshot, m);
      assert.ok(
        Math.abs(p.home + p.draw + p.away - 1) < 1e-9,
        `minute ${m} summed to ${p.home + p.draw + p.away}`,
      );
    }
  });

  it('never emits a negative or out-of-range probability', () => {
    for (let m = 0; m <= FT; m++) {
      const p = winProb(snapshot, m);
      for (const v of [p.home, p.draw, p.away]) {
        assert.ok(v >= 0 && v <= 1, `minute ${m} produced ${v}`);
      }
    }
  });

  it('converges on the actual result by full time', () => {
    const p = winProb(snapshot, FT);
    assert.ok(p.home > 0.98, `expected home certainty, got ${p.home}`);
  });

  it('is deterministic', () => {
    const a = buildTimeline(snapshot);
    const b = buildTimeline(snapshot);
    assert.deepEqual(a.points, b.points);
  });

  it('clamps minutes outside the match', () => {
    assert.deepEqual(winProb(snapshot, -20), winProb(snapshot, 0));
    assert.deepEqual(winProb(snapshot, FT + 40), winProb(snapshot, FT));
  });
});

describe('event responses', () => {
  it('raises home win probability when home scores', () => {
    const before = makeSnapshot({ status: { started: true, finished: false, cancelled: false, liveMinute: 60 } });
    const after = makeSnapshot({
      goals: [goal(60, true)],
      status: { started: true, finished: false, cancelled: false, liveMinute: 60 },
    });
    assert.ok(winProb(after, 60).home > winProb(before, 60).home);
  });

  it('lowers home win probability when home takes a red card', () => {
    const before = makeSnapshot();
    const after = makeSnapshot({ redCards: [red(30, true)] });
    assert.ok(winProb(after, 45).home < winProb(before, 45).home);
  });

  it('makes a red card bite harder the earlier it is shown', () => {
    // Measured at the moment the card appears: an early one has far more
    // remaining minutes to act on, so it moves the number further.
    const clean = makeSnapshot();
    const earlyDrop = winProb(clean, 10).home - winProb(makeSnapshot({ redCards: [red(10, true)] }), 10).home;
    const lateDrop = winProb(clean, 85).home - winProb(makeSnapshot({ redCards: [red(85, true)] }), 85).home;
    assert.ok(earlyDrop > 0 && lateDrop > 0, 'a red card must always hurt');
    assert.ok(earlyDrop > lateDrop, `early drop ${earlyDrop} should exceed late drop ${lateDrop}`);
  });

  it('stops caring when a card was shown, only that it is in effect', () => {
    // Two matches level with a man down are the same match from here on; the
    // timing of the card is already priced into the minutes that have passed.
    const early = makeSnapshot({ redCards: [red(10, true)] });
    const late = makeSnapshot({ redCards: [red(85, true)] });
    assert.deepEqual(winProb(early, 86), winProb(late, 86));
  });

  it('treats a two-goal lead as safer than a one-goal lead', () => {
    const oneUp = makeSnapshot({ goals: [goal(30, true)] });
    const twoUp = makeSnapshot({ goals: [goal(30, true), goal(35, true)] });
    assert.ok(winProb(twoUp, 60).home > winProb(oneUp, 60).home);
  });

  it('decays a lead into near-certainty as the clock runs down', () => {
    const snapshot = makeSnapshot({ goals: [goal(30, true)] });
    let previous = 0;
    for (const minute of [35, 50, 65, 80, 90]) {
      const p = winProb(snapshot, minute).home;
      assert.ok(p > previous, `home prob fell from ${previous} to ${p} at ${minute}'`);
      previous = p;
    }
  });
});

describe('baseline', () => {
  it('gives the home side an edge between identical teams', () => {
    const p = winProb(makeSnapshot({ status: { started: false, finished: false, cancelled: false, liveMinute: null } }), 0);
    assert.ok(p.home > p.away, `${p.home} should beat ${p.away}`);
  });

  it('falls back to league averages without a table', () => {
    assert.equal(prematchBaseline(makeSnapshot()).source, 'league-average');
  });

  it('uses the table when the season is far enough along', () => {
    const table = Array.from({ length: 20 }, (_, i) => ({
      teamId: i + 1,
      played: 20,
      goalsFor: 30,
      goalsAgainst: 30,
    }));
    table[0] = { teamId: 1, played: 20, goalsFor: 50, goalsAgainst: 15 };
    const baseline = prematchBaseline(makeSnapshot({ table }));
    assert.equal(baseline.source, 'table');
    assert.ok(baseline.home > baseline.away, 'stronger home side should carry the higher lambda');
  });

  it('keeps an extreme mismatch inside plausible territory', () => {
    // A top attack meeting a bottom defence multiplies two already-clamped
    // strengths together. Without a clamp on the resulting lambda this priced
    // the home side near 93%, beyond anything a real fixture trades at.
    const table = Array.from({ length: 20 }, (_, i) => ({
      teamId: i + 1,
      played: 20,
      goalsFor: 28,
      goalsAgainst: 28,
    }));
    table[0] = { teamId: 1, played: 20, goalsFor: 52, goalsAgainst: 16 };
    table[1] = { teamId: 2, played: 20, goalsFor: 16, goalsAgainst: 44 };

    const baseline = prematchBaseline(makeSnapshot({ table }));
    assert.ok(baseline.home <= 3.0, `home lambda ${baseline.home} exceeds the cap`);
    assert.ok(baseline.away >= 0.35, `away lambda ${baseline.away} below the floor`);

    const p = winProb(makeSnapshot({ table }), 0);
    assert.ok(p.home > 0.75 && p.home < 0.9, `extreme mismatch priced at ${p.home}`);
  });

  it('leaves an even fixture on the plain home-advantage baseline', () => {
    const table = Array.from({ length: 20 }, (_, i) => ({
      teamId: i + 1,
      played: 20,
      goalsFor: 28,
      goalsAgainst: 28,
    }));
    assert.deepEqual(winProb(makeSnapshot({ table }), 0), winProb(makeSnapshot(), 0));
  });

  it('ignores a table that does not contain this match’s teams', () => {
    // Captured standings persist across navigation within a tab, so a table
    // from another competition can outlive the match it came from. Looking
    // rows up by team id makes that harmless rather than wrong.
    const foreignTable = Array.from({ length: 20 }, (_, i) => ({
      teamId: 9000 + i,
      played: 20,
      goalsFor: 50,
      goalsAgainst: 10,
    }));
    assert.equal(prematchBaseline(makeSnapshot({ table: foreignTable })).source, 'league-average');
  });

  it('ignores a table when too few games have been played', () => {
    const table = Array.from({ length: 20 }, (_, i) => ({
      teamId: i + 1,
      played: 2,
      goalsFor: 3,
      goalsAgainst: 3,
    }));
    assert.equal(prematchBaseline(makeSnapshot({ table })).source, 'league-average');
  });
});

describe('live xG blending', () => {
  it('shifts toward the side actually creating chances', () => {
    const level = makeSnapshot({ shots: [...shotSeries(true, 1.5), ...shotSeries(false, 1.5)] });
    const homeDominant = makeSnapshot({ shots: [...shotSeries(true, 3.0), ...shotSeries(false, 0.3)] });
    assert.ok(winProb(homeDominant, 60).home > winProb(level, 60).home);
  });

  it('keeps the prior in charge at kickoff', () => {
    const quiet = makeSnapshot({ shots: [] });
    const loud = makeSnapshot({ shots: [...shotSeries(true, 3.0)] });
    assert.deepEqual(winProb(quiet, 0), winProb(loud, 0));
  });

  it('never lets a quiet spell drive lambda to zero', () => {
    const snapshot = makeSnapshot({ shots: [] });
    const { lambdaRemaining } = winProbDetailed(snapshot, 30);
    assert.ok(lambdaRemaining.home > 0.1, `lambda collapsed to ${lambdaRemaining.home}`);
  });
});

describe('timeline', () => {
  const snapshot = makeSnapshot({
    goals: [goal(12, true), goal(70, false)],
    redCards: [red(55, false)],
  });

  it('produces one point per minute through full time', () => {
    const timeline = buildTimeline(snapshot);
    assert.equal(timeline.points.length, FT + 1);
    assert.equal(timeline.points[0]!.minute, 0);
    assert.equal(timeline.points[FT]!.minute, FT);
  });

  it('marks every goal and red card with a running scoreline', () => {
    const timeline = buildTimeline(snapshot);
    assert.equal(timeline.markers.length, 3);
    assert.deepEqual(
      timeline.markers.map((m) => `${m.minute}:${m.kind}`),
      ['12:goal', '55:red', '70:goal'],
    );
    assert.equal(timeline.markers[0]!.label, '1-0');
    assert.equal(timeline.markers[2]!.label, '1-1');
  });

  it('names the scorer when the payload carried one', () => {
    const named = makeSnapshot({
      goals: [
        goal(12, true, 'B. Saka'),
        { minute: 70, isHome: false, ownGoal: true, scorer: 'W. Saliba', assist: null },
      ],
    });
    const { markers } = buildTimeline(named);
    assert.equal(markers[0]!.label, '1-0 — B. Saka');
    assert.equal(markers[1]!.label, '1-1 — W. Saliba (OG)', 'own goals still name the player');
  });

  it('credits the assist where the competition records one', () => {
    const assisted = makeSnapshot({
      goals: [
        goal(12, true, 'B. Saka', 'M. Ødegaard'),
        // An own goal is nobody's assist, whatever the payload claims.
        { minute: 70, isHome: false, ownGoal: true, scorer: 'W. Saliba', assist: 'B. Saka' },
      ],
    });
    const { markers } = buildTimeline(assisted);
    assert.equal(markers[0]!.label, '1-0 — B. Saka (Assist by M. Ødegaard)');
    assert.equal(markers[1]!.label, '1-1 — W. Saliba (OG)');
  });

  it('stops at the live clock instead of extrapolating into the future', () => {
    const live = makeSnapshot({
      status: { started: true, finished: false, cancelled: false, liveMinute: 63 },
      goals: [goal(12, true), goal(70, false)],
    });
    const timeline = buildTimeline(live);
    assert.equal(timeline.through, 63);
    assert.equal(timeline.markers.length, 1, 'a goal in the future must not be plotted');
  });

  it('estimates the clock from kickoff when none is reported', () => {
    // A quiet match would otherwise appear stuck at the minute of its last
    // shot, freezing both the timeline and the probability.
    const kickoff = Date.UTC(2026, 3, 12, 14, 0, 0);
    const live = makeSnapshot({
      status: { started: true, finished: false, cancelled: false, liveMinute: null },
      kickoffUtc: kickoff,
      shots: [{ minute: 12, isHome: true, xg: 0.3, isGoal: false }],
    });

    // 30 minutes after kickoff, before the interval.
    assert.equal(currentMinute(live, kickoff + 30 * 60_000), 30);
    // 75 minutes of wall clock, minus the 15-minute interval.
    assert.equal(currentMinute(live, kickoff + 75 * 60_000), 60);
    // Never past full time, however long the page has been open.
    assert.equal(currentMinute(live, kickoff + 300 * 60_000), live.fullTime);
  });

  it('falls back to the last event only when kickoff is unknown', () => {
    const live = makeSnapshot({
      status: { started: true, finished: false, cancelled: false, liveMinute: null },
      kickoffUtc: null,
      shots: [{ minute: 12, isHome: true, xg: 0.3, isGoal: false }],
    });
    assert.equal(currentMinute(live), 12);
  });

  it('renders a single point for a match that has not kicked off', () => {
    const pre = makeSnapshot({
      status: { started: false, finished: false, cancelled: false, liveMinute: null },
    });
    assert.equal(buildTimeline(pre).points.length, 1);
  });
});

describe('next-goal swing', () => {
  it('brackets the current probability', () => {
    const snapshot = makeSnapshot({
      status: { started: true, finished: false, cancelled: false, liveMinute: 70 },
    });
    const swing = nextGoalSwing(snapshot, 70);
    assert.ok(swing.ifHomeScores.home > swing.base.home);
    assert.ok(swing.ifAwayScores.home < swing.base.home);
  });
});
