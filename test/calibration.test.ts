import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { extractSnapshot } from '../src/model/extract.ts';
import type { MatchSnapshot } from '../src/model/types.ts';
import { winProb } from '../src/model/winprob.ts';

/**
 * Reliability check against real finished matches.
 *
 * Sanity tests prove the model is coherent; only this proves the numbers mean
 * anything. If the model says 70% and those matches are won 45% of the time,
 * the model is confidently wrong and the sanity tests would never notice.
 *
 * Fixtures are captured through the extension itself (the API is unreachable
 * without it) — see README. Drop the JSON into test/fixtures/.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CHECKPOINTS = [0, 15, 30, 45, 60, 75];
const BUCKETS = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001];

function loadFixtures(): MatchSnapshot[] {
  let files: string[];
  try {
    files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const snapshots: MatchSnapshot[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
      const snapshot = extractSnapshot(raw);
      // Only finished matches have a known answer to score against.
      if (snapshot.status.finished) snapshots.push(snapshot);
    } catch (error) {
      console.warn(`[calibration] skipped ${file}: ${(error as Error).message}`);
    }
  }
  return snapshots;
}

interface Prediction {
  predicted: number;
  happened: 0 | 1;
}

function collect(snapshots: MatchSnapshot[]): Prediction[] {
  const predictions: Prediction[] = [];

  for (const snapshot of snapshots) {
    const homeGoals = snapshot.goals.filter((g) => g.isHome).length;
    const awayGoals = snapshot.goals.filter((g) => !g.isHome).length;
    const actual = {
      home: homeGoals > awayGoals ? 1 : 0,
      draw: homeGoals === awayGoals ? 1 : 0,
      away: awayGoals > homeGoals ? 1 : 0,
    } as const;

    for (const minute of CHECKPOINTS) {
      if (minute >= snapshot.fullTime) continue;
      const p = winProb(snapshot, minute);
      predictions.push({ predicted: p.home, happened: actual.home });
      predictions.push({ predicted: p.draw, happened: actual.draw });
      predictions.push({ predicted: p.away, happened: actual.away });
    }
  }

  return predictions;
}

function reliabilityTable(predictions: Prediction[]) {
  return BUCKETS.slice(0, -1).map((lo, i) => {
    const hi = BUCKETS[i + 1]!;
    const inBucket = predictions.filter((p) => p.predicted >= lo && p.predicted < hi);
    const n = inBucket.length;
    const meanPredicted = n ? inBucket.reduce((s, p) => s + p.predicted, 0) / n : 0;
    const observed = n ? inBucket.reduce((s, p) => s + p.happened, 0) / n : 0;
    return { lo, hi, n, meanPredicted, observed };
  });
}

describe('calibration', () => {
  const snapshots = loadFixtures();

  it('has fixtures to score against', { skip: snapshots.length === 0 ? 'no fixtures in test/fixtures — capture some first (see README)' : false }, () => {
    assert.ok(snapshots.length > 0);
  });

  it(
    'is well calibrated across finished matches',
    { skip: snapshots.length === 0 ? 'no fixtures' : false },
    () => {
      const predictions = collect(snapshots);
      const table = reliabilityTable(predictions);

      const brier =
        predictions.reduce((s, p) => s + (p.predicted - p.happened) ** 2, 0) / predictions.length;

      console.log(`\n  Reliability — ${snapshots.length} matches, ${predictions.length} predictions`);
      console.log('  bucket        n     predicted   observed   gap');
      for (const row of table) {
        if (row.n === 0) continue;
        const gap = row.observed - row.meanPredicted;
        console.log(
          `  ${(row.lo * 100).toFixed(0).padStart(3)}-${(Math.min(row.hi, 1) * 100).toFixed(0).padEnd(3)} ` +
            `${String(row.n).padStart(6)}   ${row.meanPredicted.toFixed(3).padStart(9)}   ` +
            `${row.observed.toFixed(3).padStart(8)}   ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}`,
        );
      }
      console.log(`  Brier score: ${brier.toFixed(4)} (lower is better; 0.25 = always guessing 50%)\n`);
      console.log(
        '  Note: predictions from the same match are correlated, so treat small\n' +
          '  fixture sets as indicative rather than significant.\n',
      );

      // Buckets thin enough to be noise are reported but not asserted on.
      for (const row of table) {
        if (row.n < 30) continue;
        const gap = Math.abs(row.observed - row.meanPredicted);
        assert.ok(
          gap <= 0.1,
          `bucket ${row.lo}-${row.hi} is off by ${gap.toFixed(3)} ` +
            `(predicted ${row.meanPredicted.toFixed(3)}, observed ${row.observed.toFixed(3)}, n=${row.n})`,
        );
      }

      assert.ok(brier < 0.25, `Brier ${brier.toFixed(4)} is no better than guessing`);
    },
  );

  it(
    'lands on the right answer by full time',
    { skip: snapshots.length === 0 ? 'no fixtures' : false },
    () => {
      for (const snapshot of snapshots) {
        const homeGoals = snapshot.goals.filter((g) => g.isHome).length;
        const awayGoals = snapshot.goals.filter((g) => !g.isHome).length;
        const p = winProb(snapshot, snapshot.fullTime);
        const winner = homeGoals > awayGoals ? p.home : awayGoals > homeGoals ? p.away : p.draw;
        assert.ok(
          winner > 0.98,
          `${snapshot.matchId} finished ${homeGoals}-${awayGoals} but full-time probability was ${winner.toFixed(3)}`,
        );
      }
    },
  );
});
