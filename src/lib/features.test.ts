import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRIORS,
  RHO_MAX,
  RHO_MIN,
  buildLeagueModel,
  buildLeagueModels,
  calculateDrawProbabilityDC,
  dixonColesTau,
  drawProbabilityFromRates,
  estimatePriors,
  fitRho,
  teamStrength,
  type LeagueInput,
  type Priors,
  type TeamInput,
} from "./features.ts";

/** Priors with (almost) no league-level shrinkage: a league reproduces its own table. */
const FLAT: Priors = {
  ...DEFAULT_PRIORS,
  teamGoals: { mean: 1.3, variance: 1e6 },
  homeShare: { mean: 0.56, variance: 1e6 },
  drawRate: { mean: 0.26, excessVariance: 1e6 },
};

interface LeagueSpec {
  teams?: number;
  games?: number;
  L?: number;
  drawRate?: number;
  /** Relative spread of attack/defence strengths; 0 makes every team identical. */
  spread?: number;
  venue?: boolean;
}

/** Deterministic synthetic league whose tables are internally consistent. */
function league(id: string, spec: LeagueSpec = {}): LeagueInput {
  const { teams = 18, games = 10, L = 1.3, drawRate = 0.3, spread = 0, venue = true } = spec;
  const out: TeamInput[] = [];
  for (let i = 0; i < teams; i++) {
    const att = 1 + spread * Math.sin(i + 1);
    const def = 1 - spread * Math.sin(i + 1) * 0.5;
    const gf = Math.round(games * L * att);
    const ga = Math.round(games * L * def);
    const draws = Math.round(games * drawRate);
    const hg = Math.floor(games / 2);
    const gfh = Math.round(gf * 0.56);
    const gah = Math.round(ga * 0.44);
    out.push({
      team: `T${i}`,
      overall: { totalGames: games, goalsFor: gf, goalsAgainst: ga, draws },
      ...(venue && {
        home: { totalGames: hg, goalsFor: gfh, goalsAgainst: gah },
        away: { totalGames: games - hg, goalsFor: gf - gfh, goalsAgainst: ga - gah },
      }),
    });
  }
  return { league: id, teams: out };
}

/** Seeded PRNG (mulberry32) so the noisy tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda: number, u: () => number): number {
  let k = 0;
  let p = Math.exp(-lambda);
  let s = p;
  const x = u();
  while (x > s && k < 1000) {
    k++;
    p *= lambda / k;
    s += p;
  }
  return k;
}

/** League whose goal counts are Poisson draws around known true strengths. */
function noisyLeague(id: string, u: () => number, attCv: number, L: number, drawRate: number): LeagueInput {
  const games = 20;
  const teams: TeamInput[] = [];
  for (let i = 0; i < 18; i++) {
    const att = Math.max(0.2, 1 + attCv * Math.sqrt(3) * (2 * u() - 1));
    const def = Math.max(0.2, 1 + attCv * Math.sqrt(3) * (2 * u() - 1));
    const gfh = poisson(10 * L * 1.12 * att, u);
    const gfa = poisson(10 * L * 0.88 * att, u);
    const gah = poisson(10 * L * 0.88 * def, u);
    const gaa = poisson(10 * L * 1.12 * def, u);
    teams.push({
      team: `${id}-${i}`,
      overall: { totalGames: games, goalsFor: gfh + gfa, goalsAgainst: gah + gaa, draws: Math.round(games * drawRate) },
      home: { totalGames: 10, goalsFor: gfh, goalsAgainst: gah },
      away: { totalGames: 10, goalsFor: gfa, goalsAgainst: gaa },
    });
  }
  return { league: id, teams };
}

/** A team that is exactly league-average in a 1.3-goal league after 10 games. */
const avg = (): TeamInput => ({
  team: "avg",
  overall: { totalGames: 10, goalsFor: 13, goalsAgainst: 13, draws: 3 },
  home: { totalGames: 5, goalsFor: 7, goalsAgainst: 6 },
  away: { totalGames: 5, goalsFor: 6, goalsAgainst: 7 },
});

