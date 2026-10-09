import type * as Path from "effect/Path";

import { temporaryWorktreeToken } from "@t3tools/shared/git";

import { expandHomePathWith } from "./pathExpansion.ts";

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting, or `defaultDir` (`<T3 home>/worktrees`) when it is empty. Null when
 * the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a
 * filesystem root, which would make every path on that drive look managed.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePathWith(setting, path);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

/** Every directory that holds T3-managed worktrees on this machine. */
export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}

/**
 * `<parentDir>/<id>/<repo>`. The last segment is the repository directory name
 * so vendor apps that group sessions by working-directory leaf (Codex) file D3
 * worktrees under the right project. `<id>` is the temporary branch's 8-hex
 * token, else the sanitized branch name; `suffix` disambiguates a collision.
 * Worktrees created before this layout live at `<repo>/<branch>`; everything
 * that recognises managed worktrees checks containment, so both work.
 */
export function buildWorktreePath(
  parentDir: string,
  repoName: string,
  branch: string,
  path: Path.Path,
  suffix?: string,
): string {
  const id = temporaryWorktreeToken(branch) ?? branch.replace(/\//g, "-");
  return path.join(parentDir, suffix ? `${id}-${suffix}` : id, repoName);
}
