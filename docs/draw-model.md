# Draw-probability model

This document covers sections 1–3 and 5–8 of the model review. Section 4 (code
changes) is listed in [GUIDE.md](GUIDE.md).

> **Accuracy is unmeasured.** No match results exist in this pipeline yet, so
> there is no backtest. Every number below is either arithmetic on the model, a
> result on synthetic data, or a published value. None of it is a measured hit
> rate or calibration error.

---

## 1. How the code works

```
map.ts ──► sources.ts ──► main.ts (puppeteer-cluster) ──► output/scrape.json
                                                       └► output/snapshots/scrape-<timestamp>.json
output/scrape.json ──► process.ts ──► processData.ts ──► features.ts ──► output/draw-candidates-<preset>.csv ──► Supabase
```

### Stage 1: sources (`src/lib/sources.ts`)
`flashscoreMap` holds 163 `{ fixtures, standings }` URL pairs. `buildSources()`
does the following:

- It gives each entry a **`leagueId`** of the form `country/league-slug`, taken
  from the fixtures URL (for example `ghana/premier-league`). Every row scraped
  from that entry carries this id.
- It drops exact duplicates (`hungary/otp-bank-liga` and `malaysia/super-league`
  each appear twice), which leaves **161 sources**.
- It derives the home and away table URLs by swapping
  `/standings/overall` → `/standings/home|away`. The older `/table/overall` form
  is also accepted.
- Four entries have no `overall` segment (`live-standings` or Spanish
  `clasificacion/general`). The old code then loaded the overall page three times
  and stored overall rows as "home" and "away" rows. Their venue tables are now
  skipped, and the model falls back to overall rows for those leagues.
- It warns about suspicious pairs. For example, the `sweden/superettan` fixtures
  are paired with the **Norway** `obos-ligaen` standings, so those fixtures can't
  join.

Shape: `Source { leagueId, fixtures, overall, home?, away? }`.

### Stage 2: scrape (`src/main.ts`, `src/tasks/*`)
There are up to four jobs per source, with 4 concurrent Chrome contexts.

- **`fixturesTask`** reads `div.event__match`. In the browser it keeps every
  `{ date, home, away }` row. In Node it keeps only rows whose stage time starts
  with the target day (`flashscoreDayKey("05.07. 18:00") === "05.07"`). The
  target day is today by default, or `--date`.
  Output: `FixtureRow { leagueId, date, matchDate, home, away }`.
- **`standingsTask`** reads `div.ui-table__row`. The cells
  `span.table__cell--value` are parsed as follows:

  | cell | field | status |
  |---|---|---|
  | `cells[0]` | `totalGames` | read since v1 |
  | `cells[2]` | `draws` (stored raw now) → `matchesDrawed` = draws ÷ games × 100, 2 dp | read since v1 |
  | `cells[4]` `"GF:GA"` | `goalsFor`, `goalsAgainst` → `expectedGoals` and `expectedConcededGoals` (÷ games, 2 dp, **actual goals, not xG**) | read since v1 |
  | `cells[1]`, `cells[3]`, last cell | `wins`, `losses`, `points` | **new, unverified against the live DOM** |

  The model doesn't use `wins`, `losses` or `points`. They are stored for future
  use.
  Output: `TeamRow { leagueId, league, team, totalGames, goalsFor, goalsAgainst,
  expectedGoals, expectedConcededGoals, matchesDrawed, rank, wins?, draws?,
  losses?, points? }`.
  For the overall table, the task also pushes
  `LeagueRow { leagueId, league, leagueAvgGoalsForPerTeam, leagueAvgGoalsAgainstPerTeam }`.
  The two averages are always equal. The model no longer reads them, because it
  recomputes league rates from the team rows.
- **`saveSnapshot()`** writes `output/scrape.json` **and** a dated copy at
  `output/snapshots/scrape-<scrapedAt>.json`.
  Shape: `ScrapeSnapshot { scrapedAt, matchDate, fixtures, overalls, homes, aways, leagues }`.

