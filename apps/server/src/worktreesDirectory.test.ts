import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { buildWorktreePath } from "./worktreesDirectory.ts";

describe("buildWorktreePath", () => {
  it.effect("puts the repo name last and the temporary-branch token first", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(buildWorktreePath("/w", "frub-ai", "d3/359d97ab", path), "/w/359d97ab/frub-ai");
      assert.equal(buildWorktreePath("/w", "frub-ai", "d3-359d97ab", path), "/w/359d97ab/frub-ai");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the sanitized branch for named branches and appends a collision suffix", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(buildWorktreePath("/w", "frub-ai", "feature/x", path), "/w/feature-x/frub-ai");
      assert.equal(
        buildWorktreePath("/w", "frub-ai", "d3/359d97ab", path, "ab12"),
        "/w/359d97ab-ab12/frub-ai",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
