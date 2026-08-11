import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTimeline } from '../src/model/replay.ts';
import {
  CHART,
  minuteAtX,
  renderEvents,
  renderTimeline,
  resolveColors,
  xForMinute,
} from '../src/popup/chart.ts';
import { goal, makeSnapshot, red } from './helpers.ts';

/**
 * The chart is generated SVG, so its structure is testable without a browser.
 * These lock in the geometry bugs the model tests cannot see: a chart can be
 * built from perfectly correct probabilities and still draw wrong.
 */

const colors = { home: '#2563eb', away: '#dc2626' };

function polylines(svg: string): string[] {
  return [...svg.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1]!);
}

function pointsOf(polyline: string): Array<[number, number]> {
  return polyline.split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return [x!, y!];
  });
}

describe('timeline chart', () => {
  const finished = makeSnapshot({
    goals: [goal(23, true), goal(58, false), goal(77, true)],
    redCards: [red(65, false)],
  });

  it('draws one line per outcome', () => {
    const svg = renderTimeline(buildTimeline(finished), colors);
    assert.equal(polylines(svg).length, 3, 'home, draw and away each need a line');
  });

  it('gives every line the same number of points as the timeline', () => {
    const timeline = buildTimeline(finished);
    const svg = renderTimeline(timeline, colors);
    for (const line of polylines(svg)) {
      assert.equal(pointsOf(line).length, timeline.points.length);
    }
  });

  it('keeps every point inside the plot area', () => {
    const svg = renderTimeline(buildTimeline(finished), colors);
    for (const line of polylines(svg)) {
      for (const [x, y] of pointsOf(line)) {
        assert.ok(x >= CHART.padLeft - 0.5 && x <= CHART.width - CHART.padRight + 0.5, `x ${x}`);
        assert.ok(y >= CHART.padTop - 0.5 && y <= CHART.height - CHART.padBottom + 0.5, `y ${y}`);
      }
    }
  });

  it('stacks the three lines to full height at every minute', () => {
    // y = padTop + (1 - p) * plotHeight, and the three probabilities sum to 1,
    // so the y values must sum to 3*padTop + 2*plotHeight at every minute.
    // A scaling error in any one line breaks this.
    const svg = renderTimeline(buildTimeline(finished), colors);
    const [away, draw, home] = polylines(svg).map(pointsOf);
    const plotHeight = CHART.height - CHART.padBottom - CHART.padTop;
    const expected = 3 * CHART.padTop + 2 * plotHeight;

    for (let i = 0; i < home!.length; i++) {
      const total = home![i]![1] + draw![i]![1] + away![i]![1];
      assert.ok(Math.abs(total - expected) < 0.4, `minute ${i} summed to ${total}, want ${expected}`);
    }
  });

  it('runs the lines to the right edge for a finished match', () => {
    const svg = renderTimeline(buildTimeline(finished), colors);
    const last = pointsOf(polylines(svg)[0]!).at(-1)!;
    assert.ok(Math.abs(last[0] - (CHART.width - CHART.padRight)) < 0.5);
    assert.ok(!svg.includes('class="unplayed"'), 'a finished match has nothing left to play');
  });

  it('stops at the current minute on a live match and shades the rest', () => {
    const live = makeSnapshot({
      status: { started: true, finished: false, cancelled: false, liveMinute: 60 },
      goals: [goal(23, true)],
    });
    const timeline = buildTimeline(live);
    const svg = renderTimeline(timeline, colors);

    const last = pointsOf(polylines(svg)[0]!).at(-1)!;
    assert.ok(Math.abs(last[0] - xForMinute(60, timeline.fullTime)) < 0.5);
    assert.ok(svg.includes('class="unplayed"'), 'the rest of the match needs its own treatment');
    assert.ok(svg.includes('class="now"'), 'the live edge should be marked');
  });

  it('emits no NaN or undefined coordinates', () => {
    for (const snapshot of [finished, makeSnapshot()]) {
      const svg = renderTimeline(buildTimeline(snapshot), colors);
      assert.ok(!svg.includes('NaN'), 'NaN in a polyline silently drops the whole line');
      assert.ok(!svg.includes('undefined'));
    }
  });

  it('marks goals in the colour of the side that scored', () => {
    const svg = renderTimeline(buildTimeline(finished), colors);
    const fills = [...svg.matchAll(/<circle [^>]*fill="([^"]+)"[^>]*class="marker-dot"/g)].map(
      (m) => m[1]!,
    );
    // Three goals: 23' and 77' home, 58' away.
    assert.equal(fills.length, 3);
    assert.equal(fills.filter((f) => f === colors.home).length, 2);
    assert.equal(fills.filter((f) => f === colors.away).length, 1);
    // Each is a ball, not a plain dot: one centre panel and five seams apiece.
    assert.equal([...svg.matchAll(/class="ball-face"/g)].length, 3);
    assert.equal([...svg.matchAll(/class="ball-seam"/g)].length, 15);

    // The red card is drawn as a card, in its own colour.
    assert.ok(/<rect [^>]*fill="#e5484d"/.test(svg), 'red card marker missing');
  });

  it('keeps every marker in its lane above the plot', () => {
    // A marker inside the plot lands on whichever line passes through it.
    const svg = renderTimeline(buildTimeline(finished), colors);
    const glyphs = [...svg.matchAll(/<(?:circle|rect) [^>]*class="marker-dot"[^>]*\/>/g)].map(
      (m) => m[0]!,
    );
    assert.equal(glyphs.length, 4, 'three goals and a red card');

    for (const glyph of glyphs) {
      const cy = Number(/cy="([\d.]+)"/.exec(glyph)?.[1] ?? NaN);
      const r = Number(/ r="([\d.]+)"/.exec(glyph)?.[1] ?? NaN);
      const y = Number(/ y="([\d.]+)"/.exec(glyph)?.[1] ?? NaN);
      const bottom = Number.isNaN(cy)
        ? y + Number(/height="([\d.]+)"/.exec(glyph)?.[1] ?? NaN)
        : cy + r;
      assert.ok(bottom < CHART.padTop, `marker reaches ${bottom}, into the plot at ${CHART.padTop}`);
    }
  });

  it('maps a hover position back to the right minute', () => {
    const fullTime = 95;
    for (const minute of [0, 23, 45, 90, 95]) {
      assert.equal(minuteAtX(xForMinute(minute, fullTime), fullTime), minute);
    }
    // Inside the axis gutter clamps to kickoff rather than going negative.
    assert.equal(minuteAtX(0, fullTime), 0);
    assert.equal(minuteAtX(CHART.width + 50, fullTime), fullTime);
  });
});

