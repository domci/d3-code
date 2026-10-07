import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  PROJECT_BOARD_SCOPE_COMMAND,
  ProjectBoardError,
  type EnvironmentId,
  type ProjectBoard,
  type ProjectBoardItem,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useOpenDraftWithPrompt } from "../../hooks/useOpenDraftWithPrompt";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
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
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  NO_BOARD_FILTERS,
  collectBoardFacets,
  filterBoardItems,
  githubBoardProjects,
  groupBoardColumns,
  moveBoardItem,
  projectBoardChoiceKey,
  startThreadPrompt,
  type BoardColumnView,
  type BoardFilters,
  type BoardStateFilter,
} from "./projectBoard.logic";

export interface ProjectBoardSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

const BOARD_DRAG_TYPE = "application/x-t3-board-item";
const NO_MOVES: ReadonlyMap<string, string | null> = new Map();

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

function readRememberedProjectNumber(key: string): number | undefined {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function rememberProjectNumber(key: string, projectNumber: number): void {
  try {
    window.localStorage.setItem(key, String(projectNumber));
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
  }
}

export function ProjectBoardPage(props: {
  readonly search: ProjectBoardSearch;
  readonly onSelectProject: (project: {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }) => void;
}) {
  const { search, onSelectProject } = props;
  const allProjects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const candidates = useMemo(() => githubBoardProjects(allProjects), [allProjects]);
  const project = useMemo(
    () =>
      candidates.find(
        (candidate) =>
          candidate.id === search.projectId &&
          (search.environmentId === undefined || candidate.environmentId === search.environmentId),
      ) ??
      candidates[0] ??
      null,
    [candidates, search.environmentId, search.projectId],
  );

  // The GitHub Project chosen for each T3 project, remembered across visits.
  const choiceKey =
    project === null ? null : projectBoardChoiceKey(project.environmentId, project.id);
  const [chosen, setChosen] = useState<Readonly<Record<string, number>>>({});
  const remembered = useMemo(
    () => (choiceKey === null ? undefined : readRememberedProjectNumber(choiceKey)),
    [choiceKey],
  );
  const projectNumber = choiceKey === null ? undefined : (chosen[choiceKey] ?? remembered);

  const query = useEnvironmentQuery(
    project === null
      ? null
      : sourceControlEnvironment.projectBoard({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            ...(projectNumber === undefined ? {} : { projectNumber }),
          },
        }),
  );
  const board = query.data?.board ?? null;
  const githubProjects = query.data?.projects ?? [];

  const canMove = useAtomValue(
    sourceControlEnvironment.moveProjectBoardItem.permissionAtom(project?.environmentId ?? null),
  );
  const moveItem = useAtomCommand(sourceControlEnvironment.moveProjectBoardItem, {
    reportFailure: false,
  });
  const openDraftWithPrompt = useOpenDraftWithPrompt();

  // Moves shown before GitHub has confirmed them. They belong to the board they were made on:
  // once a newer read arrives it is the truth, and they are dropped with the board they annotate.
  const [moves, setMoves] = useState<{
    readonly base: ProjectBoard | null;
    readonly byItem: ReadonlyMap<string, string | null>;
  }>({ base: null, byItem: NO_MOVES });
  const pendingMoves = useRef(0);
  const activeMoves = moves.base === board ? moves.byItem : NO_MOVES;
  const items = useMemo(
    () =>
      board === null
        ? []
        : [...activeMoves].reduce(
            (current, [itemId, optionId]) => moveBoardItem(current, itemId, optionId),
            board.items,
          ),
    [activeMoves, board],
  );

  const boardKey = board === null || project === null ? "" : `${project.id}:${board.projectId}`;
  const [filterState, setFilterState] = useState({ key: "", filters: NO_BOARD_FILTERS });
  const filters = filterState.key === boardKey ? filterState.filters : NO_BOARD_FILTERS;
  const setFilters = (next: BoardFilters) => setFilterState({ key: boardKey, filters: next });
  const facets = useMemo(() => collectBoardFacets(board?.items ?? []), [board]);
  const columns = useMemo(
    () => (board === null ? [] : groupBoardColumns(board, filterBoardItems(items, filters))),
    [board, filters, items],
  );

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const canDrag = board !== null && board.statusFieldId !== null && canMove;

  const dropOnColumn = async (itemId: string, optionId: string | null) => {
    if (project === null || board === null || board.statusFieldId === null) return;
    const item = items.find((entry) => entry.itemId === itemId);
    if (item === undefined || item.statusOptionId === optionId) return;
    setMoves((current) => ({
      base: board,
      byItem: new Map(current.base === board ? current.byItem : NO_MOVES).set(itemId, optionId),
    }));
    pendingMoves.current += 1;
    const result = await moveItem({
      environmentId: project.environmentId,
      input: {
        cwd: project.workspaceRoot,
        projectId: board.projectId,
        itemId,
        fieldId: board.statusFieldId,
        optionId,
      },
    });
    pendingMoves.current -= 1;
    if (result._tag === "Failure") {
      setMoves((current) => {
        const byItem = new Map(current.byItem);
        byItem.delete(itemId);
        return { base: current.base, byItem };
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
    if (pendingMoves.current === 0) query.refresh();
  };

  const startThread = async (item: ProjectBoardItem) => {
    if (project === null) return;
    const opened = await openDraftWithPrompt(
      scopeProjectRef(project.environmentId, project.id),
      startThreadPrompt(item),
    );
    if (!opened) {
      toastManager.add({ type: "error", title: "Could not open a new thread" });
    }
  };

  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectOptionKey = (candidate: { environmentId: string; id: string }) =>
    `${candidate.environmentId}:${candidate.id}`;

  let body: ReactNode;
  if (!projectsKnown) {
    body = <BoardStatus>Loading projects…</BoardStatus>;
  } else if (project === null) {
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
  } else if (query.data === null && query.error === null) {
    body = <BoardStatus>Loading board…</BoardStatus>;
  } else if (query.data === null) {
    body = (
      <BoardError
        message={query.error ?? ""}
        scopeMissing={
          isProjectBoardError(query.failure) && query.failure.reason === "scope_missing"
        }
      />
    );
  } else if (board === null) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No GitHub Project is linked to this repository.</EmptyTitle>
          <EmptyDescription>
            Link a project to the repository on GitHub to see it here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-col gap-3">
        {query.error === null ? null : (
          <BoardError
            message={query.error}
            scopeMissing={
              isProjectBoardError(query.failure) && query.failure.reason === "scope_missing"
            }
          />
        )}
        {board.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the first 100 items of this project.
          </p>
        ) : null}
        <div className="flex items-start gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <BoardColumn
              key={column.key}
              column={column}
              canDrag={canDrag}
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
                void dropOnColumn(itemId, column.optionId);
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
            {candidates.length > 1 && project !== null ? (
              <BoardSelect
                label="Repository"
                value={projectOptionKey(project)}
                onChange={(value) => {
                  const next = candidates.find(
                    (candidate) => projectOptionKey(candidate) === value,
                  );
                  if (next !== undefined) onSelectProject(next);
                }}
              >
                {candidates.map((candidate) => (
                  <option key={projectOptionKey(candidate)} value={projectOptionKey(candidate)}>
                    {environments.length > 1
                      ? `${candidate.title} (${environmentLabels.get(candidate.environmentId) ?? candidate.environmentId})`
                      : candidate.title}
                  </option>
                ))}
              </BoardSelect>
            ) : null}
            {githubProjects.length > 1 && board !== null && choiceKey !== null ? (
              <BoardSelect
                label="Project"
                value={String(board.projectNumber)}
                onChange={(value) => {
                  const next = Number(value);
                  rememberProjectNumber(choiceKey, next);
                  setChosen((current) => ({ ...current, [choiceKey]: next }));
                }}
              >
                {githubProjects.map((githubProject) => (
                  <option key={githubProject.id} value={String(githubProject.number)}>
                    {githubProject.title}
                  </option>
                ))}
              </BoardSelect>
            ) : null}
            {board === null ? null : (
              <>
                <BoardSelect
                  label="Label"
                  value={filters.label ?? ""}
                  onChange={(value) =>
                    setFilters({ ...filters, label: value === "" ? null : value })
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
                  onChange={(value) => setFilters({ ...filters, state: value as BoardStateFilter })}
                >
                  <option value="all">All</option>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </BoardSelect>
                <BoardSelect
                  label="Assignee"
                  value={filters.assignee ?? ""}
                  onChange={(value) =>
                    setFilters({ ...filters, assignee: value === "" ? null : value })
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
              disabled={project === null || query.isPending}
              onClick={query.refresh}
            >
              <RefreshIcon size="md" refreshing={query.isPending} />
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

function BoardError(props: { readonly message: string; readonly scopeMissing: boolean }) {
  return (
    <Alert variant="error">
      <AlertTitle>
        {props.scopeMissing ? "GitHub Projects access is missing" : "Could not load the board"}
      </AlertTitle>
      <AlertDescription>
        {props.scopeMissing ? (
          <>
            <p>Your GitHub token cannot read Projects. Run this, then refresh:</p>
            <code className="mt-1 inline-block rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
              {PROJECT_BOARD_SCOPE_COMMAND}
            </code>
          </>
        ) : (
          props.message
        )}
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
  readonly canDrag: boolean;
  readonly over: boolean;
  readonly draggingId: string | null;
  readonly onDragStart: (itemId: string) => void;
  readonly onDragOver: (columnKey: string) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (itemId: string) => void;
  readonly onStartThread: (item: ProjectBoardItem) => void;
}) {
  const { column } = props;
  return (
    <section
      aria-label={column.name}
      className={cn(
        "flex w-72 shrink-0 flex-col gap-2 rounded-lg border bg-muted/30 p-2",
        props.over ? "border-primary" : "border-border",
      )}
      onDragOver={(event) => {
        if (!props.canDrag || props.draggingId === null) return;
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
  readonly item: ProjectBoardItem;
  readonly draggable: boolean;
  readonly dimmed: boolean;
  readonly onDragStart: (itemId: string) => void;
  readonly onDragEnd: () => void;
  readonly onStartThread: (item: ProjectBoardItem) => void;
}) {
  const { item } = props;
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
        "flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 text-sm text-card-foreground",
        props.dimmed && "opacity-50",
      )}
      onDragStart={(event) => {
        event.dataTransfer.setData(BOARD_DRAG_TYPE, item.itemId);
        event.dataTransfer.effectAllowed = "move";
        props.onDragStart(item.itemId);
      }}
      onDragEnd={props.onDragEnd}
    >
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
