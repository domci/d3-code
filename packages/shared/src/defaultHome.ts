/**
 * Default data folder ("T3 home"): `~/.d3`, or `~/.t3` for an install that
 * has not been moved yet. After the move `~/.t3` is a symlink to `~/.d3`, so
 * `~/.d3` is checked first. An explicit `T3CODE_HOME` / `--base-dir` never
 * reaches this helper. Every default-home derivation routes through here.
 */
// @effect-diagnostics nodeBuiltinImport:off - the default home is chosen before any Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function resolveDefaultHome(
  homeDirectory: string,
  exists: (path: string) => boolean = NodeFS.existsSync,
): string {
  const d3 = NodePath.join(homeDirectory, ".d3");
  if (exists(d3)) return d3;
  const t3 = NodePath.join(homeDirectory, ".t3");
  return exists(t3) ? t3 : d3;
}
