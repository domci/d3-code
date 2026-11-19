#!/usr/bin/env python3
"""Mechanical steps of merging upstream T3 Code into the D3 fork.

  merge.py prepare   merge upstream/main (no commit), auto-resolve branding conflicts, renumber
                     migrations, brand new upstream copy, then list what still needs a human.
  merge.py i18n      after every conflict is resolved: rebuild the GT catalogs from upstream's
                     and carry each translation over to its re-branded key.

Run from the root of a merge worktree. See docs/operations/upstream-merge.md.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

UPSTREAM = os.environ.get("UPSTREAM_REF", "upstream/main")
# User-visible "T3 <Word>" is the fork's "D3 <Word>"; identifiers (t3 CLI, refs/t3, T3CODE_*) stay.
BRAND = re.compile(r"\bT3(?=[ -][A-Za-z])(?! Chat)|\bT3(?=Wordmark|CodeDev)")
# Where upstream's new copy gets branded. Release tooling, patches and packaging keep upstream names.
BRAND_SCOPE = re.compile(r"(apps/(server|web|mobile|desktop)/src|packages/[^/]+/src|docs/user)/")
# Upstream migration ids from here on are one higher in the fork (fork-only 059_ProjectThreadFolders).
MIGRATION_OFFSET_FROM, MIGRATION_OFFSET = 59, 1
FORK_MIGRATIONS = {"ProjectThreadFolders"}
MIGRATIONS_DIR = "apps/server/src/persistence/Migrations"
MIGRATIONS_TS = "apps/server/src/persistence/Migrations.ts"
I18N_APPS = ["web", "mobile", "desktop"]
TAKE_THEIRS = re.compile(r"(^pnpm-lock\.yaml$|routeTree\.gen\.ts$|/i18n/translations/[^/]+\.json$)")
TAKE_THEIRS_BRANDED = re.compile(r"\.ndjson$")


def git(*args, check=True, input=None):
    result = subprocess.run(["git", *args], capture_output=True, text=True, input=input, errors="replace")
    if check and result.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{result.stderr}")
    return result.stdout


def show(ref, path):
    result = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True, errors="replace")
    return result.stdout if result.returncode == 0 else None


def brand(text):
    return BRAND.sub("D3", text)


def write(path, text):
    with open(path, "w") as f:
        f.write(text)


def conflicted():
    return [p for p in git("diff", "--name-only", "--diff-filter=U").split("\n") if p]


def stages(path):
    return "".join(line.split()[2] for line in git("ls-files", "-u", "--", path).splitlines())


def resolve_conflicts():
    left = []
    with tempfile.TemporaryDirectory() as tmp:
        base, ours, theirs = (os.path.join(tmp, n) for n in ("base", "ours", "theirs"))
        for path in conflicted():
            if stages(path) != "123":
                left.append(f"{path} (one side deleted it: {stages(path)})")
                continue
            if TAKE_THEIRS.search(path) or TAKE_THEIRS_BRANDED.search(path):
                text = git("show", f":3:{path}")
                write(path, brand(text) if TAKE_THEIRS_BRANDED.search(path) else text)
                git("add", "--", path)
                continue
            write(base, brand(git("show", f":1:{path}")))
            write(ours, git("show", f":2:{path}"))
            write(theirs, brand(git("show", f":3:{path}")))
            merged = subprocess.run(["git", "merge-file", "-p", ours, base, theirs], capture_output=True, text=True)
            write(path, merged.stdout)
            if merged.returncode == 0:
                git("add", "--", path)
            else:
                left.append(f"{path} ({merged.returncode} conflict hunks)")
    return left


def migration_files():
    return sorted(f for f in os.listdir(MIGRATIONS_DIR) if re.match(r"^\d{3}_\w+(\.test)?\.ts$", f))


def renumber_migrations():
    upstream = set(git("ls-tree", "--name-only", f"{UPSTREAM}:{MIGRATIONS_DIR}").split())
    renamed = []
    for name in sorted(migration_files(), reverse=True):
        number, rest = int(name[:3]), name[4:]
        if number < MIGRATION_OFFSET_FROM or name not in upstream or rest.split(".")[0] in FORK_MIGRATIONS:
            continue
        target = f"{number + MIGRATION_OFFSET:03d}_{rest}"
        git("mv", f"{MIGRATIONS_DIR}/{name}", f"{MIGRATIONS_DIR}/{target}")
        renamed.append(target)
    for name in renamed:
        if name.endswith(".test.ts"):
            path = f"{MIGRATIONS_DIR}/{name}"
            text = open(path).read()
            text = re.sub(r'"\d{3}_(\w+)"', lambda m: f'"{name[:3]}_{m.group(1)}"' if m.group(1) == name[4:-8] else m.group(0), text)
            write(path, bump_inclusive(text))
    if not regenerate_manifest():
        renamed.append(f"!! {MIGRATIONS_TS} has non-migration conflicts; regenerate its migration lists by hand")
    return renamed


def bump_inclusive(text, only_lines=None):
    def bump(match):
        n = int(match.group(2))
        return match.group(1) + str(n + MIGRATION_OFFSET if n >= MIGRATION_OFFSET_FROM else n)

    if only_lines is None:
        return re.sub(r"(toMigrationInclusive:\s*)(\d+)", bump, text)
    return "\n".join(
        re.sub(r"(toMigrationInclusive:\s*)(\d+)", bump, line) if line in only_lines else line
        for line in text.split("\n")
    )


def regenerate_manifest():
    text = open(MIGRATIONS_TS).read()
    entries = [(int(f[:3]), f[4:-3], f) for f in migration_files() if not f.endswith(".test.ts")]
    entries = [e for e in entries if e[0] >= MIGRATION_OFFSET_FROM]
    lines = text.split("\n")
    is_import = re.compile(r'^import Migration(\d{4}) from "\./Migrations/')
    is_row = re.compile(r'^  \[(\d+), "\w+", Migration\d{4}\],$')
    is_marker = re.compile(r"^(<<<<<<<|=======|>>>>>>>)( |$)")
    blocks = re.findall(r"^<<<<<<< .*?^>>>>>>> [^\n]*$", text, re.S | re.M)
    for block in blocks:
        body = [l for l in block.split("\n") if l.strip() and not is_marker.match(l)]
        if not all(is_import.match(l) or is_row.match(l) for l in body):
            return False
    out, anchor_import, anchor_row = [], None, None
    for line in lines:
        m = is_import.match(line) or is_row.match(line)
        if m and int(m.group(1)) >= MIGRATION_OFFSET_FROM:
            continue
        if is_marker.match(line):
            continue  # only migration lines conflict here; they are all regenerated below
        out.append(line)
        if m and int(m.group(1)) == MIGRATION_OFFSET_FROM - 1:
            if is_import.match(line):
                anchor_import = len(out)
            else:
                anchor_row = len(out)
    rows = [f'  [{n}, "{name}", Migration{n:04d}],' for n, name, _ in entries]
    imports = [f'import Migration{n:04d} from "./Migrations/{f}";' for n, _, f in entries]
    out[anchor_row:anchor_row] = rows
    out[anchor_import:anchor_import] = imports
    write(MIGRATIONS_TS, "\n".join(out))
    git("add", "--", MIGRATIONS_TS, MIGRATIONS_DIR)
    return True


def fix_migration_test_ids():
    """Fix ids in upstream's migration tests: exact for [id, "Name"], a bump for toMigrationInclusive."""
    manifest = {name: n for n, name, _ in ((int(f[:3]), f[4:-3], f) for f in migration_files() if not f.endswith(".test.ts"))}
    review = []
    tests = [p for p in git("ls-files", "apps/server/src/persistence", "apps/server/scripts").split() if ".test." in p]
    for path in tests:
        up, ours = show(UPSTREAM, path), show("HEAD", path)
        text = open(path).read()
        # A renamed upstream test exists under neither path, so every line in it is upstream's.
        added = set((up if up is not None else text if ours is None else "").split("\n"))
        added -= set((ours or "").split("\n"))
        new = re.sub(r'\[(\d+), "(\w+)"\]', lambda m: f'[{manifest.get(m.group(2), int(m.group(1)))}, "{m.group(2)}"]', text)
        if up is not None:
            new = bump_inclusive(new, added)
        if new != text:
            write(path, new)
        for i, line in enumerate(new.split("\n"), 1):
            renamed_test = up is None and ours is None
            if line in added and "toMigrationInclusive" not in line and (renamed_test or re.search(r"migration_id|\bid\s*[<>]=?|BETWEEN", line)):
                if any(int(n) >= MIGRATION_OFFSET_FROM for n in re.findall(r"\b\d{2,3}\b", line)):
                    review.append(f"{path}:{i}: {line.strip()}")
    return review


