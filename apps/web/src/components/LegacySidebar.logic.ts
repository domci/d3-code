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
