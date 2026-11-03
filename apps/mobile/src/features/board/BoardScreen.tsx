import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  NO_BOARD_FILTERS,
  collectBoardFacets,
  dedupeBoardRepositories,
  filterBoardItems,
  mergeBoardColumns,
  resolveDropTarget,
  type BoardCardItem,
  type BoardColumnView,
  type BoardFilters,
  type BoardRepository,
  type BoardStateFilter,
} from "@t3tools/client-runtime/state/project-board";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import {
  PROJECT_BOARD_SCOPE_COMMAND,
  ProjectBoardError,
  type EnvironmentId,
  type ProjectBoard,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useDeferredValue, useRef, useState } from "react";
import { FlatList, Linking, Pressable, ScrollView, View, useWindowDimensions } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { useProjects } from "../../state/entities";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceSurface } from "../workspace/useWorkspaceSurface";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { BoardThreadSheet } from "./BoardThreadSheet";

type Repository = BoardRepository<EnvironmentProject>;

const cardKey = (item: BoardCardItem) => `${item.repoKey}:${item.itemId}`;
const isProjectBoardError = Schema.is(ProjectBoardError);

const failureText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : "The request failed.";
};

/** GitHub's Status option colors. */
const COLUMN_DOT_CLASS: Record<string, string> = {
  GRAY: "bg-foreground-muted",
  BLUE: "bg-primary",
  GREEN: "bg-success",
  YELLOW: "bg-warning",
  ORANGE: "bg-warning",
  RED: "bg-danger",
  PINK: "bg-primary",
  PURPLE: "bg-primary",
};

