export interface FixtureRow {
  /** Id of the map entry the fixtures page belongs to, e.g. "italy/serie-b". */
  leagueId: string;
  /** Raw Flashscore text, e.g. "05.07. 18:00" (no year). */
  date: string;
  /** Match day the scrape filtered on, as YYYY-MM-DD. */
  matchDate: string;
  home: string;
  away: string;
}
export type FixturesType = FixtureRow[];

export interface TeamRow {
  /** Id of the map entry the table belongs to; joins are on (leagueId, team). */
  leagueId: string;
  /** Display name from div.heading__name (not unique across countries). */
  league: string;
  team: string;
  totalGames: number;
  goalsFor: number;
  goalsAgainst: number;
  /** Actual goals for per game (not xG), 2 dp. */
  expectedGoals: number;
  /** Actual goals against per game (not xG), 2 dp. */
  expectedConcededGoals: number;
  /** Draws ÷ games × 100, 2 dp. */
  matchesDrawed: number;
  /** Position within this table (a home-table row holds the home rank). */
  rank: number;
  // Tier B: raw counts from the same table row. `draws` is the cell the draw %
  // was always computed from; wins, losses and points are parsed from cells
  // that have not been verified against the live DOM yet.
  wins?: number;
  draws?: number;
  losses?: number;
  points?: number;
}
export type StatsType = TeamRow[];

export interface LeagueRow {
  leagueId: string;
  league: string;
  /** Σ goals ÷ Σ team-games over the overall table (identical to ...Against). */
  leagueAvgGoalsForPerTeam: number;
  leagueAvgGoalsAgainstPerTeam: number;
}
export type LeagueType = LeagueRow[];

export interface ScrapeSnapshot {
  scrapedAt: string;
  /** Match day the fixtures were filtered on (YYYY-MM-DD). */
  matchDate?: string;
  fixtures: FixturesType;
  overalls: StatsType;
  homes: StatsType;
  aways: StatsType;
  leagues: LeagueType;
}
