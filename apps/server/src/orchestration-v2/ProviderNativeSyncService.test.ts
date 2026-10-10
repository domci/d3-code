import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderNativeSyncService from "./ProviderNativeSyncService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };

/** Which outbox effects the commands enqueue; no worker runs them. */
{
  const adapter = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider here"),
  } as ProviderAdapterV2Shape;
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "provider-native-sync-effects" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
  );

  const syncEffects = (commandId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly request_json: string }>`
        SELECT payload_json AS request_json FROM orchestration_v2_effect_outbox
        WHERE command_id = ${commandId} AND effect_type = 'provider-native.sync'
      `;
      return rows.map((row) => (JSON.parse(row.request_json) as { aspects: string[] }).aspects);
    });

  it.effect("enqueues a native sync for a title change and for settle state changes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:native-sync-effects");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:native-sync-effects"),
        threadId,
        projectId: ProjectId.make("project:native-sync-effects"),
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const dispatch = (
        type: "thread.settle" | "thread.unsettle" | "thread.metadata.update",
        name: string,
        extra: { readonly title?: string } = {},
      ) =>
        orchestrator.dispatch({
          type,
          commandId: CommandId.make(name),
          threadId,
          ...extra,
        } as never);

      yield* dispatch("thread.metadata.update", "rename", { title: "Fix the login bug" });
      yield* dispatch("thread.metadata.update", "same-title", { title: "Fix the login bug" });
      yield* dispatch("thread.settle", "settle");
      yield* dispatch("thread.unsettle", "unsettle");

      assert.deepEqual(yield* syncEffects("rename"), [["title"]]);
      // Re-saving the same title changes nothing, so there is nothing to mirror.
      assert.deepEqual(yield* syncEffects("same-title"), []);
      assert.deepEqual(yield* syncEffects("settle"), [["archive"]]);
      assert.deepEqual(yield* syncEffects("unsettle"), [["archive"]]);
    }).pipe(Effect.provide(layerTest)),
  );
}

const nativeThreadId = "native-thread-1";
const providerSessionId = ProviderSessionId.make("provider-session:native-sync");

/** Runs one sync against fakes and returns what the provider was asked to do. */
const runSync = (input: {
  readonly aspects: ReadonlyArray<"title" | "archive">;
  readonly title?: string;
  readonly settled?: boolean;
  readonly live?: boolean;
  readonly controls?: ProviderAdapterV2Shape["nativeThreadControls"];
  readonly failProvider?: boolean;
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (call: string) => Ref.update(calls, (existing) => [...existing, call]);
    const fail = input.failProvider === true;
    const runtime = {
      setThreadTitle: ({ title }: { readonly title: string }) =>
        record(`title:${title}`).pipe(
          Effect.andThen(fail ? Effect.fail("provider refused" as never) : Effect.void),
        ),
      setThreadArchived: ({ archived }: { readonly archived: boolean }) =>
        record(`archived:${archived}`).pipe(
          Effect.andThen(fail ? Effect.fail("provider refused" as never) : Effect.void),
        ),
    } as unknown as ProviderAdapterV2SessionRuntime;
    const providerThreadId = "provider-thread:native-sync";
    const projection = {
      thread: {
        deletedAt: null,
        title: input.title ?? "Fix the login bug",
        settledOverride: input.settled === true ? "settled" : null,
        archivedAt: null,
        activeProviderThreadId: providerThreadId,
        modelSelection,
      },
      providerThreads: [
        {
          id: providerThreadId,
          providerInstanceId: instanceId,
          providerSessionId,
          nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
          nativeMetadata: null,
        },
      ],
      providerSessions: [],
    };
    const layer = ProviderNativeSyncService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () => Effect.succeed(projection as never),
          }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            get: () =>
              Effect.succeed({
                nativeThreadControls: input.controls ?? { title: true, archive: true },
              } as ProviderAdapterV2Shape),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeed(input.live === true ? Option.some(runtime) : Option.none()),
            open: () => record("open").pipe(Effect.as(runtime)),
            detach: () => record("detach"),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: () => Effect.succeed({ cwd: "/work" } as never),
          }),
        ),
      ),
    );
    yield* ProviderNativeSyncService.ProviderNativeSyncService.use((service) =>
      service.sync({ threadId: ThreadId.make("thread:native-sync"), aspects: input.aspects }),
    ).pipe(Effect.provide(layer));
    return yield* Ref.get(calls);
  });

it.effect("names the provider thread through a live session without opening another", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* runSync({ aspects: ["title"], live: true }), [
      "title:Fix the login bug",
    ]);
  }),
);

it.effect("does not push the placeholder title", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* runSync({ aspects: ["title"], live: true, title: "New thread" }), []);
  }),
);

it.effect("archives a settled thread with no live session, then lets the session go", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* runSync({ aspects: ["archive"], settled: true }), [
      "open",
      "archived:true",
      "detach",
    ]);
  }),
);

it.effect("restores the provider thread when the thread is no longer settled", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* runSync({ aspects: ["archive"], settled: false }), [
      "open",
      "archived:false",
      "detach",
    ]);
  }),
);

it.effect("leaves a live session attached after archiving", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* runSync({ aspects: ["archive"], settled: true, live: true }), [
      "archived:true",
    ]);
  }),
);

it.effect("never opens a session for a driver without the control", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* runSync({ aspects: ["title", "archive"], settled: true, controls: {} }),
      [],
    );
    // Only the supported half runs.
    assert.deepEqual(
      yield* runSync({ aspects: ["title", "archive"], settled: true, controls: { title: true } }),
      ["open", "title:Fix the login bug", "detach"],
    );
  }),
);

it.effect("swallows a provider failure and still releases the session it opened", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* runSync({ aspects: ["title", "archive"], settled: true, failProvider: true }),
      ["open", "title:Fix the login bug", "archived:true", "detach"],
    );
  }),
);
