import type { WinProb } from './types.ts';

/** Poisson pmf. Computed in log space so large k cannot overflow the factorial. */
export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k));
}

const LOG_FACTORIAL_CACHE = [0, 0];
function logFactorial(n: number): number {
  for (let i = LOG_FACTORIAL_CACHE.length; i <= n; i++) {
    LOG_FACTORIAL_CACHE[i] = LOG_FACTORIAL_CACHE[i - 1]! + Math.log(i);
  }
  return LOG_FACTORIAL_CACHE[n]!;
}

/**
 * Dixon-Coles low-score dependence correction.
 *
 * Independent Poisson underestimates 0-0 and 1-1 and overestimates 1-0 and 0-1;
 * tau reweights exactly those four cells and leaves the rest untouched.
 */
export function dixonColesTau(
  x: number,
  y: number,
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
): number {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (x === 0 && y === 1) return 1 + lambdaHome * rho;
  if (x === 1 && y === 0) return 1 + lambdaAway * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

export interface OutcomeOptions {
  /** Goals already on the board, added to every remaining-goal combination. */
  homeGoals: number;
  awayGoals: number;
  gridMax: number;
  /** Pass 0 to disable the low-score correction. */
  rho: number;
}

/**
 * Distribute remaining goals over a grid and fold each cell into the win/draw/
 * loss bucket its *final* scoreline implies.
 */
export function outcomeProbabilities(
  lambdaHome: number,
  lambdaAway: number,
  opts: OutcomeOptions,
): WinProb {
  const { homeGoals, awayGoals, gridMax, rho } = opts;

  const homePmf: number[] = [];
  const awayPmf: number[] = [];
  for (let i = 0; i <= gridMax; i++) {
    homePmf.push(poissonPmf(i, lambdaHome));
    awayPmf.push(poissonPmf(i, lambdaAway));
  }

  let home = 0;
  let draw = 0;
  let away = 0;

  for (let h = 0; h <= gridMax; h++) {
    for (let a = 0; a <= gridMax; a++) {
      let p = homePmf[h]! * awayPmf[a]!;
      if (rho !== 0) p *= dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
      if (p <= 0) continue;

      const diff = homeGoals + h - (awayGoals + a);
      if (diff > 0) home += p;
      else if (diff < 0) away += p;
      else draw += p;
    }
  }

  // The grid truncates a sliver of mass, and tau is not measure-preserving for
  // an arbitrary rho. Renormalising makes the three always sum to exactly 1.
  const total = home + draw + away;
  if (total <= 0) return { home: 0, draw: 1, away: 0 };
  return { home: home / total, draw: draw / total, away: away / total };
}
