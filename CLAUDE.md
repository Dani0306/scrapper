# CLAUDE.md

Football draw-prediction pipeline. Scrapes league tables and upcoming fixtures from Flashscore, estimates each fixture's draw probability, and exports the best candidates to a CSV that gets imported into Supabase. Model details: `docs/draw-model.md`. Run guide: `docs/GUIDE.md`.

## Commands

```bash
npm run scrape                          # Step 1: scrape Flashscore for today → output/scrape.json (+ dated copy)
npm run scrape -- --date 2026-10-04     # same, for another day (also --date 04.10)
npm run process                         # Step 2: scrape.json → output/draw-candidates-medium.csv
npm run process -- hard                 # same, with a different preset (soft | medium | hard)
npm test                                # node:test via tsx, synthetic data only
npm run typecheck                       # tsc --noEmit
npm run lint                            # eslint . (lint:fix to auto-fix)
```

Run `typecheck`, `lint` and `test` after every change. Don't run `npm run scrape` to test: it opens 4 visible Chrome windows and loads about 640 pages.

## Stack and conventions

- Node 22, ESM (`"type": "module"`), TypeScript run directly with `tsx`.
- **TypeScript is pinned to 6.0.x on purpose.** typescript-eslint doesn't support TS 7 yet, so don't upgrade it.
- Relative imports use the `.ts` extension (`import x from "./lib/store.ts"`). `rewriteRelativeImportExtensions` turns them into `.js` at build time.
- The tsconfig is strict and also enables `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`:
  - Array indexing returns `T | undefined`, so handle it with `?? 0` (or similar).
  - Don't assign `undefined` to an optional property explicitly; spread the property in only when it has a value.
- `lib` includes `dom` because code inside Puppeteer's `page.evaluate()` runs in the browser and uses `document`. Keep Node imports out of `page.evaluate()` callbacks; filter in Node afterwards.
- Tests are `src/**/*.test.ts` (`node:test` + `node:assert/strict`). `npm run build` uses `tsconfig.build.json`, which excludes them.
- There is no database. MongoDB/Mongoose was removed on purpose. Persistence is JSON files in `output/`, and the final results go to Supabase as a CSV.
- Keep the layers separate: the probability model (`src/lib/features.ts`, pure) ≠ filtering and scoring (`processData.ts`) ≠ any staking logic.

## Pipeline, step by step

### Step 1: Scrape (`src/main.ts`)

1. **Build the source list.** `buildSources()` (`src/lib/sources.ts`) turns `flashscoreMap` (`src/data/map.ts`, 163 entries) into 161 sources. Each gets a `leagueId` = `country/league-slug` from the fixtures URL. Duplicates are dropped and suspicious pairings are warned about. Home and away URLs come from swapping `/standings/overall` (or `/table/overall`) for `home` or `away`. Entries without that segment (`live-standings`, Spanish `clasificacion`) get no home or away jobs.
2. **Pick the match day.** `matchDayFromArgs()` (`src/lib/dates.ts`) returns today (local time) or `--date`.
3. **Launch the browser cluster.** It starts a `puppeteer-cluster` with `CONCURRENCY_CONTEXT`, `maxConcurrency: 4`, `headless: false` and a 90 s task timeout. Task errors are logged and don't stop the run.
4. **Queue up to 4 jobs per league.** Every row is tagged with the source's `leagueId`.
   - **`fixturesTask`**: reads each `div.event__match` → `{ date, home, away }`, then keeps rows whose stage time starts with the match day's `DD.MM` → `FixtureRow { leagueId, date, matchDate, home, away }`.
   - **`standingsTask`** (overall, home, away): reads each `div.ui-table__row` → `TeamRow`. `cells[0]` is games, `cells[2]` draws, `cells[4]` `"GF:GA"`. `cells[1]`, `cells[3]` and the last cell are stored as `wins`, `losses` and `points`, which are **unverified against the live DOM** and unused by the model. `expectedGoals` and `expectedConcededGoals` are actual goals per game (not xG), and `matchesDrawed` is draw %.
   - The overall job also pushes a `LeagueRow` (league goals per team-game, 0-safe). The model no longer reads it.
5. **Shared page setup.** `prep()` (`src/lib/utils.ts`) blocks images, fonts, media and CSS, and sets a 25 s navigation timeout.
6. **Save.** `saveSnapshot()` writes `{ scrapedAt, matchDate, fixtures, overalls, homes, aways, leagues }` to `output/scrape.json` **and** `output/snapshots/scrape-<timestamp>.json`.

### Step 2: Process (`src/process.ts` → `src/actions/processData.ts` → `src/lib/features.ts`)

