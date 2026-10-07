import { describe, expect, it } from "vite-plus/test";

import { buildSubagentTree, partitionSettledThreads } from "./LegacySidebar.logic";

describe("partitionSettledThreads", () => {
  it("separates settled threads and keeps the incoming order within each group", () => {
    const threads = [
      { id: "a", settledOverride: null },
      { id: "b", settledOverride: "settled" as const },
      { id: "c", settledOverride: "active" as const },
      { id: "d", settledOverride: "settled" as const },
    ];

    const { active, settled } = partitionSettledThreads(threads);

    expect(active.map((thread) => thread.id)).toEqual(["a", "c"]);
    expect(settled.map((thread) => thread.id)).toEqual(["b", "d"]);
  });
});

describe("buildSubagentTree", () => {
  const thread = (id: string, parent: string | null = null, env = "e") =>
    ({
      id,
      environmentId: env,
      lineage: {
        relationshipToParent: parent === null ? null : "subagent",
        parentThreadId: parent,
      },
    }) as never as Parameters<typeof buildSubagentTree>[0][number];
  const ids = (list: readonly { id: string }[] | undefined) => (list ?? []).map((t) => t.id);

  it("keeps subagents out of the roots and groups them under their parent in order", () => {
    const { roots, childrenByParentKey } = buildSubagentTree([
      thread("a"),
      thread("a1", "a"),
      thread("b"),
      thread("a2", "a"),
    ]);
    expect(ids(roots)).toEqual(["a", "b"]);
    expect(ids(childrenByParentKey.get("e:a"))).toEqual(["a1", "a2"]);
    expect(childrenByParentKey.has("e:b")).toBe(false);
  });

  it("drops subagents whose parent is not in the list, and parent cycles", () => {
    const { roots, childrenByParentKey } = buildSubagentTree([
      thread("a"),
      thread("orphan", "gone"),
      thread("x", "y"),
      thread("y", "x"),
    ]);
    expect(ids(roots)).toEqual(["a"]);
    expect(childrenByParentKey.size).toBe(0);
  });

  it("scopes parents by environment", () => {
    const { childrenByParentKey } = buildSubagentTree([
      thread("a", null, "e1"),
      thread("c", "a", "e2"),
    ]);
    expect(childrenByParentKey.size).toBe(0);
  });

  it("nests recursively and lists levels past the depth cap beside the deepest level", () => {
    const threads = [
      thread("a"),
      thread("b", "a"),
      thread("c", "b"),
      thread("d", "c"),
      thread("e", "d"),
    ];
    const { childrenByParentKey } = buildSubagentTree(threads, 2);
    expect(ids(childrenByParentKey.get("e:a"))).toEqual(["b"]);
    expect(ids(childrenByParentKey.get("e:b"))).toEqual(["c", "d", "e"]);
    expect(childrenByParentKey.has("e:c")).toBe(false);
  });
});
