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

type SubagentTreeThread = Pick<SidebarThreadSummary, "id" | "environmentId" | "lineage">;

const subagentTreeKey = (thread: Pick<SidebarThreadSummary, "id" | "environmentId">) =>
  `${thread.environmentId}:${thread.id}`;

/**
 * Attaches subagent threads under their parent. `roots` are the non-subagent threads in the
 * incoming order; `childrenByParentKey` maps `${environmentId}:${threadId}` to that thread's
 * subagent children in incoming order. Subagents whose parent is not in `threads` are dropped.
 * Nesting beyond `maxDepth` levels is listed beside the deepest level instead of going deeper.
 */
export function buildSubagentTree<T extends SubagentTreeThread>(
  threads: readonly T[],
  maxDepth: number = MAX_SUBAGENT_TREE_DEPTH,
): { readonly roots: T[]; readonly childrenByParentKey: ReadonlyMap<string, readonly T[]> } {
  const roots: T[] = [];
  const rawChildren = new Map<string, T[]>();
  for (const thread of threads) {
    if (thread.lineage.relationshipToParent !== "subagent") {
      roots.push(thread);
      continue;
    }
    const parentId = thread.lineage.parentThreadId;
    if (parentId === null || parentId === undefined) continue;
    const parentKey = `${thread.environmentId}:${parentId}`;
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
