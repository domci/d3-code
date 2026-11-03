export const BOARD_REPOSITORIES_KEY = "t3code:project-board:repositories";

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