### Stage 3: group and model (`src/actions/processData.ts` → `src/lib/features.ts`)
1. `groupTables()` builds `Map<leagueId, { overall, home, away: Map<norm(team), TeamRow> }>`.
   Team names are only compared **within a league**, so England's "United" and
   Ghana's "United" no longer overwrite each other.
2. `leagueInputs()` converts the rows to `TeamInput { team, overall, home?, away? }`,
   with each `TableRow { totalGames, goalsFor, goalsAgainst, draws? }`. When an
   older snapshot has no raw `draws`, they are recovered exactly with
   `round(matchesDrawed / 100 × games)`.
3. `estimatePriors()` fits the pooled priors from the whole snapshot (see §3).
4. `buildLeagueModels()` builds one `LeagueModel` per league: goal rates, a home
   and away split, the draw rate, ρ and the shrinkage weights.

### Stage 4: filter, score and predict (`processDataDetailed`)
A fixture is skipped in these cases, each of which is counted and printed:

- there's no table for its `leagueId`;
- a team isn't in that league's overall table;
- either team has fewer than `minSeasonGames` games;
- the hard goals-per-game gates fail.

Each surviving fixture is then scored with the unchanged hand-tuned heuristic.
It also gets a draw probability from `calculateDrawProbabilityDC(home, away,
date, leagueModel)`.

The keep rule is unchanged: `score ≥ scoreKeepThreshold` **or**
`prob ≥ probKeepThreshold`. Kept fixtures are sorted by `drawPercentage`.

### Stage 5: export
`toCsv()` writes the original 16 columns, with the same names and order, then
12 new columns (§4 in the guide). `draw_percentage` is on a 0–100 scale and
`prob` on 0–1.

### Where CLAUDE.md and the code disagreed
- **"About 164 leagues":** the map has 163 active entries, of which 2 are
  duplicates, so 161 are unique.
- **Home and away URLs:** CLAUDE.md said they come from replacing `"overall"`.
  For the four `live-standings` or `clasificacion` URLs, nothing was replaced,
  so the home and away "tables" were the overall table. CLAUDE.md didn't mention
  this.
- **NaN at season start:** `leagueAvgGoalsForPerTeam` was `goals / totalGames`
  with no zero guard. A league with 0 games produced `NaN`, which propagated
  through `shrinkRate` and `Math.max(0.05, NaN)` into a `NaN` `draw_percentage`.
  CLAUDE.md didn't mention this either.
- **Mismatched pairs:** the `sweden/superettan` fixtures are paired with
  `norway/obos-ligaen` standings. The `jamaica/premier-league` "fixtures" URL
  points at `/results/`, and its standings URL ends in `/overall/s`.

---

## 2. Assessment of the old model

**Sound:** it uses a Poisson goal model with multiplicative attack × defence
(Maher 1982), Bayesian shrinkage toward the league mean, Dixon–Coles low-score
correction (Dixon & Coles 1997), a sensible truncation, and an optional
logistic calibration hook.

**Wrong:** the defects below were all measured with the old code itself, taken
from `features.ts` before the rewrite. Unless a row says otherwise, the
reference fixture is two exactly league-average teams in a league with 1.35
goals per team-game. Home sides average 1.5 goals and away sides 1.2, and each
team has played 10 games (5 home, 5 away). The correct independent-Poisson
answer for that fixture is **25.48%**.

