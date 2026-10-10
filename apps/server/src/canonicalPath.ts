// @effect-diagnostics nodeBuiltinImport:off - identity of a location must follow symlinks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * The real location of `target`, whether or not it exists yet: the deepest
 * existing ancestor is resolved through symlinks and the rest is appended.
 * Paths stored before the data folder moved from `~/.t3` to `~/.d3` still go
 * through the `~/.t3` symlink, so any comparison, containment check, or map
 * key over such paths must use this form, never the stored string. Operations
 * on the location (git, fs) keep using the stored form.
 */
export function canonicalPath(target: string): string {
  const resolved = NodePath.resolve(target);
  try {
    return NodeFS.realpathSync(resolved);
  } catch {
    const parent = NodePath.dirname(resolved);
    return parent === resolved
      ? resolved
      : NodePath.join(canonicalPath(parent), NodePath.basename(resolved));
  }
}
