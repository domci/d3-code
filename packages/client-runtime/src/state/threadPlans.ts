import type { NodeId, OrchestrationV2ThreadProjection, PlanId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadTaskProgress {
  readonly runId: RunId;
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly steps: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
    readonly durationMs?: number;
  }>;
}

export function planItemTime(projection: OrchestrationV2ThreadProjection, planId: PlanId): string {
  const item = projection.turnItems.findLast(
    (candidate) =>
      (candidate.type === "proposed_plan" || candidate.type === "todo_list") &&
      candidate.planId === planId,
  );
  return DateTime.formatIso(item?.updatedAt ?? projection.updatedAt);
}

/** Current root work only: retries and child tasks own separate checklists. */
export function deriveCurrentTaskProgress(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "attempts" | "nodes" | "plans"
  > | null,
  activityRunId: RunId | undefined,
): ThreadTaskProgress | null {
  if (projection === null || activityRunId === undefined) return null;
  const run = projection.runs.find((candidate) => candidate.id === activityRunId);
  if (
    run === undefined ||
    !["preparing", "starting", "running", "waiting"].includes(run.status) ||
    run.providerInstanceId !== projection.thread.providerInstanceId ||
    run.providerThreadId === null ||
    run.providerThreadId !== projection.thread.activeProviderThreadId
  )
    return null;
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  if (
    attempt === undefined ||
    attempt.runId !== run.id ||
    attempt.rootNodeId !== run.rootNodeId ||
    attempt.providerInstanceId !== run.providerInstanceId ||
    attempt.providerThreadId !== run.providerThreadId ||
    (attempt.status !== "running" && attempt.status !== "completed")
  )
    return null;
  const nodes = new Map(projection.nodes.map((node) => [node.id, node] as const));
  const belongsToRoot = (nodeId: NodeId): boolean => {
    const visited = new Set<NodeId>();
    let current: NodeId | null = nodeId;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const node = nodes.get(current);
      if (
        node === undefined ||
        node.threadId !== projection.thread.id ||
        node.runId !== run.id ||
        node.rootNodeId !== attempt.rootNodeId ||
        node.providerThreadId !== attempt.providerThreadId ||
        node.kind === "subagent"
      )
        return false;
      if (node.id === attempt.rootNodeId) return node.kind === "root_turn";
      current = node.parentNodeId;
    }
    return false;
  };
  let plan:
    | Extract<OrchestrationV2ThreadProjection["plans"][number], { kind: "todo_list" }>
    | undefined;
  let planStartedAt: number | null = null;
  // Persistence sorts random plan IDs; node start times preserve checklist chronology.
  // shortcut: equally timed active checklists keep source order; use durable event order if this becomes visible.
  for (const candidate of projection.plans) {
    if (
      candidate.kind !== "todo_list" ||
      candidate.threadId !== projection.thread.id ||
      candidate.runId !== run.id ||
      !belongsToRoot(candidate.nodeId)
    )
      continue;
    const startedAt = nodes.get(candidate.nodeId)?.startedAt;
    const candidateStartedAt = startedAt == null ? null : DateTime.toEpochMillis(startedAt);
    const order =
      candidateStartedAt !== null && planStartedAt !== null
        ? candidateStartedAt - planStartedAt
        : 0;
    const candidateClears = candidate.status === "superseded" || candidate.steps.length === 0;
    const currentClears = plan?.status === "superseded" || plan?.steps.length === 0;
    if (plan === undefined || order > 0 || (order === 0 && (!currentClears || candidateClears))) {
      plan = candidate;
      planStartedAt = candidateStartedAt;
    }
  }
  // An empty or superseded newest checklist clears progress instead of reviving an older one.
  if (plan?.kind !== "todo_list" || plan.status === "superseded" || plan.steps.length === 0)
    return null;
  const steps = plan.steps.map(({ text, status, durationMs }) => ({
    step: text,
    status: status === "running" ? ("inProgress" as const) : status,
    ...(durationMs === undefined ? {} : { durationMs }),
  }));
  return {
    runId: run.id,
    step:
      steps.find((step) => step.status === "inProgress")?.step ??
      steps.find((step) => step.status === "pending")?.step ??
      steps.at(-1)!.step,
    completedSteps: steps.filter((step) => step.status === "completed").length,
    totalSteps: steps.length,
    steps,
  };
}
