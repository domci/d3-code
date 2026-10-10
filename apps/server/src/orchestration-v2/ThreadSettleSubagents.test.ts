import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so Stop ends them without a provider.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-settle-subagents" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-settle-subagents"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Delegates `task` from the parent's latest run and returns the child thread. */
const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const setLatestRunStatus = (threadId: ThreadId, status: "completed" | "waiting") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:run-${status}`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status, completedAt: status === "completed" ? now : null },
    });
  });

const settle = (threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`settle:${name}`),
      threadId,
    });
  });

const settledOverride = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride;
  });

const runStatuses = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).runs.map((run) => run.status);
  });

it.effect("settling a parent settles its subagents and Stop then ends their turns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentId = ThreadId.make("thread:settle-parent");
    yield* createThread(parentId);
    yield* send(parentId, "work");
    const childId = yield* delegate(parentId, "child task");
    const grandchildId = yield* delegate(childId, "grandchild task");
    yield* setLatestRunStatus(parentId, "completed");

    yield* settle(parentId, "parent");

    assert.equal(yield* settledOverride(parentId), "settled");
    assert.equal(yield* settledOverride(childId), "settled");
    assert.equal(yield* settledOverride(grandchildId), "settled");
    const effects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${"settle:parent"}
    `;
    assert.include(
      effects.map((row) => row.effect_type),
      "delegated-tasks.stop",
    );

    // What the delegated-tasks.stop effect runs once the settle commits.
    yield* threads.stopDelegatedTasks({
      threadId: parentId,
      commandId: CommandId.make("settle:parent"),
    });
    assert.deepEqual(yield* runStatuses(childId), ["interrupted"]);
    assert.deepEqual(yield* runStatuses(grandchildId), ["interrupted"]);
    // A turn that ends after the settle does not bring the subagent back.
    assert.equal(yield* settledOverride(childId), "settled");
    assert.equal(yield* settledOverride(grandchildId), "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a parent that only waits on its subagents can be settled", () =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("thread:settle-waiting-parent");
    yield* createThread(parentId);
    yield* send(parentId, "work");
    const childId = yield* delegate(parentId, "waiting child");
    yield* setLatestRunStatus(parentId, "waiting");

    yield* settle(parentId, "waiting-subagents");
    assert.equal(yield* settledOverride(parentId), "settled");
    assert.equal(yield* settledOverride(childId), "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a draining parent with no subagents is still its own work", () =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("thread:settle-draining-parent");
    yield* createThread(parentId);
    yield* send(parentId, "work");
    yield* setLatestRunStatus(parentId, "waiting");

    assert.isTrue(Exit.isFailure(yield* Effect.exit(settle(parentId, "draining"))));
    assert.isNull(yield* settledOverride(parentId));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a parent with its own running turn still cannot be settled", () =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("thread:settle-running-parent");
    yield* createThread(parentId);
    yield* send(parentId, "work");
    const childId = yield* delegate(parentId, "running parent child");

    assert.isTrue(Exit.isFailure(yield* Effect.exit(settle(parentId, "running"))));
    assert.isNull(yield* settledOverride(parentId));
    assert.isNull(yield* settledOverride(childId));
  }).pipe(Effect.provide(layerTest)),
);
