# Role

You are a senior sports-analytics engineer and statistician who specialises in
football (soccer) score models: Poisson and bivariate Poisson, Dixon–Coles, rating
systems and probability calibration. You also write production-quality TypeScript
for Node.

# Task

1. Read the codebase and explain exactly what it does, from scraping to the CSV
   that gets imported into Supabase.
2. Evaluate the current draw-probability model (`calculateDrawProbabilityDC` in
   `src/lib/features.ts`) against the data this pipeline actually has. Say whether
   it's the most accurate option for that data and, if not, what is.
3. Implement the most accurate, best-calibrated draw-probability method that this
   data supports. You may rewrite the model completely and change any file, within
   the constraints below.
4. Separately, rank additional data I could collect by expected accuracy gain.

# Context

## Where things are

Start with `CLAUDE.md` (commands, conventions, pipeline, file map), then read every
file under `src/`. `src/data/map.ts` is just ~165 pairs of league URLs, so skim it.
If CLAUDE.md and the code disagree, the code wins. Tell me about any mismatch.

Pipeline: `npm run scrape` (`src/main.ts`, a puppeteer-cluster over Flashscore)
→ `output/scrape.json` → `npm run process -- <soft|medium|hard>` (`src/process.ts`
→ `src/actions/processData.ts`, which filters and scores fixtures and calls the
model) → `output/draw-candidates-<preset>.csv` → imported into Supabase by hand.

## What the output is for

The CSV feeds a draw-betting strategy, so a calibrated probability per fixture
matters most: when the model says 30%, about 30% of those matches should end
level. Ranking fixtures correctly is not enough.

## Data available

**Tier A: stored in `scrape.json` today** (types in `src/types/index.ts`):

- Team rows, in three tables (`overalls`, `homes`, `aways`): `league` (text of
  `div.heading__name`), `team`, `totalGames`, `goalsFor`, `goalsAgainst`,
  `expectedGoals` (goalsFor ÷ totalGames, 2 dp, **not xG**), `expectedConcededGoals`
  (goalsAgainst ÷ totalGames), `matchesDrawed` (draws ÷ games × 100, 2 dp) and
  `rank` (the position within _that_ table, so a home-table row holds its home rank).
- League rows: `league`, `leagueAvgGoalsForPerTeam` and
  `leagueAvgGoalsAgainstPerTeam`. Both are total goals ÷ total team-games from the
  overall table, so they are always identical.
- Fixtures: `date` (raw Flashscore text such as `05.07. 18:00`, with no year),
  `home` and `away`. There is no league or source tag.

**Derivable from Tier A** without scraping anything new:

- the league draw rate (Σ draws ÷ Σ games over the overall table, with draws ≈
  matchesDrawed × totalGames ÷ 100);
- league home-goals and away-goals per game (from the home and away tables), which
  give a per-league home advantage;
- home and away draw rates.

**Tier B: on pages the scraper already loads but doesn't store.** These are wins,
losses, points and the raw draw count, all in the same row of
`span.table__cell--value` cells (`cells[0]` is games, `cells[2]` draws, `cells[4]`
"GF:GA"). Adding them is in scope. Any column you parse from new cells stays
unverified until I check it against the live DOM, so flag it as unverified.

**Tier C: everything else** (new pages or sources). This belongs in section 7 only.

There's no match-by-match history: no past results, no match dates and no list of
opponents. Every number is a season-to-date aggregate. Each run also overwrites
`output/scrape.json`, so no history builds up either.

## Known issues (verify each one; the list may be incomplete)

Model (`src/lib/features.ts`):

- **λ isn't normalised.** `combineAttackDefense` multiplies the attack rate by the
  defence rate without dividing by the league average, so λ is inflated by roughly
  the league average (~1.3–1.4×). I measured the effect on two league-average teams
  in a 1.35-goals-per-team league:
  - 20.6% with the code as it is;
  - 24.1% with λ normalised;
  - 28.0% with λ normalised and ρ = −0.10.
- **ρ = +0.06.** In `dixonColesAdj`, τ(0,0) = 1 − λμρ and τ(1,1) = 1 − ρ, so a
  positive ρ lowers the chance of 0-0 and 1-1. Published estimates are usually
  negative.
- **Home advantage may be counted twice.** The home team's home split and the away
  team's away split already contain home advantage, and `homeAdvFactor` (1.03) is
  applied on top. The split rates are also shrunk toward the overall league mean
  rather than a venue-specific mean.
- **`blendSplitWithOverall` double-counts games.** It blends each split with an
  overall row that contains the same games.
- **`priorStrengthK` has no effect.** The split path ignores it and uses
  hard-coded `kSplit = 6` and `kOverall = 8`. The split path always runs, because
  `processData` always passes an overall row.
- **`calibrate: { a, b }` is never passed**, and there's no data to fit it yet.

Data integrity:

- **League names may collide.** In `map.ts`, 20 entries have a `premier-league`
  slug, 7 have `super-league`, 3 have `serie-b`, and more repeat. If
  `div.heading__name` holds only the league name:
  - `LMAP` keeps one league-average row per name, and the last one written wins;
  - `sameLeagueOnly` accepts two teams from different "Premier League"s.
- **Team names collide.** `byTeam` keys the maps on `norm(team)` across all
  leagues, so clubs with the same name in different countries overwrite each other.
  Because fixtures have no league tag, a fixture can join to the wrong club's stats.
