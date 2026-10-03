import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CSV_HEADER,
  PRESETS,
  groupTables,
  processData,
  processDataDetailed,
  toCsv,
} from "./processData.ts";
import type { FixtureRow, StatsType, TeamRow } from "../types/index.ts";

const round2 = (x: number) => Number(x.toFixed(2));

/** Minimal RFC 4180 line parser (quoted cells, doubled quotes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function row(
  leagueId: string,
  league: string,
  team: string,
  games: number,
  gf: number,
  ga: number,
  draws: number,
  rank: number,
): TeamRow {
  return {
    leagueId,
    league,
    team,
    totalGames: games,
    goalsFor: gf,
    goalsAgainst: ga,
    expectedGoals: games ? round2(gf / games) : 0,
    expectedConcededGoals: games ? round2(ga / games) : 0,
    matchesDrawed: games ? round2((draws / games) * 100) : 0,
    rank,
    draws,
  };
}

/** A league of identical, average teams (10 games, 1.3 goals per game, 30 % draws). */
function leagueTables(leagueId: string, league: string, teams: string[], games = 10) {
  const overalls: StatsType = [];
  const homes: StatsType = [];
  const aways: StatsType = [];
  teams.forEach((team, i) => {
    const gf = Math.round(games * 1.3);
    const hg = Math.floor(games / 2);
    overalls.push(row(leagueId, league, team, games, gf, gf, Math.round(games * 0.3), i + 1));
    homes.push(row(leagueId, league, team, hg, Math.round(gf * 0.56), Math.round(gf * 0.44), 1, i + 1));
    aways.push(row(leagueId, league, team, games - hg, gf - Math.round(gf * 0.56), gf - Math.round(gf * 0.44), 1, i + 1));
  });
  return { overalls, homes, aways };
}

const ENG = "england/premier-league";
const GHA = "ghana/premier-league";
const eng = leagueTables(ENG, "Premier League", ["United", "City", "Rovers", "Town", "Albion", "Athletic", "Wanderers", "County"]);
const gha = leagueTables(GHA, "Premier League", ["United", "Hearts", "Kotoko", "Dreams", "Medeama", "Legon", "Aduana", "Bibiani"], 12);

const fixture = (leagueId: string, home: string, away: string): FixtureRow => ({
  leagueId,
  date: "05.07. 18:00",
  matchDate: "2026-07-05",
  home,
  away,
});

const snapshot = {
  scrapedAt: "2026-07-05T08:00:00.000Z",
  matchDate: "2026-07-05",
  fixtures: [
    fixture(GHA, "United", "Hearts"),
    fixture(ENG, "United", "City"),
    fixture(ENG, "United", "Nobody FC"),
    fixture("nowhere/league", "United", "City"),
  ],
  overalls: [...eng.overalls, ...gha.overalls],
  homes: [...eng.homes, ...gha.homes],
  aways: [...eng.aways, ...gha.aways],
  leagues: [],
};

describe("processData", () => {
  test("joins fixtures to the tables of their own league, even when names collide", () => {
    const { results, stats } = processDataDetailed(snapshot, "soft");
    assert.equal(stats.fixtures, 4);
    assert.equal(stats.unjoined, 1);
    assert.equal(stats.noLeagueTables, 1);
    assert.equal(stats.leagues, 2);
    assert.equal(results.length, 2);
    const ghana = results.find((r) => r.leagueId === GHA);
    const england = results.find((r) => r.leagueId === ENG);
    assert.ok(ghana && england);
    assert.equal(ghana.meta.games.home, 12, "Ghana's United, not England's");
    assert.equal(england.meta.games.home, 10);
    assert.equal(ghana.league, "Premier League");
    assert.equal(ghana.scrapedAt, snapshot.scrapedAt);
    assert.equal(ghana.meta.usedVenue.home, true);
    assert.equal(ghana.meta.usedVenue.away, true);
  });

  test("groupTables keys teams by normalised name within each league", () => {
    const tables = groupTables(snapshot);
    assert.deepEqual([...tables.keys()].sort(), [ENG, GHA]);
    assert.ok(tables.get(ENG)?.overall.has("united"));
    assert.ok(tables.get(GHA)?.home.has("united"));
  });

  test("the games minimum and the hard goal gates are applied per preset", () => {
    const few = leagueTables("x/y", "X", ["A", "B", "C", "D"], 2);
    const { stats } = processDataDetailed(
      { ...snapshot, fixtures: [fixture("x/y", "A", "B")], ...few },
      "medium",
    );
    assert.equal(stats.tooFewGames, 1);

    const leaky = leagueTables("x/y", "X", ["A", "B", "C", "D"], 10);
    const a = leaky.overalls[0];
    assert.ok(a);
    a.goalsFor = 30;
    a.expectedGoals = 3;
    const gated = processDataDetailed(
      { ...snapshot, fixtures: [fixture("x/y", "A", "B")], ...leaky },
      "hard",
    );
    assert.equal(gated.stats.gated, 1);
    assert.equal(PRESETS.soft.hardXgGates, false);
  });

  test("results are sorted by draw percentage, highest first", () => {
    const results = processData(snapshot, "soft");
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const cur = results[i];
      assert.ok(prev && cur && prev.drawPercentage >= cur.drawPercentage);
    }
  });
});

describe("CSV contract", () => {
  const CONTRACT = [
    "home_team",
    "away_team",
    "league",
    "game_date",
    "draw_percentage",
    "lambda_home",
    "lambda_away",
    "score",
    "prob",
    "rank_gap",
    "home_draw_pct",
    "away_draw_pct",
    "att_delta",
    "home_used_split",
    "away_used_split",
    "method",
  ];

  test("the first 16 columns keep their names and order; new ones are appended", () => {
    assert.deepEqual(CSV_HEADER.slice(0, CONTRACT.length), CONTRACT);
    assert.ok(CSV_HEADER.includes("league_id") && CSV_HEADER.includes("scraped_at"));
  });

  test("draw_percentage is on a 0–100 scale and prob on 0–1", () => {
    const results = processData(snapshot, "soft");
    const csv = toCsv(results);
    const [header, ...lines] = csv.trimEnd().split("\n");
    assert.equal(header, CSV_HEADER.join(","));
    assert.equal(lines.length, results.length);
    const col = (cells: string[], name: string) => cells[CSV_HEADER.indexOf(name)];
    const rows = lines.map(parseCsvLine);
    for (const cells of rows) {
      assert.equal(cells.length, CSV_HEADER.length);
      const pct = Number(col(cells, "draw_percentage"));
      const prob = Number(col(cells, "prob"));
      assert.ok(pct > 10 && pct < 40, `draw_percentage ${pct}`);
      assert.ok(Math.abs(prob - pct / 100) < 1e-3);
      assert.equal(col(cells, "match_date"), "2026-07-05");
    }
    assert.deepEqual(rows.map((c) => col(c, "league_id")).sort(), [ENG, GHA]);
  });

  test("cells with commas or quotes are escaped", () => {
    const results = processData(
      { ...snapshot, fixtures: [fixture(GHA, "United", "Hearts")] },
      "soft",
    );
    const r = results[0];
    assert.ok(r);
    r.homeTeam = 'Say "hi", United';
    assert.ok(toCsv([r]).includes('"Say ""hi"", United"'));
  });
});