const pDraw = (home: TeamInput, away: TeamInput, model = buildLeagueModel(league("x"), FLAT)) =>
  calculateDrawProbabilityDC(home, away, "05.07. 18:00", model).drawPercentage / 100;

describe("league-average teams reproduce the league's own draw rate", () => {
  test("identical teams: exactly the table's draw rate, per league", () => {
    const high = buildLeagueModel(league("high", { drawRate: 0.3 }), FLAT);
    const low = buildLeagueModel(league("low", { drawRate: 0.2 }), FLAT);
    assert.equal(high.drawRate, 0.3);
    assert.equal(low.drawRate, 0.2);
    const pHigh = pDraw(avg(), avg(), high);
    const pLow = pDraw(avg(), avg(), low);
    assert.ok(Math.abs(pHigh - 0.3) < 1e-3, `got ${pHigh}, want 0.30`);
    assert.ok(Math.abs(pLow - 0.2) < 1e-3, `got ${pLow}, want 0.20`);
    assert.ok(pHigh > pLow);
    assert.ok(high.rho < 0 && low.rho > 0, "low-draw league needs a positive ρ");
  });

  test("uneven league: an average pairing sits at or just above the league rate", () => {
    const model = buildLeagueModel(league("uneven", { spread: 0.3, drawRate: 0.3 }), FLAT);
    const p = pDraw(avg(), avg(), model);
    assert.ok(p >= 0.3 - 0.005 && p <= 0.3 + 0.03, `got ${p}`);
    // home advantage enters once, through the league's venue goal rates
    assert.ok(model.homeGoals > model.awayGoals);
    assert.ok(Math.abs(model.homeGoals + model.awayGoals - 2 * model.teamGoals) < 1e-9);
  });

  test("a league without draw counts uses the pooled ρ", () => {
    const noDraws = league("nd");
    for (const t of noDraws.teams) delete t.overall.draws;
    const model = buildLeagueModel(noDraws, { ...FLAT, rho: -0.08 });
    assert.equal(model.drawRate, undefined);
    assert.equal(model.rhoFitted, false);
    assert.equal(model.rho, -0.08);
    assert.ok(Math.abs(pDraw(avg(), avg(), model) - model.drawRatePrior) < 1e-3);
  });

  test("the draw-rate prior falls as the league's goal rate rises", () => {
    const priors = { ...DEFAULT_PRIORS, rho: -0.06 };
    const low = buildLeagueModel(league("low", { L: 1.0, spread: 0.3 }), priors);
    const high = buildLeagueModel(league("high", { L: 1.8, spread: 0.3 }), priors);
    assert.ok(high.drawRatePrior < low.drawRatePrior - 0.04, `${high.drawRatePrior} vs ${low.drawRatePrior}`);
  });
});

describe("direction of the effects", () => {
  const model = buildLeagueModel(league("x", { spread: 0.3 }), FLAT);
  const base = pDraw(avg(), avg(), model);
  const hi: TeamInput = { overall: { totalGames: 30, goalsFor: 78, goalsAgainst: 78 } };
  const strong: TeamInput = { overall: { totalGames: 30, goalsFor: 78, goalsAgainst: 19 } };
  const weak: TeamInput = { overall: { totalGames: 30, goalsFor: 19, goalsAgainst: 78 } };

  test("more expected goals → fewer draws", () => {
    assert.ok(pDraw(hi, hi, model) < base - 0.03);
  });

  test("bigger strength mismatch → fewer draws", () => {
    assert.ok(pDraw(strong, weak, model) < base - 0.05);
    assert.ok(pDraw(weak, strong, model) < base - 0.05);
  });

  test("the same holds for raw rates at a fixed total", () => {
    const rho = -0.1;
    const even = drawProbabilityFromRates(1.35, 1.35, rho).pDraw;
    const uneven = drawProbabilityFromRates(2.0, 0.7, rho).pDraw;
    const low = drawProbabilityFromRates(1.0, 1.0, rho).pDraw;
    const high = drawProbabilityFromRates(2.0, 2.0, rho).pDraw;
    assert.ok(uneven < even);
    assert.ok(high < even && even < low);
  });
});

