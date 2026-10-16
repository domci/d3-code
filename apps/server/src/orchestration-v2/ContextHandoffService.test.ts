import { assert, it } from "@effect/vitest";
import {
  MessageId,
  OrchestrationV2ContextHandoff,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  historicalMessage,
  historyCost,
  historyResponseItems,
  renderHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import type { ProviderAdapterV2HistoricalContext } from "@t3tools/provider-core/server/ProviderAdapter";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const threadId = ThreadId.make("thread:legacy-context");
const targetProviderThreadId = ProviderThreadId.make("provider-thread:target");

function commandItem(
  id: string,
  output: string,
  options: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  const base = importedItem({ role: "assistant", id, text: "", ordinal: 2 });
  return {
    ...base,
    type: "command_execution",
    input: "cat <<'EOF'\nExit code: 77\nCommand: preserve this input\nEOF",
    output,
    exitCode: 0,
    ...options,
    providerThreadId: options.providerThreadId ?? base.providerThreadId ?? null,
  };
}

function prepareHandoff(
  service: ContextHandoffService.ContextHandoffServiceV2Shape,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  mode: "legacy" | "fork" | "provider" = "provider",
) {
  const input = {
    threadId,
    targetRunId: RunId.make("run:target"),
    toProviderThreadId: targetProviderThreadId,
    toProviderInstanceId: ProviderInstanceId.make("codex"),
    items,
    createdAt: now,
  };
  if (mode === "legacy") return service.prepareLegacyImport(input);
  const transfer = {
    ...input,
    transferId: null,
    fromProviderThreadIds: [],
    fromProviderInstanceId: ProviderInstanceId.make("claude"),
    coveredRunOrdinals: { from: 1, to: 1 },
  };
  return mode === "fork"
    ? service.prepareForkDelta({
        ...transfer,
        sourceThreadId: threadId,
        targetThreadId: ThreadId.make("thread:fork-target"),
        deltaItems: items,
      })
    : service.prepareProviderHandoff({ ...transfer, strategy: "full_thread_summary" });
}

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
      const providerMessage = ContextHandoffService.providerMessageWithContextHandoff({
        handoff,
        userText: "Continue from there.",
      });
      assert.include(providerMessage, handoff.summaryText);
      assert.include(providerMessage, "User message:\nContinue from there.");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.layer(layerTest)("ContextHandoffService command history", (it) => {
  it.effect.each(["legacy", "fork", "provider"] as const)(
    "preserves complete command output without pressure in %s preparation",
    (mode) =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const output = "HEAD\n" + "界🧪".repeat(400) + "\nTAIL";
        const older = commandItem("older", output);
        const newest = commandItem("newest", "Latest result");
        const handoff = yield* prepareHandoff(service, [older, newest], mode);
        assert.deepEqual(
          handoff.history?.messages.map((message) => message.text),
          [
            `Command: ${older.input}\nExit code: 0\n${output}`,
            `Command: ${newest.input}\nExit code: 0\nLatest result`,
          ],
        );
        assert.equal(handoff.history?.omittedItems, 0);
      }),
  );

  it.effect.each(["legacy", "fork", "provider"] as const)(
    "abbreviates older successful logs before omission in %s preparation",
    (mode) =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const output = "HEAD\n" + '界🧪\u0000\\"🧪'.repeat(5_000) + "\nTAIL";
        const older = commandItem("older", output);
        const newest = commandItem("newest", "Latest result");
        const items = [
          importedItem({
            role: "user",
            id: "constraints",
            text: "Preserve my constraints exactly.\n  Indentation too.",
            ordinal: 1,
          }),
          older,
          newest,
          importedItem({
            role: "assistant",
            id: "answer",
            text: "Latest partial answer.",
            ordinal: 4,
          }),
        ];
        const before = JSON.stringify(items);
        const handoff = yield* prepareHandoff(service, items, mode);
        const prepared = handoff.history!.messages;
        assert.deepEqual(
          prepared.map((message) => message.itemId),
          items.map((item) => item.id),
        );
        const command = prepared[1]!;
        assert.include(command.text, `Command: ${older.input}\nExit code: 0\nHEAD\n`);
        assert.match(command.text, /\[Command output abbreviated: \d+ UTF-8 bytes omitted\./);
        assert.include(
          command.text,
          't3_thread_read({"threadId":"thread:legacy-context","view":"activity","itemId":"turn-item:older","textOffset":0})',
        );
        assert.isTrue(command.text.endsWith("\nTAIL"));
        assert.notInclude(command.text, "\ufffd");
        const outputPreview = command.text.slice(`Command: ${older.input}\nExit code: 0\n`.length);
        const [head, tail] = outputPreview.split(/\n\[Command output abbreviated:[^\n]*\]\n/);
        assert.isAtMost(Buffer.byteLength(head!), 1_024);
        assert.isAtMost(Buffer.byteLength(tail!), 1_024);
        assert.isTrue(output.startsWith(head!));
        assert.isTrue(output.endsWith(tail!));
        assert.isBelow(Buffer.byteLength(command.text), 3_000);
        assert.equal(prepared[0]!.text, items[0]!.type === "user_message" ? items[0]!.text : "");
        assert.equal(prepared[3]!.text, "Latest partial answer.");
        assert.equal(handoff.history!.omittedItems, 0);
        assert.isAtMost(historyCost(prepared, handoff.history!.coverage), 16_000);
        assert.equal(JSON.stringify(items), before);
        assert.include(historicalMessage(older)!.text, output);
        const repeated = yield* prepareHandoff(service, items, mode);
        assert.deepEqual(repeated.history, handoff.history);
      }),
  );

  it.effect.each([
    { status: "completed", exitCode: 1 },
    { status: "completed", exitCode: undefined },
    { status: "failed", exitCode: 0 },
    { status: "running", exitCode: 0 },
    { status: "interrupted", exitCode: 0 },
    { status: "cancelled", exitCode: 0 },
    { status: "completed", exitCode: 0, outputIndicatesFailure: true },
  ] as const)(
    "keeps guarded command outcome $status/$exitCode complete under pressure",
    (options) =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const protectedOutput = "Guarded output\n" + "g".repeat(3_000);
        const guarded = commandItem("guarded", protectedOutput, options);
        const handoff = yield* prepareHandoff(service, [
          commandItem("older", "HEAD" + "x".repeat(30_000) + "TAIL"),
          guarded,
          commandItem("newest", "Newest output"),
        ]);
        const command = handoff.history!.messages.find((message) => message.itemId === guarded.id)!;
        assert.equal(
          command.text,
          `Command: ${guarded.input}\nExit code: ${guarded.exitCode ?? "unknown"}\n${protectedOutput}`,
        );
        assert.notInclude(command.text, "abbreviated");
        assert.equal(handoff.history!.omittedItems, 0);
      }),
  );

  it.effect("omits the newest oversized command whole while retaining older abbreviated work", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const newest = commandItem("newest", "newest".repeat(10_000));
      const handoff = yield* prepareHandoff(service, [
        commandItem("older", "HEAD" + "older".repeat(10_000) + "TAIL"),
        newest,
      ]);
      assert.deepEqual(
        handoff.history!.messages.map((message) => message.itemId),
        [TurnItemId.make("turn-item:older")],
      );
      assert.deepEqual(handoff.history!.omittedItemIds, [newest.id]);
      assert.equal(handoff.history!.omittedItems, 1);
    }),
  );

  it.effect("keeps near-limit output complete when excerpts and their marker would be larger", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const short = commandItem("short", "s".repeat(2_048));
      const nearLimit = commandItem("near-limit", "n".repeat(2_100));
      const nearJsonLimit = commandItem("near-json-limit", "n".repeat(2_294));
      const handoff = yield* prepareHandoff(service, [
        commandItem("older", "x".repeat(30_000)),
        short,
        nearLimit,
        nearJsonLimit,
        commandItem("newest", "Newest output"),
      ]);
      assert.equal(
        handoff.history!.messages[1]!.text,
        `Command: ${short.input}\nExit code: 0\n${short.output}`,
      );
      assert.equal(
        handoff.history!.messages[2]!.text,
        `Command: ${nearLimit.input}\nExit code: 0\n${nearLimit.output}`,
      );
      assert.equal(
        handoff.history!.messages[3]!.text,
        `Command: ${nearJsonLimit.input}\nExit code: 0\n${nearJsonLimit.output}`,
      );
      assert.equal(handoff.history!.omittedItems, 0);
    }),
  );

  it.effect.each([true, false])(
    "delivers prepared abbreviated text once with native injection=%s",
    (native) =>
      Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const older = commandItem("older", "HEAD" + "界🧪".repeat(5_000) + "TAIL");
        let durable = yield* prepareHandoff(service, [
          older,
          commandItem("newest", "Newest output"),
        ]);
        const prepared = durable.history!.messages;
        const providerThread = {
          id: targetProviderThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("codex"),
            strength: "strong" as const,
            nativeId: "native:target",
          },
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        let injections = 0;
        const input = {
          providerThread,
          budget: 4_500,
          alreadyDeliveredItemIds: new Set<string>(),
          ...(native
            ? {
                inject: (history: ProviderAdapterV2HistoricalContext) =>
                  Effect.sync(() => {
                    injections++;
                    assert.deepEqual(history.messages, prepared);
                    assert.isAtMost(
                      Buffer.byteLength(
                        JSON.stringify(historyResponseItems(history.messages, history.context)),
                      ) + 256,
                      4_500,
                    );
                    assert.isAtMost(
                      Buffer.byteLength(
                        JSON.stringify(renderHistory(history.messages, history.context)),
                      ) + 256,
                      4_500,
                    );
                    return true;
                  }),
              }
            : {}),
          persist: (value: OrchestrationV2ContextHandoff) =>
            Effect.sync(() => {
              durable = value;
            }),
        };
        const delivery = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
        if (!native) {
          assert.include(delivery.context, prepared[0]!.text);
          assert.isAtMost(Buffer.byteLength(JSON.stringify(delivery.context)) + 256, 4_500);
        }
        yield* delivery.delivered;
        assert.equal(durable.delivery!.status, native ? "injected" : "inline");
        assert.deepEqual(
          durable.delivery!.itemIds,
          prepared.map((message) => message.itemId),
        );
        assert.deepEqual(durable.delivery!.omittedItemIds, []);
        assert.deepEqual(durable.history!.messages, prepared);
        const retry = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
        assert.equal(retry.context, "");
        assert.equal(injections, native ? 1 : 0);
        assert.include(historicalMessage(older)!.text, older.output!);
      }),
  );
});
