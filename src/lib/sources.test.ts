import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildSources, leagueIdFromUrl } from "./sources.ts";

describe("league ids", () => {
  test("come from the country and slug of the URL path", () => {
    assert.equal(leagueIdFromUrl("https://www.flashscore.com/football/italy/serie-b/fixtures/"), "italy/serie-b");
    assert.equal(leagueIdFromUrl("https://www.flashscore.com/football/italy/serie-b/standings/#/jwYYXp2E/standings/overall/"), "italy/serie-b");
    assert.equal(leagueIdFromUrl("https://www.flashscore.co/futbol/mexico/liga-de-expansion-mx/partidos/"), "mexico/liga-de-expansion-mx");
    assert.equal(leagueIdFromUrl("not a url"), "not a url");
  });
});

describe("buildSources", () => {
  const entry = (country: string, slug: string, standingsSlug = slug) => ({
    fixtures: `https://www.flashscore.com/football/${country}/${slug}/fixtures/`,
    standings: `https://www.flashscore.com/football/${country}/${standingsSlug}/standings/#/abc123/standings/overall/`,
  });

  test("derives the home and away table URLs and tags every source", () => {
    const warnings: string[] = [];
    const [s] = buildSources([entry("italy", "serie-b")], (m) => warnings.push(m));
    assert.ok(s);
    assert.equal(s.leagueId, "italy/serie-b");
    assert.ok(s.home?.endsWith("/standings/home/"));
    assert.ok(s.away?.endsWith("/standings/away/"));
    assert.deepEqual(warnings, []);
    const [old] = buildSources(
      [{ fixtures: entry("usa", "usl").fixtures, standings: "https://www.flashscore.com/football/usa/usl/standings/#/x/table/overall" }],
      () => {},
    );
    assert.equal(old?.home, "https://www.flashscore.com/football/usa/usl/standings/#/x/table/home");
  });

  test("drops duplicate entries and reports suspicious pairings", () => {
    const warnings: string[] = [];
    const sources = buildSources(
      [
        entry("italy", "serie-b"),
        entry("italy", "serie-b"),
        { fixtures: "https://www.flashscore.com/football/sweden/superettan/fixtures/", standings: entry("norway", "obos-ligaen").standings },
        { fixtures: "https://www.flashscore.com/football/jamaica/premier-league/results/", standings: "https://www.flashscore.com/football/jamaica/premier-league/#/x/" },
      ],
      (m) => warnings.push(m),
    );
    assert.deepEqual(sources.map((s) => s.leagueId), ["italy/serie-b", "sweden/superettan", "jamaica/premier-league"]);
    assert.equal(sources[2]?.home, undefined, "no overall segment → no home table job");
    assert.ok(warnings.some((w) => w.includes("duplicate entry italy/serie-b")));
    assert.ok(warnings.some((w) => w.includes("sweden/superettan") && w.includes("norway/obos-ligaen")));
    assert.ok(warnings.some((w) => w.includes("jamaica/premier-league") && w.includes("/standings/overall")));
    assert.ok(warnings.some((w) => w.includes("jamaica/premier-league") && w.includes("/fixtures")));
  });

  test("the real map yields unique ids", () => {
    const sources = buildSources(undefined, () => {});
    assert.ok(sources.length >= 150);
    assert.equal(new Set(sources.map((s) => s.leagueId)).size, sources.length);
  });
});
