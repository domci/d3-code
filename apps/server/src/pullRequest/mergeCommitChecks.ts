import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";

/**
 * What the check runs on a pull request's merge commit say, as far as settling its thread cares:
 * a post-merge workflow (deploy, release, publish) should have gone green before the thread is
 * put away, and a red one should stay in front of the user.
 */
export type MergeCommitChecksState = "none" | "pending" | "passed" | "failed";

export interface MergeCommitChecks {
  readonly state: MergeCommitChecksState;
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * `runs` are the latest run of each check on the commit. A failure outranks a run still going,
 * since the thread will not settle either way. When the host listed more runs than were read, a
 * clean page proves nothing about the rest, so it stays pending.
 */
export function reduceMergeCommitChecks(
  runs: ReadonlyArray<{ readonly status: string; readonly conclusion?: string | null | undefined }>,
  truncated: boolean,
): MergeCommitChecks {
  if (
    runs.some((run) => run.status === "completed" && !PASSING_CONCLUSIONS.has(run.conclusion ?? ""))
  ) {
    return { state: "failed" };
  }
  if (runs.some((run) => run.status !== "completed") || (truncated && runs.length > 0)) {
    return { state: "pending" };
  }
  return { state: runs.length === 0 ? "none" : "passed" };
}

const MergedPullRequest = Schema.Struct({
  merged: Schema.optional(Schema.Boolean),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
});
const CheckRuns = Schema.Struct({
  total_count: Schema.Int,
  check_runs: Schema.Array(
    Schema.Struct({
      status: Schema.String,
      conclusion: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeMergedPullRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(MergedPullRequest),
);
const decodeCheckRuns = Schema.decodeUnknownOption(Schema.fromJsonString(CheckRuns));

const CHECK_RUNS_PAGE_SIZE = 100;

/**
 * Reads a merged pull request's merge commit and its check runs over REST, as a background read:
 * it neither spends the GraphQL reserve nor skips a rate-limit pause. The merge commit never
 * changes once GitHub names it, so it is read once per pull request. Null where GitHub names no
 * merge commit or answers in a shape this does not know.
 */
export const makeMergeCommitChecksReader = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const mergeCommits = yield* Cache.makeWith(
    (key: string) => {
      const [host = "", repository = "", number = ""] = key.split("\0");
      return api
        .rest({
          host,
          operation: "readMergeCommit",
          path: `repos/${repository}/pulls/${number}`,
        })
        .pipe(
          Effect.map((response) => {
            const decoded = decodeMergedPullRequest(response.body);
            return Option.isSome(decoded) &&
              decoded.value.merged === true &&
              decoded.value.merge_commit_sha != null &&
              /^[a-f0-9]{40,64}$/.test(decoded.value.merge_commit_sha)
              ? decoded.value.merge_commit_sha
              : null;
          }),
        );
    },
    {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== null ? "1 day" : Duration.zero),
    },
  );
  return Effect.fn("mergeCommitChecks.read")(function* (input: {
    readonly host: string;
    readonly repository: string;
    readonly number: number;
  }) {
    const sha = yield* Cache.get(
      mergeCommits,
      `${input.host}\0${input.repository}\0${input.number}`,
    );
    if (sha === null) return null;
    const response = yield* api.rest({
      host: input.host,
      operation: "readMergeCommitChecks",
      path: `repos/${input.repository}/commits/${sha}/check-runs?filter=latest&per_page=${CHECK_RUNS_PAGE_SIZE}`,
    });
    const decoded = decodeCheckRuns(response.body);
    if (response.status !== 200 || Option.isNone(decoded)) return null;
    return reduceMergeCommitChecks(
      decoded.value.check_runs,
      decoded.value.total_count > decoded.value.check_runs.length,
    );
  });
});
