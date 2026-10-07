import type { ProjectBoard, ProjectBoardItem } from "@t3tools/contracts";

export type BoardStateFilter = "all" | "open" | "closed";

export interface BoardFilters {
  /** A label name present on the board, or null for every card. */
  readonly label: string | null;
  readonly state: BoardStateFilter;
  /** An assignee login present on the board, or null for every card. */
  readonly assignee: string | null;
}

export const NO_BOARD_FILTERS: BoardFilters = { label: null, state: "all", assignee: null };

export interface BoardColumnView {
  readonly key: string;
  /** The Status option a card dropped here takes; null clears the Status. */
  readonly optionId: string | null;
  readonly name: string;
  readonly color: string | null;
  readonly items: ReadonlyArray<ProjectBoardItem>;
}

/**
 * Closed and merged cards are "closed". A draft item has no state and is still to do, so it
 * counts as open.
 */
function matchesState(item: ProjectBoardItem, state: BoardStateFilter): boolean {
  if (state === "all") return true;
  const closed = item.state === "closed" || item.state === "merged";
  return state === "closed" ? closed : !closed;
}

export function filterBoardItems(
  items: ReadonlyArray<ProjectBoardItem>,
  filters: BoardFilters,
): ReadonlyArray<ProjectBoardItem> {
  return items.filter(
    (item) =>
      matchesState(item, filters.state) &&
      (filters.label === null || item.labels.some((label) => label.name === filters.label)) &&
      (filters.assignee === null ||
        item.assignees.some((assignee) => assignee.login === filters.assignee)),
  );
}

/** Every label and assignee on the board, sorted, for the filter menus. */
export function collectBoardFacets(items: ReadonlyArray<ProjectBoardItem>): {
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
} {
  const labels = new Set<string>();
  const assignees = new Set<string>();
  for (const item of items) {
    for (const label of item.labels) labels.add(label.name);
    for (const assignee of item.assignees) assignees.add(assignee.login);
  }
  const sorted = (values: Set<string>) => [...values].toSorted((a, b) => a.localeCompare(b));
  return { labels: sorted(labels), assignees: sorted(assignees) };
}

/**
 * One column per Status option in GitHub's order, then "No status". A card whose option no
 * longer exists (deleted on GitHub) is shown under "No status" too. Without a Status field
 * there is a single column of everything.
 */
export function groupBoardColumns(
  board: Pick<ProjectBoard, "columns" | "statusFieldId">,
  items: ReadonlyArray<ProjectBoardItem>,
): ReadonlyArray<BoardColumnView> {
  if (board.statusFieldId === null) {
    return [{ key: "all", optionId: null, name: "Items", color: null, items }];
  }
  const known = new Set(board.columns.map((column) => column.optionId));
  return [
    ...board.columns.map((column) => ({
      key: column.optionId,
      optionId: column.optionId,
      name: column.name,
      color: column.color,
      items: items.filter((item) => item.statusOptionId === column.optionId),
    })),
    {
      key: "none",
      optionId: null,
      name: "No status",
      color: null,
      items: items.filter(
        (item) => item.statusOptionId === null || !known.has(item.statusOptionId),
      ),
    },
  ];
}

/** The board with one card moved to another Status option, the way GitHub will have it. */
export function moveBoardItem(
  items: ReadonlyArray<ProjectBoardItem>,
  itemId: string,
  optionId: string | null,
): ReadonlyArray<ProjectBoardItem> {
  return items.map((item) =>
    item.itemId === itemId ? { ...item, statusOptionId: optionId } : item,
  );
}

/** What "Start thread" puts in the new draft's composer. A draft item has no link to give. */
export function startThreadPrompt(item: Pick<ProjectBoardItem, "title" | "url">): string {
  return item.url === null
    ? `Work on this GitHub issue:\n\n${item.title}`
    : `Work on this GitHub issue:\n\n${item.title}\n${item.url}`;
}

/** Where the chosen GitHub Project is remembered, per T3 project. */
export function projectBoardChoiceKey(environmentId: string, projectId: string): string {
  return `t3code:project-board:${environmentId}:${projectId}`;
}

/** The T3 projects whose repository is on GitHub, which is all a GitHub board can be read for. */
export function githubBoardProjects<
  Project extends {
    readonly repositoryIdentity?: { readonly provider?: string | undefined } | null | undefined;
  },
>(projects: ReadonlyArray<Project>): ReadonlyArray<Project> {
  return projects.filter((project) => project.repositoryIdentity?.provider === "github");
}
