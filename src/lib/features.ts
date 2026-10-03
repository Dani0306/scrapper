/**
 * Draw-probability model.
 *
 * Method (see docs/draw-model.md):
 *   - Maher (1982) multiplicative Poisson strengths, estimated from the
 *     season-to-date tables: attack_i = goals for per game ÷ league rate,
 *     defence_i = goals against per game ÷ league rate.
 *   - Gamma–Poisson shrinkage of every rate toward its prior (league mean for
 *     team strengths, the team's own overall rate for venue splits, the pooled
 *     snapshot for league-level rates). Prior strengths are estimated from the
 *     snapshot by the method of moments (empirical Bayes), see estimatePriors().
 *   - Dixon & Coles (1997) low-score dependence τ(x, y; ρ). A pooled ρ is
 *     fitted so that predicted draws over every league match observed draws.
 *     Each league's draw rate is shrunk toward the rate the model implies for
 *     that league at the pooled ρ, and the league's own ρ is then fitted so the
 *     mean draw probability over a home-and-away round robin of its teams
 *     equals that shrunk rate.
 *
 * Everything in this file is pure: no I/O, no fixture filtering, no staking.
 */

// ---------- inputs ----------

/** One row of a standings table (overall, home or away) for one team. */
export interface TableRow {
  totalGames: number;
  goalsFor: number;
  goalsAgainst: number;
  /** Draw count for the games in this row, when known. */
  draws?: number;
}

export interface TeamInput {
  team?: string;
  overall: TableRow;
  home?: TableRow;
  away?: TableRow;
}

export interface LeagueInput {
  /** Stable league id (the map entry the rows were scraped from). */
  league: string;
  teams: TeamInput[];
}

export interface Calibration {
  a: number;
  b: number;
}

export interface DrawProbabilityOptions {
  /** Poisson truncation: goals 0..K per side. */
  K?: number;
  /** Logistic recalibration logit(p') = a + b·logit(p). Fit it once results exist. */
  calibrate?: Calibration | null;
}

// ---------- priors ----------

/**
 * Pooled parameters that every league model is shrunk toward. All variances are
 * variances of the *true* quantity between groups (teams or leagues), i.e. after
 * removing sampling noise. estimatePriors() fits them from a snapshot; the
 * defaults below are assumptions used when a snapshot is too small to tell.
 */
export interface Priors {
  /** Relative variance (CV²) of true attack / defence multipliers between teams. */
  attackCv2: number;
  defenceCv2: number;
  /** Relative variance of a team's venue-specific deviation from its own rate. */
  venueAttackCv2: number;
  venueDefenceCv2: number;
  /** League goals per team-game. */
  teamGoals: { mean: number; variance: number };
  /** Share of a match's goals scored by the home side. */
  homeShare: { mean: number; variance: number };
  /**
   * mean: pooled draw rate (drawn matches ÷ matches), for reporting.
   * excessVariance: variance of a league's true draw rate around the rate the
   * model implies for it at the pooled ρ (league-specific "draw excess").
   */
  drawRate: { mean: number; excessVariance: number };
  /**
   * Pooled Dixon–Coles ρ: predicted draws over all leagues equal observed draws.
   * Every league's draw rate is shrunk toward its model rate at this ρ.
   */
  rho: number;
}

export const DEFAULT_PRIORS: Priors = {
  attackCv2: 0.07, // CV ≈ 26 % → prior weight ≈ 1/(0.07·1.35) ≈ 10.6 games
  defenceCv2: 0.07,
  venueAttackCv2: 0.015, // CV ≈ 12 % → prior weight ≈ 49 games
  venueDefenceCv2: 0.015,
  teamGoals: { mean: 1.35, variance: 0.015 }, // sd ≈ 0.12 goals
  homeShare: { mean: 0.56, variance: 0.0004 }, // sd ≈ 2 pp
  drawRate: { mean: 0.26, excessVariance: 0.0004 }, // sd ≈ 2 pp
  rho: -0.06,
};

