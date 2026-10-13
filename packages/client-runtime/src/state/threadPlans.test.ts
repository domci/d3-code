import {
  MessageId,
  NodeId,
  PlanId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import { deriveCurrentTaskProgress } from "./threadPlans.ts";

const providerThreadId = ProviderThreadId.make("root-provider");
const rootNodeId = NodeId.make("root");
const run: OrchestrationV2Run = {
  id: RunId.make("current-run"),
  threadId: v2Projection.thread.id,
  ordinal: 1,
  providerInstanceId: v2Projection.thread.providerInstanceId,
  modelSelection: v2Projection.thread.modelSelection,
  providerThreadId,
  userMessageId: MessageId.make("user"),
  rootNodeId,
  activeAttemptId: RunAttemptId.make("accepted-attempt"),
  status: "running",
  requestedAt: v2Now,
  startedAt: v2Now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const attempt: OrchestrationV2RunAttempt = {
  id: run.activeAttemptId!,
  runId: run.id,
  attemptOrdinal: 1,
  rootNodeId,
  providerInstanceId: run.providerInstanceId,
  providerThreadId,
  providerTurnId: null,
  reason: "initial",
  status: "running",
  startedAt: v2Now,
  completedAt: null,
};
const root: OrchestrationV2ExecutionNode = {
  id: rootNodeId,
  threadId: v2Projection.thread.id,
  runId: run.id,
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
  startedAt: v2Now,
  completedAt: null,
};
const planNode = {
  ...root,
  id: NodeId.make("checklist"),
  kind: "todo_list" as const,
  parentNodeId: root.id,
  countsForRun: false,
};
const plan: Extract<OrchestrationV2PlanArtifact, { kind: "todo_list" }> = {
  id: PlanId.make("current-plan"),
  threadId: run.threadId,
  runId: run.id,
  nodeId: planNode.id,
  status: "active",
  kind: "todo_list",
  steps: [
    { id: "inspect", text: "Inspect", status: "completed", durationMs: 3_000 },
    { id: "verify", text: "Verify", status: "running" },
    { id: "report", text: "Report", status: "pending" },
  ],
};
const projection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, activeProviderThreadId: providerThreadId },
  runs: [run],
  attempts: [attempt],
  nodes: [root, planNode],
  plans: [plan],
};

