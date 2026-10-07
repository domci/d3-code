import { describe, expect, it } from "vite-plus/test";

import { partitionSettledThreads } from "./LegacySidebar.logic";

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