describe('goal summary', () => {
  const teams = { home: 'Liverpool', away: 'Manchester City' };

  it('colours each row by the side the event belongs to', () => {
    const timeline = buildTimeline(
      makeSnapshot({ goals: [goal(23, true, 'M. Salah'), goal(58, false, 'E. Haaland')] }),
    );
    const html = renderEvents(timeline, teams, colors);
    const swatches = [...html.matchAll(/class="swatch" style="background:([^"]+)"/g)].map(
      (m) => m[1]!,
    );

    // Newest first, so the away goal leads.
    assert.deepEqual(swatches, [colors.away, colors.home]);
    assert.ok(html.includes('title="Manchester City"'), 'colour needs a non-visual fallback');
    assert.ok(html.indexOf('E. Haaland') < html.indexOf('M. Salah'));
  });

  it('lists the red card against the side that was shown it', () => {
    const timeline = buildTimeline(makeSnapshot({ redCards: [red(65, false)] }));
    const html = renderEvents(timeline, teams, colors);
    assert.ok(html.includes(`background:${colors.away}`));
  });

  it('keeps only the most recent events', () => {
    const many = makeSnapshot({
      goals: Array.from({ length: 9 }, (_, i) => goal(i * 10 + 1, i % 2 === 0)),
    });
    const html = renderEvents(buildTimeline(many), teams, colors);
    assert.equal([...html.matchAll(/<li /g)].length, 6);
    assert.ok(html.includes('81\''), 'the latest event must survive the cut');
  });

  it('renders nothing at all for a match with no events', () => {
    assert.equal(renderEvents(buildTimeline(makeSnapshot()), teams, colors), '');
  });

  it('escapes names, which come from FotMob', () => {
    const hostile = buildTimeline(
      makeSnapshot({ goals: [goal(10, true, '<img src=x onerror=alert(1)>')] }),
    );
    const html = renderEvents(hostile, { home: '"><script>', away: 'B' }, colors);
    assert.ok(!html.includes('<img'), html);
    assert.ok(!html.includes('<script'), html);
  });
});

describe('line colours', () => {
  it('replaces a kit colour that would vanish into the background', () => {
    // Tottenham white against a light popup, Newcastle black against a dark one.
    const invisible = makeSnapshot({ colors: { home: '#ffffff', away: '#241f20' } });
    const resolved = resolveColors(invisible);
    assert.notEqual(resolved.home, '#ffffff');
    assert.notEqual(resolved.away, '#241f20');
    assert.notEqual(resolved.home, resolved.away);
  });

  it('replaces kit colours that clash with each other', () => {
    const clashing = makeSnapshot({ colors: { home: '#d00027', away: '#c8102e' } });
    const resolved = resolveColors(clashing);
    assert.notEqual(resolved.home, resolved.away);
  });

  it('keeps distinguishable mid-brightness kit colours', () => {
    const fine = makeSnapshot({ colors: { home: '#d00027', away: '#6cabdd' } });
    assert.deepEqual(resolveColors(fine), { home: '#d00027', away: '#6cabdd' });
  });

  it('never returns a colour matching the draw line', () => {
    const greyish = makeSnapshot({ colors: { home: '#64748b', away: '#6b7280' } });
    const resolved = resolveColors(greyish);
    assert.notEqual(resolved.home, '#64748b');
    assert.notEqual(resolved.away, '#64748b');
  });
});