| # | Problem (old location) | Direction | Size, computed |
|---|---|---|---|
| 1 | **λ not normalised.** `combineAttackDefense` (`features.ts:121-128`) and `lambdaAway = attB * defA` (`:233`) multiply two goals-per-game rates without dividing by the league rate. | ↓ draws | λ_home 1.94 instead of 1.50 (×1.29) and λ_away 1.76 instead of 1.20 (×1.47). At ρ = 0 this alone takes P(draw) from 25.48% to 21.52% (**−4.0 pp**). |
| 2 | **ρ = +0.06.** `dixonColesAdj` (`:71-83`) together with the defaults (`:151`, `processData.ts:240`). τ(0,0) = 1 − λμρ and τ(1,1) = 1 − ρ, so ρ > 0 removes mass from 0-0 and 1-1. | ↓ draws | With correct λ: 24.03% vs 25.48% at ρ = 0 (**−1.45 pp**), and vs 26.93% at ρ = −0.06 (**−2.9 pp**). The draw probability is exactly P_indep − 2ρλμe^(−λ−μ). |
| 3 | **Venue splits shrunk toward the overall mean**, not the venue mean. `blendSplitWithOverall` (`:103-118`) shrinks a home attack of 1.50 toward 1.35, giving 1.37, and an away attack of 1.20 toward 1.35, giving 1.33. | ↑ draws (slightly) | The home/away λ ratio falls from 1.25 to 1.10. Two equal-strength sides draw more: at the same total, (1.35, 1.35) gives 25.82% vs 25.48% for (1.5, 1.2), so **≤ +0.3 pp**. |
| 4 | **Home advantage applied again** with `homeAdvFactor = 1.03` (`:150`, `processData.ts:239`) on top of splits that already contain it. | ↓ draws | **−0.20 pp** with the old λs. |
| 5 | **The blend double-counts games.** The overall row contains the split's games, and both are weighted by their own game counts. | Variance and bias of team strength | After 5+5 games, home games carry 1.8× the weight of away games. The implicit prior weight is about 48%, set by the hard-coded `kSplit = 6` and `kOverall = 8`. |
| 6 | **`priorStrengthK` is ignored** on the split path, which is always taken because `processData` always passes an overall row. | None (dead parameter) | `priorStrengthK: 10` in `processData.ts:238` never had any effect. |
| 7 | **`calibrate` is never passed** (`:153`). | None | There are no results to fit it to. |
| 8 | **No league draw-rate information.** The model never sees how often a league actually draws. | Either way | League draw rates differ by several pp at the same goal rate. A Poisson model with a fixed ρ can't reproduce this. |
| 9 | **League-name join collisions.** `LMAP` is keyed by display name (`processData.ts:166`), and 20 entries are "Premier League". | Wrong λ | Every "Premier League" fixture used whichever league's average was written last. Goal rates across the map range from about 1.1 to 1.6, so λ could be off by ±20%. |
| 10 | **Team-name collisions.** `byTeam` is keyed by `norm(team)` across all leagues (`:154-155`). | Wrong stats entirely | A fixture could be joined to another country's club, and `sameLeagueOnly` only compared display names. |
| 11 | **NaN at season start.** There's no guard for a 0/0 league average (`standingTasks.ts:79`). | NaN | `draw_percentage` = `NaN`. |
| 12 | **Hard-coded date** `"05 07"` (`fixturesTask.ts:39`). | No fixtures | A scrape on any other day saved nothing. |

Net effect on the reference fixture: the old model says **20.51%**. A correctly
scaled model at a typical published ρ (−0.06 to −0.10) gives **26.9–27.9%**. On
an 80-fixture synthetic snapshot whose true draw rate is 27.8%, the old model
averaged **20.4%** and the new one **27.5%**. In other words, the old output was
systematically about 7 pp too low. Because the keep rule's `prob` branch used
thresholds of 0.20–0.28, the score heuristic was doing almost all of the
selecting.

---

## 3. Recommended method

### What season aggregates can and can't identify

