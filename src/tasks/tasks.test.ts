import { test } from "node:test";
import assert from "node:assert/strict";
import { fixturesTask } from "./fixturesTask.ts";
import { standingsTask } from "./standingTasks.ts";

// Under tsx, esbuild's keepNames wraps named functions in `__name(...)`. Code
// inside page.evaluate() is serialised and run in the browser, where that
// helper doesn't exist ("__name is not defined"). The tasks are compiled by the
// same loader as this test, so a helper in their source shows up here.
test("scraper tasks contain no esbuild __name helper (breaks page.evaluate)", () => {
  for (const [name, task] of [
    ["fixturesTask", fixturesTask],
    ["standingsTask", standingsTask],
  ] as const) {
    // A call, not a substring: class names like "heading__name" are fine.
    assert.ok(
      !/\b__name\s*\(/.test(task.toString()),
      `${name} declares a named function or arrow const; inline it instead`,
    );
  }
});
