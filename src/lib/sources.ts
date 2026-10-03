import { flashscoreMap } from "../data/map.ts";

export interface MapEntry {
  fixtures: string;
  standings: string;
}

export interface Source {
  /** "country/league-slug", derived from the fixtures URL. Tags every row scraped from the entry. */
  leagueId: string;
  fixtures: string;
  overall: string;
  /** Absent when the standings URL has no "/standings/overall" segment to swap. */
  home?: string;
  away?: string;
}

/** "https://www.flashscore.com/football/italy/serie-b/fixtures/" → "italy/serie-b". */
export function leagueIdFromUrl(url: string): string {
  try {
    const [, country, slug] = new URL(url).pathname.split("/").filter(Boolean);
    if (country && slug) return `${country}/${slug}`;
  } catch {
    // not a URL: fall through and use the text itself as the id
  }
  return url;
}

/**
 * Turns the URL map into scrape sources with one id per entry. Duplicate
 * entries are dropped and suspicious pairings are reported through `warn`
 * (never thrown: one bad entry must not stop a 160-league scrape).
 */
export function buildSources(
  map: readonly MapEntry[] = flashscoreMap,
  warn: (message: string) => void = console.warn,
): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const { fixtures, standings } of map) {
    const leagueId = leagueIdFromUrl(fixtures);
    if (seen.has(leagueId)) {
      warn(`map.ts: duplicate entry ${leagueId} skipped (${fixtures})`);
      continue;
    }
    seen.add(leagueId);

    const standingsId = leagueIdFromUrl(standings);
    if (standingsId.split("/")[0] !== leagueId.split("/")[0]) {
      warn(
        `map.ts: ${leagueId} fixtures are paired with standings from ${standingsId}; its fixtures will not join`,
      );
    }
    // "/standings/overall/" (current) or "/table/overall" (older URL form)
    const venueSegment = /\/(standings|table)\/overall(?=\/|$)/;
    const hasVenueTables = venueSegment.test(standings);
    if (!hasVenueTables) {
      warn(
        `map.ts: ${leagueId} standings URL has no "/standings/overall" segment (e.g. live-standings); its home and away tables are skipped`,
      );
    }
    if (!/\/fixtures\/?$/.test(fixtures)) {
      warn(`map.ts: ${leagueId} fixtures URL does not end in /fixtures (${fixtures})`);
    }

    out.push({
      leagueId,
      fixtures,
      overall: standings,
      ...(hasVenueTables && {
        home: standings.replace(venueSegment, "/$1/home"),
        away: standings.replace(venueSegment, "/$1/away"),
      }),
    });
  }
  return out;
}
