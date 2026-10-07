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
import { useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useOpenDraftWithPrompt } from "../../hooks/useOpenDraftWithPrompt";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ProjectFavicon } from "../ProjectFavicon";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
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

  const canMove = useAtomValue(
    useMemo(() => {
      const permissions = [...new Set(repos.map((repo) => repo.project.environmentId))].map((id) =>
        sourceControlEnvironment.moveProjectBoardItem.permissionAtom(id),
      );
      return Atom.make((get) => permissions.every((permission) => get(permission)));
    }, [repos]),
  );
  const moveItem = useAtomCommand(sourceControlEnvironment.moveProjectBoardItem, {
    reportFailure: false,
  });
  const openDraftWithPrompt = useOpenDraftWithPrompt();

  // Moves shown before GitHub has confirmed them. Each belongs to the board it was made on: once
  // a newer read arrives it is the truth, and the move is dropped with the board it annotates.
  const [moves, setMoves] = useState<
    ReadonlyMap<string, { readonly base: ProjectBoard; readonly optionId: string | null }>
  >(new Map());
  const pendingMoves = useRef<Record<string, number>>({});
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
  const filters: BoardFilters = {
    ...filterState,
    label: facets.labels.includes(filterState.label ?? "") ? filterState.label : null,
    assignee: facets.assignees.includes(filterState.assignee ?? "") ? filterState.assignee : null,
  };
  const columns = mergeBoardColumns(
    shown.map((entry) => ({ ...entry, items: filterBoardItems(entry.items, filters) })),
  );

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const dragged =
    draggingId === null
      ? undefined
      : columns.flatMap((column) => column.items).find((item) => item.itemId === draggingId);
  const dropTarget = (card: BoardCardItem | undefined, columnKey: string) => {
    const board = shown.find((entry) => entry.repoKey === card?.repoKey)?.board;
    return board === undefined ? null : resolveDropTarget(board, columnKey);
  };
  const repoOf = (key: string) => repos.find((repo) => repo.key === key);

  const dropOnColumn = async (itemId: string, columnKey: string) => {
    const card = columns.flatMap((column) => column.items).find((item) => item.itemId === itemId);
    const repo = repoOf(card?.repoKey ?? "");
    const board = shown.find((entry) => entry.repoKey === card?.repoKey)?.board;
    if (card === undefined || repo === undefined || board === undefined) return;
    const target = dropTarget(card, columnKey);
    if (target === null) {
      toastManager.add({
        type: "error",
        title: "Cannot move the card here",
        description: `${repo.label}'s project has no such status.`,
      });
      return;
    }
    if (card.statusOptionId === target.optionId) return;
    setMoves((current) => new Map(current).set(itemId, { base: board, optionId: target.optionId }));
    pendingMoves.current[repo.key] = (pendingMoves.current[repo.key] ?? 0) + 1;
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
    pendingMoves.current[repo.key] = (pendingMoves.current[repo.key] ?? 1) - 1;
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
      return;
    }
    // Rapid drags are each shown at once; one read after the last settles confirms them all.
    if (pendingMoves.current[repo.key] === 0) refreshRepo(repo.key);
  };

  const startThread = async (item: BoardCardItem) => {
    const repo = repoOf(item.repoKey);
    if (repo === undefined) return;
    const opened = await openDraftWithPrompt(
      scopeProjectRef(repo.project.environmentId, repo.project.id),
      startThreadPrompt(item),
    );
    if (!opened) {
      toastManager.add({ type: "error", title: "Could not open a new thread" });
    }
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
      <div className="flex min-h-0 flex-col gap-3">
        {failures.length === 0 ? null : <BoardError failures={failures} />}
        {shown
          .filter((entry) => entry.board.truncated)
          .map((entry) => (
            <p key={entry.repoKey} className="text-xs text-muted-foreground">
              Showing the first 100 items of {repoOf(entry.repoKey)?.label}&apos;s project.
            </p>
          ))}
        <div className="flex items-start gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <BoardColumn
              key={column.key}
              column={column}
              repos={repos}
              canDrag={canMove}
              droppable={dragged !== undefined && dropTarget(dragged, column.key) !== null}
              over={overKey === column.key}
              draggingId={draggingId}
              onDragStart={setDraggingId}
              onDragOver={setOverKey}
              onDragEnd={() => {
                setDraggingId(null);
                setOverKey(null);
              }}
              onDrop={(itemId) => {
                setDraggingId(null);
                setOverKey(null);
                void dropOnColumn(itemId, column.key);
              }}
              onStartThread={(item) => void startThread(item)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2">
            <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1>Board</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="min-w-0 flex-1" />
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
        </WorkspacePageHeader>
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
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{props.label}</span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  /** The card being dragged can take this column's status. */
  readonly droppable: boolean;
  readonly over: boolean;
  readonly draggingId: string | null;
  readonly onDragStart: (itemId: string) => void;
  readonly onDragOver: (columnKey: string) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (itemId: string) => void;
  readonly onStartThread: (item: BoardCardItem) => void;
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
        if (!props.canDrag) return;
        event.preventDefault();
        const itemId = event.dataTransfer.getData(BOARD_DRAG_TYPE);
        if (itemId !== "") props.onDrop(itemId);
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
            draggable={props.canDrag}
            dimmed={props.draggingId === item.itemId}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onStartThread={props.onStartThread}
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
      )}
      onDragStart={(event) => {
        event.dataTransfer.setData(BOARD_DRAG_TYPE, item.itemId);
        event.dataTransfer.effectAllowed = "move";
        props.onDragStart(item.itemId);
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
        <Button size="xs" variant="outline" onClick={() => props.onStartThread(item)}>
          Start thread
        </Button>
      </div>
    </li>
  );
}
