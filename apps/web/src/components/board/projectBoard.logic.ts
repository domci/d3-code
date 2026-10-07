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

/** A card with the repository it came from. */
export type BoardCardItem = ProjectBoardItem & { readonly repoKey: string };

export interface BoardColumnView {
  /** `NO_STATUS_KEY`, or the normalised Status name shared by the merged boards. */
  readonly key: string;
  readonly name: string;
  readonly color: string | null;
  readonly items: ReadonlyArray<BoardCardItem>;
}

export const NO_STATUS_KEY = "none";

/**
 * Closed and merged cards are "closed". A draft item has no state and is still to do, so it
 * counts as open.
 */
function matchesState(item: ProjectBoardItem, state: BoardStateFilter): boolean {
  if (state === "all") return true;
  const closed = item.state === "closed" || item.state === "merged";
  return state === "closed" ? closed : !closed;
}

export function filterBoardItems<Item extends ProjectBoardItem>(
  items: ReadonlyArray<Item>,
  filters: BoardFilters,
): ReadonlyArray<Item> {
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

const statusKey = (name: string) => `status:${name.trim().toLowerCase()}`;

/**
 * The Status options of all boards merged by name (trimmed, case-insensitive), in order of first
 * appearance, then "No status". A card sits in the column named like its own status; one whose
 * option was deleted on GitHub, or whose project has no Status field, sits under "No status".
 */
export function mergeBoardColumns(
  boards: ReadonlyArray<{
    readonly repoKey: string;
    readonly board: Pick<ProjectBoard, "columns" | "statusFieldId">;
    readonly items: ReadonlyArray<ProjectBoardItem>;
  }>,
): ReadonlyArray<BoardColumnView> {
  const columns = new Map<string, { name: string; color: string | null; items: BoardCardItem[] }>();
  const none: BoardCardItem[] = [];
  for (const { board } of boards) {
    if (board.statusFieldId === null) continue;
    for (const column of board.columns) {
      const key = statusKey(column.name);
      if (!columns.has(key)) {
        columns.set(key, { name: column.name.trim(), color: column.color, items: [] });
      }
    }
  }
  for (const { repoKey, board, items } of boards) {
    const names = new Map(board.columns.map((column) => [column.optionId, column.name]));
    for (const item of items) {
      const name = board.statusFieldId === null ? undefined : names.get(item.statusOptionId ?? "");
      const target = name === undefined ? undefined : columns.get(statusKey(name));
      (target?.items ?? none).push({ ...item, repoKey });
    }
  }
  return [
    ...[...columns].map(([key, column]) => ({ key, ...column })),
    { key: NO_STATUS_KEY, name: "No status", color: null, items: none },
  ];
}

/**
 * What dropping a card on a column sets in the card's own GitHub project, or null when that
 * project cannot take it (no Status field, or no option with the column's name).
 */
export function resolveDropTarget(
  board: Pick<ProjectBoard, "columns" | "statusFieldId">,
  columnKey: string,
): { readonly fieldId: string; readonly optionId: string | null } | null {
  if (board.statusFieldId === null) return null;
  if (columnKey === NO_STATUS_KEY) return { fieldId: board.statusFieldId, optionId: null };
  const option = board.columns.find((column) => statusKey(column.name) === columnKey);
  return option === undefined ? null : { fieldId: board.statusFieldId, optionId: option.optionId };
}

/** What "Start thread" puts in the new draft's composer. A draft item has no link to give. */
export function startThreadPrompt(item: Pick<ProjectBoardItem, "title" | "url">): string {
  return item.url === null
    ? `Work on this GitHub issue:\n\n${item.title}`
    : `Work on this GitHub issue:\n\n${item.title}\n${item.url}`;
}

export const BOARD_REPOSITORIES_KEY = "t3code:project-board:repositories";

export interface BoardRepository<Project> {
  /** Lower-cased host/owner/name. */
  readonly key: string;
  /** `owner/name` */
  readonly label: string;
  /** The T3 project that stands for the repository. */
  readonly project: Project;
}

/** `owner/name` of a repository identity. */
export function repositoryLabel(identity: {
  readonly canonicalKey: string;
  readonly owner?: string | undefined;
  readonly name?: string | undefined;
}): string {
  return identity.owner !== undefined && identity.name !== undefined
    ? `${identity.owner}/${identity.name}`
    : identity.canonicalKey.split("/").slice(-2).join("/");
}

/** Dot-directories, temp directories, agent checkouts and hash-named folders are throwaway copies. */
const looksTemporary = (root: string) =>
  /(^|[\\/])\.[^\\/]|[\\/]te?mp[\\/]/i.test(root) ||
  /[\\/](checkouts|worktrees)([\\/]|$)/i.test(root) ||
  /^[0-9a-f]{16,}$/i.test(root.split(/[\\/]/).findLast(Boolean) ?? "");

/**
 * One entry per GitHub repository, in project order. Among several T3 projects for one repository
 * the first whose workspace root does not look temporary stands for it, else the first.
 */
export function dedupeBoardRepositories<
  Project extends {
    readonly workspaceRoot: string;
    readonly repositoryIdentity?:
      | {
          readonly provider?: string | undefined;
          readonly canonicalKey: string;
          readonly owner?: string | undefined;
          readonly name?: string | undefined;
        }
      | null
      | undefined;
  },
>(projects: ReadonlyArray<Project>): ReadonlyArray<BoardRepository<Project>> {
  const repositories = new Map<string, BoardRepository<Project>>();
  for (const project of projects) {
    const identity = project.repositoryIdentity;
    if (identity?.provider !== "github") continue;
    const key = identity.canonicalKey.toLowerCase();
    const known = repositories.get(key);
    if (
      known !== undefined &&
      !(looksTemporary(known.project.workspaceRoot) && !looksTemporary(project.workspaceRoot))
    ) {
      continue;
    }
    repositories.set(key, { key, label: repositoryLabel(identity), project });
  }
  return [...repositories.values()];
}

/** Fixed accent palette; the literals are spelled out so Tailwind keeps them. */
const REPOSITORY_ACCENTS = [
  { dot: "bg-red-500", border: "border-l-red-500" },
  { dot: "bg-orange-500", border: "border-l-orange-500" },
  { dot: "bg-amber-500", border: "border-l-amber-500" },
  { dot: "bg-lime-500", border: "border-l-lime-500" },
  { dot: "bg-emerald-500", border: "border-l-emerald-500" },
  { dot: "bg-cyan-500", border: "border-l-cyan-500" },
  { dot: "bg-blue-500", border: "border-l-blue-500" },
  { dot: "bg-violet-500", border: "border-l-violet-500" },
  { dot: "bg-pink-500", border: "border-l-pink-500" },
] as const;

/** A stable accent per `owner/name`. */
export function repositoryAccent(label: string): (typeof REPOSITORY_ACCENTS)[number] {
  let hash = 0;
  for (const char of label.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return REPOSITORY_ACCENTS[hash % REPOSITORY_ACCENTS.length]!;
}
