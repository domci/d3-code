import {
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2ExecutionNode,
} from "@t3tools/contracts";
import {
  getLatestThreadForProject,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import { formatHourShort, formatRelativeHourShort } from "@t3tools/shared/usageFormat";
import { describe, test } from "vite-plus/test";

import { makeThreadProjectionFixture } from "./test-fixtures";
import { deriveCurrentTaskProgress } from "@t3tools/client-runtime/state/thread-plans";

const projectId = ProjectId.make("benchmark-project");
const runId = RunId.make("benchmark-run");
const start = Date.parse("2026-08-11T00:00:00.000Z");
const threads = Array.from({ length: 1_000 }, (_, index) => {
  const timestamp = new Date(start + ((index * 997) % 1_000) * 60_000).toISOString();
  return {
    id: `thread-${index}`,
    projectId,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    latestUserMessageAt: timestamp,
    unsettledAt: null,
  };
});
const baseProjection = makeThreadProjectionFixture();
const providerThreadId = ProviderThreadId.make("bench-provider");
const rootNodeId = NodeId.make("bench-root");
const attemptId = RunAttemptId.make("bench-attempt");
const root: OrchestrationV2ExecutionNode = {
  id: rootNodeId,
  threadId: baseProjection.thread.id,
  runId,
  parentNodeId: null,
  rootNodeId,
  kind: "root_turn",
  status: "running",
  countsForRun: true,
  providerThreadId,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: baseProjection.updatedAt,
  completedAt: null,
};
const projection = {
  ...baseProjection,
  thread: { ...baseProjection.thread, activeProviderThreadId: providerThreadId },
  runs: [
    {
      id: runId,
      threadId: baseProjection.thread.id,
      ordinal: 1,
      providerInstanceId: baseProjection.thread.providerInstanceId,
      modelSelection: baseProjection.thread.modelSelection,
      providerThreadId,
      userMessageId: MessageId.make("bench-user"),
      rootNodeId,
      activeAttemptId: attemptId,
      status: "running" as const,
      requestedAt: baseProjection.updatedAt,
      startedAt: baseProjection.updatedAt,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  ],
  attempts: [
    {
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId,
      providerInstanceId: baseProjection.thread.providerInstanceId,
      providerThreadId,
      providerTurnId: null,
      reason: "initial" as const,
      status: "running" as const,
      startedAt: baseProjection.updatedAt,
      completedAt: null,
    },
  ],
  nodes: [
    root,
    {
      ...root,
      id: NodeId.make("bench-node"),
      kind: "todo_list" as const,
      parentNodeId: rootNodeId,
    },
  ],
  plans: Array.from({ length: 5 }, (_, index) => ({
    id: PlanId.make(`plan-${index}`),
    runId,
    threadId: baseProjection.thread.id,
    nodeId: NodeId.make("bench-node"),
    status: "active" as const,
    kind: "todo_list" as const,
    steps: [{ id: "check", text: "Run checks", status: "running" as const }],
  })),
};
const hours = Array.from({ length: 24 }, (_, index) =>
  new Date(start + index * 3_600_000).toISOString(),
);
const referenceTime = "2026-08-12T00:00:00.000Z";

describe("client performance", () => {
  test("sort 1000 threads by recent activity", async ({ bench }) => {
    await bench("sort", () => {
      sortThreads(threads, "updated_at");
    }).run();
  });
  test("sort 1000 active threads", async ({ bench }) => {
    await bench("sort", () => {
      sortActiveThreadsByOrderKey(threads);
    }).run();
  });
  test("sort 1000 keyless pinned threads", async ({ bench }) => {
    await bench("sort", () => {
      sortPinnedThreadsByOrderKey(threads);
    }).run();
  });
  test("select latest project thread from 1000 threads", async ({ bench }) => {
    await bench("select", () => {
      getLatestThreadForProject(threads, projectId, "updated_at");
    }).run();
  });
  test("derive current plan from 5 normalized plans", async ({ bench }) => {
    await bench("derive", () => {
      deriveCurrentTaskProgress(projection, runId);
    }).run();
  });
  test("format 24 hourly usage labels and tooltips", async ({ bench }) => {
    await bench("format", () => {
      hours.map((hour) => [
        formatHourShort(hour, "America/New_York"),
        formatRelativeHourShort(hour, referenceTime, "America/New_York"),
      ]);
    }).run();
  });
});
