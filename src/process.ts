import {
  exportResultsToCsv,
  PRESETS,
  processDataDetailed,
  type PresetName,
} from "./actions/processData.ts";
import { loadSnapshot } from "./lib/store.ts";

// Usage: npm run process -- [soft|medium|hard]
async function main() {
  const preset = (process.argv[2] ?? "medium") as PresetName;
  if (!(preset in PRESETS)) {
    throw new Error(
      `Unknown preset "${preset}". Use one of: ${Object.keys(PRESETS).join(", ")}`,
    );
  }

  const snapshot = await loadSnapshot();
  console.log(
    `Using scrape from ${snapshot.scrapedAt}` +
      (snapshot.matchDate ? ` (fixtures for ${snapshot.matchDate})` : "") +
      ` with the ${preset} preset`,
  );

  const untagged = snapshot.fixtures.filter((f) => !f.leagueId).length;
  if (untagged > 0) {
    console.warn(
      `${untagged} fixtures have no leagueId (snapshot from an older scraper); they cannot be joined. Re-run "npm run scrape".`,
    );
  }

  const { results, stats, priors } = processDataDetailed(snapshot, preset);
  console.log(
    `Priors: attack CV² ${priors.attackCv2.toFixed(3)}, defence CV² ${priors.defenceCv2.toFixed(3)}, ` +
      `venue CV² ${priors.venueAttackCv2.toFixed(3)}/${priors.venueDefenceCv2.toFixed(3)}, ` +
      `goals/team-game ${priors.teamGoals.mean.toFixed(3)} (sd ${Math.sqrt(priors.teamGoals.variance).toFixed(3)}), ` +
      `home share ${priors.homeShare.mean.toFixed(3)}, draw rate ${priors.drawRate.mean.toFixed(3)}, ` +
      `pooled ρ ${priors.rho.toFixed(3)}, league draw excess sd ${Math.sqrt(priors.drawRate.excessVariance).toFixed(3)}`,
  );
  console.log(
    `Fixtures ${stats.fixtures}: ${stats.noLeagueTables} without league tables, ${stats.unjoined} unjoined, ` +
      `${stats.tooFewGames} below the games minimum, ${stats.gated} rejected by the goal gates, ${stats.kept} kept of ${stats.scored} scored ` +
      `(${stats.leagues} leagues modelled)`,
  );
  if (stats.unjoinedSample.length > 0) {
    console.log(`Unjoined examples: ${stats.unjoinedSample.join("; ")}`);
  }

  if (results.length === 0) {
    console.log(`No matches passed the ${preset} filters.`);
    return;
  }

  await exportResultsToCsv(results, `output/draw-candidates-${preset}.csv`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
