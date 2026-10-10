// @effect-diagnostics nodeBuiltinImport:off - builds real symlinked directories.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  isManagedWorktreeDirectory,
  storageCleanupActivityAt,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("treats a thread whose last run finished as idle", () => {
    expect(storageCleanupThreadIdle(candidateWithStatus("completed"), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(candidateWithStatus("running"), NOW_MS)).toBe(false);
  });

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("isManagedWorktreeDirectory", () => {
  // `<base>/t3` -> `<base>/d3`: the layout after `~/.t3` is renamed to `~/.d3`.
  const check = (arrange: (base: string) => string) =>
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wt-"))),
        ),
        (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      NodeFS.mkdirSync(NodePath.join(base, "d3", "worktrees", "abcd1234", "repo"), {
        recursive: true,
      });
      NodeFS.mkdirSync(NodePath.join(base, "outside", "repo"), { recursive: true });
      NodeFS.symlinkSync(NodePath.join(base, "d3"), NodePath.join(base, "t3"));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* isManagedWorktreeDirectory(
        fs,
        path,
        [NodePath.join(base, "d3", "worktrees")],
        arrange(base),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("accepts a path stored through the legacy symlinked ancestor", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* check((base) => NodePath.join(base, "t3", "worktrees", "abcd1234", "repo")),
      );
    }),
  );

  it.effect("accepts the direct form", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* check((base) => NodePath.join(base, "d3", "worktrees", "abcd1234", "repo")),
      );
    }),
  );

  it.effect("rejects a worktree directory that is itself a symlink", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* check((base) => {
          const link = NodePath.join(base, "d3", "worktrees", "abcd1234", "linked");
          NodeFS.symlinkSync(NodePath.join(base, "outside", "repo"), link);
          return NodePath.join(base, "t3", "worktrees", "abcd1234", "linked");
        }),
      );
    }),
  );

  it.effect("rejects a path that resolves outside the managed root", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* check((base) => NodePath.join(base, "outside", "repo")));
    }),
  );
});
