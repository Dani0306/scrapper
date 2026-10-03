import { Cluster } from "puppeteer-cluster";
import { buildSources } from "./lib/sources.ts";
import { matchDayFromArgs } from "./lib/dates.ts";
import { fixturesTask } from "./tasks/fixturesTask.ts";
import { standingsTask } from "./tasks/standingTasks.ts";
import { saveSnapshot } from "./lib/store.ts";
import type { FixturesType, LeagueType, StatsType } from "./types/index.ts";

// Usage: npm run scrape [-- --date YYYY-MM-DD | --date DD.MM]   (default: today)
async function main() {
  const matchDay = matchDayFromArgs(process.argv.slice(2));
  const sources = buildSources();
  console.log(
    `Scraping ${sources.length} leagues for fixtures on ${matchDay.iso} (${matchDay.ddmm})`,
  );

  // * Teams
  const overalls: StatsType = [];
  const homes: StatsType = [];
  const aways: StatsType = [];

  // * Fixtures
  const fixtures: FixturesType = [];

  // * Leagues
  const leagues: LeagueType = [];

  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: 4,
    puppeteerOptions: {
      headless: false,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      defaultViewport: null,
    },
    timeout: 90_000,
  });

  cluster.on("taskerror", (err: Error, data: { url: string }) => {
    console.error(`Error crawling ${data.url}: ${err.message}`);
  });

  for (const item of sources) {
    const { leagueId } = item;
    await cluster.queue(
      { url: item.fixtures, leagueId, matchDay, fixtures },
      fixturesTask,
    );
    await cluster.queue(
      {
        url: item.overall,
        leagueId,
        type: "overall",
        standings: overalls,
        league: leagues,
      },
      standingsTask,
    );
    if (item.home) {
      await cluster.queue(
        { url: item.home, leagueId, type: "home", standings: homes },
        standingsTask,
      );
    }
    if (item.away) {
      await cluster.queue(
        { url: item.away, leagueId, type: "away", standings: aways },
        standingsTask,
      );
    }
  }

  await cluster.idle();
  await cluster.close();

  const withTables = new Set(overalls.map((r) => r.leagueId));
  const missing = sources.filter((s) => !withTables.has(s.leagueId));
  console.log(
    "overall:",
    overalls.length,
    "home:",
    homes.length,
    "away:",
    aways.length,
    "fixtures:",
    fixtures.length,
    "leagues:",
    leagues.length,
  );
  if (missing.length > 0) {
    console.warn(
      `${missing.length} leagues returned no overall table: ${missing.map((s) => s.leagueId).join(", ")}`,
    );
  }

  const paths = await saveSnapshot({
    scrapedAt: new Date().toISOString(),
    matchDate: matchDay.iso,
    fixtures,
    overalls,
    homes,
    aways,
    leagues,
  });

  console.log(`Data stored in ${paths.join(" and ")}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