describe("shrinkage", () => {
  const model = buildLeagueModel(league("x", { spread: 0.3 }), FLAT);
  const base = pDraw(avg(), avg(), model);

  test("a team with one game stays near the league average", () => {
    const oneGame: TeamInput = { overall: { totalGames: 1, goalsFor: 4, goalsAgainst: 0 } };
    const manyGames: TeamInput = { overall: { totalGames: 30, goalsFor: 120, goalsAgainst: 0 } };
    const dFew = Math.abs(pDraw(oneGame, avg(), model) - base);
    const dMany = Math.abs(pDraw(manyGames, avg(), model) - base);
    assert.ok(dFew < 0.04, `moved ${dFew}`);
    assert.ok(dFew < 0.35 * dMany, `few ${dFew} vs many ${dMany}`);
    const s = teamStrength(oneGame, "home", model);
    assert.ok(s.att > 1 && s.att < 1.3 && s.def < 1 && s.def > 0.8);
  });

  test("an average team has multipliers of 1 and uses its venue rows", () => {
    const s = teamStrength(avg(), "home", model);
    assert.ok(Math.abs(s.att - 1) < 0.02 && Math.abs(s.def - 1) < 0.02);
    assert.ok(Math.abs(s.attVenue - 1) < 0.03 && Math.abs(s.defVenue - 1) < 0.03);
    assert.equal(s.usedVenue, true);
    assert.equal(teamStrength({ overall: avg().overall }, "home", model).usedVenue, false);
  });

  test("a short-season league's draw rate is pulled toward its model rate", () => {
    const leagues = Array.from({ length: 12 }, (_, i) =>
      league(`L${i}`, { games: 20, spread: 0.3, L: 1.1 + 0.05 * i, drawRate: 0.2 + 0.01 * i }),
    );
    const tiny = league("tiny", { teams: 10, games: 2, drawRate: 0.5 });
    const priors = estimatePriors([...leagues, tiny]);
    const model = buildLeagueModel(tiny, priors);
    assert.equal(model.drawRate, 0.5);
    assert.ok(model.drawRateShrunk < 0.5 && model.drawRateShrunk > model.drawRatePrior);
    assert.ok(model.drawRateShrunk - model.drawRatePrior < 0.5 - model.drawRateShrunk, "closer to the prior than to its own 10 matches");
  });
});