| Parameter | Identified by the tables? | How |
|---|---|---|
| Team attack and defence (Maher multipliers) | **Yes** | GF/game and GA/game ÷ league rate. These are sufficient statistics for a Maher model with a balanced schedule. There's no opponent adjustment beyond the balance a league schedule gives. |
| League goal rate L | **Yes** | Σ goals ÷ Σ team-games. |
| Home advantage per league | **Yes** | Home-table goals vs away-table goals give a home share of goals per league. This matches a league-level total. |
| Spread of team strengths (shrinkage strength) | **Yes**, pooled | The method of moments on the variance of GF/game across teams, minus Poisson noise (empirical Bayes, Efron & Morris 1975). |
| Venue-specific deviation of a team | **Weakly**, pooled | The home-minus-away multiplier variance in excess of noise. It's usually small, so the shrinkage is heavy. |
| ρ, or draw inflation, pooled | **Yes**, as one number | Fitted so that Σ predicted draws = Σ observed draws over all leagues (a league-level total). |
| ρ per league | **Yes**, as one number per league | Fitted so that the mean draw probability over the league's round robin = the league's (shrunk) draw rate. |
| ρ vs a diagonal-inflation term vs a bivariate-Poisson covariance | **No** | All three only move the draw total. Separating them needs score-level results (how many 0-0s vs 1-1s vs 2-2s). |
| Team-specific draw propensity | **No** (not reliably) | A team's draw % after n games has sd ≈ √(0.25·0.75/n), which is 13 pp at n = 11. That's mostly noise, and it's already part of the league total. |
| Calibration coefficients a, b | **No** | They need outcomes per prediction. |

### Candidates

