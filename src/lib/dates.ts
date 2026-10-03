/** Match-day helpers shared by the scraper and the tests. Pure, no I/O. */

export interface MatchDay {
  /** YYYY-MM-DD, local time. */
  iso: string;
  /** DD.MM as Flashscore prints it in `.event__stageTime`. */
  ddmm: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function matchDayFromDate(d: Date): MatchDay {
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  return { iso: `${d.getFullYear()}-${month}-${day}`, ddmm: `${day}.${month}` };
}

/** "YYYY-MM-DD" → MatchDay, or undefined when the text is not in that form. */
export function matchDayFromIso(iso: string): MatchDay | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return undefined;
  const [, year, month, day] = m;
  if (!year || !month || !day) return undefined;
  return { iso: `${year}-${month}-${day}`, ddmm: `${day}.${month}` };
}

/**
 * Reads `--date=YYYY-MM-DD`, `--date YYYY-MM-DD` or `--date=DD.MM` (current
 * year) from the CLI arguments. Defaults to today in local time, which is the
 * time zone Flashscore renders kick-off times in for this machine.
 */
export function matchDayFromArgs(
  argv: readonly string[],
  now: Date = new Date(),
): MatchDay {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--date=")) raw = arg.slice("--date=".length);
    else if (arg === "--date") raw = argv[i + 1];
  }
  if (raw === undefined) return matchDayFromDate(now);

  const fromIso = matchDayFromIso(raw);
  if (fromIso) return fromIso;

  const dm = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(raw);
  if (dm) {
    const day = pad(Number(dm[1]));
    const month = pad(Number(dm[2]));
    return { iso: `${now.getFullYear()}-${month}-${day}`, ddmm: `${day}.${month}` };
  }
  throw new Error(`Invalid --date "${raw}". Use YYYY-MM-DD or DD.MM.`);
}

/**
 * "05.07. 18:00" → "05.07". Undefined when the cell carries no day, e.g. a live
 * minute ("45'") or a status ("Postp.").
 */
export function flashscoreDayKey(stageTime: string): string | undefined {
  const m = /^\s*(\d{2})\.(\d{2})\./.exec(stageTime);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/** "05.07. 18:00" → "18:00", or undefined. */
export function flashscoreKickoff(stageTime: string): string | undefined {
  const m = /(\d{1,2}:\d{2})\s*$/.exec(stageTime);
  return m ? m[1] : undefined;
}
