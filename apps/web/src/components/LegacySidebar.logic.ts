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
