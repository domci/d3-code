import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2TurnItem,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Newest usage report across a thread's provider turns. Snapshots order turns
    by provider thread, not time, so pick by timestamp. */
export function latestProviderTurnTokenUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "tokenUsage">>,
): OrchestrationV2ProviderTurnTokenUsage | null {
  let latest: OrchestrationV2ProviderTurnTokenUsage | null = null;
  for (const { tokenUsage } of turns) {
    if (tokenUsage === undefined) continue;
    // Ties go to the later entry, since live upserts append.
    if (latest === null || Date.parse(tokenUsage.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = tokenUsage;
    }
  }
  return latest;
}

export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: OrchestrationV2TurnItem;
  }>,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerTurns" | "attempts"
  > | null,
): ContextWindowSnapshot | null {
  if (projection === null) return null;
  const providerThread = projection.providerThreads.find(
    (candidate) =>
      candidate.id === projection.thread.activeProviderThreadId &&
      candidate.providerInstanceId === projection.thread.providerInstanceId,
  );
  if (providerThread === undefined) return null;
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const turns = new Map(projection.providerTurns.map((turn) => [turn.id, turn]));
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
  // Recovery may reuse the row for a different native conversation; legacy identities are optional.
  const belongsToNativeThread = (
    turn: OrchestrationV2ThreadProjection["providerTurns"][number] | undefined,
  ) => {
    const attempt = turn?.runAttemptId == null ? undefined : attempts.get(turn.runAttemptId);
    return (
      nativeThreadId === undefined ||
      attempt?.nativeThreadId === undefined ||
      attempt.nativeThreadId === nativeThreadId
    );
  };
  const liveUsage = projection.providerTurns.reduce<
    OrchestrationV2ThreadProjection["providerTurns"][number] | null
  >(
    (latest, candidate) =>
      candidate.providerThreadId === providerThread.id &&
      belongsToNativeThread(candidate) &&
      candidate.tokenUsage !== undefined &&
      (latest === null || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    null,
  )?.tokenUsage;
  const compaction = entries.findLast(
    ({ item }) =>
      item.type === "compaction" &&
      item.status === "completed" &&
      item.providerThreadId === providerThread.id &&
      item.threadId === projection.thread.id &&
      belongsToNativeThread(
        item.providerTurnId === null ? undefined : turns.get(item.providerTurnId),
      ) &&
      typeof item.afterTokenCount === "number" &&
      Number.isFinite(item.afterTokenCount) &&
      item.afterTokenCount >= 0,
  )?.item;
  const usageUpdatedAt =
    liveUsage === undefined
      ? DateTime.toEpochMillis(providerThread.updatedAt)
      : Date.parse(liveUsage.updatedAt);
  const newerCompaction =
    compaction !== undefined && DateTime.toEpochMillis(compaction.updatedAt) > usageUpdatedAt;
  if (liveUsage != null && !newerCompaction) {
    const usedTokens = Math.max(0, liveUsage.usedTokens);
    const maxTokens =
      liveUsage.maxTokens != null && liveUsage.maxTokens > 0 ? liveUsage.maxTokens : null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
    return {
      usedTokens,
      totalProcessedTokens: null,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: liveUsage.inputTokens ?? null,
      cachedInputTokens: liveUsage.cachedInputTokens ?? null,
      outputTokens: liveUsage.outputTokens ?? null,
      reasoningOutputTokens: liveUsage.reasoningOutputTokens ?? null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: providerThread.contextUsage?.compactsAutomatically ?? null,
      autoCompactThreshold: null,
      cost: null,
      updatedAt: liveUsage.updatedAt,
    };
  }
  const providerUsage = providerThread?.contextUsage;
  const providerUsageUpdatedAt = providerThread?.updatedAt;
  if (
    providerUsage !== null &&
    providerUsage !== undefined &&
    providerUsageUpdatedAt !== undefined &&
    !newerCompaction
  ) {
    const reportedMax = asFiniteNumber(providerUsage.maxTokens);
    const maxTokens = reportedMax !== null && reportedMax > 0 ? reportedMax : null;
    const usedTokens = providerUsage.usedTokens;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(providerUsage.totalProcessedTokens),
      maxTokens,
      remainingTokens: maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens)),
      usedPercentage,
      remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
      inputTokens: asFiniteNumber(providerUsage.inputTokens),
      cachedInputTokens: asFiniteNumber(providerUsage.cachedInputTokens),
      outputTokens: asFiniteNumber(providerUsage.outputTokens),
      reasoningOutputTokens: asFiniteNumber(providerUsage.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(providerUsage.lastUsedTokens),
      lastInputTokens: asFiniteNumber(providerUsage.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(providerUsage.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(providerUsage.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(providerUsage.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(providerUsage.toolUses),
      durationMs: asFiniteNumber(providerUsage.durationMs),
      compactsAutomatically: providerUsage.compactsAutomatically ?? null,
      cost: providerUsage.cost ?? null,
      autoCompactThreshold: providerUsage.autoCompactThreshold ?? null,
      updatedAt: DateTime.formatIso(providerUsageUpdatedAt),
    };
  }
  if (compaction?.type === "compaction") {
    const payload = compaction;
    const usedTokens = asFiniteNumber(payload.afterTokenCount);
    if (usedTokens === null || usedTokens < 0) {
      return null;
    }

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload.beforeTokenCount),
      maxTokens: null,
      remainingTokens: null,
      usedPercentage: null,
      remainingPercentage: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: providerThread.contextUsage?.compactsAutomatically ?? null,
      autoCompactThreshold: null,
      cost: null,
      updatedAt: DateTime.formatIso(payload.updatedAt),
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
