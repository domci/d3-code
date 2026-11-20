# Merging upstream T3 Code

D3 Code is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (remote `upstream`). Merge often: conflicts grow faster than the commit count. A weekly scheduled task (Sunday night) runs the merge, pushes `main` when checks pass, and rolls it out to the desktop app, Android app and live server.

## Steps

1. Make a worktree on a new branch from `main`: `git worktree add -b merge/upstream-<date> /srv/dom/worktrees/upstream-merge-<date>/d3-code main`.
2. In it, run `python3 scripts/upstream-merge/merge.py prepare`. It merges `upstream/main` without committing and then:
   - re-merges each conflict against branded base and upstream text, which settles every conflict that was only T3 vs D3 naming;
   - takes upstream's `pnpm-lock.yaml`, `routeTree.gen.ts` and i18n catalogs, and upstream's replay fixtures with branding;
   - renumbers upstream's new migrations (+1 from 59 on), regenerates the lists in `Migrations.ts`, and fixes migration ids in upstream's tests;
   - brands user-visible `T3 <Word>` on lines upstream added in `apps/*/src`, `packages/*/src` and `docs/user`.

   It ends with the files left to resolve and the migration ids to check by hand.

3. `vp i`, then resolve the remaining files. Keep both sides: port fork features onto upstream's new shape rather than dropping either. `git show :1:<f>`, `:2:<f>`, `:3:<f>` give base, fork and upstream.
4. `python3 scripts/upstream-merge/merge.py i18n` regenerates the GT catalogs and moves each translation to its re-branded key.
5. Typecheck each package with `effect-tsgo tsrs --noEmit` (`vp run typecheck` can be OOM-killed and still look green), lint and run the tests beside every resolved file, then commit `chore: merge upstream T3 Code into D3`.

`git rerere` is on in the main checkout, so a resolution recorded once is replayed when the same conflict comes back.

## What the fork keeps, and where merges break

- **Branding.** User-visible text says D3 Code and D3 Connect. Identifiers keep `t3`: `refs/t3/...`, bundle id `com.t3tools.t3code`, the `t3` CLI, `t3.json`, MCP tool names, `T3CODE_*`. Catalogs are keyed by a hash of the English text, which is why branded strings need step 4.
- **Migrations.** The fork's `059_ProjectThreadFolders` shifts every later upstream migration up by one. The runner skips every id at or below the highest recorded one, so fork migrations cannot move to a separate high range.
- **Tree sidebar.** `LegacySidebar.tsx` replaces upstream's sidebar (`legacySidebarEnabled`, on by default). Everything it takes from upstream's sidebar code goes through `LegacySidebar.upstream.ts`; a merge that breaks the tree breaks there first.
- **i18n lint.** New fork copy uses `<T>`, `gt()` or `msg()`; `t3code/no-untranslated-copy` fails the commit otherwise. D3 Code and D3 Connect are proper nouns in that rule.