interface BoardTarget {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/**
 * One read per repository, in parallel, shown together as they settle. Keyed on the serialized
 * repositories so a re-render reuses the same atoms instead of resubscribing.
 */
const boardAtomsFamily = Atom.family((serialized: string) => {
  const targets: ReadonlyArray<BoardTarget> = JSON.parse(serialized);
  const boardAtoms = targets.map((target) =>
    sourceControlEnvironment.projectBoard({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    }),
  );
  const permissions = targets.map((target) => ({
    key: target.key,
    move: sourceControlEnvironment.moveProjectBoardItem.permissionAtom(target.environmentId),
    state: sourceControlEnvironment.setProjectBoardIssueState.permissionAtom(target.environmentId),
  }));
  return {
    boardAtoms,
    resultsAtom: Atom.make((get) => boardAtoms.map((atom) => get(atom))),
    permissionsAtom: Atom.make((get) => ({
      move: new Set(permissions.filter(({ move }) => get(move)).map(({ key }) => key)),
      state: new Set(permissions.filter(({ state }) => get(state)).map(({ key }) => key)),
    })),
  };
});

/** The GitHub Projects of the user's repositories, one column per Status. */
export function BoardScreen() {
  const surface = useWorkspaceSurface();
  const registry = useContext(RegistryContext);
  const allProjects = useProjects();
  const repos = dedupeBoardRepositories(allProjects);
  const targets = repos.map((repo) => ({
    key: repo.key,
    environmentId: repo.project.environmentId,
    cwd: repo.project.workspaceRoot,
  }));
  const { boardAtoms, resultsAtom, permissionsAtom } = boardAtomsFamily(JSON.stringify(targets));
  const results = useAtomValue(resultsAtom);
  const permissions = useAtomValue(permissionsAtom);
  const states = results.map((result, index) => ({
    repo: repos[index] as Repository,
    board: Option.getOrNull(AsyncResult.value(result))?.board ?? null,
    error: result._tag === "Failure" ? failureText(result.cause) : null,
    scopeMissing:
      result._tag === "Failure" &&
      Option.match(Cause.findErrorOption(result.cause), {
        onNone: () => false,
        onSome: (error) => isProjectBoardError(error) && error.reason === "scope_missing",
      }),
    settled: result._tag !== "Initial",
  }));
  const loaded = states.filter((state) => state.board !== null);
  const failures = states.filter((state) => state.error !== null);
  const pending = results.some((result) => result.waiting);
  const refreshRepo = (key: string) => {
    const atom = boardAtoms[repos.findIndex((repo) => repo.key === key)];
    if (atom !== undefined) registry.refresh(atom);
  };
  const repoOf = (key: string) => repos.find((repo) => repo.key === key);

  const boardRepos = loaded.map((state) => state.repo);
  const [picked, setPicked] = useState<ReadonlyArray<string> | null>(null);
  const activeKeys =
    picked !== null && boardRepos.some((repo) => picked.includes(repo.key))
      ? new Set(picked)
      : new Set(boardRepos.map((repo) => repo.key));

  // Moves shown before GitHub has confirmed them; a newer read of the board replaces them.
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
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const facets = collectBoardFacets(shown.flatMap((entry) => entry.items));
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
  const selecting = selectedItems.length > 0;
  const setItemsSelected = (items: ReadonlyArray<BoardCardItem>, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const item of items) {
        if (checked) next.add(cardKey(item));
        else next.delete(cardKey(item));
      }
      return next;
    });
  const [threadItems, setThreadItems] = useState<ReadonlyArray<BoardCardItem>>([]);

  const moveItem = useAtomCommand(sourceControlEnvironment.moveProjectBoardItem, {
    reportFailure: false,
  });
  const setIssueState = useAtomCommand(sourceControlEnvironment.setProjectBoardIssueState, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const actionRunning = useRef(false);

  const boardOf = (item: BoardCardItem) =>
    shown.find((entry) => entry.repoKey === item.repoKey)?.board;
  const dropTarget = (item: BoardCardItem, columnKey: string) => {
    const board = boardOf(item);
    return board === undefined ? null : resolveDropTarget(board, columnKey);
  };

  const moveToColumn = async (item: BoardCardItem, columnKey: string) => {
    const repo = repoOf(item.repoKey);
    const board = boardOf(item);
    const target = dropTarget(item, columnKey);
    if (repo === undefined || board === undefined || target === null) return false;
    if (item.statusOptionId === target.optionId) return true;
    setMoves((current) =>
      new Map(current).set(item.itemId, { base: board, optionId: target.optionId }),
    );
    const result = await moveItem({
      environmentId: repo.project.environmentId,
      input: {
        cwd: repo.project.workspaceRoot,
        projectId: board.projectId,
        itemId: item.itemId,
        fieldId: target.fieldId,
        optionId: target.optionId,
      },
    });
    if (result._tag === "Success") return true;
    setMoves((current) => {
      const next = new Map(current);
      next.delete(item.itemId);
      return next;
    });
    if (!isAtomCommandInterrupted(result)) reportFailure("Could not move the card", result);
    return false;
  };

  const changeIssueState = async (item: BoardCardItem, state: "open" | "closed") => {
    const repo = repoOf(item.repoKey);
    if (!repo || !permissions.state.has(repo.key)) return false;
    const result = await setIssueState({
      environmentId: repo.project.environmentId,
      input: { cwd: repo.project.workspaceRoot, itemId: item.itemId, state },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result))
      reportFailure(`Could not ${state === "closed" ? "close" : "reopen"} ${item.title}`, result);
    return false;
  };

  const runBatch = async (
    items: ReadonlyArray<BoardCardItem>,
    action: (item: BoardCardItem) => Promise<boolean>,
  ) => {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    // React Compiler cannot compile try/finally yet, so cleanup rides on the promise.
    const runItems = async () => {
      for (const item of items) {
        if (await action(item)) setItemsSelected([item], false);
      }
    };
    await runItems().finally(() => {
      new Set(items.map((item) => item.repoKey)).forEach(refreshRepo);
      actionRunning.current = false;
      setBusy(false);
    });
  };

  /** Menu actions that act on `items`: a move, closing or reopening issues, starting threads. */
  const itemActions = (items: ReadonlyArray<BoardCardItem>): MenuAction[] => {
    const movable = items.every((item) => permissions.move.has(item.repoKey));
    const targets = columns.filter((column) =>
      items.every((item) => dropTarget(item, column.key) !== null),
    );
    const eligible = (state: "open" | "closed") =>
      items.filter((item) => item.kind === "issue" && item.state !== state);
    const url = items.length === 1 ? items[0]!.url : null;
    return [
      {
        id: "start",
        title: items.length > 1 ? `Start threads (${items.length})` : "Start thread",
        image: "square.and.pencil",
      },
      {
        id: "move",
        title: "Move to",
        image: "arrow.right",
        attributes: { disabled: busy || !movable || targets.length === 0 },
        subactions: targets.map((column) => ({ id: `move:${column.key}`, title: column.name })),
      },
      ...(["closed", "open"] as const)
        .filter((state) => eligible(state).length > 0)
        .map((state) => ({
          id: state,
          title: `${state === "closed" ? "Close" : "Reopen"} issue${items.length > 1 ? `s (${eligible(state).length})` : ""}`,
          image: state === "closed" ? "checkmark.circle" : "arrow.clockwise",
          attributes: {
            disabled: busy || eligible(state).some((item) => !permissions.state.has(item.repoKey)),
          },
        })),
      ...(url === null ? [] : [{ id: "open", title: "Open on GitHub", image: "arrow.up.right" }]),
    ];
  };
  const runItemAction = (items: ReadonlyArray<BoardCardItem>, id: string) => {
    if (id === "start") setThreadItems(items);
    else if (id === "open" && items[0]?.url) void Linking.openURL(items[0].url);
    else if (id.startsWith("move:"))
      void runBatch(items, (item) => moveToColumn(item, id.slice("move:".length)));
    else if (id === "closed" || id === "open")
      void runBatch(
        items.filter((item) => item.kind === "issue" && item.state !== id),
        (item) => changeIssueState(item, id),
      );
  };

  let body;
  if (repos.length === 0) {
    body = (
      <EmptyState
        title="No GitHub repository"
        detail="Add a project whose repository is hosted on GitHub to see its board."
        variant="plain"
      />
    );
  } else if (loaded.length === 0 && states.some((state) => !state.settled)) {
    body = (
      <View className="flex-1 items-center justify-center">
        <AppActivityIndicator />
      </View>
    );
  } else if (loaded.length === 0 && failures.length === 0) {
    body = (
      <EmptyState
        title="No GitHub Project"
        detail="Link a project to a repository on GitHub to see it here."
        variant="plain"
      />
    );
  } else {
    body = (
      <BoardColumns
        columns={columns}
        repos={repos}
        selected={selected}
        selecting={selecting}
        busy={busy}
        itemActions={itemActions}
        onItemAction={runItemAction}
        onToggle={(item) => setItemsSelected([item], !selected.has(cardKey(item)))}
        onToggleColumn={(column) =>
          setItemsSelected(column.items, !column.items.every((item) => selected.has(cardKey(item))))
        }
      />
    );
  }

  const scopeMissing = failures.some((failure) => failure.scopeMissing);
  return (
    <View collapsable={false} className={`flex-1 ${surface.className}`}>
      <AppBar
        title="Board"
        sidebar={false}
        hideBottomBorder
        search={
          loaded.length === 0
            ? undefined
            : {
                value: search,
                onChangeText: setSearch,
                placeholder: "Search cards",
                mode: "inline",
                clearAccessibilityLabel: "Clear search",
              }
        }
        actions={[
          {
            accessibilityLabel: "Refresh board",
            icon: "arrow.clockwise",
            loading: pending,
            disabled: repos.length === 0 || pending,
            onPress: () => boardAtoms.forEach((atom) => registry.refresh(atom)),
          },
        ]}
      />
      <ScreenContent>
        {loaded.length === 0 ? null : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="grow-0"
            contentContainerClassName="gap-2 px-4 py-2"
          >
            {boardRepos.length > 1 ? (
              <ListFilterMenu
                label={`Repos ${activeKeys.size}/${boardRepos.length}`}
                accessibilityLabel="Repositories"
                active={activeKeys.size < boardRepos.length}
                actions={boardRepos.map((repo) => ({
                  id: repo.key,
                  title: repo.label,
                  state: activeKeys.has(repo.key) ? ("on" as const) : undefined,
                }))}
                onSelect={(key) =>
                  setPicked(
                    activeKeys.has(key)
                      ? [...activeKeys].filter((candidate) => candidate !== key)
                      : [...activeKeys, key],
                  )
                }
              />
            ) : null}
            <ListFilterMenu
              label={
                filters.state === "all" ? "State" : filters.state === "open" ? "Open" : "Closed"
              }
              accessibilityLabel="State"
              active={filters.state !== "all"}
              actions={(["all", "open", "closed"] as const).map((state) => ({
                id: state,
                title: state === "all" ? "All" : state === "open" ? "Open" : "Closed",
                state: filters.state === state ? ("on" as const) : undefined,
              }))}
              onSelect={(state) => setFilterState({ ...filters, state: state as BoardStateFilter })}
            />
            {facets.labels.length === 0 ? null : (
              <ListFilterMenu
                label={filters.label ?? "Label"}
                accessibilityLabel="Label"
                active={filters.label !== null}
                actions={["", ...facets.labels].map((label) => ({
                  id: label,
                  title: label || "All labels",
                  state: (filters.label ?? "") === label ? ("on" as const) : undefined,
                }))}
                onSelect={(label) => setFilterState({ ...filters, label: label || null })}
              />
            )}
            {facets.assignees.length === 0 ? null : (
              <ListFilterMenu
                label={filters.assignee ?? "Assignee"}
                accessibilityLabel="Assignee"
                active={filters.assignee !== null}
                actions={["", ...facets.assignees].map((login) => ({
                  id: login,
                  title: login || "All assignees",
                  state: (filters.assignee ?? "") === login ? ("on" as const) : undefined,
                }))}
                onSelect={(login) => setFilterState({ ...filters, assignee: login || null })}
              />
            )}
          </ScrollView>
        )}
        {failures.length === 0 ? null : (
          <View className="mx-4 mb-2 rounded-xl bg-subtle px-3 py-2">
            <Text textRole="footnote" className="font-t3-medium text-danger">
              {scopeMissing ? "GitHub Projects access is missing" : "Could not load some boards"}
            </Text>
            {scopeMissing ? (
              <Text textRole="caption" selectable className="text-foreground-muted">
                Run {PROJECT_BOARD_SCOPE_COMMAND} on the server, then refresh.
              </Text>
            ) : null}
            {failures.map((failure) => (
              <Text key={failure.repo.key} textRole="caption" className="text-foreground-muted">
                {failure.repo.label}: {failure.error}
              </Text>
            ))}
          </View>
        )}
        {selecting ? (
          <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2">
            <Text textRole="footnote" className="flex-1 text-foreground" role="status">
              {selectedItems.length} selected
            </Text>
            {busy ? <AppActivityIndicator /> : null}
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              disabled={busy}
              onPress={() => setSelected(new Set())}
            >
              <Text textRole="footnote" className="text-foreground-muted">
                Clear
              </Text>
            </Pressable>
            <Menu
              title={`${selectedItems.length} cards`}
              actions={itemActions(selectedItems)}
              onPressAction={({ nativeEvent }) => runItemAction(selectedItems, nativeEvent.event)}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Selection actions"
                hitSlop={8}
              >
                <Text textRole="footnote" className="font-t3-medium text-primary">
                  Actions
                </Text>
              </Pressable>
            </Menu>
          </View>
        ) : null}
        {body}
      </ScreenContent>
      {threadItems.length > 0 ? (
        <BoardThreadSheet
          items={threadItems}
          repos={repos}
          onClose={() => setThreadItems([])}
          onStarted={(items) => setItemsSelected(items, false)}
        />
      ) : null}
    </View>
  );
}

