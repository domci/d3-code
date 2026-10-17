import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  PROJECT_BOARD_SCOPE_COMMAND,
  ProjectBoardError,
  type EnvironmentId,
  type ProjectBoard,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useContext, useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useOpenDraftWithPrompt } from "../../hooks/useOpenDraftWithPrompt";
import {
  useStartThreadWithPrompt,
  type SharedWorktree,
  type StartThreadOptions,
} from "../../hooks/useStartThreadWithPrompt";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { formatEnvironmentQueryError } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  PullRequestActorAvatar,
  PullRequestLabelChip,
} from "../pullRequest/pullRequestPresentation";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ProjectFavicon } from "../ProjectFavicon";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BoardThreadSetup } from "./BoardThreadSetup";
import {
  BOARD_REPOSITORIES_KEY,
  NO_BOARD_FILTERS,
  collectBoardFacets,
  dedupeBoardRepositories,
  filterBoardItems,
  mergeBoardColumns,
  repositoryAccent,
  resolveDropTarget,
  startThreadPrompt,
  type BoardCardItem,
  type BoardColumnView,
  type BoardFilters,
  type BoardRepository,
  type BoardStateFilter,
} from "./projectBoard.logic";

export interface ProjectBoardSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

const BOARD_DRAG_TYPE = "application/x-t3-board-item";
const cardKey = (item: BoardCardItem) => `${item.repoKey}:${item.itemId}`;

const isProjectBoardError = Schema.is(ProjectBoardError);

/** GitHub's Status option colors, as theme tokens. */
const COLUMN_DOT_CLASS: Record<string, string> = {
  GRAY: "bg-muted-foreground",
  BLUE: "bg-info",
  GREEN: "bg-success",
  YELLOW: "bg-warning",
  ORANGE: "bg-warning",
  RED: "bg-destructive",
  PINK: "bg-primary",
  PURPLE: "bg-primary",
};

function readRememberedRepositories(): ReadonlyArray<string> | null {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(BOARD_REPOSITORIES_KEY) ?? "null",
    );
    return Array.isArray(value) ? value.filter((key) => typeof key === "string") : null;
  } catch {
    return null;
  }
}

function rememberRepositories(keys: ReadonlyArray<string>): void {
  try {
    window.localStorage.setItem(BOARD_REPOSITORIES_KEY, JSON.stringify(keys));
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
  }
}

type ProjectRecord = ReturnType<typeof useProjects>[number];
type Repository = BoardRepository<ProjectRecord>;