const PRIOR_BOUNDS = {
  attackCv2: [0.02, 0.3],
  venueCv2: [0.002, 0.1],
  teamGoalsMean: [0.8, 2.2],
  teamGoalsVariance: [0.003, 0.1],
  homeShareMean: [0.45, 0.65],
  homeShareVariance: [0.0001, 0.01],
  drawRateMean: [0.15, 0.4],
  drawExcessVariance: [0.0001, 0.005],
} as const;

/** Minimum group counts before a method-of-moments estimate replaces the default. */
const MIN_TEAMS_FOR_PRIOR = 40;
const MIN_LEAGUES_FOR_PRIOR = 8;

// ---------- league model ----------

/** Goal-rate part of a league model: everything team strengths need. */
export interface LeagueRates {
  league: string;
  teams: number;
  /** Matches played so far (Σ overall games ÷ 2). */
  matches: number;
  /** Shrunk league goals per team-game (L). */
  teamGoals: number;
  /** Expected goals of an average home side against an average away side. */
  homeGoals: number;
  /** Expected goals of an average away side against an average home side. */
  awayGoals: number;
  /** Prior weights, in games, for the Gamma–Poisson shrinkage. */
  kAttack: number;
  kDefence: number;
  kVenueAttack: number;
  kVenueDefence: number;
}

export interface LeagueModel extends LeagueRates {
  /** Observed league draw rate, when the tables carry draw counts. */
  drawRate: number | undefined;
  /** Mean round-robin draw probability at the pooled ρ: the shrinkage target. */
  drawRatePrior: number;
  /** Observed draw rate shrunk toward drawRatePrior; the target ρ was fitted to. */
  drawRateShrunk: number;
  rho: number;
  /** True when ρ was fitted to a target that includes this league's own draws. */
  rhoFitted: boolean;
}

export interface TeamStrength {
  /** Shrunk overall multipliers (league average = 1). */
  att: number;
  def: number;
  /** Multipliers at the venue the team plays this fixture at. */
  attVenue: number;
  defVenue: number;
  games: number;
  venueGames: number;
  usedVenue: boolean;
}

export interface DrawProbabilityResult {
  homeTeam: string | undefined;
  awayTeam: string | undefined;
  /** 0–100. */
  drawPercentage: number;
  gameDate: string;
  meta: {
    lambdaHome: number;
    lambdaAway: number;
    /** ρ after clamping to the range where every Dixon–Coles cell is ≥ 0. */
    rho: number;
    K: number;
    /** Draw probability of the same λs under independent Poisson (ρ = 0). */
    pIndependent: number;
    strengths: {
      homeAtt: number;
      homeDef: number;
      awayAtt: number;
      awayDef: number;
    };
    games: { home: number; away: number };
    usedVenue: { home: boolean; away: boolean };
    league: Pick<
      LeagueModel,
      | "league"
      | "teamGoals"
      | "homeGoals"
      | "awayGoals"
      | "drawRate"
      | "drawRatePrior"
      | "drawRateShrunk"
      | "rhoFitted"
      | "kAttack"
      | "kDefence"
      | "kVenueAttack"
      | "kVenueDefence"
    >;
    calibrate: Calibration | null;
    method: string;
  };
}

export const METHOD =
  "Maher Poisson strengths + Dixon–Coles ρ fitted to league draw rate, empirical-Bayes shrinkage (v2)";

// ---------- constants ----------

export const DEFAULT_K = 15;
export const RHO_MIN = -0.5;
export const RHO_MAX = 0.35;
const LAMBDA_MIN = 0.05;
const LAMBDA_MAX = 6;
const K_MIN = 1;
const K_MAX = 500;

// ---------- small numeric helpers ----------

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** Non-negative finite number, else 0. Table cells can be NaN after a bad parse. */
const count = (x: number | undefined): number =>
  x !== undefined && Number.isFinite(x) && x > 0 ? x : 0;

const clampRate = (x: number): number =>
  Number.isFinite(x) ? clamp(x, LAMBDA_MIN, LAMBDA_MAX) : LAMBDA_MIN;

const round4 = (x: number): number => Number(x.toFixed(4));

/**
 * Posterior mean of a Gamma–Poisson model, written as a weighted average in
 * game units: `games` observations of `goals / (games · rate)` against a prior
 * multiplier `prior` worth `k` games.
 */