describe("current root task progress", () => {
  it("updates the current step and counts while preserving repeated-label durations", () => {
    expect(deriveCurrentTaskProgress(projection, run.id)).toEqual({
      runId: run.id,
      step: "Verify",
      completedSteps: 1,
      totalSteps: 3,
      steps: [
        { step: "Inspect", status: "completed", durationMs: 3_000 },
        { step: "Verify", status: "inProgress" },
        { step: "Report", status: "pending" },
      ],
    });
    expect(
      deriveCurrentTaskProgress(
        {
          ...projection,
          plans: [
            {
              ...plan,
              steps: [
                { id: "verify-a", text: "Verify", status: "completed", durationMs: 3_000 },
                { id: "verify-b", text: "Verify", status: "completed", durationMs: 4_000 },
                { id: "report", text: "Report", status: "pending" },
              ],
            },
          ],
        },
        run.id,
      ),
    ).toEqual({
      runId: run.id,
      step: "Report",
      completedSteps: 2,
      totalSteps: 3,
      steps: [
        { step: "Verify", status: "completed", durationMs: 3_000 },
        { step: "Verify", status: "completed", durationMs: 4_000 },
        { step: "Report", status: "pending" },
      ],
    });
  });

  it.each(["completed", "failed", "cancelled", "interrupted", "rolled_back"] as const)(
    "hides current progress when the run is %s",
    (status) => {
      expect(
        deriveCurrentTaskProgress({ ...projection, runs: [{ ...run, status }] }, run.id),
      ).toBeNull();
    },
  );

  it("does not carry the previous run's checklist into fresh work", () => {
    expect(
      deriveCurrentTaskProgress(
        { ...projection, plans: [{ ...plan, runId: RunId.make("previous-run") }] },
        run.id,
      ),
    ).toBeNull();
    expect(deriveCurrentTaskProgress(projection, undefined)).toBeNull();
  });

  it.each([
    ["empty", "equal"],
    ["superseded", "equal"],
    ["empty", "missing"],
    ["superseded", "missing"],
  ] as const)(
    "keeps progress cleared by a %s checklist with %s chronology",
    (state, chronology) => {
      const newest = {
        ...plan,
        id: PlanId.make("newest"),
        ...(state === "empty" ? { steps: [] } : { status: "superseded" as const }),
      };
      expect(
        deriveCurrentTaskProgress(
          {
            ...projection,
            nodes:
              chronology === "equal" ? projection.nodes : [root, { ...planNode, startedAt: null }],
            plans: [newest, plan],
          },
          run.id,
        ),
      ).toBeNull();
    },
  );

  it.each(["active", "empty", "superseded"] as const)(
    "selects the newest %s checklist after persisted plan order changes",
    (state) => {
      const newestNode = {
        ...planNode,
        id: NodeId.make("newest-checklist"),
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"),
      };
      const newest = {
        ...plan,
        id: PlanId.make("a-newest-plan"),
        nodeId: newestNode.id,
        status: state === "superseded" ? ("superseded" as const) : ("active" as const),
        steps:
          state === "empty"
            ? []
            : [{ id: "newest", text: "Newest root task", status: "running" as const }],
      };
      const progress = deriveCurrentTaskProgress(
        {
          ...projection,
          nodes: [...projection.nodes, newestNode],
          plans: [newest, plan],
        },
        run.id,
      );
      if (state === "active") expect(progress?.step).toBe("Newest root task");
      else expect(progress).toBeNull();
    },
  );

  it.each(["superseded", "failed", "cancelled", "interrupted"] as const)(
    "rejects a checklist from a %s accepted-attempt row",
    (status) => {
      expect(
        deriveCurrentTaskProgress({ ...projection, attempts: [{ ...attempt, status }] }, run.id),
      ).toBeNull();
    },
  );

  it("ignores rejected retry plans while presenting the accepted attempt's plan", () => {
    const rejectedRoot = {
      ...root,
      id: NodeId.make("rejected-root"),
      rootNodeId: NodeId.make("rejected-root"),
    };
    const rejectedNode = {
      ...planNode,
      id: NodeId.make("rejected-plan"),
      rootNodeId: rejectedRoot.id,
      parentNodeId: rejectedRoot.id,
    };
    const rejectedPlan = {
      ...plan,
      id: PlanId.make("rejected-plan"),
      nodeId: rejectedNode.id,
      steps: [{ id: "ghost", text: "Retry ghost", status: "running" as const }],
    };
    expect(
      deriveCurrentTaskProgress(
        {
          ...projection,
          nodes: [...projection.nodes, rejectedRoot, rejectedNode],
          plans: [plan, rejectedPlan],
          attempts: [
            attempt,
            {
              ...attempt,
              id: RunAttemptId.make("rejected"),
              rootNodeId: rejectedRoot.id,
              status: "superseded",
            },
          ],
        },
        run.id,
      )?.step,
    ).toBe("Verify");
  });

  it("ignores child checklists even when they share the root run and native thread", () => {
    const child = { ...planNode, id: NodeId.make("child"), kind: "subagent" as const };
    const childPlanNode = { ...planNode, id: NodeId.make("child-plan"), parentNodeId: child.id };
    const childPlan = {
      ...plan,
      id: PlanId.make("child-plan"),
      nodeId: childPlanNode.id,
      steps: [{ id: "child", text: "Child task", status: "running" as const }],
    };
    expect(
      deriveCurrentTaskProgress(
        {
          ...projection,
          nodes: [...projection.nodes, child, childPlanNode],
          plans: [plan, childPlan],
        },
        run.id,
      )?.step,
    ).toBe("Verify");
  });

  it("omits ambiguous ancestry and another provider's execution", () => {
    expect(deriveCurrentTaskProgress({ ...projection, nodes: [planNode] }, run.id)).toBeNull();
    expect(
      deriveCurrentTaskProgress(
        { ...projection, nodes: [root, { ...planNode, parentNodeId: planNode.id }] },
        run.id,
      ),
    ).toBeNull();
    expect(
      deriveCurrentTaskProgress(
        {
          ...projection,
          nodes: [root, { ...planNode, providerThreadId: ProviderThreadId.make("other") }],
        },
        run.id,
      ),
    ).toBeNull();
  });
});