- **The date filter is hardcoded.** `fixturesTask.ts` keeps only fixtures dated
  `05.07`, so a scrape on any other day saves no fixtures.
- **There's no backtest**, so current accuracy is unmeasured.

Filtering and scoring (`src/actions/processData.ts`):

- **The keep rule is unvalidated.** A fixture is kept if
  `score >= scoreKeepThreshold` **or** `prob >= probKeepThreshold`. The score
  weights and thresholds were set by hand. The medium preset's probability
  threshold (0.24) is higher than what the current model gives two average teams,
  so in practice the score does most of the selecting.
- **The preset fields named `xg` and `xga` hold actual goals per game.**

# Reasoning

Work through these steps before writing any code:

1. Trace the numbers end to end, from DOM cell to CSV column. Note every
   transformation, rounding and fallback.
2. Say what season aggregates can and can't identify. For each parameter (ρ, home
   advantage, any draw-inflation term, shrinkage strength, calibration
   coefficients), say whether the data can estimate it or whether it has to come
   from published values until match-level results exist. Matching league-level
   totals, such as the league draw rate or the home/away goal split, counts as
   estimating it from the data.
3. Compare the candidate methods that fit this data. Cover at least:
   - the current shrunk-averages Dixon–Coles, with its bugs fixed;
   - a diagonal-inflated bivariate Poisson;
   - an ordered-outcome model (ordered logit or probit) on strength difference;
   - a blend of the Poisson draw probability with shrunk team and league draw rates.

   For each one, say what it needs, what it gains, how it fails and what it can't
   estimate without results.

4. Pick one method. Justify the choice by the data constraint, not by how popular
   the method is.
5. Sanity-check the result. These checks become the tests:
   - Two league-average teams get close to that league's own draw rate, derived
     from its table, rather than a generic 25%.
   - Higher combined goal expectation lowers the draw probability, and so does a
     bigger strength mismatch.
   - A team with very few games stays near the league average.
   - Outputs stay in a plausible range (roughly 10–40%) and never come out as NaN,
     including with 0 games played or a missing league row.
6. Say which numbers are fitted and which are assumed, and how confident you are
   in each.

# Output

Make the code changes directly in the repo. Write sections 1–3 and 5–8 to
`docs/draw-model.md`, then reply with a short summary and the list of changed files.

1. **How the code works.** A short walkthrough by stage, with the shape of the data
   at each stage.
2. **Assessment of the current model.** What's sound and what's wrong. For each
   problem, give the function and line, the direction of its effect on the draw
   probability and its rough size. Compute the size wherever you can instead of
   estimating it.
3. **Recommended method.** The choice, the formulas, and why it beats the
   alternatives for this data.
4. **Code.** Edit the files in place, and list what changed in each file in the
   summary.
5. **Tests.** A `node:test` file with synthetic data that checks the sanity rules
   above. Make `npm test` run it (for example with `tsx --test`), replacing the
   placeholder script.
6. **Validation plan.** How to measure accuracy once results exist:
   - Brier score, log loss and a calibration curve;
   - compared against two baselines: the league draw rate, and the market's draw
     probability with the bookmaker margin removed;
   - using a walk-forward split built only from point-in-time snapshots.

   Say what the pipeline must start saving now to make this possible.

7. **Extra data worth collecting.** A table with the data item, a free source,
   expected gain (high, medium or low), effort, and what it would let the model do.
   Include how to get past results for a backtest.
8. **Assumptions and open questions.**

# Constraints

- **Data:** the core method uses only Tier A and Tier B data. Anything that needs
  Tier C goes in section 7.
- **Conventions:** follow CLAUDE.md:
  - TypeScript 6.0.x (don't upgrade it), ESM and `.ts` relative imports;
  - strict mode plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
  - `npm run typecheck` and `npm run lint` must pass.
- **Stack:** no Python, no paid services and no database. Persistence stays as
  JSON files plus the CSV. Small, well-known npm packages are fine if you justify
  them.
- **CSV contract:** keep the existing columns with the same names and order, and
  keep `draw_percentage` on a 0–100 scale. You may append columns. List any you
  add, because they have to be added to the Supabase table before the import.
- **Separation:** keep the probability model (`src/lib/features.ts`) separate from
  fixture filtering and scoring (`processData.ts`) and from any staking logic. If
  the keep rule or the presets need to change because the model's scale changed,
  propose the change, but don't tune thresholds without data.
- **Integrity fixes (in scope):**
  - tag fixtures and table rows with the `map.ts` entry they came from, so joins
    are on (league, team);
  - replace the hardcoded date filter: default to today, with an optional CLI
    override;
  - save a dated copy of each snapshot alongside `output/scrape.json`.
- **Don't run `npm run scrape`.** It opens 4 visible Chrome windows and loads about
  660 Flashscore pages. Test with synthetic data, or with `output/scrape.json` if
  it exists.
- **Accuracy claims:** don't invent accuracy figures. Without a backtest, say that
  accuracy is unmeasured.
- **Citations:** name the published methods you rely on (for example Maher 1982,
  Dixon & Coles 1997, Karlis & Ntzoufras 2003) so I can look them up.
- **Docs:** update the pipeline and "Known issues" sections of CLAUDE.md to match
  your changes.
- **Unclear code:** if something in the code is unclear, state your assumption and
  keep going instead of stopping.