function reportFailure(title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const cause = squashAtomCommandFailure(result);
  Dialog.alert(title, cause instanceof Error ? cause.message : "Try again.");
}

function BoardColumns(props: {
  readonly columns: ReadonlyArray<BoardColumnView>;
  readonly repos: ReadonlyArray<Repository>;
  readonly selected: ReadonlySet<string>;
  readonly selecting: boolean;
  readonly busy: boolean;
  readonly itemActions: (items: ReadonlyArray<BoardCardItem>) => MenuAction[];
  readonly onItemAction: (items: ReadonlyArray<BoardCardItem>, id: string) => void;
  readonly onToggle: (item: BoardCardItem) => void;
  readonly onToggleColumn: (column: BoardColumnView) => void;
}) {
  const { width } = useWindowDimensions();
  // Phones see one column and the edge of the next; wide screens see several.
  const columnWidth = Math.min(width - 48, 340);
  return (
    <FlatList
      horizontal
      data={props.columns}
      keyExtractor={(column) => column.key}
      showsHorizontalScrollIndicator={false}
      snapToInterval={columnWidth + 12}
      decelerationRate="fast"
      contentContainerClassName="gap-3 px-4 pb-4"
      renderItem={({ item: column }) => {
        const selectedCount = column.items.filter((item) =>
          props.selected.has(cardKey(item)),
        ).length;
        return (
          <View style={{ width: columnWidth }} className="flex-1 rounded-2xl bg-subtle">
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={`Select all in ${column.name}`}
              accessibilityState={{
                checked:
                  selectedCount === 0
                    ? false
                    : selectedCount === column.items.length
                      ? true
                      : "mixed",
              }}
              disabled={props.busy || column.items.length === 0}
              onPress={() => props.onToggleColumn(column)}
              className="flex-row items-center gap-2 px-3 py-2.5"
            >
              <View
                className={cn(
                  "size-2 rounded-full",
                  (column.color === null ? undefined : COLUMN_DOT_CLASS[column.color]) ??
                    "bg-border",
                )}
              />
              <Text textRole="footnote" numberOfLines={1} className="shrink font-t3-medium">
                {column.name}
              </Text>
              <Text textRole="caption" className="text-foreground-muted">
                {column.items.length}
              </Text>
            </Pressable>
            <FlatList
              data={column.items}
              keyExtractor={cardKey}
              nestedScrollEnabled
              contentContainerClassName="gap-2 px-2 pb-2"
              renderItem={({ item }) => (
                <BoardCard
                  item={item}
                  repo={props.repos.find((repo) => repo.key === item.repoKey)}
                  selected={props.selected.has(cardKey(item))}
                  selecting={props.selecting}
                  busy={props.busy}
                  actions={props.itemActions([item])}
                  onAction={(id) => props.onItemAction([item], id)}
                  onToggle={() => props.onToggle(item)}
                />
              )}
            />
          </View>
        );
      }}
    />
  );
}

