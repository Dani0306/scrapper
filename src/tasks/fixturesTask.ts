import { Page } from "puppeteer";
import { prep } from "../lib/utils.ts";
import { flashscoreDayKey, type MatchDay } from "../lib/dates.ts";
import type { FixturesType } from "../types/index.ts";

export interface FixturesTaskData {
  url: string;
  leagueId: string;
  /** Only fixtures on this day are kept. */
  matchDay: MatchDay;
  fixtures: FixturesType;
}

export const fixturesTask = async ({
  page,
  data,
}: {
  page: Page;
  data: FixturesTaskData;
}) => {
  const { url, leagueId, matchDay, fixtures } = data;
  await prep(page);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
  await page
    .waitForSelector("div.event__match", { timeout: 15_000 })
    .catch(() => {});

  // Runs in the browser: keep it free of Node imports, filter afterwards.
  const rows = await page.evaluate(() => {
    const out: Array<{ date: string; home: string; away: string }> = [];
    document.querySelectorAll("div.event__match").forEach((div) => {
      const date =
        div.querySelector(".event__stageTime")?.textContent?.trim() ?? "";
      const home =
        div.querySelector("div.event__homeParticipant")?.textContent?.trim() ??
        "";
      const away =
        div.querySelector("div.event__awayParticipant")?.textContent?.trim() ??
        "";
      if (date && home && away) out.push({ date, home, away });
    });
    return out;
  });

  for (const r of rows) {
    if (flashscoreDayKey(r.date) !== matchDay.ddmm) continue;
    fixtures.push({ leagueId, matchDate: matchDay.iso, ...r });
  }
};
