import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  planPinnedReorder,
  sortActiveThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";

import { sortThreads } from "../lib/threadSort";
import type { SidebarThreadSummary } from "../types";

/** Stable split of an already-ordered thread list into active and settled threads. */
export function partitionSettledThreads<T extends Pick<SidebarThreadSummary, "settledOverride">>(
  threads: readonly T[],
): { readonly active: T[]; readonly settled: T[] } {
  const active: T[] = [];
  const settled: T[] = [];
  for (const thread of threads) {
    (thread.settledOverride === "settled" ? settled : active).push(thread);
  }
  return { active, settled };
}

/** Deepest level of subagent nesting the tree sidebar indents; deeper ones list beside it. */
export const MAX_SUBAGENT_TREE_DEPTH = 3;

type SubagentTreeThread = Pick<
  SidebarThreadSummary,
  "id" | "environmentId" | "lineage" | "settledOverride"
>;

const subagentTreeKey = (thread: Pick<SidebarThreadSummary, "id" | "environmentId">) =>
  `${thread.environmentId}:${thread.id}`;

/**
 * Attaches subagent threads under their parent. `roots` are the non-subagent threads in the
 * incoming order; `childrenByParentKey` maps `${environmentId}:${threadId}` to that thread's
 * children in incoming order. Subagents whose parent is not in `threads` are dropped.
 * A fork nests under its source the same way, but only when the source is in `threads`, is not
 * a subagent (those fold away or drop, and a fork is a full session that must stay listed) and is
 * on the same side of the active/settled split; otherwise it stays a root (shown with a fork mark).
 * Nesting beyond `maxDepth` levels is listed beside the deepest level instead of going deeper.
 */
export function buildSubagentTree<T extends SubagentTreeThread>(
  threads: readonly T[],
  maxDepth: number = MAX_SUBAGENT_TREE_DEPTH,
): { readonly roots: T[]; readonly childrenByParentKey: ReadonlyMap<string, readonly T[]> } {
  const roots: T[] = [];
  const rawChildren = new Map<string, T[]>();
  const byKey = new Map(threads.map((thread) => [subagentTreeKey(thread), thread]));
  for (const thread of threads) {
    const relationship = thread.lineage.relationshipToParent;
    const parentId = thread.lineage.parentThreadId;
    const parentKey = `${thread.environmentId}:${parentId}`;
    if (relationship === "fork") {
      const source = parentId === null || parentId === undefined ? undefined : byKey.get(parentKey);
      if (
        !source ||
        source.lineage.relationshipToParent === "subagent" ||
        (source.settledOverride === "settled") !== (thread.settledOverride === "settled")
      ) {
        roots.push(thread);
        continue;
      }
    } else if (relationship === "subagent") {
      if (parentId === null || parentId === undefined) continue;
    } else {
      roots.push(thread);
      continue;
    }
    const siblings = rawChildren.get(parentKey);
    if (siblings) siblings.push(thread);
    else rawChildren.set(parentKey, [thread]);
  }
  const childrenByParentKey = new Map<string, T[]>();
  // Walking from the roots also drops parent cycles, which no root reaches.
  const visit = (key: string, depth: number, inheritedHost: string) => {
    const host = depth < maxDepth ? key : inheritedHost;
    for (const child of rawChildren.get(key) ?? []) {
      const list = childrenByParentKey.get(host);
      if (list) list.push(child);
      else childrenByParentKey.set(host, [child]);
      visit(subagentTreeKey(child), depth + 1, host);
    }
  };
  for (const root of roots) {
    const key = subagentTreeKey(root);
    visit(key, 0, key);
  }
  return { roots, childrenByParentKey };
}

/**
 * Splits one parent's children into the render groups, in display order: running subagents,
 * forks (oldest first; always visible, never counted as subagents), finished subagents.
 */
export function groupThreadChildren<T extends SubagentTreeThread & { readonly createdAt: string }>(
  children: readonly T[],
  isRunning: (child: T) => boolean,
): { readonly running: T[]; readonly forks: T[]; readonly finished: T[] } {
  const isFork = (child: T) => child.lineage.relationshipToParent === "fork";
  return {
    running: children.filter((child) => !isFork(child) && isRunning(child)),
    forks: children
      .filter(isFork)
      .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
    finished: children.filter((child) => !isFork(child) && !isRunning(child)),
  };
}

/**
 * The threads that have a row under `roots`, top to bottom as rendered: each thread, then its
 * running subagents, its forks, and its finished subagents when `isFinishedOpen(parentKey)`.
 */