| Method | Needs | Gains | Fails when | Can't estimate without results |
|---|---|---|---|---|
| **A. Shrunk-averages Dixon–Coles, bugs fixed** (fixed ρ) | Tier A | Correct scale and a proper home advantage | A league's draw rate differs from what a fixed ρ implies | ρ, calibration |
| **B. Diagonal-inflated bivariate Poisson** (Karlis & Ntzoufras 2003) | Tier A, plus a draw rate to set the inflation p | Explicit draw inflation and a covariance term λ₃ | λ₃ and p can't be told apart from aggregates. With p set from the league draw rate, it gives the same fixture ranking as D, with a different shape over score cells. | λ₃ separately from p, and the inflation distribution |
| **C. Ordered probit or logit on strength difference** (e.g. Koning 2000; Goddard 2005) | Results, to fit cut points and the slope | Models W/D/L directly | **It can't be fitted.** The cut points and the slope on the strength difference need match outcomes. From aggregates you can only set the draw-band width so the league draw rate matches, but then the slope is an assumption. It also ignores the goal level, so it can't say that a 0.9-goal league draws more than a 1.6-goal one at the same strength gap, which Poisson gets for free. | Everything except the league draw rate |
| **D. Poisson draw probability blended with shrunk team and league draw rates** | Tier A | Uses the observed draw counts | Blending a team's draw % (noise ±13 pp) adds variance and double-counts the league rate. Blend weights need results. | The blend weights |
| **Chosen: A + league-calibrated ρ (D's useful part, done inside the likelihood family)** | Tier A, plus Tier B draw counts | Correct scale, venue-aware λ, a draw rate matched per league with empirical-Bayes shrinkage, and every parameter either estimated or an explicit prior | Teams' draw tendencies beyond goal rates aren't modelled, and neither is in-season change in form (no match history). | Score-level ρ vs inflation, and calibration |

**Why this one?** The data constraint decides it. The only draw-specific signal
in the tables is each league's draw count. The only goal-level signal is
GF/GA at overall and venue level. Dixon–Coles with a per-league ρ uses both:

- λ comes from goals, so the effects of goal level and mismatch on draws come
  out of the Poisson structure;
- ρ is the single free draw parameter, and it's pinned to the league's own
  shrunk draw rate.

A diagonal-inflated bivariate Poisson would have the same number of
identifiable draw parameters (one per league), so it can't do better on this
data. An ordered probit can't be fitted at all. A team draw-rate blend adds
noise with weights that can't be fitted. ρ is clamped to [−0.5, 0.35] and to
the range where every τ cell is ≥ 0. A league whose draw rate needs a value
outside that range is reported at the bound, which shows up in the `rho` column.

### Formulas

Notation: league l with teams i. n is games, G is goals, D is draws (the table
counts each match twice). Every "shrink" is a Gamma–Poisson or Beta–Binomial
posterior mean, written as a weighted average with a prior worth k pseudo-games.

**League rates.** `leagueRates()` computes these. The priors come from §"Priors".

$$L_l = \frac{\sum_i G^{for}_i + k_L \bar L}{\sum_i n_i + k_L},\qquad k_L = \bar L / \sigma^2_L$$

$$s_l = \frac{G^{home}_l + m_s \bar s}{G^{home}_l + G^{away}_l + m_s},\qquad m_s=\bar s(1-\bar s)/\sigma^2_s$$

$$H_l = 2L_l s_l,\qquad A_l = 2L_l(1-s_l)$$

**Team strengths** (Maher multipliers, average = 1). `teamStrength()` computes
these.

$$\alpha_i = \frac{G^{for}_i/L_l + k_\alpha\cdot 1}{n_i + k_\alpha},\qquad \delta_i = \frac{G^{against}_i/L_l + k_\delta\cdot 1}{n_i + k_\delta},\qquad k_\alpha = \frac{1}{CV^2_\alpha L_l}$$

Venue multipliers are shrunk toward the team's own overall multiplier. They are
measured against the league's venue-specific rate, so home advantage enters only
once, through $H_l$ and $A_l$.

$$\alpha^{home}_i = \frac{G^{for,home}_i/H_l + k_v\,\alpha_i}{n^{home}_i + k_v},\qquad \delta^{home}_i = \frac{G^{against,home}_i/A_l + k_v\,\delta_i}{n^{home}_i + k_v}$$

The away side is the mirror image, with $A_l$ for goals scored and $H_l$ for goals conceded.

**Fixture rates** (normalised, clamped to [0.05, 6]):

$$\lambda = H_l\,\alpha^{home}_h\,\delta^{away}_a,\qquad \mu = A_l\,\alpha^{away}_a\,\delta^{home}_h$$

**Draw probability** (Dixon & Coles 1997, with K = 15):

$$P(D) = \sum_{k=0}^{K} \mathrm{Pois}(k;\lambda)\,\mathrm{Pois}(k;\mu)\,\tau(k,k) = P_{indep} - 2\rho\lambda\mu e^{-\lambda-\mu}$$

**League ρ.** `buildLeagueModel()` builds the full home-and-away round robin of
the league's teams from their overall strengths, $\{(\lambda_{ij}, \mu_{ij})\}$.
It then does the following:

1. Prior draw rate: $\pi_l = \overline{P(D;\rho_{pool})}$, which is what the
   model expects for this league at the pooled ρ.
2. Shrunk draw rate: $d_l = \dfrac{D_l/2 + m_d\,\pi_l}{N_l/2 + m_d}$, where
   $m_d = \pi_l(1-\pi_l)/\sigma^2_{excess}$.
3. Bisect for $\rho_l$ so that $\overline{P(D;\rho_l)} = d_l$.

**Priors**, from `estimatePriors()`, using the method of moments over the whole
snapshot:

- $CV^2_\alpha = \mathrm{mean}\big[(\hat\alpha_i - 1)^2 - 1/(n_i L_l)\big]$, and
  the same for δ.
- The venue CV² comes from the home-minus-away multiplier variance in excess of
  noise.
- $\sigma^2_L$ and $\sigma^2_s$ are the between-league variances in excess of
  Poisson or binomial noise.
- $\rho_{pool}$ solves $\sum_l N_l\,\overline{P(D;\rho)} = \sum_l D_l$, where
  the sums run over leagues with draw counts.
- $\sigma^2_{excess}$ is the variance of (observed − model rate at
  $\rho_{pool}$), minus binomial noise.

Each estimate needs at least 40 teams or 8 leagues. Otherwise it falls back to
`DEFAULT_PRIORS`, and it's clamped to `PRIOR_BOUNDS`.

### Fitted vs assumed, and confidence

| Quantity | Source | Confidence |
|---|---|---|
| $L_l$, $s_l$ (home share) | Fitted per league, shrunk | High once the league has about 50+ matches |
| α, δ per team | Fitted, shrunk with an estimated $k$ | Moderate. After 10 games, about half the weight is still on the league prior (k ≈ 10–12 games), which is intended. |
| $CV^2$ (strength spread), venue CV² | Fitted (empirical Bayes) | Moderate for strengths and low for venue. The venue estimate is usually at or near its floor. |
| $\rho_{pool}$ | Fitted to total draws | Moderate. It's really a draw-inflation number: whatever the Poisson structure misses on the draw total ends up here. |
| $\sigma^2_{excess}$ | Fitted, floor of 0.0001 (sd 1 pp) | **Low.** With ~10 matches per league early in the season, almost all league-to-league draw variation is noise, so the estimate sits at the floor and leagues are pulled strongly toward $\pi_l$. The floor is an assumption. |
| $\rho_l$ per league | Fitted to $d_l$ | Same as above |
| Defaults (`DEFAULT_PRIORS`) | **Assumed**. Order-of-magnitude values typical of European leagues: CV ≈ 26%, home share 0.56, draw rate 0.26, ρ −0.06 (Dixon & Coles report ρ ≈ −0.13 for English leagues in 1992–95). | Only used when the snapshot is too small to tell |
| Bounds (`PRIOR_BOUNDS`, `RHO_MIN`/`RHO_MAX`, λ ∈ [0.05, 6]) | **Assumed** | They guard against degenerate fits only |
| Calibration (a, b) | **Not fitted.** Identity. | — |

---

## 5. Tests

Run them with `npm test`, which runs `tsx --test "src/**/*.test.ts"`. There are
37 tests. All use synthetic data, and the Poisson noise comes from a seeded
PRNG.

| Sanity rule | Test (file) |
|---|---|
| Two league-average teams get close to **that league's own** draw rate, not a generic 25% | "identical teams: exactly the table's draw rate, per league" (30% and 20% leagues). Also "uneven league: an average pairing sits at or just above the league rate". (`features.test.ts`) |
| Higher combined goal expectation → fewer draws | "more expected goals → fewer draws", and the raw-rate version |
| Bigger strength mismatch → fewer draws | "bigger strength mismatch → fewer draws" (both orientations) |
| A team with very few games stays near the league average | "a team with one game stays near the league average" (moves < 4 pp, and < 35% of what the same rates over 30 games would move) |
| Plausible range of 10–40%, never NaN (including 0 games and a missing league row) | "empty league", "season not started", "garbage cells (NaN, negatives) and extreme rows", "typical fixtures land roughly in 10–40 %" |
| League draw-rate prior depends on goal level | "the draw-rate prior falls as the league's goal rate rises" |
| Empirical Bayes recovers known parameters | "recover the true spread of strengths from Poisson-noised tables", and "the pooled ρ reproduces the total number of draws" |
| DC arithmetic | Closed form P_indep − 2ρλμe^(−λ−μ), τ ≥ 0 clamping, the `fitRho` target and bounds, and the calibration hook |
| Joins on (league, team) despite name collisions | "joins fixtures to the tables of their own league, even when names collide" (`processData.test.ts`) |
| CSV contract | First 16 columns unchanged in name and order, `draw_percentage` on 0–100, quoting |
| Date filter, source ids | `dates.test.ts`, `sources.test.ts` |

---

## 6. Validation plan

### What the pipeline now saves
- **Dated snapshots** at `output/snapshots/scrape-<ISO timestamp>.json`, with
  `matchDate`. These are point-in-time inputs: the model is deterministic, so
  any past prediction can be regenerated exactly from its snapshot.
- **CSV keys** for joining results later: `league_id`, `match_date`,
  `home_team`, `away_team` and `scraped_at`.

### What still needs to be saved (not built yet)
1. **Results.** Scrape each league's `/results/` page (same `leagueId`, same
   selectors, plus the score cells) every day for the previous day. Store
   `{ leagueId, matchDate, home, away, homeGoals, awayGoals }` in
   `output/results/<date>.json`.
