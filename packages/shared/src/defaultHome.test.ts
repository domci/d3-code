// @effect-diagnostics nodeBuiltinImport:off - builds real home layouts on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { resolveDefaultHome } from "./defaultHome.ts";

const withHome = (run: (home: string) => void) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-default-home-"));
  try {
    run(home);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

describe("resolveDefaultHome", () => {
  it("uses ~/.d3 when it exists", () =>
    withHome((home) => {
      NodeFS.mkdirSync(NodePath.join(home, ".d3"));
      assert.equal(resolveDefaultHome(home), NodePath.join(home, ".d3"));
    }));

  it("uses ~/.t3 when only it exists", () =>
    withHome((home) => {
      NodeFS.mkdirSync(NodePath.join(home, ".t3"));
      assert.equal(resolveDefaultHome(home), NodePath.join(home, ".t3"));
    }));

  it("uses ~/.d3 for a fresh install", () =>
    withHome((home) => {
      assert.equal(resolveDefaultHome(home), NodePath.join(home, ".d3"));
    }));

  it("uses ~/.d3 when ~/.t3 is a symlink to it", () =>
    withHome((home) => {
      NodeFS.mkdirSync(NodePath.join(home, ".d3"));
      NodeFS.symlinkSync(NodePath.join(home, ".d3"), NodePath.join(home, ".t3"));
      assert.equal(resolveDefaultHome(home), NodePath.join(home, ".d3"));
    }));
});
