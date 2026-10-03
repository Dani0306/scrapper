import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ScrapeSnapshot } from "../types/index.ts";

export type { ScrapeSnapshot } from "../types/index.ts";

export const DEFAULT_SNAPSHOT_PATH = "output/scrape.json";
/** Every scrape is also kept here, named by its timestamp, for later backtests. */
export const SNAPSHOT_HISTORY_DIR = "output/snapshots";

export function datedSnapshotPath(
  scrapedAt: string,
  dir = SNAPSHOT_HISTORY_DIR,
): string {
  return join(dir, `scrape-${scrapedAt.replace(/[:.]/g, "-")}.json`);
}

/** Writes the snapshot to `filePath` and, unless `historyDir` is null, a dated copy. Returns the paths written. */
export async function saveSnapshot(
  snapshot: ScrapeSnapshot,
  filePath = DEFAULT_SNAPSHOT_PATH,
  historyDir: string | null = SNAPSHOT_HISTORY_DIR,
): Promise<string[]> {
  const json = JSON.stringify(snapshot, null, 2);
  const paths = [filePath];
  if (historyDir) paths.push(datedSnapshotPath(snapshot.scrapedAt, historyDir));
  for (const p of paths) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, json, "utf8");
  }
  return paths;
}

export async function loadSnapshot(
  filePath = DEFAULT_SNAPSHOT_PATH,
): Promise<ScrapeSnapshot> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as ScrapeSnapshot;
  } catch (err) {
    throw new Error(
      `Could not read scrape snapshot at ${filePath}. Run "npm run scrape" first.`,
      { cause: err },
    );
  }
}