2. **Predictions for every scored fixture**, not only the kept ones. The kept
   subset is selected on `prob`, so evaluating only that subset is biased. Until
   this exists, regenerate the full set from the dated snapshots.
3. **Closing draw odds** for the market baseline (Tier C, see §7).
4. The **git commit or model version** used for each prediction run. `method`
   includes "(v2)". Bump it whenever the model changes.

### Metrics
For every prediction p with outcome y ∈ {0, 1} (draw or not):

- **Brier score:** mean (p − y)².
- **Log loss:** −mean[y ln p + (1−y) ln(1−p)].
- **Calibration curve:** bin p into deciles or 2.5 pp bins, and plot the mean p
  against the observed draw rate with Wilson intervals. Also compute the
  calibration slope and intercept by regressing y on logit p. That regression
  gives the `{ a, b }` for `calibrate`.
- **Skill vs baselines:** BSS = 1 − Brier/Brier_baseline.
  1. **League draw rate:** p = the shrunk draw rate from the same snapshot (the
     `league_draw_rate` column, or `drawRateShrunk`). This is the
     "no team information" baseline, and the model must beat it.
  2. **Market:** p = (1/o_D) ÷ (1/o_H + 1/o_D + 1/o_A), with the bookmaker margin
     removed proportionally. Shin's method (Shin 1993; Štrumbelj 2014) is better
     for longshots. Being calibrated is necessary for the model. Beating the
     market on log loss is what makes betting viable.
