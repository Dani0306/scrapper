import { Page } from "puppeteer";
import { prep } from "../lib/utils.ts";
import type { StatsType, LeagueType } from "../types/index.ts";

export interface StandingsTaskData {
  url: string;
  leagueId: string;
  type: "overall" | "home" | "away";
  standings: StatsType;
  /** Passed for the overall table only; receives one league-average row. */
  league?: LeagueType;
}

export const standingsTask = async ({
  page,
  data,
}: {
  page: Page;
  data: StandingsTaskData;
}) => {
  const { url, leagueId, standings, league } = data;
  await prep(page);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
  await page
    .waitForSelector("div.ui-table__row", { timeout: 15_000 })
    .catch(() => {});

  // This callback is serialised to text and run in the browser. Don't declare
  // named functions or arrow-function consts inside it: tsx (esbuild keepNames)
  // wraps them in a `__name(...)` helper that doesn't exist there. Inline instead.
  const { leagueName, rows } = await page.evaluate((id: string) => {
    const leagueName =
      document.querySelector("div.heading__name")?.textContent ?? "";
    const rows = Array.from(document.querySelectorAll("div.ui-table__row")).map(
      (item) => {
        const team =
          item
            .querySelector("a.tableCellParticipant__name")
            ?.textContent?.trim() ?? "";
        // Flashscore row cells: MP, W, D, L, G ("GF:GA"), ..., PTS.
        // cells[0], cells[2] and cells[4] have always been read; cells[1],
        // cells[3] and the last cell (wins, losses, points) are unverified.
        const cells = Array.from(
          item.querySelectorAll("span.table__cell--value"),
          (td) => td.textContent?.trim() ?? "",
        );
        const rankRaw =
          item.querySelector("div.tableCellRank")?.textContent?.trim() ?? "";
        const gfga = (cells[4] || "0:0").split(":");
        const games = Number(cells[0]) || 0;
        const wins = Number(cells[1]) || 0;
        const draws = Number(cells[2]) || 0;
        const losses = Number(cells[3]) || 0;
        const points = Number(cells[cells.length - 1]) || 0;
        const gf = Number(gfga[0]) || 0;
        const ga = Number(gfga[1]) || 0;

        return {
          leagueId: id,
          league: leagueName,
          team,
          totalGames: games,
          goalsFor: gf,
          goalsAgainst: ga,
          expectedGoals: games ? Number((gf / games).toFixed(2)) : 0,
          expectedConcededGoals: games ? Number((ga / games).toFixed(2)) : 0,
          matchesDrawed: games ? Number(((draws / games) * 100).toFixed(2)) : 0,
          rank: Number((rankRaw.split(".")[0] || "0").trim()),
          wins,
          draws,
          losses,
          points,
        };
      },
    );
    return { leagueName, rows };
  }, leagueId);

  if (league) {
    let goalsFor = 0;
    let goalsAgainst = 0;
    let totalGames = 0;
    for (const row of rows) {
      goalsFor += row.goalsFor;
      goalsAgainst += row.goalsAgainst;
      totalGames += row.totalGames;
    }
    league.push({
      leagueId,
      league: leagueName,
      leagueAvgGoalsForPerTeam: totalGames ? goalsFor / totalGames : 0,
      leagueAvgGoalsAgainstPerTeam: totalGames ? goalsAgainst / totalGames : 0,
    });
  }

  standings.push(...rows);
};
