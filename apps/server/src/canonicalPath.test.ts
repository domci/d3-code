// @effect-diagnostics nodeBuiltinImport:off - builds real symlinked directories.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { canonicalPath } from "./canonicalPath.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";

// `<base>/t3` -> `<base>/d3`: the layout after `~/.t3` is renamed to `~/.d3`.
const layout = Effect.acquireRelease(
  Effect.sync(() => {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-canon-")),
    );
    NodeFS.mkdirSync(NodePath.join(base, "d3", "worktrees", "x"), { recursive: true });
    NodeFS.symlinkSync(NodePath.join(base, "d3"), NodePath.join(base, "t3"));
    return base;
  }),
  (base) => Effect.sync(() => NodeFS.rmSync(base, { recursive: true, force: true })),
);

describe("canonicalPath", () => {
  it.effect("maps the legacy symlinked form and the direct form to one location", () =>
    Effect.gen(function* () {
      const base = yield* layout;
      const direct = NodePath.join(base, "d3", "worktrees", "x");
      assert.equal(canonicalPath(NodePath.join(base, "t3", "worktrees", "x")), direct);
      assert.equal(canonicalPath(direct), direct);
    }).pipe(Effect.scoped),
  );

  it.effect("resolves the existing ancestor of a missing path", () =>
    Effect.gen(function* () {
      const base = yield* layout;
      assert.equal(
        canonicalPath(NodePath.join(base, "t3", "worktrees", "gone", "repo")),
        NodePath.join(base, "d3", "worktrees", "gone", "repo"),
      );
    }).pipe(Effect.scoped),
  );
});

describe("withWorkspaceLease", () => {
  it.effect("serializes work on the same directory reached through either form", () =>
    Effect.gen(function* () {
      const base = yield* layout;
      const order: Array<string> = [];
      const firstEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        withWorkspaceLease(
          NodePath.join(base, "t3", "worktrees", "x"),
          Effect.gen(function* () {
            order.push("first:start");
            yield* Deferred.succeed(firstEntered, undefined);
            yield* Deferred.await(release);
            order.push("first:end");
          }),
        ),
      );
      yield* Deferred.await(firstEntered);
      const second = yield* Effect.forkChild(
        withWorkspaceLease(
          NodePath.join(base, "d3", "worktrees", "x"),
          Effect.sync(() => order.push("second")),
        ),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepEqual(order, ["first:start", "first:end", "second"]);
    }).pipe(Effect.scoped),
  );
});
