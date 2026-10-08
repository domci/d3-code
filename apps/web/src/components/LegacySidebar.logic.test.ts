import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectThreadOrder,
  buildSubagentTree,
  groupThreadChildren,
  describeSubagentCounts,
  listThreadRows,
  partitionSettledThreads,
  planActiveThreadMove,
  resolveThreadReveal,
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
  const thread = (
    id: string,
    parent: string | null = null,
    env = "e",
    kind: "subagent" | "fork" = "subagent",
    settled = false,
  ) =>
    ({
      id,
      environmentId: env,
      settledOverride: settled ? "settled" : null,
      lineage: {
        relationshipToParent: parent === null ? null : kind,
        parentThreadId: parent,
      },
    }) as never as Parameters<typeof buildSubagentTree>[0][number];
  const fork = (id: string, parent: string, settled = false) =>
    thread(id, parent, "e", "fork", settled);
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

  it("nests a fork under an active source and keeps it out of the roots", () => {
    const { roots, childrenByParentKey } = buildSubagentTree([
      thread("a"),
      fork("f", "a"),
      thread("a1", "a"),
    ]);
    expect(ids(roots)).toEqual(["a"]);
    expect(ids(childrenByParentKey.get("e:a"))).toEqual(["f", "a1"]);
  });

  it("shows a fork at top level when its source is on the other side of the settle split", () => {
    const { roots, childrenByParentKey } = buildSubagentTree([
      thread("a", null, "e", "subagent", true),
      fork("f", "a"),
      thread("b"),
      fork("g", "b", true),
    ]);
    expect(ids(roots)).toEqual(["a", "f", "b", "g"]);
    expect(childrenByParentKey.size).toBe(0);
  });

  it("nests forks of forks and nests a settled fork under a settled source", () => {
    const { roots, childrenByParentKey } = buildSubagentTree([
      thread("a", null, "e", "subagent", true),
      fork("f", "a", true),
      fork("g", "f", true),
    ]);
    expect(ids(roots)).toEqual(["a"]);
    expect(ids(childrenByParentKey.get("e:a"))).toEqual(["f"]);
    expect(ids(childrenByParentKey.get("e:f"))).toEqual(["g"]);
  });

  it("keeps a fork with a missing source as a root, unlike a subagent", () => {
    const { roots } = buildSubagentTree([fork("f", "gone"), thread("s", "gone")]);
    expect(ids(roots)).toEqual(["f"]);
  });

  it("keeps a fork of a subagent as a root, so it neither folds away nor drops with it", () => {
    const { roots, childrenByParentKey } = buildSubagentTree([
      thread("a"),
      thread("s", "a"),
      fork("f", "s"),
      thread("orphan", "gone"),
      fork("g", "orphan"),
    ]);
    expect(ids(roots)).toEqual(["a", "f", "g"]);
    expect(childrenByParentKey.has("e:s")).toBe(false);
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

describe("groupThreadChildren", () => {
  const child = (id: string, relationship: string, createdAt: string) =>
    ({
      id,
      environmentId: "e",
      createdAt,
      settledOverride: null,
      lineage: { relationshipToParent: relationship, parentThreadId: "p" },
    }) as never as Parameters<typeof groupThreadChildren>[0][number];

  it("orders running subagents, forks oldest first, then finished; forks never count as subagents", () => {
    const { running, forks, finished } = groupThreadChildren(
      [
        child("done", "subagent", "2026-01-01"),
        child("f2", "fork", "2026-03-01"),
        child("busy", "subagent", "2026-01-02"),
        child("f1", "fork", "2026-02-01"),
      ],
      (c) => c.id === "busy" || c.id === "f2",
    );
    expect(running.map((c) => c.id)).toEqual(["busy"]);
    expect(forks.map((c) => c.id)).toEqual(["f1", "f2"]);
    expect(finished.map((c) => c.id)).toEqual(["done"]);
  });
});

describe("visible rows and reveal", () => {
  const row = (id: string, parent: string | null, relationship: string | null, at: string) =>
    ({
      id,
      environmentId: "e",
      createdAt: at,
      settledOverride: null,
      lineage: { relationshipToParent: relationship, parentThreadId: parent },
    }) as never as Parameters<typeof groupThreadChildren>[0][number];
  // a: busy + done subagents and a fork; done has its own finished subagent; z is settled.
  const a = row("a", null, null, "2026-01-01");
  const done = row("done", "a", "subagent", "2026-01-02");
  const deep = row("deep", "done", "subagent", "2026-01-03");
  const busy = row("busy", "a", "subagent", "2026-01-04");
  const f = row("f", "a", "fork", "2026-01-05");
  const z = row("z", null, null, "2026-01-06");
  const zDone = row("zDone", "z", "subagent", "2026-01-07");
  const childrenByParentKey = new Map([
    ["e:a", [done, busy, f]],
    ["e:done", [deep]],
    ["e:z", [zDone]],
  ]);
  const isRunning = (thread: { id: string }) => thread.id === "busy";
  const tree = { active: [a], settled: [z], childrenByParentKey };

  it("lists rows in render order and leaves out closed finished-subagent folds", () => {
    const rows = (open: readonly string[]) =>
      listThreadRows([a], childrenByParentKey, isRunning, (key) => open.includes(key)).map(
        (thread) => thread.id,
      );
    expect(rows([])).toEqual(["a", "busy", "f"]);
    expect(rows(["e:a"])).toEqual(["a", "busy", "f", "done"]);
    expect(rows(["e:a", "e:done"])).toEqual(["a", "busy", "f", "done", "deep"]);
  });

  it("opens only the folds above the thread, and nothing for rows that are already visible", () => {
    const reveal = (key: string) => resolveThreadReveal(tree, isRunning, key);
    expect(reveal("e:a")).toEqual({ settled: false, foldedParentKeys: [] });
    expect(reveal("e:busy")).toEqual({ settled: false, foldedParentKeys: [] });
    expect(reveal("e:f")).toEqual({ settled: false, foldedParentKeys: [] });
    expect(reveal("e:deep")).toEqual({ settled: false, foldedParentKeys: ["e:a", "e:done"] });
    expect(reveal("e:z")).toEqual({ settled: true, foldedParentKeys: [] });
    expect(reveal("e:zDone")).toEqual({ settled: true, foldedParentKeys: ["e:z"] });
    expect(reveal("e:elsewhere")).toBeNull();
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