export function listThreadRows<T extends SubagentTreeThread & { readonly createdAt: string }>(
  roots: readonly T[],
  childrenByParentKey: ReadonlyMap<string, readonly T[]>,
  isRunning: (child: T) => boolean,
  isFinishedOpen: (parentKey: string) => boolean,
): T[] {
  const rows: T[] = [];
  const visit = (thread: T) => {
    rows.push(thread);
    const key = subagentTreeKey(thread);
    const { running, forks, finished } = groupThreadChildren(
      childrenByParentKey.get(key) ?? [],
      isRunning,
    );
    for (const child of running) visit(child);
    for (const child of forks) visit(child);
    if (isFinishedOpen(key)) for (const child of finished) visit(child);
  };
  for (const root of roots) visit(root);
  return rows;
}

/**
 * What has to open for the row of `threadKey` to be on screen: the Settled group and the
 * finished-subagent folds (parent keys) above it. Null when the thread has no row here.
 * Used to reveal a thread once when it is navigated to; the user's toggles win afterwards.
 */
export function resolveThreadReveal<T extends SubagentTreeThread>(
  tree: {
    readonly active: readonly T[];
    readonly settled: readonly T[];
    readonly childrenByParentKey: ReadonlyMap<string, readonly T[]>;
  },
  isRunning: (child: T) => boolean,
  threadKey: string,
): { readonly settled: boolean; readonly foldedParentKeys: string[] } | null {
  const find = (thread: T, folds: string[]): string[] | null => {
    const key = subagentTreeKey(thread);
    if (key === threadKey) return folds;
    for (const child of tree.childrenByParentKey.get(key) ?? []) {
      const folded = child.lineage.relationshipToParent !== "fork" && !isRunning(child);
      const found = find(child, folded ? [...folds, key] : folds);
      if (found) return found;
    }
    return null;
  };
  for (const settled of [false, true]) {
    for (const root of settled ? tree.settled : tree.active) {
      const foldedParentKeys = find(root, []);
      if (foldedParentKeys) return { settled, foldedParentKeys };
    }
  }
  return null;
}

/** Tooltip for a parent row's subagent expander, e.g. "2 working · 3 finished". */
export function describeSubagentCounts(running: number, finished: number): string {
  return [running > 0 ? `${running} working` : null, finished > 0 ? `${finished} finished` : null]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * One project's rows for the tree sidebar. Timestamp modes sort everything by the chosen
 * timestamp. "manual" keeps creation order for settled threads and subagents (nothing
 * reshuffles on activity) and arranges the active top-level threads by their persisted
 * `activeOrderKey`; keyless (new or reopened) threads lead, newest first.
 */
export function buildProjectThreadOrder<T extends SidebarThreadSummary>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): {
  readonly roots: T[];
  readonly active: T[];
  readonly settled: T[];
  readonly childrenByParentKey: ReadonlyMap<string, readonly T[]>;
} {
  const { roots, childrenByParentKey } = buildSubagentTree(sortThreads(threads, sortOrder));
  const { active, settled } = partitionSettledThreads(roots);
  return {
    roots,
    active: sortOrder === "manual" ? sortActiveThreadsByOrderKey(active) : active,
    settled,
    childrenByParentKey,
  };
}

/**
 * Order-key writes for dragging `movedKey` onto the row of `overKey` within one project's
 * active list (`${environmentId}:${threadId}` keys). Usually one write; a keyless neighbour
 * materializes keys for the whole list once. Empty when nothing needs to change.
 */
export function planActiveThreadMove<
  T extends Pick<SidebarThreadSummary, "id" | "environmentId" | "activeOrderKey">,
>(
  activeThreads: readonly T[],
  movedKey: string,
  overKey: string,
): Array<{ readonly thread: T; readonly orderKey: string }> {
  const keys = activeThreads.map(subagentTreeKey);
  const from = keys.indexOf(movedKey);
  const to = keys.indexOf(overKey);
  if (from === -1 || to === -1 || from === to) return [];
  const orderedIds = [...keys];
  orderedIds.splice(from, 1);
  orderedIds.splice(to, 0, movedKey);
  const keysById = new Map(activeThreads.map((t) => [subagentTreeKey(t), t.activeOrderKey]));
  const byKey = new Map(activeThreads.map((t) => [subagentTreeKey(t), t]));
  return planPinnedReorder({ orderedIds, keysById, movedId: movedKey }).map(({ id, orderKey }) => ({
    thread: byKey.get(id)!,
    orderKey,
  }));
}

/**
 * Oldest-created first. Fed to the manual project order so projects without a stored
 * position (new ones, or ones from another device) append in a fixed order instead of
 * the order the server happens to list them in.
 */
export function sortProjectsByCreation<T extends { readonly createdAt: string }>(
  projects: readonly T[],
): T[] {
  return projects
    .map((project) => ({ project, ms: Date.parse(project.createdAt) || 0 }))
    .sort((left, right) => left.ms - right.ms)
    .map(({ project }) => project);
}