export function ProjectBoardPage(props: { readonly search: ProjectBoardSearch }) {
  const { search } = props;
  const allProjects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const registry = useContext(RegistryContext);
  const repos = useMemo(() => dedupeBoardRepositories(allProjects), [allProjects]);

  // One read per repository, in parallel, shown together as they settle.
  const boardAtoms = useMemo(
    () =>
      repos.map((repo) =>
        sourceControlEnvironment.projectBoard({
          environmentId: repo.project.environmentId,
          input: { cwd: repo.project.workspaceRoot },
        }),
      ),
    [repos],
  );
  const resultsAtom = useMemo(
    () => Atom.make((get) => boardAtoms.map((atom) => get(atom))),
    [boardAtoms],
  );
  const results = useAtomValue(resultsAtom);
  const states = useMemo(
    () =>
      results.map((result, index) => {
        const failure =
          result._tag === "Failure" ? Option.getOrNull(Cause.findErrorOption(result.cause)) : null;
        return {
          repo: repos[index] as Repository,
          board: Option.getOrNull(AsyncResult.value(result))?.board ?? null,
          error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
          scopeMissing: isProjectBoardError(failure) && failure.reason === "scope_missing",
          settled: result._tag !== "Initial",
        };
      }),
    [repos, results],
  );
  const loaded = states.filter((state) => state.board !== null);
  const failures = states.filter((state) => state.error !== null);
  const pending = results.some((result) => result.waiting);
  const refreshRepo = (key: string) => {
    const atom = boardAtoms[repos.findIndex((repo) => repo.key === key)];
    if (atom !== undefined) registry.refresh(atom);
  };

  // The repositories shown: the route's project, else the remembered choice, else all.
  const searchKey = allProjects
    .find(
      (project) =>
        project.id === search.projectId &&
        (search.environmentId === undefined || project.environmentId === search.environmentId),
    )
    ?.repositoryIdentity?.canonicalKey.toLowerCase();
  const [picked, setPicked] = useState<ReadonlyArray<string> | null>(null);
  const [remembered] = useState(readRememberedRepositories);
  const boardRepos = loaded.map((state) => state.repo);
  const wanted = picked ?? (searchKey === undefined ? remembered : [searchKey]);
  const chosen = new Set(wanted);
  const activeKeys = boardRepos.some((repo) => chosen.has(repo.key))
    ? chosen
    : new Set(boardRepos.map((repo) => repo.key));
  const pickRepositories = (keys: ReadonlyArray<string>) => {
    setPicked(keys);
    rememberRepositories(keys);
  };

  const movePermissions = useAtomValue(
    useMemo(() => {
      const permissions = repos.map((repo) => ({
        key: repo.key,
        atom: sourceControlEnvironment.moveProjectBoardItem.permissionAtom(
          repo.project.environmentId,
        ),
      }));
      return Atom.make(
        (get) => new Set(permissions.filter(({ atom }) => get(atom)).map(({ key }) => key)),
      );
    }, [repos]),
  );
  const moveItem = useAtomCommand(sourceControlEnvironment.moveProjectBoardItem, {
    reportFailure: false,
  });
  const openDraftWithPrompt = useOpenDraftWithPrompt();
  const { startThread: startThreadNow, createSharedWorktree } = useStartThreadWithPrompt();
  const setIssueState = useAtomCommand(sourceControlEnvironment.setProjectBoardIssueState, {
    reportFailure: false,
  });
  const issueStatePermissions = useAtomValue(
    useMemo(() => {
      const permissions = repos.map((repo) => ({
        key: repo.key,
        atom: sourceControlEnvironment.setProjectBoardIssueState.permissionAtom(
          repo.project.environmentId,
        ),
      }));
      return Atom.make(
        (get) => new Set(permissions.filter(({ atom }) => get(atom)).map(({ key }) => key)),
      );
    }, [repos]),
  );

  // Moves shown before GitHub has confirmed them. Each belongs to the board it was made on: once
  // a newer read arrives it is the truth, and the move is dropped with the board it annotates.
  const [moves, setMoves] = useState<
    ReadonlyMap<string, { readonly base: ProjectBoard; readonly optionId: string | null }>
  >(new Map());
  const shown = loaded
    .filter((state) => activeKeys.has(state.repo.key))
    .map((state) => {
      const board = state.board as ProjectBoard;
      return {
        repoKey: state.repo.key,
        board,
        items: board.items.map((item) => {
          const move = moves.get(item.itemId);
          return move?.base === board ? { ...item, statusOptionId: move.optionId } : item;
        }),
      };
    });

  const [filterState, setFilterState] = useState(NO_BOARD_FILTERS);
  const facets = collectBoardFacets(shown.flatMap((entry) => entry.items));
  const [cardSearch, setCardSearch] = useState("");
  const deferredSearch = useDeferredValue(cardSearch);
  const filters: BoardFilters = {
    ...filterState,
    search: deferredSearch,
    label: facets.labels.includes(filterState.label ?? "") ? filterState.label : null,
    assignee: facets.assignees.includes(filterState.assignee ?? "") ? filterState.assignee : null,
  };
  const columns = mergeBoardColumns(
    shown.map((entry) => ({ ...entry, items: filterBoardItems(entry.items, filters) })),
  );

  const visibleItems = columns.flatMap((column) => column.items);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectedItems = visibleItems.filter((item) => selected.has(cardKey(item)));
  const canMove = selectedItems.every((item) => movePermissions.has(item.repoKey));
  const [busy, setBusy] = useState(false);
  const actionRunning = useRef(false);
  const [threadItems, setThreadItems] = useState<ReadonlyArray<BoardCardItem>>([]);
  const [threadRepoKey, setThreadRepoKey] = useState("");
  const [grouping, setGrouping] = useState<"one" | "separate">("one");
  const toggleSelected = (item: BoardCardItem, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(cardKey(item));
      else next.delete(cardKey(item));
      return next;
    });
  };
  const draggedItems = (key: string) => {
    const card = visibleItems.find((item) => cardKey(item) === key);
    return card === undefined ? [] : selected.has(cardKey(card)) ? selectedItems : [card];
  };

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const dragged =
    draggingId === null ? undefined : visibleItems.find((item) => cardKey(item) === draggingId);
  const dropTarget = (card: BoardCardItem | undefined, columnKey: string) => {
    const board = shown.find((entry) => entry.repoKey === card?.repoKey)?.board;
    return board === undefined ? null : resolveDropTarget(board, columnKey);
  };
  const repoOf = (key: string) => repos.find((repo) => repo.key === key);

  const dropOnColumn = async (card: BoardCardItem, columnKey: string) => {
    const { itemId } = card;
    const repo = repoOf(card.repoKey);
    const board = shown.find((entry) => entry.repoKey === card.repoKey)?.board;
    if (repo === undefined || board === undefined) return false;
    const target = dropTarget(card, columnKey);
    if (target === null) {
      toastManager.add({
        type: "error",
        title: "Cannot move the card here",
        description: `${repo.label}'s project has no such status.`,
      });
      return false;
    }
    if (card.statusOptionId === target.optionId) return true;
    setMoves((current) => new Map(current).set(itemId, { base: board, optionId: target.optionId }));
    const result = await moveItem({
      environmentId: repo.project.environmentId,
      input: {
        cwd: repo.project.workspaceRoot,
        projectId: board.projectId,
        itemId,
        fieldId: target.fieldId,
        optionId: target.optionId,
      },
    });
    if (result._tag === "Failure") {
      setMoves((current) => {
        const next = new Map(current);
        next.delete(itemId);
        return next;
      });
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not move the card",
          description: formatEnvironmentQueryError(result.cause),
        });
      }
      return false;
    }
    return true;
  };

  const runBatch = async (
    items: ReadonlyArray<BoardCardItem>,
    action: (item: BoardCardItem) => Promise<boolean>,
    refresh = true,
  ) => {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    try {
      for (const item of items) {
        if (await action(item)) toggleSelected(item, false);
      }
    } finally {
      if (refresh) new Set(items.map((item) => item.repoKey)).forEach(refreshRepo);
      actionRunning.current = false;
      setBusy(false);
    }
  };

  const changeIssueState = async (item: BoardCardItem, state: "open" | "closed") => {
    const repo = repoOf(item.repoKey);
    if (!repo || !issueStatePermissions.has(repo.key)) return false;
    const result = await setIssueState({
      environmentId: repo.project.environmentId,
      input: { cwd: repo.project.workspaceRoot, itemId: item.itemId, state },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        toastManager.add({
          type: "error",
          title: `Could not ${state === "closed" ? "close" : "reopen"} ${item.title}`,
          description: formatEnvironmentQueryError(result.cause),
        });
      return false;
    }
    return true;
  };

  const openThreadSetup = (items: ReadonlyArray<BoardCardItem>) => {
    setThreadRepoKey(items[0]!.repoKey);
    setGrouping("one");
    setThreadItems(items);
  };

  /** Runs the dialog's choice: one thread for all cards or one each, now or as drafts. */
  const submitThreads = async (
    options: ReadonlyMap<EnvironmentId, StartThreadOptions>,
    start: boolean,
  ) => {
    const items = threadItems;
    if (actionRunning.current || items.length === 0) return;
    setThreadItems([]);
    const combined = grouping === "one";
    const worktrees = new Map<string, SharedWorktree | null>();
    await runBatch(
      combined ? items.slice(0, 1) : items,
      async (item) => {
        const group = combined ? items : [item];
        const repo = repoOf(combined ? threadRepoKey : item.repoKey);
        const threadOptions = repo && options.get(repo.project.environmentId);
        if (!repo || !threadOptions) return false;
        const prompt = group.map(startThreadPrompt).join("\n\n");
        let opened: boolean;
        if (start) {
          let shared: (SharedWorktree & { readonly setup: boolean }) | undefined;
          if (!combined && threadOptions.sharedWorktree) {
            const known = worktrees.has(repo.key);
            if (!known)
              worktrees.set(repo.key, await createSharedWorktree(repo.project, threadOptions));
            const tree = worktrees.get(repo.key);
            if (!tree) return false;
            shared = { ...tree, setup: !known };
          }
          opened = await startThreadNow({
            project: repo.project,
            prompt,
            title: group.length === 1 ? item.title : `${item.title} +${group.length - 1}`,
            options: threadOptions,
            ...(shared ? { shared } : {}),
            open: combined || items.length === 1,
          });
        } else {
          opened = await openDraftWithPrompt(
            scopeProjectRef(repo.project.environmentId, repo.project.id),
            prompt,
            threadOptions,
          );
          if (!opened) toastManager.add({ type: "error", title: "Could not open a new thread" });
        }
        if (opened) group.forEach((entry) => toggleSelected(entry, false));
        return opened;
      },
      false,
    );
  };

  let body: ReactNode;
  if (!projectsKnown) {
    body = <BoardStatus>Loading projects…</BoardStatus>;
  } else if (repos.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No GitHub repository</EmptyTitle>
          <EmptyDescription>
            Add a project whose repository is hosted on GitHub to see its board.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (loaded.length === 0 && states.some((state) => !state.settled)) {
    body = <BoardStatus>Loading boards…</BoardStatus>;
  } else if (loaded.length === 0 && failures.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No GitHub Project is linked to any of your repositories.</EmptyTitle>
          <EmptyDescription>
            Link a project to a repository on GitHub to see it here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <div className="flex min-h-full flex-col gap-3">
        {failures.length === 0 ? null : <BoardError failures={failures} />}
        <div className="flex flex-wrap items-center gap-2" aria-label="Board selection">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || visibleItems.length === 0}
            onClick={() => setSelected(new Set(visibleItems.map(cardKey)))}
          >
            Select all visible
          </Button>
          {selectedItems.length === 0 ? null : (
            <>
              <span className="text-sm text-muted-foreground" role="status">
                {selectedItems.length} selected
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </Button>
              <BoardSelect
                label="Move to"
                value=""
                disabled={!canMove || busy}
                onChange={(key) => {
                  if (key) void runBatch(selectedItems, (item) => dropOnColumn(item, key));
                }}
              >
                <option value="">Choose status</option>
                {columns
                  .filter((column) =>
                    selectedItems.every((item) => dropTarget(item, column.key) !== null),
                  )
                  .map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.name}
                    </option>
                  ))}
              </BoardSelect>
              {(["closed", "open"] as const).map((state) => {
                const eligible = selectedItems.filter(
                  (item) => item.kind === "issue" && item.state !== state,
                );
                return (
                  <Button
                    key={state}
                    size="sm"
                    variant="outline"
                    disabled={
                      busy ||
                      eligible.length === 0 ||
                      eligible.some((item) => !issueStatePermissions.has(item.repoKey))
                    }
                    onClick={() => void runBatch(eligible, (item) => changeIssueState(item, state))}
                  >
                    {state === "closed" ? "Close" : "Reopen"} issues ({eligible.length})
                  </Button>
                );
              })}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => openThreadSetup(selectedItems)}
              >
                Start thread{selectedItems.length > 1 ? "s" : ""}
              </Button>
            </>
          )}
          {busy ? <Spinner className="size-4" /> : null}
        </div>
        {shown
          .filter((entry) => entry.board.truncated)
          .map((entry) => (
            <p key={entry.repoKey} className="text-xs text-muted-foreground">
              Showing the first 1,000 items of {repoOf(entry.repoKey)?.label}&apos;s project.
            </p>
          ))}
        <div className="flex min-h-80 flex-1 items-stretch gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <BoardColumn
              key={column.key}
              column={column}
              repos={repos}
              canDrag={!busy}
              movePermissions={movePermissions}
              droppable={
                dragged !== undefined &&
                draggedItems(cardKey(dragged)).every(
                  (item) =>
                    movePermissions.has(item.repoKey) && dropTarget(item, column.key) !== null,
                )
              }
              over={overKey === column.key}
              draggingId={draggingId}
              draggingSelection={dragged !== undefined && selected.has(cardKey(dragged))}
              onDragStart={setDraggingId}
              onDragOver={setOverKey}
              onDragEnd={() => {
                setDraggingId(null);
                setOverKey(null);
              }}
              onDrop={(itemId) => {
                setDraggingId(null);
                setOverKey(null);
                void runBatch(draggedItems(itemId), (item) => dropOnColumn(item, column.key));
              }}
              onStartThread={(item) => openThreadSetup([item])}
              selected={selected}
              busy={busy}
              onSelect={toggleSelected}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <Dialog
        open={threadItems.length > 0}
        onOpenChange={(open) => {
          if (!open) setThreadItems([]);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              Start{" "}
              {threadItems.length === 1 ? "thread" : `threads for ${threadItems.length} cards`}
            </DialogTitle>
            <DialogDescription>
              Choose the model, thinking level and workspace. Start runs the threads now; a draft
              opens them for review first.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              {threadItems.length > 1 ? (
                <div className="flex flex-wrap items-center gap-3">
                  <BoardSelect
                    label="Threads"
                    value={grouping}
                    onChange={(value) => setGrouping(value === "separate" ? "separate" : "one")}
                  >
                    <option value="one">One thread for all cards</option>
                    <option value="separate">One thread per card</option>
                  </BoardSelect>
                  {grouping === "one" &&
                  new Set(threadItems.map((item) => item.repoKey)).size > 1 ? (
                    <BoardSelect label="Project" value={threadRepoKey} onChange={setThreadRepoKey}>
                      {repos
                        .filter((repo) => threadItems.some((item) => item.repoKey === repo.key))
                        .map((repo) => (
                          <option key={repo.key} value={repo.key}>
                            {repo.label}
                          </option>
                        ))}
                    </BoardSelect>
                  ) : null}
                </div>
              ) : null}
              <BoardThreadSetup
                canShareWorktree={grouping === "separate"}
                projects={repos
                  .filter((repo) =>
                    grouping === "one"
                      ? repo.key === threadRepoKey
                      : threadItems.some((item) => item.repoKey === repo.key),
                  )
                  .map((repo) => repo.project)}
                onSubmit={(options, start) => void submitThreads(options, start)}
              />
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Board</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2 sm:px-6">
          {loaded.length === 0 ? null : (
            <div className="flex items-center gap-1.5">
              <input
                type="search"
                value={cardSearch}
                placeholder="Search cards"
                aria-label="Search cards by number, title, repository, label, assignee or text"
                onChange={(event) => setCardSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setCardSearch("");
                }}
                className="h-8 w-48 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
              {cardSearch === "" ? null : (
                <>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {columns.reduce((total, column) => total + column.items.length, 0)} found
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Clear search"
                    onClick={() => setCardSearch("")}
                  >
                    Clear
                  </Button>
                </>
              )}
            </div>
          )}
          {boardRepos.length === 0 ? null : (
            <Menu>
              <MenuTrigger render={<Button variant="outline" size="sm" />}>
                Repositories ({activeKeys.size}/{boardRepos.length})
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                {boardRepos.map((repo) => (
                  <MenuCheckboxItem
                    key={repo.key}
                    checked={activeKeys.has(repo.key)}
                    onCheckedChange={(next) =>
                      pickRepositories(
                        next
                          ? [...activeKeys, repo.key]
                          : [...activeKeys].filter((key) => key !== repo.key),
                      )
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          repositoryAccent(repo.label).dot,
                        )}
                      />
                      <ProjectFavicon project={repo.project} className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate">{repo.label}</span>
                    </span>
                  </MenuCheckboxItem>
                ))}
              </MenuPopup>
            </Menu>
          )}
          {loaded.length === 0 ? null : (
            <>
              <BoardSelect
                label="Label"
                value={filters.label ?? ""}
                onChange={(value) =>
                  setFilterState({ ...filters, label: value === "" ? null : value })
                }
              >
                <option value="">All labels</option>
                {facets.labels.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </BoardSelect>
              <BoardSelect
                label="State"
                value={filters.state}
                onChange={(value) =>
                  setFilterState({ ...filters, state: value as BoardStateFilter })
                }
              >
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </BoardSelect>
              <BoardSelect
                label="Assignee"
                value={filters.assignee ?? ""}
                onChange={(value) =>
                  setFilterState({ ...filters, assignee: value === "" ? null : value })
                }
              >
                <option value="">All assignees</option>
                {facets.assignees.map((login) => (
                  <option key={login} value={login}>
                    {login}
                  </option>
                ))}
              </BoardSelect>
            </>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh board"
            disabled={repos.length === 0 || pending}
            onClick={() => boardAtoms.forEach((atom) => registry.refresh(atom))}
          >
            <RefreshIcon size="md" refreshing={pending} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-6 pt-2 sm:px-6">{body}</div>
      </div>
    </SidebarInset>
  );
}

function BoardStatus(props: { readonly children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner size="sm" />
      {props.children}
    </div>
  );
}

function BoardError(props: {
  readonly failures: ReadonlyArray<{
    readonly repo: { readonly label: string };
    readonly error: string | null;
    readonly scopeMissing: boolean;
  }>;
}) {
  const scopeMissing = props.failures.some((failure) => failure.scopeMissing);
  const others = props.failures.filter((failure) => !failure.scopeMissing);
  return (
    <Alert variant="error">
      <AlertTitle>
        {scopeMissing ? "GitHub Projects access is missing" : "Could not load some boards"}
      </AlertTitle>
      <AlertDescription>
        {scopeMissing ? (
          <>
            <p>Your GitHub token cannot read Projects. Run this, then refresh:</p>
            <code className="mt-1 inline-block rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
              {PROJECT_BOARD_SCOPE_COMMAND}
            </code>
          </>
        ) : null}
        {others.map((failure) => (
          <p key={failure.repo.label}>
            {failure.repo.label}: {failure.error}
          </p>
        ))}
      </AlertDescription>
    </Alert>
  );
}

function BoardSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{props.label}</span>
      <select
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {props.children}
      </select>
    </label>
  );
}