describe("empirical-Bayes priors", () => {
  test("recover the true spread of strengths from Poisson-noised tables", () => {
    const u = rng(42);
    // true CV of attack and defence = 0.3 → CV² = 0.09; true home share = 0.56
    const leagues = Array.from({ length: 12 }, (_, i) =>
      noisyLeague(`L${i}`, u, 0.3, 1.1 + 0.05 * i, 0.2 + 0.01 * i),
    );
    const p = estimatePriors(leagues);
    assert.ok(p.attackCv2 > 0.05 && p.attackCv2 < 0.14, `attackCv2 ${p.attackCv2}`);
    assert.ok(p.defenceCv2 > 0.05 && p.defenceCv2 < 0.14, `defenceCv2 ${p.defenceCv2}`);
    // no true venue deviation was simulated, so the estimate sits at or near the floor
    assert.ok(p.venueAttackCv2 < 0.03, `venueAttackCv2 ${p.venueAttackCv2}`);
    assert.ok(Math.abs(p.homeShare.mean - 0.56) < 0.02, `homeShare ${p.homeShare.mean}`);
    // true mean 1.375; ±0.1 covers Poisson noise plus the random team strengths
    assert.ok(Math.abs(p.teamGoals.mean - 1.375) < 0.1, `teamGoals ${p.teamGoals.mean}`);
    assert.ok(Math.abs(p.drawRate.mean - 0.255) < 0.02, `drawRate ${p.drawRate.mean}`);
    assert.ok(p.homeShare.mean > 0.5 && p.homeShare.mean < 0.6);
    assert.ok(p.rho > RHO_MIN && p.rho < RHO_MAX, `pooled rho ${p.rho}`);
    for (const v of [p.venueAttackCv2, p.venueDefenceCv2, p.teamGoals.variance, p.homeShare.variance, p.drawRate.excessVariance]) {
      assert.ok(Number.isFinite(v) && v > 0);
    }
  });

  test("fall back to the defaults with too little data", () => {
    assert.deepEqual(estimatePriors([]), DEFAULT_PRIORS);
    const one = estimatePriors([league("only")]);
    assert.equal(one.attackCv2, DEFAULT_PRIORS.attackCv2);
    assert.equal(one.drawRate.excessVariance, DEFAULT_PRIORS.drawRate.excessVariance);
    assert.equal(one.rho, DEFAULT_PRIORS.rho);
  });

  test("the pooled ρ reproduces the total number of draws", () => {
    const u = rng(7);
    // draw rates fall as scoring rises, as in real leagues
    const leagues = Array.from({ length: 12 }, (_, i) => noisyLeague(`L${i}`, u, 0.3, 1.1 + 0.05 * i, 0.31 - 0.01 * i));
    const p = estimatePriors(leagues);
    const models = buildLeagueModels(leagues, { ...p, drawRate: { ...p.drawRate, excessVariance: 1e6 } });
    // with no league-level shrinkage every league targets its own observed rate…
    for (const m of models.values()) {
      assert.ok(Math.abs(m.drawRateShrunk - (m.drawRate ?? 0)) < 1e-3);
      assert.ok(m.rho > RHO_MIN && m.rho < RHO_MAX, `${m.league} rho ${m.rho}`);
    }
    // …and at the pooled ρ the predicted total equals the observed total
    const pooled = buildLeagueModels(leagues, p);
    let predicted = 0;
    let observed = 0;
    for (const m of pooled.values()) {
      predicted += m.drawRatePrior * m.matches;
      observed += (m.drawRate ?? 0) * m.matches;
    }
    assert.ok(Math.abs(predicted - observed) / observed < 1e-4, `${predicted} vs ${observed}`);
  });

  test("buildLeagueModels keys the models by league id", () => {
    const models = buildLeagueModels([league("a"), league("b")]);
    assert.deepEqual([...models.keys()], ["a", "b"]);
  });
});

