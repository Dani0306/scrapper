import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildLeagueModels,
  calculateDrawProbabilityDC,
  estimatePriors,
  type DrawProbabilityResult,
  type LeagueInput,
  type LeagueModel,
  type Priors,
  type TableRow,
  type TeamInput,
} from "../lib/features.ts";
import type {
  FixtureRow,
  ScrapeSnapshot,
  StatsType,
  TeamRow,
} from "../types/index.ts";

export type ProcessDataInput = Pick<
  ScrapeSnapshot,
  "fixtures" | "overalls" | "homes" | "aways" | "leagues"
> &
  Partial<Pick<ScrapeSnapshot, "scrapedAt" | "matchDate">>;

export interface DrawCandidate extends DrawProbabilityResult {
  /** Display name of the league. */
  league: string;
  leagueId: string;
  fixture: FixtureRow;
  scrapedAt: string | undefined;
  debug: {
    score: number;
    prob: number;
    gap: number;
    hDrawPct: number;
    aDrawPct: number;
    attDelta: number;
  };
}

export interface ProcessStats {
  fixtures: number;
  /** Fixtures whose league has no scraped overall table. */
  noLeagueTables: number;
  /** Fixtures with a team name that is not in its league's overall table. */
  unjoined: number;
  unjoinedSample: string[];
  tooFewGames: number;
  gated: number;
  scored: number;
  kept: number;
  leagues: number;
}

export interface ProcessDataOutput {
  results: DrawCandidate[];
  stats: ProcessStats;
  priors: Priors;
  models: Map<string, LeagueModel>;
}

// ---------- FILTER PRESETS ----------
// Thresholds were set by hand against the previous model and are untouched;
// see docs/draw-model.md §8 before changing them.
interface FilterPreset {
  minSeasonGames: number;
  // reject fixtures where a team's goals / goals-against per game exceed the max (otherwise only scored)
  hardXgGates: boolean;
  maxXg: number;
  maxXga: number;
  xgWeight: number;
  xgaWeight: number;
  minDrawPct: number;
  drawWeight: number;
  drawBonusPct: number;
  drawBonusWeight: number;
  maxRankGap: number;
  rankGapWeight: number;
  closeRankGap: number;
  closeRankWeight: number;
  maxAttDelta: number;
  attWeight: number;
  tightAttDelta: number;
  tightAttWeight: number;
  // bonus for not being extreme top/bottom of the table
  rankOkMin: number;
  rankOkMax: number;
  rankOkWeight: number;
  scoreKeepThreshold: number;
  probKeepThreshold: number;
}

export type PresetName = "soft" | "medium" | "hard";

export const PRESETS: Record<PresetName, FilterPreset> = {
  soft: {
    minSeasonGames: 3,
    hardXgGates: false,
    maxXg: 1.4,
    maxXga: 1.4,
    xgWeight: 0.5,
    xgaWeight: 0.4,
    minDrawPct: 15,
    drawWeight: 0.45,
    drawBonusPct: 22,
    drawBonusWeight: 0.25,
    maxRankGap: 14,
    rankGapWeight: 0.45,
    closeRankGap: 8,
    closeRankWeight: 0.3,
    maxAttDelta: 0.9,
    attWeight: 0.35,
    tightAttDelta: 0.5,
    tightAttWeight: 0.25,
    rankOkMin: 1,
    rankOkMax: 22,
    rankOkWeight: 0.15,
    scoreKeepThreshold: 1.0,
    probKeepThreshold: 0.2,
  },
  medium: {
    minSeasonGames: 4,
    hardXgGates: true,
    maxXg: 1.45,
    maxXga: 1.4,
    xgWeight: 0.4,
    xgaWeight: 0.3,
    minDrawPct: 16,
    drawWeight: 0.4,
    drawBonusPct: 23,
    drawBonusWeight: 0.2,
    maxRankGap: 12,
    rankGapWeight: 0.45,
    closeRankGap: 8,
    closeRankWeight: 0.2,
    maxAttDelta: 0.6,
    attWeight: 0.3,
    tightAttDelta: 0.35,
    tightAttWeight: 0.18,
    rankOkMin: 1,
    rankOkMax: 20,
    rankOkWeight: 0.1,
    scoreKeepThreshold: 1.15,
    probKeepThreshold: 0.24,
  },
  hard: {
    minSeasonGames: 5,
    hardXgGates: true,
    maxXg: 1.35,
    maxXga: 1.3,
    xgWeight: 0.45,
    xgaWeight: 0.35,
    minDrawPct: 18,
    drawWeight: 0.45,
    drawBonusPct: 24,
    drawBonusWeight: 0.25,
    maxRankGap: 10,
    rankGapWeight: 0.5,
    closeRankGap: 6,
    closeRankWeight: 0.25,
    maxAttDelta: 0.45,
    attWeight: 0.35,
    tightAttDelta: 0.25,
    tightAttWeight: 0.2,
    rankOkMin: 2,
    rankOkMax: 18,
    rankOkWeight: 0.1,
    scoreKeepThreshold: 1.25,
    probKeepThreshold: 0.28,
  },
};