function BoardCard(props: {
  readonly item: BoardCardItem;
  readonly repo: Repository | undefined;
  readonly selected: boolean;
  readonly selecting: boolean;
  readonly busy: boolean;
  readonly actions: MenuAction[];
  readonly onAction: (id: string) => void;
  readonly onToggle: () => void;
}) {
  const { item } = props;
  const badge =
    item.kind === "draft"
      ? "Draft"
      : item.state === "merged"
        ? "Merged"
        : item.state === "closed"
          ? "Closed"
          : null;
  return (
    <Menu
      title={item.title}
      shouldOpenOnLongPress
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityHint={
          props.selecting ? "Toggles selection" : "Opens on GitHub. Long press for actions."
        }
        accessibilityState={{ selected: props.selected }}
        onPress={() =>
          props.selecting || item.url === null ? props.onToggle() : void Linking.openURL(item.url)
        }
        className={cn(
          "gap-1.5 rounded-xl border bg-card p-3 active:opacity-70",
          props.selected ? "border-primary" : "border-border",
        )}
      >
        <View className="flex-row items-start gap-2">
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`Select ${item.title}`}
            accessibilityState={{ checked: props.selected, disabled: props.busy }}
            disabled={props.busy}
            hitSlop={10}
            onPress={props.onToggle}
          >
            <SymbolView
              name={props.selected ? "checkmark.circle.fill" : "circle"}
              size={18}
              tintColorClassName={props.selected ? "accent-primary" : "accent-icon-muted"}
            />
          </Pressable>
          <View className="min-w-0 flex-1 gap-1">
            {props.repo === undefined ? null : (
              <Text textRole="caption" numberOfLines={1} className="text-foreground-muted">
                {props.repo.label}
                {item.number === null ? "" : ` #${item.number}`}
              </Text>
            )}
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              {item.title}
            </Text>
          </View>
        </View>
        {badge === null && item.labels.length === 0 && item.assignees.length === 0 ? null : (
          <View className="flex-row flex-wrap items-center gap-1 pl-[26px]">
            {badge === null ? null : <CardTag label={badge} strong />}
            {item.labels.map((label) => (
              <CardTag key={label.name} label={label.name} />
            ))}
            {item.assignees.map((assignee) => (
              <Text key={assignee.login} textRole="caption" className="text-foreground-muted">
                @{assignee.login}
              </Text>
            ))}
          </View>
        )}
      </Pressable>
    </Menu>
  );
}

function CardTag(props: { readonly label: string; readonly strong?: boolean }) {
  return (
    <View className="rounded-md bg-subtle px-1.5 py-0.5">
      <Text
        textRole="caption"
        numberOfLines={1}
        className={props.strong ? "font-t3-medium text-foreground" : "text-foreground-muted"}
      >
        {props.label}
      </Text>
    </View>
  );
}