1. **Load** the snapshot. The preset comes from `argv[2]` (default `medium`).
2. **Group** the tables by `leagueId`, with teams keyed by `norm(team)` within their league (`groupTables`).
3. **Fit priors** from the whole snapshot (`estimatePriors`, empirical Bayes / method of moments): spread of team strengths, venue deviation, league goal-rate and home-share spread, pooled Dixon–Coles ρ (fitted so total predicted draws = total observed draws), and league draw-excess variance. Defaults are used when there's too little data.
4. **Build one model per league** (`buildLeagueModel`): shrunk goals per team-game `L`, home and away rates `H` and `A` from the home share of goals, and the draw rate shrunk toward what the model implies at the pooled ρ. Then the league's own ρ is fitted so that the mean round-robin draw probability equals that shrunk rate.
5. **Filter each fixture.** It's skipped when its league has no tables, a team isn't in that league's overall table, either team has fewer than `minSeasonGames`, or the `hardXgGates` fail (medium and hard).
6. **Heuristic score** (unchanged, hand-tuned): low goals for and against, high draw %, small rank gap, similar attack, not top or bottom of the table.
7. **Model probability** (`calculateDrawProbabilityDC`): Maher multipliers α and δ, shrunk toward 1. Venue multipliers are measured against the venue league rate and shrunk toward the team's overall multiplier. λ = H·α_home·δ_away and μ = A·α_away·δ_home, clamped to [0.05, 6]. Then P(draw) = Σ Pois·Pois·τ_DC with the league's ρ (K = 15). Optional logistic `calibrate`, not used.
8. **Keep or drop.** A fixture is kept if `score >= scoreKeepThreshold` **or** `prob >= probKeepThreshold`, then sorted by `drawPercentage`, highest first.
9. **Export** `output/draw-candidates-<preset>.csv`. The first 16 columns are a contract (names and order must not change):

   `home_team, away_team, league, game_date, draw_percentage, lambda_home, lambda_away, score, prob, rank_gap, home_draw_pct, away_draw_pct, att_delta, home_used_split, away_used_split, method`

   They are followed by `league_id, match_date, scraped_at, league_draw_rate, rho, prob_poisson, home_att, home_def, away_att, away_def, home_games, away_games`. A new column must be added to the Supabase table before importing.

## File map

| File | Role |
|---|---|
| `src/main.ts` | Entry point for step 1: scrapes and saves the snapshot |
| `src/process.ts` | Entry point for step 2: loads the snapshot, processes it, prints diagnostics, writes the CSV |
| `src/data/map.ts` | League fixture and standings URLs |
| `src/lib/sources.ts` | `leagueId`s, de-duplication and URL checks for the map |
| `src/lib/dates.ts` | Match day (today / `--date`) and Flashscore stage-time parsing |
| `src/tasks/fixturesTask.ts` | Puppeteer task that scrapes the match day's fixtures |
| `src/tasks/standingTasks.ts` | Puppeteer task that scrapes a standings table and league averages |
| `src/lib/utils.ts` | `prep()`: request blocking and timeouts |
| `src/lib/store.ts` | Saves and loads `output/scrape.json`, plus dated copies |
| `src/lib/features.ts` | The model: priors, league models, team strengths, Dixon–Coles |
| `src/actions/processData.ts` | Grouping, filter presets, scoring, `processData()`, CSV export |
| `src/types/index.ts` | `FixtureRow`, `TeamRow`, `LeagueRow`, `ScrapeSnapshot` |
| `src/**/*.test.ts` | Tests |
| `docs/draw-model.md` | Model assessment, method, validation plan, data wishlist |

## Known issues (not yet fixed)

- **Accuracy is unmeasured.** No results are scraped, so there's no backtest or calibration. See `docs/draw-model.md` §6.
- **Keep thresholds were tuned against the old, roughly 7 pp low model.** With the corrected scale, `probKeepThreshold` lets most fixtures through. Re-derive the thresholds from a backtest; don't hand-tune them. Proposals are in `docs/draw-model.md` §8.
- **Wins, losses and points cells are unverified** against the live DOM.
- **`map.ts` problems** (warned at scrape time): `sweden/superettan` is paired with Norway's standings, `jamaica/premier-league` points at `/results/`, and two entries are duplicated. Four leagues have no venue tables.
- **`game_date` is raw Flashscore text** (e.g. `05.07. 18:00`, no year). Store it as `text`. `match_date` is the real date.
- **"Today" is local time.** Fixtures near midnight can land on the neighbouring day.
- **Old snapshots** (from before `leagueId` existed) can't be processed. Re-scrape.
- **The goals-per-game fields aren't xG**, despite the `xg` / `xga` names in the presets.