- Report the metrics by league group and by games played (≤ 5, 6–15, > 15),
  because shrinkage matters most early in the season.

### Walk-forward split
Use only point-in-time snapshots. For each matchday t:

- the prediction uses `snapshot(t)`;
- any fitted hyper-parameter (calibration a and b, `σ²_excess` floors, keep
  thresholds) is fitted on matchdays **< t** only.

Expand the window over time, never shuffle, and keep a final untouched block
(for example, the last 20% of the season) for the one-off check. With roughly
150 leagues × 4–8 fixtures a day, a few weeks gives thousands of predictions.
Calibration within ±2 pp per bin needs about 500 fixtures per bin.

---

## 7. Extra data worth collecting (Tier C)

| Data | Free source | Expected gain | Effort | What it enables |
|---|---|---|---|---|
| **Past results with scores** (for the backtest) | Flashscore `/results/` pages (same selectors as fixtures, plus `.event__score--home/away`). Also football-data.co.uk CSVs (about 25 European leagues, many seasons, with closing odds). | **High (a prerequisite)** | Low: one more task in the cluster | Everything in §6. Score-level fits separate DC ρ from draw inflation, and allow calibration `{ a, b }`. |
| **Closing 1X2 odds** | football-data.co.uk (Europe). Flashscore odds tab per match. OddsPortal (scraping is fragile). | **High** | Medium | The market baseline. Market-implied draw probability as a feature or prior. Edge-based keep rules. |
| **Match-by-match history** (date, opponent, venue, score) | Flashscore team or results pages, and football-data.co.uk | **High** | Medium | A true Dixon–Coles likelihood fit with time decay (DC 1997 §5), opponent adjustment for unbalanced schedules, and team form. Also bivariate Poisson (Karlis & Ntzoufras 2003) fitted properly. |
| **Real xG / xGA** | FBref (Opta-sourced, top ~20 leagues). Understat (top 6). | Medium-high for covered leagues | Medium | Strengths with less noise than goals (xG converges about 2× faster). Coverage is small next to 161 leagues. |
| **Previous-season tables** | Flashscore archive (`/standings/` of the previous season) | Medium | Low | Informative priors for early-season shrinkage (a prior centred on last season, regressed) instead of the league mean. |
| **Lineups and injuries** | Flashscore match pages, about 1 hour before kick-off | Low-medium | High (timing) | Adjusts for missing key players. The gain is mostly already in the market price. |
| **Match context** (dead rubbers, derbies, end-of-season incentives) | Derived from tables and fixtures | Low-medium for draws specifically | Medium | End-of-season mutual-benefit draws are documented but rare. |
| **Weather and pitch** | Open-Meteo (free API) | Low | Low | Small effect on goal rates. |

