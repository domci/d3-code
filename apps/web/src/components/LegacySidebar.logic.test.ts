import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectThreadOrder,
  buildSubagentTree,
  describeSubagentCounts,
  partitionSettledThreads,
  planActiveThreadMove,
  sortProjectsByCreation,
} from "./LegacySidebar.logic";

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

describe("describeSubagentCounts", () => {
  it("omits zero parts", () => {
    expect(describeSubagentCounts(2, 3)).toBe("2 working · 3 finished");
    expect(describeSubagentCounts(0, 3)).toBe("3 finished");
    expect(describeSubagentCounts(1, 0)).toBe("1 working");
  });
});

describe("manual session order", () => {
  const make = (
    id: string,
    createdAt: string,
    extra: Record<string, unknown> = {},
  ): Parameters<typeof buildProjectThreadOrder>[0][number] =>
    ({
      id,
      environmentId: "e",
      createdAt,
      updatedAt: createdAt,
      unsettledAt: null,
      activeOrderKey: null,
      settledOverride: null,
      lineage: { relationshipToParent: null, parentThreadId: null },
      ...extra,
    }) as never;
  const ids = (list: readonly { id: string }[]) => list.map((t) => t.id);

  it("orders keyless threads newest-created first", () => {
    const { active } = buildProjectThreadOrder(
      [make("a", "2026-01-01T00:00:00Z"), make("b", "2026-01-03T00:00:00Z")],
      "manual",
    );
    expect(ids(active)).toEqual(["b", "a"]);
  });

  it("puts keyed threads by key with new keyless threads on top", () => {
    const { active } = buildProjectThreadOrder(
      [
        make("a", "2026-01-01T00:00:00Z", { activeOrderKey: "n" }),
        make("b", "2026-01-02T00:00:00Z", { activeOrderKey: "d" }),
        make("c", "2026-01-03T00:00:00Z"),
      ],
      "manual",
    );
    expect(ids(active)).toEqual(["c", "b", "a"]);
  });

  it("does not move when updatedAt changes", () => {
    const base = [
      make("a", "2026-01-01T00:00:00Z", { activeOrderKey: "d" }),
      make("b", "2026-01-02T00:00:00Z", { activeOrderKey: "n" }),
    ];
    const before = ids(buildProjectThreadOrder(base, "manual").active);
    const bumped = base.map((t, i) => ({ ...t, updatedAt: `2027-01-0${i + 1}T00:00:00Z` }));
    expect(ids(buildProjectThreadOrder(bumped, "manual").active)).toEqual(before);
  });

  it("returns an un-settled thread to its key position, or the top without a key", () => {
    const threads = (override: "settled" | null) => [
      make("a", "2026-01-01T00:00:00Z", { activeOrderKey: "d" }),
      make("b", "2026-01-02T00:00:00Z", { activeOrderKey: "n", settledOverride: override }),
      make("c", "2026-01-03T00:00:00Z", { activeOrderKey: "t" }),
    ];
    expect(ids(buildProjectThreadOrder(threads("settled"), "manual").active)).toEqual(["a", "c"]);
    expect(ids(buildProjectThreadOrder(threads(null), "manual").active)).toEqual(["a", "b", "c"]);
    const keyless = [
      make("a", "2026-01-01T00:00:00Z", { activeOrderKey: "d" }),
      make("z", "2025-01-01T00:00:00Z"),
    ];
    expect(ids(buildProjectThreadOrder(keyless, "manual").active)).toEqual(["z", "a"]);
  });

  it("keeps settled threads in creation order and subagents under their parent", () => {
    const { active, settled, childrenByParentKey } = buildProjectThreadOrder(
      [
        make("s1", "2026-01-01T00:00:00Z", { settledOverride: "settled" }),
        make("s2", "2026-01-02T00:00:00Z", { settledOverride: "settled" }),
        make("p", "2026-01-03T00:00:00Z", { activeOrderKey: "m" }),
        make("c", "2026-01-04T00:00:00Z", {
          lineage: { relationshipToParent: "subagent", parentThreadId: "p" },
        }),
      ],
      "manual",
    );
    expect(ids(active)).toEqual(["p"]);
    expect(ids(settled)).toEqual(["s2", "s1"]);
    expect(ids([...(childrenByParentKey.get("e:p") ?? [])])).toEqual(["c"]);
  });

  describe("planActiveThreadMove", () => {
    const keyed = [
      make("a", "2026-01-01T00:00:00Z", { activeOrderKey: "d" }),
      make("b", "2026-01-02T00:00:00Z", { activeOrderKey: "h" }),
      make("c", "2026-01-03T00:00:00Z", { activeOrderKey: "p" }),
    ] as never as Parameters<typeof planActiveThreadMove>[0];
    const move = (from: string, to: string) =>
      planActiveThreadMove(keyed, `e:${from}`, `e:${to}`).map((w) => [w.thread.id, w.orderKey]);

    it("writes one key between the new neighbours", () => {
      const [[id, key]] = move("c", "b") as [[string, string]];
      expect(id).toBe("c");
      expect(key > "d" && key < "h").toBe(true);
    });

    it("moves to the top and to the bottom with one write", () => {
      const [[topId, topKey]] = move("c", "a") as [[string, string]];
      expect(topId).toBe("c");
      expect(topKey < "d").toBe(true);
      const [[botId, botKey]] = move("a", "c") as [[string, string]];
      expect(botId).toBe("a");
      expect(botKey > "p").toBe(true);
    });

    it("materializes keys for everyone when a neighbour has none", () => {
      const mixed = [
        make("a", "2026-01-03T00:00:00Z"),
        make("b", "2026-01-02T00:00:00Z", { activeOrderKey: "h" }),
        make("c", "2026-01-01T00:00:00Z"),
      ] as never as Parameters<typeof planActiveThreadMove>[0];
      const writes = planActiveThreadMove(mixed, "e:c", "e:a");
      expect(writes.map((w) => w.thread.id)).toEqual(["c", "a", "b"]);
      expect(new Set(writes.map((w) => w.orderKey)).size).toBe(3);
      expect(writes.map((w) => w.orderKey).sort()).toEqual(writes.map((w) => w.orderKey));
    });

    it("is a no-op for the same row or unknown keys", () => {
      expect(move("a", "a")).toEqual([]);
      expect(move("a", "zzz")).toEqual([]);
    });
  });
});

describe("sortProjectsByCreation", () => {
  it("orders oldest first and is stable on ties", () => {
    const list = [
      { id: "b", createdAt: "2026-02-01T00:00:00Z" },
      { id: "a", createdAt: "2026-01-01T00:00:00Z" },
      { id: "c", createdAt: "2026-02-01T00:00:00Z" },
    ];
    expect(sortProjectsByCreation(list).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});