const norm = (s = "") =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove accents
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();

// ---------- league tables ----------

interface LeagueTables {
  leagueId: string;
  name: string;
  overall: Map<string, TeamRow>;
  home: Map<string, TeamRow>;
  away: Map<string, TeamRow>;
}

/** Groups the three tables by league id; teams are keyed by their normalised name within the league. */
export function groupTables({
  overalls,
  homes,
  aways,
}: Pick<ProcessDataInput, "overalls" | "homes" | "aways">): Map<
  string,
  LeagueTables
> {
  const leagues = new Map<string, LeagueTables>();
  const tableOf = (leagueId: string, name: string): LeagueTables => {
    let l = leagues.get(leagueId);
    if (!l) {
      l = { leagueId, name, overall: new Map(), home: new Map(), away: new Map() };
      leagues.set(leagueId, l);
    }
    return l;
  };
  const add = (rows: StatsType, which: "overall" | "home" | "away") => {
    for (const row of rows) {
      if (!row.team) continue;
      tableOf(row.leagueId, row.league)[which].set(norm(row.team), row);
    }
  };
  add(overalls, "overall");
  add(homes, "home");
  add(aways, "away");
  return leagues;
}

const toTableRow = (t: TeamRow): TableRow => ({
  totalGames: t.totalGames,
  goalsFor: t.goalsFor,
  goalsAgainst: t.goalsAgainst,
  // The % was computed from the raw count, so rounding recovers it exactly.
  draws: t.draws ?? Math.round((t.matchesDrawed / 100) * t.totalGames),
});

const toTeamInput = (
  overall: TeamRow,
  home: TeamRow | undefined,
  away: TeamRow | undefined,
): TeamInput => ({
  team: overall.team,
  overall: toTableRow(overall),
  ...(home && { home: toTableRow(home) }),
  ...(away && { away: toTableRow(away) }),
});

/** Model input for every league: each team's overall row with its home and away rows attached. */
export function leagueInputs(tables: Map<string, LeagueTables>): LeagueInput[] {
  return [...tables.values()].map((l) => ({
    league: l.leagueId,
    teams: [...l.overall.entries()].map(([key, row]) =>
      toTeamInput(row, l.home.get(key), l.away.get(key)),
    ),
  }));
}

// ---------- main ----------

export function processDataDetailed(
  input: ProcessDataInput,
  presetName: PresetName = "medium",
): ProcessDataOutput {
  const p = PRESETS[presetName];
  const tables = groupTables(input);
  const inputs = leagueInputs(tables);
  const priors = estimatePriors(inputs);
  const models = buildLeagueModels(inputs, priors);

  const stats: ProcessStats = {
    fixtures: input.fixtures.length,
    noLeagueTables: 0,
    unjoined: 0,
    unjoinedSample: [],
    tooFewGames: 0,
    gated: 0,
    scored: 0,
    kept: 0,
    leagues: models.size,
  };
  const results: DrawCandidate[] = [];

  for (const game of input.fixtures) {
    if (!game.home || !game.away) continue;

    const league = tables.get(game.leagueId);
    const model = models.get(game.leagueId);
    if (!league || !model) {
      stats.noLeagueTables++;
      continue;
    }

    const keyH = norm(game.home);
    const keyA = norm(game.away);
    const HO = league.overall.get(keyH);
    const AO = league.overall.get(keyA);
    if (!HO || !AO) {
      stats.unjoined++;
      if (stats.unjoinedSample.length < 10) {
        stats.unjoinedSample.push(
          `${game.leagueId}: ${!HO ? game.home : game.away}`,
        );
      }
      continue;
    }

    // Split rows (fall back to overall for the gates and the score)
    const h = league.home.get(keyH) ?? HO;
    const a = league.away.get(keyA) ?? AO;

    if (HO.totalGames < p.minSeasonGames || AO.totalGames < p.minSeasonGames) {
      stats.tooFewGames++;
      continue;
    }

    const xgOk = (t: TeamRow) => t.expectedGoals <= p.maxXg;
    const xgaOk = (t: TeamRow) => t.expectedConcededGoals <= p.maxXga;

    if (p.hardXgGates && !(xgOk(h) && xgOk(a) && xgaOk(h) && xgaOk(a))) {
      stats.gated++;
      continue;
    }

    let score = 0;

    // goals-per-game bands
    if (xgOk(h)) score += p.xgWeight;
    if (xgOk(a)) score += p.xgWeight;
    if (xgaOk(h)) score += p.xgaWeight;
    if (xgaOk(a)) score += p.xgaWeight;

    // Draw tendency
    const hDrawPct = h.matchesDrawed;
    const aDrawPct = a.matchesDrawed;
    if (hDrawPct >= p.minDrawPct) score += p.drawWeight;
    if (aDrawPct >= p.minDrawPct) score += p.drawWeight;
    if (hDrawPct >= p.drawBonusPct) score += p.drawBonusWeight;
    if (aDrawPct >= p.drawBonusPct) score += p.drawBonusWeight;

    // Rank gap
    const gap = Math.abs(HO.rank - AO.rank);
    if (gap <= p.maxRankGap) score += p.rankGapWeight;
    if (gap <= p.closeRankGap) score += p.closeRankWeight;

    // Attack balance
    const attDelta = Math.abs(h.expectedGoals - a.expectedGoals);
    if (attDelta <= p.maxAttDelta) score += p.attWeight;
    if (attDelta <= p.tightAttDelta) score += p.tightAttWeight;

    // Not extreme top/bottom of the table
    const rankOk = (rank: number) => rank >= p.rankOkMin && rank <= p.rankOkMax;
    if (rankOk(HO.rank)) score += p.rankOkWeight;
    if (rankOk(AO.rank)) score += p.rankOkWeight;

    const prob = calculateDrawProbabilityDC(
      toTeamInput(HO, league.home.get(keyH), undefined),
      toTeamInput(AO, undefined, league.away.get(keyA)),
      game.date,
      model,
    );
    stats.scored++;

    const probFrac = prob.drawPercentage / 100;

    if (score >= p.scoreKeepThreshold || probFrac >= p.probKeepThreshold) {
      stats.kept++;
      results.push({
        ...prob,
        league: HO.league,
        leagueId: game.leagueId,
        fixture: game,
        scrapedAt: input.scrapedAt,
        debug: {
          score: Number(score.toFixed(2)),
          prob: Number(probFrac.toFixed(4)),
          gap,
          hDrawPct,
          aDrawPct,
          attDelta: Number(attDelta.toFixed(2)),
        },
      });
    }
  }

  results.sort((x, y) => y.drawPercentage - x.drawPercentage);
  return { results, stats, priors, models };
}

