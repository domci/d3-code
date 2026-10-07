import type { ProjectBoardItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_BOARD_FILTERS,
  collectBoardFacets,
  filterBoardItems,
  groupBoardColumns,
  moveBoardItem,
  startThreadPrompt,
} from "./projectBoard.logic";

function item(overrides: Partial<ProjectBoardItem> & { itemId: string }): ProjectBoardItem {
  return {
    kind: "issue",
    number: 1,
    title: "Title",
    url: "https://github.com/acme/web/issues/1",
    state: "open",
    statusOptionId: null,
    labels: [],
    assignees: [],
    repository: "acme/web",
    ...overrides,
  };
}

const columns = [
  { optionId: "todo", name: "Todo", color: "GREEN" },
  { optionId: "done", name: "Done", color: "PURPLE" },
];

const items = [
  item({
    itemId: "a",
    statusOptionId: "done",
    state: "closed",
    labels: [{ name: "bug", color: "d73a4a" }],
    assignees: [{ login: "octocat", avatarUrl: "" }],
  }),
  item({ itemId: "b", statusOptionId: "todo", labels: [{ name: "docs", color: "0075ca" }] }),
  item({ itemId: "c", statusOptionId: null, state: "merged", kind: "pull_request" }),
  item({ itemId: "d", statusOptionId: "deleted-option", state: null, kind: "draft", url: null }),
];

describe("groupBoardColumns", () => {
  it("orders columns as GitHub does and ends with No status, which also holds orphaned options", () => {
    const grouped = groupBoardColumns({ columns, statusFieldId: "field" }, items);
    expect(grouped.map((column) => [column.name, column.optionId])).toEqual([
      ["Todo", "todo"],
      ["Done", "done"],
      ["No status", null],
    ]);
    expect(grouped.map((column) => column.items.map((entry) => entry.itemId))).toEqual([
      ["b"],
      ["a"],
      ["c", "d"],
    ]);
  });

  it("shows one column of everything when the project has no Status field", () => {
    const grouped = groupBoardColumns({ columns: [], statusFieldId: null }, items);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.items).toHaveLength(4);
  });
});

describe("filterBoardItems", () => {
  it("narrows by label, assignee and state together", () => {
    const ids = (filters: Parameters<typeof filterBoardItems>[1]) =>
      filterBoardItems(items, filters).map((entry) => entry.itemId);
    expect(ids(NO_BOARD_FILTERS)).toEqual(["a", "b", "c", "d"]);
    expect(ids({ ...NO_BOARD_FILTERS, label: "bug" })).toEqual(["a"]);
    expect(ids({ ...NO_BOARD_FILTERS, assignee: "octocat" })).toEqual(["a"]);
    // Merged counts as closed; a draft item has no state and counts as open.
    expect(ids({ ...NO_BOARD_FILTERS, state: "closed" })).toEqual(["a", "c"]);
    expect(ids({ ...NO_BOARD_FILTERS, state: "open" })).toEqual(["b", "d"]);
    expect(ids({ label: "bug", state: "open", assignee: null })).toEqual([]);
  });

  it("lists the labels and assignees present on the board", () => {
    expect(collectBoardFacets(items)).toEqual({ labels: ["bug", "docs"], assignees: ["octocat"] });
  });
});

describe("moveBoardItem", () => {
  it("changes only the moved card's Status", () => {
    const moved = moveBoardItem(items, "b", "done");
    expect(moved.map((entry) => entry.statusOptionId)).toEqual([
      "done",
      "done",
      null,
      "deleted-option",
    ]);
    expect(moveBoardItem(items, "a", null)[0]?.statusOptionId).toBeNull();
  });
});

describe("startThreadPrompt", () => {
  it("names the issue and its link, and only the title for a draft item", () => {
    expect(
      startThreadPrompt({ title: "Fix login", url: "https://github.com/acme/web/issues/1" }),
    ).toBe("Work on this GitHub issue:\n\nFix login\nhttps://github.com/acme/web/issues/1");
    expect(startThreadPrompt({ title: "Spike", url: null })).toBe(
      "Work on this GitHub issue:\n\nSpike",
    );
  });
});