function BoardColumn(props: {
  readonly column: BoardColumnView;
  readonly repos: ReadonlyArray<Repository>;
  readonly canDrag: boolean;
  readonly movePermissions: ReadonlySet<string>;
  /** The card being dragged can take this column's status. */
  readonly droppable: boolean;
  readonly over: boolean;
  readonly draggingId: string | null;
  readonly draggingSelection: boolean;
  readonly onDragStart: (itemId: string) => void;
  readonly onDragOver: (columnKey: string) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (itemId: string) => void;
  readonly onStartThread: (item: BoardCardItem) => void;
  readonly selected: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onSelect: (item: BoardCardItem, checked: boolean) => void;
}) {
  const { column } = props;
  return (
    <section
      aria-label={column.name}
      className={cn(
        "flex w-72 shrink-0 flex-col gap-2 rounded-lg border bg-muted/30 p-2",
        props.over && props.droppable ? "border-primary" : "border-border",
      )}
      onDragOver={(event) => {
        if (!props.canDrag || !props.droppable) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onDragOver(column.key);
      }}
      onDrop={(event) => {
        if (!props.canDrag || !props.droppable || props.draggingId === null) return;
        event.preventDefault();
        props.onDrop(props.draggingId);
      }}
    >
      <header className="flex items-center gap-2 px-1 text-sm font-medium">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            (column.color === null ? undefined : COLUMN_DOT_CLASS[column.color]) ??
              "bg-muted-foreground/40",
          )}
        />
        <h2 className="min-w-0 truncate">{column.name}</h2>
        <span className="tabular-nums text-xs text-muted-foreground">{column.items.length}</span>
      </header>
      <ul className="flex flex-col gap-2">
        {column.items.map((item) => (
          <BoardCard
            key={item.itemId}
            item={item}
            repo={props.repos.find((repo) => repo.key === item.repoKey)}
            draggable={props.canDrag && props.movePermissions.has(item.repoKey)}
            dimmed={
              props.draggingId !== null &&
              (props.draggingId === cardKey(item) ||
                (props.draggingSelection && props.selected.has(cardKey(item))))
            }
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onStartThread={props.onStartThread}
            selected={props.selected.has(cardKey(item))}
            busy={props.busy}
            onSelect={props.onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

function BoardCard(props: {
  readonly item: BoardCardItem;
  readonly repo: Repository | undefined;
  readonly draggable: boolean;
  readonly dimmed: boolean;
  readonly onDragStart: (itemId: string) => void;
  readonly onDragEnd: () => void;
  readonly onStartThread: (item: BoardCardItem) => void;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (item: BoardCardItem, checked: boolean) => void;
}) {
  const { item, repo } = props;
  const url = item.url;
  const badge =
    item.kind === "draft"
      ? "Draft"
      : item.state === "merged"
        ? "Merged"
        : item.state === "closed"
          ? "Closed"
          : null;
  return (
    <li
      draggable={props.draggable}
      className={cn(
        "flex flex-col gap-2 rounded-md border border-l-4 border-border bg-card p-2.5 text-sm text-card-foreground",
        repo === undefined ? undefined : repositoryAccent(repo.label).border,
        props.dimmed && "opacity-50",
        props.selected && "ring-2 ring-primary",
      )}
      onDragStart={(event) => {
        event.dataTransfer.setData(BOARD_DRAG_TYPE, cardKey(item));
        event.dataTransfer.effectAllowed = "move";
        props.onDragStart(cardKey(item));
      }}
      onDragEnd={props.onDragEnd}
    >
      {repo === undefined ? null : (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProjectFavicon project={repo.project} className="size-3 shrink-0" />
          <span className="truncate">{repo.label}</span>
        </div>
      )}
      <div className="flex items-start gap-2">
        <Checkbox
          aria-label={`Select ${item.title}`}
          checked={props.selected}
          disabled={props.busy}
          onCheckedChange={(checked) => props.onSelect(item, checked)}
        />
        {item.number === null ? null : (
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
            #{item.number}
          </span>
        )}
        {url === null ? (
          <span className="min-w-0 flex-1 font-medium">{item.title}</span>
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer text-left font-medium hover:underline"
            onClick={() => void readLocalApi()?.shell.openExternal(url)}
          >
            {item.title}
          </button>
        )}
      </div>
      {badge === null ? null : (
        <div className="flex">
          <Badge size="sm" variant="secondary">
            {badge}
          </Badge>
        </div>
      )}
      {item.labels.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <PullRequestLabelChip key={label.name} label={label} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {item.assignees.map((assignee) => (
            <span
              key={assignee.login}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            >
              <PullRequestActorAvatar
                actor={{ login: assignee.login, name: null, avatarUrl: assignee.avatarUrl }}
              />
              {assignee.login}
            </span>
          ))}
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onStartThread(item)}
        >
          Start thread
        </Button>
      </div>
    </li>
  );
}
