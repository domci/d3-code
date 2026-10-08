import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import { makeMergeCommitChecksReader, reduceMergeCommitChecks } from "./mergeCommitChecks.ts";

const run = (status: string, conclusion?: string | null) => ({ status, conclusion });

it("reduces check runs: failures outrank running checks, which outrank success", () => {
  const states = (...runs: Array<ReturnType<typeof run>>) =>
    reduceMergeCommitChecks(runs, false).state;
  expect(states()).toBe("none");
  expect(
    states(run("completed", "success"), run("completed", "neutral"), run("completed", "skipped")),
  ).toBe("passed");
  expect(states(run("completed", "success"), run("in_progress"))).toBe("pending");
  expect(states(run("queued"), run("completed", "timed_out"))).toBe("failed");
  expect(states(run("completed", "cancelled"))).toBe("failed");
  expect(states(run("completed", "action_required"))).toBe("failed");
  // More runs than were read: a clean page does not prove the rest passed.
  expect(reduceMergeCommitChecks([run("completed", "success")], true).state).toBe("pending");
});

it.effect("reads the merge commit once, then its check runs each time", () =>
  Effect.gen(function* () {
    const sha = "b".repeat(40);
    const paths: Array<string> = [];
    let checkRuns: ReadonlyArray<ReturnType<typeof run>> = [];
    let merged = true;
    const read = yield* makeMergeCommitChecksReader.pipe(
      Effect.provide(
        Layer.mock(GitHubApi.GitHubApi)({
          rest: ({ path }) =>
            Effect.sync(() => {
              paths.push(path);
              return {
                status: 200,
                headers: {},
                body: path.includes("/check-runs")
                  ? JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns })
                  : JSON.stringify({ merged, merge_commit_sha: sha }),
                truncated: false,
                invalidUtf8: false,
              };
            }),
        }),
      ),
    );
    const input = { host: "github.com", repository: "acme/web", number: 7 };

    expect(yield* read(input)).toEqual({ state: "none" });
    checkRuns = [run("in_progress")];
    expect(yield* read(input)).toEqual({ state: "pending" });
    checkRuns = [run("completed", "success")];
    expect(yield* read(input)).toEqual({ state: "passed" });
    expect(paths.filter((path) => path === "repos/acme/web/pulls/7")).toHaveLength(1);
    expect(paths.at(-1)).toBe(
      `repos/acme/web/commits/${sha}/check-runs?filter=latest&per_page=100`,
    );

    // A pull request GitHub does not report as merged has no merge commit to read.
    merged = false;
    expect(yield* read({ ...input, number: 8 })).toBeNull();
  }),
);