def brand_sweep():
    """Brand user-visible T3 text on lines upstream added since the last merge."""
    base = git("merge-base", "HEAD", UPSTREAM).strip()
    diff = git("diff", "-U0", "--no-renames", base, UPSTREAM, "--", ".")
    added, current = {}, None
    for line in diff.split("\n"):
        if line.startswith("+++ "):
            current = line[6:] if line.startswith("+++ b/") else None
        elif current and line.startswith("+") and BRAND.search(line):
            added.setdefault(current, set()).add(line[1:])
    changed = 0
    for path, lines in added.items():
        if not BRAND_SCOPE.match(path) or "/i18n/translations/" in path or not os.path.exists(path):
            continue
        text = open(path, errors="replace").read().split("\n")
        new = [brand(line) if line in lines else line for line in text]
        if new != text:
            write(path, "\n".join(new))
            changed += 1
    return changed


def prepare():
    if git("status", "--porcelain").strip():
        sys.exit("Work tree is not clean.")
    if "UPSTREAM_REF" not in os.environ:
        git("fetch", "upstream")
    behind = git("rev-list", "--count", f"HEAD..{UPSTREAM}").strip()
    if behind == "0":
        print("Already up to date with upstream.")
        return
    git("merge", "--no-ff", "--no-commit", UPSTREAM, check=False)
    # Catalogs follow upstream exactly; `merge.py i18n` re-brands them after conflicts are resolved.
    git("checkout", UPSTREAM, "--", *(f"apps/{a}/src/i18n/translations" for a in I18N_APPS))
    total = len(conflicted())
    left = resolve_conflicts()
    renamed = renumber_migrations()
    review = fix_migration_test_ids()
    branded = brand_sweep()
    still = set(conflicted())
    left = [entry for entry in left if entry.split(" (")[0] in still]
    print(f"Merged {behind} upstream commits. {total - len(left)} of {total} conflicts resolved automatically.")
    print(f"Renumbered {len(renamed)} migration files; branded new upstream copy in {branded} files.")
    if left:
        print("\nResolve by hand (git show :1:/:2:/:3:<file> for base/fork/upstream):")
        print("\n".join(f"  {l}" for l in left))
    if review:
        print("\nCheck these migration ids in upstream tests (+1 from 59 on):")
        print("\n".join(f"  {r}" for r in review))
    print("\nThen: vp i, resolve, `merge.py i18n`, typecheck, tests, commit.")