describe("plausible range, never NaN", () => {
  const finite = (x: number) => Number.isFinite(x);

  test("empty league (no rows at all) → prior-only model, sensible probability", () => {
    const model = buildLeagueModel({ league: "empty", teams: [] });
    for (const v of [model.teamGoals, model.homeGoals, model.awayGoals, model.drawRateShrunk, model.rho, model.kAttack, model.kVenueAttack]) {
      assert.ok(finite(v), `${v}`);
    }
    assert.equal(model.rho, DEFAULT_PRIORS.rho);
    const zero: TeamInput = { overall: { totalGames: 0, goalsFor: 0, goalsAgainst: 0 } };
    const p = pDraw(zero, zero, model);
    assert.ok(p > 0.1 && p < 0.4, `got ${p}`);
  });

  test("season not started (every team on 0 games) → league-average match", () => {
    const fresh = league("fresh", { games: 0 });
    const model = buildLeagueModel(fresh);
    const p = pDraw(fresh.teams[0] ?? avg(), fresh.teams[1] ?? avg(), model);
    assert.ok(p > 0.1 && p < 0.4, `got ${p}`);
  });

  test("garbage cells (NaN, negatives) and extreme rows stay finite and in (0, 1)", () => {
    const model = buildLeagueModel(league("x", { spread: 0.3 }));
    const bad: TeamInput = { overall: { totalGames: NaN, goalsFor: NaN, goalsAgainst: -3 } };
    const huge: TeamInput = { overall: { totalGames: 10, goalsFor: 200, goalsAgainst: 0 } };
    const tiny: TeamInput = { overall: { totalGames: 10, goalsFor: 0, goalsAgainst: 200 } };
    for (const [h, a] of [[bad, bad], [bad, avg()], [huge, tiny], [tiny, huge], [huge, huge]] as const) {
      const r = calculateDrawProbabilityDC(h, a, "d", model);
      assert.ok(finite(r.drawPercentage) && r.drawPercentage > 0 && r.drawPercentage < 100);
      assert.ok(finite(r.meta.lambdaHome) && finite(r.meta.lambdaAway));
    }
    assert.ok(pDraw(bad, bad, model) > 0.1 && pDraw(bad, bad, model) < 0.4);
  });

  test("typical fixtures land roughly in 10–40 %", () => {
    const model = buildLeagueModel(league("x", { spread: 0.3 }));
    const t = league("x", { spread: 0.3 }).teams;
    for (let i = 0; i < t.length; i++) {
      for (let j = 0; j < t.length; j++) {
        if (i === j) continue;
        const p = pDraw(t[i] ?? avg(), t[j] ?? avg(), model);
        assert.ok(p > 0.1 && p < 0.4, `pair ${i}-${j}: ${p}`);
      }
    }
  });
});

describe("Dixon–Coles arithmetic", () => {
  test("P(draw) = P_independent − 2ρλμe^(−λ−μ)", () => {
    const [lh, la, rho] = [1.4, 1.2, -0.1];
    const r = drawProbabilityFromRates(lh, la, rho);
    const expected = r.pIndependent - 2 * rho * lh * la * Math.exp(-lh - la);
    assert.ok(Math.abs(r.pDraw - expected) < 1e-12);
    assert.equal(r.rho, rho);
  });

  test("ρ is clamped so every low-score cell stays non-negative", () => {
    const r = drawProbabilityFromRates(6, 0.05, RHO_MIN);
    assert.ok(r.rho > RHO_MIN);
    for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      assert.ok(dixonColesTau(x, y, r.rho, 6, 0.05) >= 0);
    }
    assert.ok(r.pDraw >= 0 && r.pDraw <= 1);
    assert.ok(Number.isFinite(drawProbabilityFromRates(NaN, Infinity, NaN).pDraw));
  });

  test("fitRho hits a reachable target and reports the bound otherwise", () => {
    const pairs = [[1.4, 1.2], [1.8, 0.9], [1.0, 1.0]] as const;
    const rho = fitRho(pairs, 0.28);
    const mean = pairs.reduce((s, [lh, la]) => s + drawProbabilityFromRates(lh, la, rho).pDraw, 0) / pairs.length;
    assert.ok(Math.abs(mean - 0.28) < 1e-6);
    assert.equal(fitRho(pairs, 0.9), RHO_MIN);
    assert.equal(fitRho(pairs, 0.01), RHO_MAX);
  });

  test("optional logistic calibration is applied when given", () => {
    const model = buildLeagueModel(league("x"), FLAT);
    const plain = calculateDrawProbabilityDC(avg(), avg(), "d", model).drawPercentage;
    const same = calculateDrawProbabilityDC(avg(), avg(), "d", model, { calibrate: { a: 0, b: 1 } }).drawPercentage;
    const shifted = calculateDrawProbabilityDC(avg(), avg(), "d", model, { calibrate: { a: 0.5, b: 1 } }).drawPercentage;
    assert.ok(Math.abs(plain - same) < 1e-6);
    assert.ok(shifted > plain);
  });
});
