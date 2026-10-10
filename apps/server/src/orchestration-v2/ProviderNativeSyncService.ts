import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

/** The title a thread has before one is generated; it names nothing worth sharing. */
const PLACEHOLDER_TITLE = "New thread";

export type ProviderNativeSyncAspect = "title" | "archive";

export class ProviderNativeSyncService extends Context.Service<
  ProviderNativeSyncService,
  {
    /**
     * Mirrors the thread's current title and settled state onto the provider's own
     * conversation, so the vendor's apps list it by name and drop it when settled.
     * Best effort: a provider that cannot do it is logged, never failed.
     */
    readonly sync: (input: {
      readonly threadId: ThreadId;
      readonly aspects: ReadonlyArray<ProviderNativeSyncAspect>;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ProviderNativeSyncService") {}

export const layer: Layer.Layer<
  ProviderNativeSyncService,
  never,
  ProjectionStoreV2 | ProviderAdapterRegistryV2 | ProviderSessionManagerV2 | RuntimePolicyV2
> = Layer.effect(
  ProviderNativeSyncService,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const adapters = yield* ProviderAdapterRegistryV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;

    const run = Effect.fn("ProviderNativeSyncService.sync")(function* (input: {
      readonly threadId: ThreadId;
      readonly aspects: ReadonlyArray<ProviderNativeSyncAspect>;
    }) {
      const projection = yield* projections.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
      ]);
      const { thread } = projection;
      if (thread.deletedAt !== null) return;
      // Only the active provider's conversation is the one the vendor apps show.
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === thread.activeProviderThreadId,
      );
      const providerSessionId = providerThread?.providerSessionId ?? null;
      if (
        providerThread === undefined ||
        providerSessionId === null ||
        providerThread.nativeThreadRef === null ||
        providerThread.providerInstanceId !== thread.modelSelection.instanceId
      ) {
        return;
      }
      const title = thread.title.trim();
      const controls = (yield* adapters.get(providerThread.providerInstanceId))
        .nativeThreadControls;
      const wantsTitle =
        input.aspects.includes("title") && controls?.title === true && title !== PLACEHOLDER_TITLE;
      const wantsArchive = input.aspects.includes("archive") && controls?.archive === true;
      if (!wantsTitle && !wantsArchive) return;

      // Reuse a live session. Otherwise open one only for these calls and detach it after:
      // settling detaches sessions, so a settled thread usually has none.
      const existingSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const live = Option.getOrNull(yield* sessions.get(providerSessionId));
      const runtime =
        live ??
        (yield* sessions.open({
          threadId: input.threadId,
          providerSessionId,
          modelSelection: thread.modelSelection,
          runtimePolicy: yield* runtimePolicy.resolve({
            thread,
            modelSelection: thread.modelSelection,
          }),
          ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
          ...(providerThread.nativeThreadRef.nativeId === null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }));
      const apply = Effect.gen(function* () {
        if (wantsTitle && runtime.setThreadTitle !== undefined) {
          yield* runtime
            .setThreadTitle({ providerThread, title })
            .pipe(Effect.catch(logFailure(input.threadId, "title")));
        }
        if (wantsArchive && runtime.setThreadArchived !== undefined) {
          yield* runtime
            .setThreadArchived({
              providerThread,
              // Settled and archived threads are done; anything else is live work.
              archived: thread.settledOverride === "settled" || thread.archivedAt !== null,
            })
            .pipe(Effect.catch(logFailure(input.threadId, "archive")));
        }
      });
      yield* live === null
        ? apply.pipe(
            Effect.ensuring(
              sessions
                .detach({
                  providerSessionId,
                  threadId: input.threadId,
                  detail: "Provider conversation synced.",
                })
                .pipe(Effect.ignore),
            ),
          )
        : apply;
    });

    return ProviderNativeSyncService.of({
      sync: (input) =>
        run(input).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : logFailure(input.threadId, input.aspects.join("+"))(cause),
          ),
        ),
    });
  }),
);

const logFailure = (threadId: ThreadId, aspect: string) => (cause: unknown) =>
  Effect.logWarning("provider conversation sync skipped", {
    threadId,
    aspect,
    cause: Cause.isCause(cause) ? Cause.pretty(cause) : cause,
  });