export function processData(
  input: ProcessDataInput,
  presetName: PresetName = "medium",
): DrawCandidate[] {
  return processDataDetailed(input, presetName).results;
}

// ---------- CSV export (flat, snake_case columns for Supabase import) ----------
// The first 16 columns are the import contract: same names, same order.
// Columns after `method` were added with the v2 model and must exist in the
// Supabase table before importing (types in docs/draw-model.md).
const CSV_COLUMNS = {
  home_team: (r) => r.homeTeam,
  away_team: (r) => r.awayTeam,
  league: (r) => r.league,
  game_date: (r) => r.gameDate,
  draw_percentage: (r) => r.drawPercentage,
  lambda_home: (r) => r.meta.lambdaHome,
  lambda_away: (r) => r.meta.lambdaAway,
  score: (r) => r.debug.score,
  prob: (r) => r.debug.prob,
  rank_gap: (r) => r.debug.gap,
  home_draw_pct: (r) => r.debug.hDrawPct,
  away_draw_pct: (r) => r.debug.aDrawPct,
  att_delta: (r) => r.debug.attDelta,
  home_used_split: (r) => r.meta.usedVenue.home,
  away_used_split: (r) => r.meta.usedVenue.away,
  method: (r) => r.meta.method,
  // ---- appended in v2 ----
  league_id: (r) => r.leagueId,
  match_date: (r) => r.fixture.matchDate,
  scraped_at: (r) => r.scrapedAt,
  league_draw_rate: (r) => r.meta.league.drawRate,
  rho: (r) => r.meta.rho,
  prob_poisson: (r) => r.meta.pIndependent,
  home_att: (r) => r.meta.strengths.homeAtt,
  home_def: (r) => r.meta.strengths.homeDef,
  away_att: (r) => r.meta.strengths.awayAtt,
  away_def: (r) => r.meta.strengths.awayDef,
  home_games: (r) => r.meta.games.home,
  away_games: (r) => r.meta.games.away,
} satisfies Record<
  string,
  (r: DrawCandidate) => string | number | boolean | undefined
>;

export const CSV_HEADER = Object.keys(CSV_COLUMNS);

const csvCell = (value: string | number | boolean | undefined): string => {
  const s = value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: DrawCandidate[]): string {
  const getters = Object.values(CSV_COLUMNS);
  const lines = [
    CSV_HEADER.join(","),
    ...rows.map((r) => getters.map((get) => csvCell(get(r))).join(",")),
  ];
  return lines.join("\n") + "\n";
}

export async function exportResultsToCsv(
  rows: DrawCandidate[],
  filePath = "output/draw-candidates.csv",
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, toCsv(rows), "utf8");
  console.log(`${rows.length} results saved to ${filePath}`);
}