def carry_translations():
    for app in I18N_APPS:
        folder = f"apps/{app}/src/i18n/translations"
        old = {f: json.loads(show(UPSTREAM, f"{folder}/{f}") or "{}") for f in os.listdir(folder)}
        subprocess.run(["vp", "run", "i18n:generate"], cwd=f"apps/{app}", check=True, capture_output=True)
        new_en = json.load(open(f"{folder}/en.json"))
        key = lambda v: json.dumps(json.loads(brand(json.dumps(v, ensure_ascii=False))), ensure_ascii=False, sort_keys=True)
        old_key_by_text = {key(v): k for k, v in old["en.json"].items()}
        remap = {k: old_key_by_text[key(v)] for k, v in new_en.items() if k not in old["en.json"] and key(v) in old_key_by_text}
        for f in os.listdir(folder):
            if f == "en.json":
                continue
            catalog = json.load(open(f"{folder}/{f}"))
            for new_key, old_key in remap.items():
                if new_key in catalog and old_key in old[f]:
                    catalog[new_key] = json.loads(brand(json.dumps(old[f][old_key], ensure_ascii=False)))
            write(f"{folder}/{f}", json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
        print(f"{app}: {len(remap)} re-branded keys kept their translations")
    subprocess.run(["node", "scripts/i18n-check.ts"], check=True)


if __name__ == "__main__":
    {"prepare": prepare, "i18n": carry_translations}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
