import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { v2Now, v2Projection } from "./state/orchestrationV2TestFixtures.ts";
import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "./contextWindow.ts";

const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("native-thread"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: v2Projection.thread.providerInstanceId,
  providerSessionId: null,
  appThreadId: v2Projection.thread.id,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  contextUsage: null,
  createdAt: v2Now,
  updatedAt: v2Now,
};
const projection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, activeProviderThreadId: providerThread.id },
  providerThreads: [providerThread],
};
const report: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("turn-report"),
  providerThreadId: providerThread.id,
  nodeId: NodeId.make("report-root"),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt: v2Now,
  completedAt: v2Now,
  tokenUsage: {
    usedTokens: 42_000,
    maxTokens: 200_000,
    inputTokens: 40_000,
    outputTokens: 2_000,
    updatedAt: "2026-08-27T00:00:00.000Z",
  },
};
const compaction: OrchestrationV2TurnItem = {
  id: TurnItemId.make("compaction-1"),
  threadId: projection.thread.id,
  runId: null,
  nodeId: null,
  providerThreadId: providerThread.id,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: v2Now,
  type: "compaction",
  driver: null,
  beforeTokenCount: 10_000,
  afterTokenCount: 2_000,
};

describe("context window presentation", () => {
  it("prefers current provider-turn usage and retains it between turns", () => {
    const snapshot = deriveLatestContextWindowSnapshot([{ item: compaction }], {
      ...projection,
      providerTurns: [
        report,
        { ...report, id: ProviderTurnId.make("turn-next"), ordinal: 2, tokenUsage: undefined },
        { ...report, providerThreadId: ProviderThreadId.make("other-provider"), ordinal: 3 },
      ],
      providerThreads: [{ ...providerThread, contextUsage: { usedTokens: 1_000 } }],
    });
    expect(snapshot).toMatchObject({
      usedTokens: 42_000,
      maxTokens: 200_000,
      remainingTokens: 158_000,
      usedPercentage: 21,
      updatedAt: report.tokenUsage!.updatedAt,
      compactsAutomatically: null,
    });
  });

  it("clears reports from another native conversation on provider switching", () => {
    expect(
      deriveLatestContextWindowSnapshot([{ item: compaction }], {
        ...projection,
        thread: {
          ...projection.thread,
          activeProviderThreadId: ProviderThreadId.make("new-native"),
        },
        providerThreads: [{ ...providerThread, id: ProviderThreadId.make("new-native") }],
        providerTurns: [report],
      }),
    ).toBeNull();
    expect(deriveLatestContextWindowSnapshot([], null)).toBeNull();
  });

  it("uses native-thread usage and explicit capability without inventing a maximum", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      ...projection,
      providerThreads: [
        {
          ...providerThread,
          contextUsage: {
            usedTokens: 2_500,
            compactsAutomatically: false,
            cost: { amount: 0.42, currency: "USD" },
          },
        },
      ],
    });
    expect(snapshot).toMatchObject({
      usedTokens: 2_500,
      maxTokens: null,
      usedPercentage: null,
      remainingTokens: null,
      compactsAutomatically: false,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  it.each([undefined, null, 0])("treats an unavailable maximum (%s) as unknown", (maxTokens) => {
    expect(
      deriveLatestContextWindowSnapshot([], {
        ...projection,
        providerTurns: [
          {
            ...report,
            tokenUsage: {
              usedTokens: 42_000,
              maxTokens,
              updatedAt: report.tokenUsage!.updatedAt,
            },
          },
        ],
      }),
    ).toMatchObject({ maxTokens: null, usedPercentage: null, remainingTokens: null });
    expect(
      deriveLatestContextWindowSnapshot([], {
        ...projection,
        providerThreads: [
          {
            ...providerThread,
            contextUsage: { usedTokens: 42_000, ...(maxTokens == null ? {} : { maxTokens }) },
          },
        ],
      }),
    ).toMatchObject({ maxTokens: null, usedPercentage: null, remainingTokens: null });
  });

  it("uses only compaction data belonging to the selected native conversation", () => {
    const snapshot = deriveLatestContextWindowSnapshot(
      [
        { item: compaction },
        {
          item: {
            ...compaction,
            providerThreadId: ProviderThreadId.make("old-native"),
            afterTokenCount: 900,
          },
        },
      ],
      projection,
    );
    expect(snapshot).toMatchObject({
      usedTokens: 2_000,
      totalProcessedTokens: 10_000,
      maxTokens: null,
      compactsAutomatically: null,
    });
    expect(deriveLatestContextWindowSnapshot([], projection)).toBeNull();
  });

  it.each(["turn", "thread"] as const)(
    "refreshes retained %s usage after compaction and then a fresh report",
    (source) => {
      const entries = [
        {
          item: {
            ...compaction,
            updatedAt: DateTime.makeUnsafe("2026-08-28T00:00:00.000Z"),
          },
        },
      ];
      expect(
        deriveLatestContextWindowSnapshot(entries, {
          ...projection,
          ...(source === "turn"
            ? { providerTurns: [report] }
            : {
                providerThreads: [
                  {
                    ...providerThread,
                    contextUsage: { usedTokens: 42_000 },
                    updatedAt: DateTime.makeUnsafe(report.tokenUsage!.updatedAt),
                  },
                ],
              }),
        }),
      ).toMatchObject({ usedTokens: 2_000, updatedAt: "2026-08-28T00:00:00.000Z" });
      expect(
        deriveLatestContextWindowSnapshot(entries, {
          ...projection,
          ...(source === "turn"
            ? {
                providerTurns: [
                  {
                    ...report,
                    tokenUsage: {
                      ...report.tokenUsage!,
                      usedTokens: 3_000,
                      updatedAt: "2026-08-29T00:00:00.000Z",
                    },
                  },
                ],
              }
            : {
                providerThreads: [
                  {
                    ...providerThread,
                    contextUsage: { usedTokens: 3_000 },
                    updatedAt: DateTime.makeUnsafe("2026-08-29T00:00:00.000Z"),
                  },
                ],
              }),
        })?.usedTokens,
      ).toBe(3_000);
    },
  );

  it("clears old reports and linked compactions when a provider-thread row gets a new native conversation", () => {
    const attempt = {
      id: RunAttemptId.make("old-attempt"),
      runId: RunId.make("old-run"),
      attemptOrdinal: 1,
      rootNodeId: report.nodeId,
      providerInstanceId: providerThread.providerInstanceId,
      providerThreadId: providerThread.id,
      providerTurnId: report.id,
      nativeThreadId: "old-native",
      reason: "initial" as const,
      status: "completed" as const,
      startedAt: v2Now,
      completedAt: v2Now,
    };
    const oldReport = { ...report, ordinal: 10, runAttemptId: attempt.id };
    const selected = {
      ...projection,
      attempts: [attempt],
      providerTurns: [oldReport],
      providerThreads: [
        {
          ...providerThread,
          nativeThreadRef: {
            driver: providerThread.driver,
            strength: "strong" as const,
            nativeId: "new-native",
          },
        },
      ],
    };
    const entries = [{ item: { ...compaction, providerTurnId: oldReport.id } }];
    expect(deriveLatestContextWindowSnapshot(entries, selected)).toBeNull();
    expect(
      deriveLatestContextWindowSnapshot(entries, {
        ...selected,
        providerThreads: [
          {
            ...selected.providerThreads[0]!,
            nativeThreadRef: {
              ...selected.providerThreads[0]!.nativeThreadRef,
              nativeId: "old-native",
            },
          },
        ],
      })?.usedTokens,
    ).toBe(42_000);
    const freshAttempt = {
      ...attempt,
      id: RunAttemptId.make("new-attempt"),
      nativeThreadId: "new-native",
    };
    expect(
      deriveLatestContextWindowSnapshot(entries, {
        ...selected,
        attempts: [attempt, freshAttempt],
        providerTurns: [
          oldReport,
          {
            ...report,
            id: ProviderTurnId.make("new-report"),
            runAttemptId: freshAttempt.id,
            tokenUsage: { usedTokens: 3_000, updatedAt: report.tokenUsage!.updatedAt },
          },
        ],
      })?.usedTokens,
    ).toBe(3_000);
  });

  it.each([
    [950, "950"],
    [1_500, "1.5k"],
    [20_000, "20k"],
    [1_500_000, "1.5m"],
  ] as const)("formats %i tokens as %s", (tokens, label) => {
    expect(formatContextWindowTokens(tokens)).toBe(label);
  });
});
