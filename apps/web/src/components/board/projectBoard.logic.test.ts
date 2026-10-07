import type { ProjectBoardItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_BOARD_FILTERS,
  collectBoardFacets,
  filterBoardItems,
  dedupeBoardRepositories,
  mergeBoardColumns,
  repositoryAccent,
  resolveDropTarget,
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

const board = { columns, statusFieldId: "field" };

describe("mergeBoardColumns", () => {
  it("orders columns as GitHub does and ends with No status, which also holds orphaned options", () => {
    const merged = mergeBoardColumns([{ repoKey: "r", board, items }]);
    expect(merged.map((column) => column.name)).toEqual(["Todo", "Done", "No status"]);
    expect(merged.map((column) => column.items.map((entry) => entry.itemId))).toEqual([
      ["b"],
      ["a"],
      ["c", "d"],
    ]);
  });

  it("merges boards by status name, case-insensitively, in first-seen order", () => {
    const other = {
      statusFieldId: "f2",
      columns: [
        { optionId: "x1", name: " done ", color: null },
        { optionId: "x2", name: "Review", color: null },
      ],
    };
    const merged = mergeBoardColumns([
      { repoKey: "r", board, items: [items[0]!] },
      { repoKey: "o", board: other, items: [item({ itemId: "z", statusOptionId: "x1" })] },
    ]);
    expect(merged.map((column) => column.name)).toEqual(["Todo", "Done", "Review", "No status"]);
    expect(merged[1]?.items.map((entry) => [entry.itemId, entry.repoKey])).toEqual([
      ["a", "r"],
      ["z", "o"],
    ]);
  });

  it("puts everything of a project without a Status field under No status", () => {
    const merged = mergeBoardColumns([
      { repoKey: "r", board: { columns: [], statusFieldId: null }, items },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.items).toHaveLength(4);
  });
});

describe("resolveDropTarget", () => {
  const done = mergeBoardColumns([{ repoKey: "r", board, items: [] }])[1]!.key;
  it("finds the option of the card's own project by name, or clears for No status", () => {
    expect(resolveDropTarget(board, done)).toEqual({ fieldId: "field", optionId: "done" });
    expect(resolveDropTarget(board, "none")).toEqual({ fieldId: "field", optionId: null });
  });
  it("refuses a column the project has no option for, or a project without Status", () => {
    expect(resolveDropTarget(board, "status:review")).toBeNull();
    expect(resolveDropTarget({ columns: [], statusFieldId: null }, done)).toBeNull();
  });
});

describe("dedupeBoardRepositories", () => {
  const project = (id: string, root: string, key: string, provider = "github") => ({
    id,
    workspaceRoot: root,
    repositoryIdentity: { provider, canonicalKey: key, owner: "Acme", name: "Web" },
  });
  it("keeps one project per repository, preferring a non-temporary checkout", () => {
    const repos = dedupeBoardRepositories([
      project("a", "/home/u/.t3/worktrees/web", "github.com/acme/web"),
      project("b", "/home/u/code/web", "GitHub.com/Acme/Web"),
      project("c", "/home/u/code/web2", "github.com/acme/web"),
      project("d", "/home/u/code/lab", "gitlab.com/acme/lab", "gitlab"),
    ]);
    expect(repos.map((repo) => [repo.label, repo.project.id])).toEqual([["Acme/Web", "b"]]);
  });
  it("prefers a real checkout over agent checkouts", () => {
    const repos = dedupeBoardRepositories([
      project(
        "a",
        "/srv/dc-team/state/checkouts/t_6ffc96f9/723ad96f7ece1cde68b9686eefd399a207f185236253abc6ba74c0cccbbea2e2",
        "github.com/frub-ai/frub-ai",
      ),
      project("b", "/home/dom/repos/frub-ai", "github.com/frub-ai/frub-ai"),
    ]);
    expect(repos[0]?.project.workspaceRoot).toBe("/home/dom/repos/frub-ai");
  });
  it("keeps the first of equals", () => {
    const repos = dedupeBoardRepositories([
      project("a", "/code/a", "github.com/acme/web"),
      project("b", "/code/b", "github.com/acme/web"),
    ]);
    expect(repos[0]?.project.id).toBe("a");
  });
});

describe("repositoryAccent", () => {
  it("is stable and case-insensitive", () => {
    expect(repositoryAccent("Acme/Web")).toBe(repositoryAccent("acme/web"));
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
