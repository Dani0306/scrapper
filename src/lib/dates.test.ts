import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  flashscoreDayKey,
  flashscoreKickoff,
  matchDayFromArgs,
  matchDayFromDate,
  matchDayFromIso,
} from "./dates.ts";

describe("match day", () => {
  const now = new Date(2026, 9, 2, 15, 30); // 2 October 2026, local time

  test("defaults to today", () => {
    assert.deepEqual(matchDayFromArgs([], now), { iso: "2026-10-02", ddmm: "02.10" });
    assert.deepEqual(matchDayFromDate(now), { iso: "2026-10-02", ddmm: "02.10" });
  });

  test("accepts --date in ISO or DD.MM form", () => {
    assert.deepEqual(matchDayFromArgs(["--date=2026-07-05"], now), { iso: "2026-07-05", ddmm: "05.07" });
    assert.deepEqual(matchDayFromArgs(["--date", "2026-07-05"], now), { iso: "2026-07-05", ddmm: "05.07" });
    assert.deepEqual(matchDayFromArgs(["--date=5.7"], now), { iso: "2026-07-05", ddmm: "05.07" });
    assert.deepEqual(matchDayFromArgs(["other", "--date=05.07."], now), { iso: "2026-07-05", ddmm: "05.07" });
    assert.throws(() => matchDayFromArgs(["--date=yesterday"], now), /Invalid --date/);
    assert.equal(matchDayFromIso("2026-7-5"), undefined);
  });
});

describe("Flashscore stage time", () => {
  test("extracts the day key only when a date is printed", () => {
    assert.equal(flashscoreDayKey("05.07. 18:00"), "05.07");
    assert.equal(flashscoreDayKey("23.08.2026 15:00"), "23.08");
    assert.equal(flashscoreDayKey("45'"), undefined);
    assert.equal(flashscoreDayKey("Postp."), undefined);
    assert.equal(flashscoreDayKey(""), undefined);
  });

  test("extracts the kick-off time", () => {
    assert.equal(flashscoreKickoff("05.07. 18:00"), "18:00");
    assert.equal(flashscoreKickoff("Postp."), undefined);
  });
});