export function shrinkMultiplier(
  goals: number,
  games: number,
  rate: number,
  prior: number,
  k: number,
): number {
  const n = count(games);
  const g = count(goals);
  const r = rate > 0 ? rate : 1;
  return (g / r + k * prior) / (n + k);
}

/**
 * Method-of-moments estimate of the variance of the true values across groups:
 * the observed variance around `mean` minus the average sampling variance.
 * Returns undefined with too few groups; may be ≤ 0 (caller clamps).
 */
function excessVariance(
  obs: Array<{ value: number; samplingVar: number }>,
  mean: number,
  minN: number,
): number | undefined {
  if (obs.length < minN) return undefined;
  let ss = 0;
  let sv = 0;
  for (const o of obs) {
    ss += (o.value - mean) ** 2;
    sv += o.samplingVar;
  }
  return (ss - sv) / obs.length;
}

// ---------- Poisson + Dixon–Coles ----------

function poissonSeries(lambda: number, K: number): number[] {
  const out = new Array<number>(K + 1).fill(0);
  let p = Math.exp(-lambda);
  out[0] = p;
  for (let k = 1; k <= K; k++) {
    p = (p * lambda) / k;
    out[k] = p;
  }
  return out;
}

/** Dixon & Coles (1997) eq. 4.2: dependence factor for the low-score cells. */
export function dixonColesTau(
  x: number,
  y: number,
  rho: number,
  lambdaHome: number,
  lambdaAway: number,
): number {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (x === 0 && y === 1) return 1 + lambdaHome * rho;
  if (x === 1 && y === 0) return 1 + lambdaAway * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Largest ρ range for which every τ cell stays ≥ 0 at these rates. */
export function validRho(
  rho: number,
  lambdaHome: number,
  lambdaAway: number,
): number {
  const eps = 1e-6;
  const lo = -1 / Math.max(lambdaHome, lambdaAway) + eps;
  const hi = Math.min(1, 1 / (lambdaHome * lambdaAway)) - eps;
  return clamp(rho, lo, hi);
}

export interface RateDrawProbability {
  pDraw: number;
  pIndependent: number;
  rho: number;
}

/**
 * P(draw) for Poisson rates λ (home) and μ (away) with the Dixon–Coles
 * correction. Equals P_independent − 2ρλμ·e^(−λ−μ).
 */
export function drawProbabilityFromRates(
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
  K = DEFAULT_K,
): RateDrawProbability {
  const lh = clampRate(lambdaHome);
  const la = clampRate(lambdaAway);
  const r = validRho(Number.isFinite(rho) ? rho : 0, lh, la);
  const ph = poissonSeries(lh, K);
  const pa = poissonSeries(la, K);
  let pIndependent = 0;
  let pDraw = 0;
  for (let k = 0; k <= K; k++) {
    const joint = (ph[k] ?? 0) * (pa[k] ?? 0);
    pIndependent += joint;
    pDraw += joint * dixonColesTau(k, k, r, lh, la);
  }
  return { pDraw: clamp(pDraw, 0, 1), pIndependent, rho: r };
}

function calibrateProb(p: number, a: number, b: number): number {
  const eps = 1e-9;
  const pp = clamp(p, eps, 1 - eps);
  const z = a + b * Math.log(pp / (1 - pp));
  return 1 / (1 + Math.exp(-z));
}

type RatePair = readonly [number, number];

/** Mean draw probability over (λ_home, λ_away) pairs at a given ρ. */
export function meanDrawProbability(
  pairs: ReadonlyArray<RatePair>,
  rho: number,
  K = DEFAULT_K,
): number {
  if (pairs.length === 0) return 0;
  let s = 0;
  for (const [lh, la] of pairs) s += drawProbabilityFromRates(lh, la, rho, K).pDraw;
  return s / pairs.length;
}

/**
 * Solves meanAt(ρ) = target on [RHO_MIN, RHO_MAX] by bisection; meanAt must be
 * decreasing in ρ. Returns the bound when the target is out of reach.
 */
function solveRho(meanAt: (rho: number) => number, target: number): number {
  let lo = RHO_MIN;
  let hi = RHO_MAX;
  if (meanAt(lo) <= target) return lo;
  if (meanAt(hi) >= target) return hi;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (meanAt(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Finds ρ such that the mean draw probability over `pairs` equals `target`.
 * The mean is strictly decreasing in ρ. Returns the bound when the target is
 * outside what the Dixon–Coles family can reach.
 */
export function fitRho(
  pairs: ReadonlyArray<RatePair>,
  target: number,
  K = DEFAULT_K,
): number {
  if (pairs.length === 0) return DEFAULT_PRIORS.rho;
  return solveRho((rho) => meanDrawProbability(pairs, rho, K), target);
}

// ---------- league sums ----------

interface LeagueSums {
  teams: number;
  teamGames: number;
  goals: number;
  /** Overall games and draws of the rows that carry a draw count. */
  drawTeamGames: number;
  draws: number;
  homeGames: number;
  homeGoals: number;
  awayGames: number;
  awayGoals: number;
}

function summariseLeague(input: LeagueInput): LeagueSums {
  const s: LeagueSums = {
    teams: input.teams.length,
    teamGames: 0,
    goals: 0,
    drawTeamGames: 0,
    draws: 0,
    homeGames: 0,
    homeGoals: 0,
    awayGames: 0,
    awayGoals: 0,
  };
  for (const t of input.teams) {
    const n = count(t.overall.totalGames);
    s.teamGames += n;
    s.goals += count(t.overall.goalsFor);
    if (t.overall.draws !== undefined && Number.isFinite(t.overall.draws)) {
      s.drawTeamGames += n;
      s.draws += clamp(count(t.overall.draws), 0, n);
    }
    if (t.home) {
      s.homeGames += count(t.home.totalGames);
      s.homeGoals += count(t.home.goalsFor);
    }
    if (t.away) {
      s.awayGames += count(t.away.totalGames);
      s.awayGoals += count(t.away.goalsFor);
    }
  }
  return s;
}

// ---------- empirical-Bayes priors ----------

/**
 * Estimates the pooled priors from a whole snapshot by the method of moments.
 * Each quantity falls back to `base` when the snapshot has too few groups.
 */
export function estimatePriors(
  leagues: LeagueInput[],
  base: Priors = DEFAULT_PRIORS,
  K = DEFAULT_K,
): Priors {
  const att: Array<{ value: number; samplingVar: number }> = [];
  const def: Array<{ value: number; samplingVar: number }> = [];
  const venueAtt: Array<{ value: number; samplingVar: number }> = [];
  const venueDef: Array<{ value: number; samplingVar: number }> = [];
  const goalRates: Array<{ value: number; samplingVar: number }> = [];
  const shares: Array<{ value: number; samplingVar: number }> = [];
  let goals = 0;
  let teamGames = 0;
  let homeGoals = 0;
  let venueGoals = 0;
  let draws = 0;
  let drawTeamGames = 0;

  for (const league of leagues) {
    const s = summariseLeague(league);
    if (s.teamGames === 0 || s.goals === 0) continue;
    const L = s.goals / s.teamGames;
    goals += s.goals;
    teamGames += s.teamGames;
    // Var(goals) = goals under Poisson, so Var(L) = L / teamGames.
    if (s.teamGames >= 20) goalRates.push({ value: L, samplingVar: L / s.teamGames });

    const vg = s.homeGoals + s.awayGoals;
    const Lh = s.homeGames > 0 ? s.homeGoals / s.homeGames : 0;
    const La = s.awayGames > 0 ? s.awayGoals / s.awayGames : 0;
    if (vg >= 20 && Lh > 0 && La > 0) {
      const share = s.homeGoals / vg;
      homeGoals += s.homeGoals;
      venueGoals += vg;
      shares.push({ value: share, samplingVar: (share * (1 - share)) / vg });
    }

    draws += s.draws;
    drawTeamGames += s.drawTeamGames;

    for (const t of league.teams) {
      const n = count(t.overall.totalGames);
      if (n < 1) continue;
      // Multiplier m = goals / (n·L); Var(m | true) = true / (n·L) ≈ 1 / (n·L).
      att.push({ value: count(t.overall.goalsFor) / (n * L), samplingVar: 1 / (n * L) });
      def.push({ value: count(t.overall.goalsAgainst) / (n * L), samplingVar: 1 / (n * L) });
      if (Lh > 0 && La > 0 && t.home && t.away) {
        const nh = count(t.home.totalGames);
        const na = count(t.away.totalGames);
        if (nh < 1 || na < 1) continue;
        // Home − away multiplier of the same team: mean 0, variance 2σ²(1+CV²) + noise.
        venueAtt.push({
          value: count(t.home.goalsFor) / (nh * Lh) - count(t.away.goalsFor) / (na * La),
          samplingVar: 1 / (nh * Lh) + 1 / (na * La),
        });
        venueDef.push({
          value: count(t.home.goalsAgainst) / (nh * La) - count(t.away.goalsAgainst) / (na * Lh),
          samplingVar: 1 / (nh * La) + 1 / (na * Lh),
        });
      }
    }
  }

  const pick = (
    est: number | undefined,
    fallback: number,
    [lo, hi]: readonly [number, number],
  ): number => clamp(est !== undefined && Number.isFinite(est) ? est : fallback, lo, hi);

  const attackCv2 = pick(excessVariance(att, 1, MIN_TEAMS_FOR_PRIOR), base.attackCv2, PRIOR_BOUNDS.attackCv2);
  const defenceCv2 = pick(excessVariance(def, 1, MIN_TEAMS_FOR_PRIOR), base.defenceCv2, PRIOR_BOUNDS.attackCv2);
  const venueScale = (cv2: number) => 2 * (1 + cv2);
  const vAtt = excessVariance(venueAtt, 0, MIN_TEAMS_FOR_PRIOR);
  const vDef = excessVariance(venueDef, 0, MIN_TEAMS_FOR_PRIOR);

  const teamGoalsMean = pick(teamGames > 0 ? goals / teamGames : undefined, base.teamGoals.mean, PRIOR_BOUNDS.teamGoalsMean);
  const homeShareMean = pick(venueGoals > 0 ? homeGoals / venueGoals : undefined, base.homeShare.mean, PRIOR_BOUNDS.homeShareMean);
  const drawRateMean = pick(drawTeamGames > 0 ? draws / drawTeamGames : undefined, base.drawRate.mean, PRIOR_BOUNDS.drawRateMean);

  const strengthPriors: Priors = {
    attackCv2,
    defenceCv2,
    venueAttackCv2: pick(vAtt !== undefined ? vAtt / venueScale(attackCv2) : undefined, base.venueAttackCv2, PRIOR_BOUNDS.venueCv2),
    venueDefenceCv2: pick(vDef !== undefined ? vDef / venueScale(defenceCv2) : undefined, base.venueDefenceCv2, PRIOR_BOUNDS.venueCv2),
    teamGoals: {
      mean: teamGoalsMean,
      variance: pick(excessVariance(goalRates, teamGoalsMean, MIN_LEAGUES_FOR_PRIOR), base.teamGoals.variance, PRIOR_BOUNDS.teamGoalsVariance),
    },
    homeShare: {
      mean: homeShareMean,
      variance: pick(excessVariance(shares, homeShareMean, MIN_LEAGUES_FOR_PRIOR), base.homeShare.variance, PRIOR_BOUNDS.homeShareVariance),
    },
    drawRate: { mean: drawRateMean, excessVariance: base.drawRate.excessVariance },
    rho: base.rho,
  };

  // Pooled ρ and the spread of league draw rates around their model rates.
  // Each match appears twice in a table, hence the ÷ 2 for match counts.
  const drawLeagues: Array<{ pairs: RatePair[]; matches: number; draws: number }> = [];
  for (const league of leagues) {
    const s = summariseLeague(league);
    if (s.teams < 2 || s.drawTeamGames < 20) continue;
    drawLeagues.push({
      pairs: roundRobinPairs(league, leagueRates(league, strengthPriors, s)),
      matches: s.drawTeamGames / 2,
      draws: s.draws / 2,
    });
  }
  if (drawLeagues.length < MIN_LEAGUES_FOR_PRIOR) return strengthPriors;

  const totalMatches = drawLeagues.reduce((t, l) => t + l.matches, 0);
  const totalDraws = drawLeagues.reduce((t, l) => t + l.draws, 0);
  const rho = solveRho(
    (r) => drawLeagues.reduce((t, l) => t + l.matches * meanDrawProbability(l.pairs, r, K), 0) / totalMatches,
    totalDraws / totalMatches,
  );
  const excess = drawLeagues.map((l) => {
    const p = meanDrawProbability(l.pairs, rho, K);
    return { value: l.draws / l.matches - p, samplingVar: (p * (1 - p)) / l.matches };
  });
  return {
    ...strengthPriors,
    drawRate: {
      mean: drawRateMean,
      excessVariance: pick(excessVariance(excess, 0, MIN_LEAGUES_FOR_PRIOR), base.drawRate.excessVariance, PRIOR_BOUNDS.drawExcessVariance),
    },
    rho,
  };
}

// ---------- team strengths ----------

/**
 * Shrunk Maher multipliers for one team. Overall rates are shrunk toward the
 * league (prior 1); the venue split is then shrunk toward the team's own
 * overall multiplier, measured against the league's venue-specific goal rates
 * so that home advantage enters once, through the league rates.
 */
export function teamStrength(
  team: TeamInput,
  venue: "home" | "away",
  league: LeagueRates,
): TeamStrength {
  const o = team.overall;
  const games = count(o.totalGames);
  const att = shrinkMultiplier(o.goalsFor, games, league.teamGoals, 1, league.kAttack);
  const def = shrinkMultiplier(o.goalsAgainst, games, league.teamGoals, 1, league.kDefence);
  const split = venue === "home" ? team.home : team.away;
  const venueGames = split ? count(split.totalGames) : 0;
  if (!split || venueGames === 0) {
    return { att, def, attVenue: att, defVenue: def, games, venueGames, usedVenue: false };
  }
  const forRate = venue === "home" ? league.homeGoals : league.awayGoals;
  const againstRate = venue === "home" ? league.awayGoals : league.homeGoals;
  return {
    att,
    def,
    attVenue: shrinkMultiplier(split.goalsFor, venueGames, forRate, att, league.kVenueAttack),
    defVenue: shrinkMultiplier(split.goalsAgainst, venueGames, againstRate, def, league.kVenueDefence),
    games,
    venueGames,
    usedVenue: true,
  };
}

// ---------- league model ----------

/** Shrunk league goal rates, venue split and prior weights. */
export function leagueRates(
  input: LeagueInput,
  priors: Priors = DEFAULT_PRIORS,
  s: LeagueSums = summariseLeague(input),
): LeagueRates {
  // League goals per team-game, Gamma–Poisson prior worth kGoals team-games.
  const kGoals = Math.max(1e-9, priors.teamGoals.mean / priors.teamGoals.variance);
  const teamGoals = (s.goals + kGoals * priors.teamGoals.mean) / (s.teamGames + kGoals);

  // Home share of goals, Beta–Binomial prior worth mShare goals.
  const p0 = priors.homeShare.mean;
  const mShare = Math.max(1e-9, (p0 * (1 - p0)) / priors.homeShare.variance);
  const share = (s.homeGoals + mShare * p0) / (s.homeGoals + s.awayGoals + mShare);

  const kOf = (cv2: number) => clamp(1 / (cv2 * teamGoals), K_MIN, K_MAX);
  return {
    league: input.league,
    teams: s.teams,
    matches: s.teamGames / 2,
    teamGoals,
    homeGoals: 2 * teamGoals * share,
    awayGoals: 2 * teamGoals * (1 - share),
    kAttack: kOf(priors.attackCv2),
    kDefence: kOf(priors.defenceCv2),
    kVenueAttack: kOf(priors.venueAttackCv2),
    kVenueDefence: kOf(priors.venueDefenceCv2),
  };
}

/**
 * (λ_home, λ_away) for every ordered pair of the league's teams, from their
 * overall strengths: a full home-and-away round robin. With fewer than two
 * teams, the single average-vs-average pairing.
 */
function roundRobinPairs(input: LeagueInput, rates: LeagueRates): RatePair[] {
  const strengths = input.teams.map((t) => teamStrength(t, "home", rates));
  const pairs: RatePair[] = [];
  for (const h of strengths) {
    for (const a of strengths) {
      if (h === a) continue;
      pairs.push([
        clampRate(rates.homeGoals * h.att * a.def),
        clampRate(rates.awayGoals * a.att * h.def),
      ]);
    }
  }
  return pairs.length > 0 ? pairs : [[clampRate(rates.homeGoals), clampRate(rates.awayGoals)]];
}

/**
 * Builds the per-league parameters: shrunk goal rates, venue split, draw rate
 * and the ρ that reproduces that draw rate over a round robin of the league.
 */
export function buildLeagueModel(
  input: LeagueInput,
  priors: Priors = DEFAULT_PRIORS,
  K = DEFAULT_K,
): LeagueModel {
  const s = summariseLeague(input);
  const rates = leagueRates(input, priors, s);
  const pairs = roundRobinPairs(input, rates);

  // Draw rate, Beta–Binomial prior centred on the model's own rate at the
  // pooled ρ and worth mDraw matches (a table counts each match twice).
  const drawRatePrior = meanDrawProbability(pairs, priors.rho, K);
  const mDraw = Math.max(
    1e-9,
    (drawRatePrior * (1 - drawRatePrior)) / priors.drawRate.excessVariance,
  );
  const hasDraws = s.drawTeamGames > 0;
  const drawRateShrunk = (s.draws / 2 + mDraw * drawRatePrior) / (s.drawTeamGames / 2 + mDraw);

  return {
    ...rates,
    drawRate: hasDraws ? s.draws / s.drawTeamGames : undefined,
    drawRatePrior,
    drawRateShrunk,
    rho: hasDraws ? fitRho(pairs, drawRateShrunk, K) : priors.rho,
    rhoFitted: hasDraws,
  };
}

/** Builds every league model of a snapshot with priors estimated from the snapshot. */
export function buildLeagueModels(
  leagues: LeagueInput[],
  priors: Priors = estimatePriors(leagues),
  K = DEFAULT_K,
): Map<string, LeagueModel> {
  return new Map(leagues.map((l) => [l.league, buildLeagueModel(l, priors, K)]));
}

// ---------- fixture ----------

export function calculateDrawProbabilityDC(
  home: TeamInput,
  away: TeamInput,
  gameDate: string,
  league: LeagueModel,
  opts: DrawProbabilityOptions = {},
): DrawProbabilityResult {
  const { K = DEFAULT_K, calibrate = null } = opts;
  const h = teamStrength(home, "home", league);
  const a = teamStrength(away, "away", league);
  const lambdaHome = clampRate(league.homeGoals * h.attVenue * a.defVenue);
  const lambdaAway = clampRate(league.awayGoals * a.attVenue * h.defVenue);
  const { pDraw, pIndependent, rho } = drawProbabilityFromRates(lambdaHome, lambdaAway, league.rho, K);
  const finalProb = calibrate ? calibrateProb(pDraw, calibrate.a, calibrate.b) : pDraw;

  return {
    homeTeam: home.team,
    awayTeam: away.team,
    drawPercentage: round4(finalProb * 100),
    gameDate,
    meta: {
      lambdaHome: round4(lambdaHome),
      lambdaAway: round4(lambdaAway),
      rho: round4(rho),
      K,
      pIndependent: round4(pIndependent),
      strengths: {
        homeAtt: round4(h.attVenue),
        homeDef: round4(h.defVenue),
        awayAtt: round4(a.attVenue),
        awayDef: round4(a.defVenue),
      },
      games: { home: h.games, away: a.games },
      usedVenue: { home: h.usedVenue, away: a.usedVenue },
      league: {
        league: league.league,
        teamGoals: round4(league.teamGoals),
        homeGoals: round4(league.homeGoals),
        awayGoals: round4(league.awayGoals),
        drawRate: league.drawRate === undefined ? undefined : round4(league.drawRate),
        drawRatePrior: round4(league.drawRatePrior),
        drawRateShrunk: round4(league.drawRateShrunk),
        rhoFitted: league.rhoFitted,
        kAttack: round4(league.kAttack),
        kDefence: round4(league.kDefence),
        kVenueAttack: round4(league.kVenueAttack),
        kVenueDefence: round4(league.kVenueDefence),
      },
      calibrate,
      method: METHOD,
    },
  };
}
