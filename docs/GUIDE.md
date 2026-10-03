# Guide: what changed and how to run it

## In short

- **The draw probabilities were about 7 percentage points too low.** The old
  model multiplied two goals-per-game rates without normalising them, used the
  wrong sign for the Dixon–Coles ρ, and applied home advantage twice. Two
  average teams came out at 20.5%. The correct figure is about 27%.
- **The new model uses each league's own draw rate.** It's a Maher Poisson model
  with properly scaled λ. ρ is fitted per league so that the league's average
  matchup reproduces its shrunk draw rate. All shrinkage strengths are
  estimated from the scrape itself (empirical Bayes) instead of being
  hard-coded.
- **Joins are now on (league, team).** Each row is tagged with the `map.ts`
  entry it came from, so the 20 different "Premier League"s and clubs with the
  same name no longer collide.
- **The scraper works on any day.** It filters fixtures for today by default,
  or for a `--date` you pass. It also keeps a dated copy of every snapshot,
  which is needed for a future backtest.
- **Accuracy is still unmeasured.** No match results are collected yet. See
  `docs/draw-model.md` §6 for the backtest plan.

The full reasoning, formulas, measured size of each old bug and references are
in [draw-model.md](draw-model.md).

## How to run

Requirements: Node 22. Run `npm install` once.

```bash
npm run scrape
```
This scrapes today's fixtures and all tables. It writes `output/scrape.json`
and `output/snapshots/scrape-<timestamp>.json`, and opens 4 Chrome windows for
about 640 pages.

```bash
npm run scrape -- --date 2026-10-04
```
Scrapes fixtures for a specific day. `--date 04.10` (current year) also works.

```bash
npm run process
```
Turns the snapshot into `output/draw-candidates-medium.csv`.

```bash
npm run process -- soft
```
Uses a different preset: `soft`, `medium` or `hard`.

```bash
npm test
```
Runs 37 tests on synthetic data. No network is needed.

```bash
npm run typecheck
```

```bash
npm run lint
```

`npm run process` prints the fitted priors (strength spread, pooled ρ, and so
on). It then prints a count of where fixtures were dropped: no league table,
unjoined team name, too few games, goal gates, kept. If "unjoined" is high,
team names on the fixtures page differ from the standings page for that league.

> **Old snapshots.** A `scrape.json` from before this change has no `leagueId`,
> so its fixtures can't be joined, and `process` warns about it. Re-run
> `npm run scrape`.

## Before your next Supabase import: add the new columns

The first 16 columns are unchanged in name and order. These 12 are appended
after `method`. This assumes your table is called `draw_candidates`, so adjust
the name if it isn't.

```sql
alter table draw_candidates
  add column league_id text,           -- "country/league-slug", the join key
  add column match_date date,          -- day the scrape filtered on
  add column scraped_at timestamptz,   -- snapshot timestamp
  add column league_draw_rate numeric, -- observed league draw rate, 0–1 (empty if unknown)
  add column rho numeric,              -- Dixon–Coles ρ used for this fixture
  add column prob_poisson numeric,     -- same λs with ρ = 0, 0–1
  add column home_att numeric,         -- home team attack multiplier (1 = league average)
  add column home_def numeric,         -- home team defence multiplier (lower = better)
  add column away_att numeric,
  add column away_def numeric,
  add column home_games integer,
  add column away_games integer;
```

`draw_percentage` is still on a 0–100 scale. Its values are now about 5–8 points
higher than before for the same fixtures, because the old values were biased
low.

## What changed, file by file

| File | Change |
|---|---|
| `src/lib/features.ts` | **Rewritten.** Maher strengths normalised by league rates. Venue splits measured against venue-specific league rates and shrunk toward the team's own overall rate, so home advantage counts once. Gamma–Poisson shrinkage with prior weights estimated from the snapshot (`estimatePriors`). Pooled ρ fitted to total draws. Per-league ρ fitted to the league's shrunk draw rate (`buildLeagueModel`, `fitRho`). ρ clamped to keep every τ ≥ 0. NaN-safe for 0 games and empty leagues. K raised from 10 to 15. |
| `src/actions/processData.ts` | Tables grouped by `leagueId`, with teams joined within their league. League models built once per run. `processDataDetailed()` returns the drop counts and priors. `sameLeagueOnly` removed (now implicit). Scoring heuristic and thresholds untouched. 12 CSV columns appended. |
| `src/types/index.ts` | `leagueId` on every row and fixture, plus `matchDate`, raw `draws`, and the unverified `wins`, `losses` and `points`. `ScrapeSnapshot` moved here. |
| `src/tasks/fixturesTask.ts` | Hard-coded `05.07` removed. Filters on the requested match day and tags fixtures. |
| `src/tasks/standingTasks.ts` | Tags rows with `leagueId`, stores raw counts, and guards the 0-game league average (it used to produce NaN). |
| `src/lib/sources.ts` (new) | Builds the scrape list from `map.ts`: league ids, de-duplication, warnings for bad pairs, and skipping home and away jobs where the URL has no `overall` segment. |
| `src/lib/dates.ts` (new) | Today or `--date` parsing, and Flashscore stage-time parsing. |
| `src/lib/store.ts` | Also writes a dated snapshot copy to `output/snapshots/`. |
| `src/main.ts`, `src/process.ts` | Wire the above together and print diagnostics. |
| `src/**/*.test.ts` (new) | 37 `node:test` tests (see draw-model.md §5). |
| `package.json` | `npm test` runs `tsx --test "src/**/*.test.ts"`. `build` uses `tsconfig.build.json`, which excludes the tests from `dist/`. No new dependencies. |
| `docs/draw-model.md`, `docs/GUIDE.md`, `CLAUDE.md` | Documentation. |

## Things in `map.ts` you should look at

The scraper now prints these as warnings. I didn't change `map.ts`, because I
couldn't verify replacement URLs.

- `sweden/superettan` fixtures are paired with **Norway's** `obos-ligaen` standings.
- `hungary/otp-bank-liga` and `malaysia/super-league` appear twice. The
  duplicates are skipped.
- `jamaica/premier-league` points at `/results/` instead of `/fixtures/`.
- `bulgaria/parva-liga`, `serbia/super-liga`, `kuwait/premier-league` (all
  `live-standings`) and `mexico/liga-de-expansion-mx` (Spanish site) have no
  home or away tables. The model uses overall rows for them.