---

## 8. Assumptions and open questions

**Assumptions I made:**
- Flashscore's `cells[1]`, `cells[3]` and the last value cell are wins, losses
  and points. This is **unverified**, and the model doesn't use them.
- `div.heading__name` is a display name, not unique across countries. The
  `leagueId` from the URL is the key.
- Kick-off dates on fixture pages are printed in the scraping machine's local
  time zone, so "today" is local. Late-night kick-offs near midnight UTC can
  fall on the neighbouring day.
- A table with multiple groups (conferences) is treated as one league for rates
  and for ρ.
- The round robin used to fit ρ treats every ordered pair as equally likely.
  Real schedules are balanced over a season, but not at every point in time.
- I haven't checked the 4 sources without venue tables or the
  Sweden/Norway mismatch against the live site. I only report them with
  warnings and don't guess replacement URLs.

**Proposals (not applied: thresholds stay as they were, because there's no data):**
- The keep rule's `prob` branch was tuned against a model biased about 7 pp low.
  With the corrected scale, `probKeepThreshold = 0.24` (medium) passes most
  league-average fixtures. On synthetic data, `soft` kept 80 of 80. I propose
  one of these:
  - (a) keep on `prob − league_draw_rate ≥ x`, a draw probability above the
    league's own rate;
  - (b) once odds exist, keep on edge = p × odds − 1 > margin;
  - (c) meanwhile, rank by `prob` and keep the top N per day.

  Pick x, N or the margin from the walk-forward backtest, not by hand.
- `sameLeagueOnly` was removed from the presets. Joins are now within the
  fixture's own league by construction, so cross-league pairings can't happen.
- The `score` heuristic is kept for continuity. It's collinear with the model
  (low goals, close ranks and similar attack all raise P(D)), so once results
  exist, test whether it adds anything beyond `prob`.

**Open questions for you:**
1. Which Supabase table receives the CSV? The column additions in GUIDE.md
   assume it's called `draw_candidates`.
2. Should the Sweden Superettan entry point at the Superettan standings? (It
   currently uses Norway OBOS-ligaen.)
3. Do you want a results scraper next? It's the single highest-value addition,
   because it turns "unmeasured" into a backtest.

### References
- Maher, M. J. (1982). Modelling association football scores. *Statistica Neerlandica* 36(3).
- Dixon, M. J. & Coles, S. G. (1997). Modelling association football scores and inefficiencies in the football betting market. *JRSS C* 46(2).
- Karlis, D. & Ntzoufras, I. (2003). Analysis of sports data by using bivariate Poisson models. *JRSS D* 52(3).
- Efron, B. & Morris, C. (1975). Data analysis using Stein's estimator and its generalizations. *JASA* 70.
- Koning, R. H. (2000). Balance in competition in Dutch soccer. *JRSS D* 49(3). Goddard, J. (2005). Regression models for forecasting goals and match results in association football. *IJF* 21.
- Shin, H. S. (1993). Measuring the incidence of insider trading in a market for state-contingent claims. *Economic Journal* 103. Štrumbelj, E. (2014). On determining probability forecasts from betting odds. *IJF* 30.
