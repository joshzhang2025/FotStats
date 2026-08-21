/**
 * Every tunable constant in the model. Nothing outside this file hardcodes a
 * number that affects a probability, so the calibration harness can sweep
 * parameters without touching model logic.
 */

export interface LeagueBaseline {
  homeLambda: number;
  awayLambda: number;
}

/**
 * Fallback baselines, used when the payload carries no usable league table or
 * the season is too young for per-team rates to mean anything. Rough long-run
 * goals-per-match splits.
 */
export const LEAGUE_BASELINES: Record<string, LeagueBaseline> = {
  // Premier League
  '47': { homeLambda: 1.55, awayLambda: 1.25 },
  // MLS — higher scoring, stronger home advantage (travel + altitude spread)
  '130': { homeLambda: 1.65, awayLambda: 1.3 },
};

export const DEFAULT_BASELINE: LeagueBaseline = { homeLambda: 1.55, awayLambda: 1.25 };

export const PARAMS = {
  /**
   * Nominal end of the match including stoppage. Modern matches run ~6-7 added
   * minutes across both halves; for a live match we cannot know the real figure
   * yet, so we assume this.
   */
  expectedFullTime: 95,

  table: {
    /** Below this many played, table rates are noise — fall back to baseline. */
    minPlayed: 5,
    /**
     * Last season's record, carried into this one as this many pseudo-games.
     *
     * Needs the results archive, so only the historical paths can use it. The
     * prior's weight is `priorGames / (priorGames + played)`, so it falls out
     * of the arithmetic rather than needing a decay schedule: dominant on the
     * opening weekend, about a third by midwinter, a fifth by May.
     *
     * Swept against 12 seasons of Premier League results — `npm run tune-prior`.
     * The optimum is flat, and the two halves of the archive disagree about
     * where it sits (20 and 12), so this is the smallest value inside both
     * halves' error bands rather than the single best-scoring one. It leans
     * least on a season already over, and costs 0.0004 Brier against the peak.
     */
    priorGames: 10,
    /**
     * A promoted club has no previous top-flight record, so it starts from the
     * league average scaled by these. Measured over 33 promoted clubs across
     * 11 seasons: they scored 0.71x and conceded 1.23x the league average, and
     * the direction held in every single season.
     *
     * Without this, a promoted side is priced as an average one and the model
     * overrates it for the two months it takes real games to outweigh the prior.
     */
    promotedAttack: 0.71,
    promotedDefence: 1.23,
    /**
     * How long after the archive's last result the prior alone may stand in
     * for a table, in days.
     *
     * Between a season ending in May and the archive being regenerated, no
     * stored season covers today, and FotMob's live table is all zeroes — so
     * the model has nothing and prices every match on home advantage alone.
     * Last season's rates are the honest answer there, and are exactly what
     * was known at kickoff on the opening weekend.
     *
     * Bounded because a prior only stays meaningful for the season directly
     * after it. Beyond that the file is two seasons stale, and by then the
     * live table has a real season in it anyway — so expiring here falls back
     * to something better, not worse.
     */
    priorOnlyMaxDays: 400,
    /** Attack/defence strength ratios are clamped into this band. */
    minStrength: 0.6,
    maxStrength: 1.6,
    /**
     * Regression to the mean, as an exponent on each strength ratio. A single
     * season overstates true strength: the best attack in the league is not
     * really 1.8x the average one, it has also been lucky.
     */
    shrink: 0.8,
    /**
     * Clamp on the resulting lambda, not just its components. Two extreme
     * multipliers compound — a top attack against a bottom defence otherwise
     * reaches 2.5x the baseline, and prices the match beyond anything real.
     * No Premier League side is a genuine 3-goal favourite.
     */
    minLambda: 0.35,
    maxLambda: 3.0,
  },

  liveXg: {
    /**
     * Shrinkage constant, in minutes. The prior keeps weight K/(K+t), so at
     * t=K the live shotmap and the pre-match baseline carry equal weight.
     */
    k: 45,
    /**
     * Floor on the observed rate, as a fraction of the prior rate. Without this
     * a quiet opening ten minutes drives lambda toward zero and the model
     * claims a 0-0 is nearly settled by minute 12.
     */
    rateFloorFraction: 0.25,
    /** Symmetric ceiling — one early penalty should not imply a 6-goal game. */
    rateCeilFraction: 3.0,
  },

  redCard: {
    /**
     * Per red card. A side down to 10 creates less and concedes more for every
     * remaining minute; the "an early red matters more" effect needs no special
     * handling, it falls out of there being more minutes left to apply it to.
     */
    attackMult: 0.7,
    concedeMult: 1.3,
    /** Cap the compounding at this many cards (9 v 11 is already extreme). */
    maxCards: 2,
  },

  gameState: {
    /** Trailing sides push; leading sides sit. Scaled by deficit and by clock. */
    trailPush: 0.13,
    leadSit: 0.07,
    /** Deficits beyond this stop changing behaviour (the game is gone). */
    maxDeficit: 3,
    /** Effect strength runs from this fraction at kickoff to 1.0 at full time. */
    earlyFactor: 0.5,
  },

  /**
   * Goals are not uniform across a match — the rate climbs steadily toward
   * full time. Modelled as a linear weight over the clock, normalised to mean 1
   * so it redistributes risk without changing the expected total.
   * w(m) = 1 + tilt * (m/T - 0.5)
   */
  minuteWeight: {
    tilt: 0.4,
  },

  dixonColes: {
    enabled: true,
    /**
     * Negative rho inflates 0-0 and 1-1 and deflates 1-0 and 0-1 — the standard
     * low-score dependence correction. Faded toward zero as the match runs down,
     * since the correction is defined over a whole match, not a remainder.
     */
    rho: -0.13,
  },

  lateDraw: {
    enabled: true,
    /** From this minute, a level match starts damping both attacks. */
    fromMinute: 80,
    /** Peak damping applied to both lambdas at full time. */
    damp: 0.15,
  },

  /** Remaining-goal grid bound. 8 covers >99.99% of mass at realistic lambdas. */
  gridMax: 8,
} as const;

export type Params = typeof PARAMS;
