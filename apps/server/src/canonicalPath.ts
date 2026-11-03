// @effect-diagnostics nodeBuiltinImport:off - identity of a location must follow symlinks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * The real location of `target`, existing or not (deepest existing ancestor resolved, rest appended).
 * Paths stored before `~/.t3` became `~/.d3` go through a symlink, so comparisons, containment checks
 * and map keys must use this form; git and fs operations keep the stored form.
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
