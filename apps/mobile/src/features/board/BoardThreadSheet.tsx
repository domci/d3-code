import { useNavigation } from "@react-navigation/native";
import {
  startThreadPrompt,
  type BoardCardItem,
  type BoardRepository,
} from "@t3tools/client-runtime/state/project-board";
import {
  executeAtomQuery,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useState } from "react";
import { Platform, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { Sheet } from "../../components/ui/Sheet";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  buildModelMenuActions,
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import {
  createNewTaskDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
  useStickyComposerModelSelection,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { vcsEnvironment } from "../../state/vcs";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

type Repository = BoardRepository<EnvironmentProject>;
type WorkspaceMode = "local" | "worktree";

interface ThreadOptions {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly workspaceMode: WorkspaceMode;
}

/**
 * Starts threads for board cards: one for all of them or one each, sent now through the outbox
 * or opened as drafts. Each destination environment gets its own model, since provider instances
 * belong to it.
 */
export function BoardThreadSheet(props: {
  readonly items: ReadonlyArray<BoardCardItem>;
  readonly repos: ReadonlyArray<Repository>;
  readonly onClose: () => void;
  readonly onStarted: (items: ReadonlyArray<BoardCardItem>) => void;
}) {
  const { items } = props;
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const [grouping, setGrouping] = useState<"one" | "separate">("one");
  const [threadRepoKey, setThreadRepoKey] = useState(items[0]!.repoKey);
  const [submitting, setSubmitting] = useState(false);
  const [options, setOptions] = useState<ReadonlyMap<EnvironmentId, ThreadOptions>>(new Map());
  // Child effects report on every render; skipping equal values keeps that from looping.
  const changeOptions = useCallback((environmentId: EnvironmentId, value: ThreadOptions) => {
    setOptions((current) =>
      JSON.stringify(current.get(environmentId)) === JSON.stringify(value)
        ? current
        : new Map(current).set(environmentId, value),
    );
  }, []);

  const repoOf = (key: string) => props.repos.find((repo) => repo.key === key);
  const cardRepos = props.repos.filter((repo) => items.some((item) => item.repoKey === repo.key));
  const groups =
    grouping === "one"
      ? [{ repo: repoOf(threadRepoKey), items }]
      : items.map((item) => ({ repo: repoOf(item.repoKey), items: [item] }));
  const environments = [
    ...new Map(
      groups.flatMap(({ repo }) =>
        repo ? [[repo.project.environmentId, repo.project] as const] : [],
      ),
    ).values(),
  ];
  const ready = environments.every((project) => options.has(project.environmentId));

  const submit = async (start: boolean) => {
    if (submitting || !ready) return;
    setSubmitting(true);
    const result = await settlePromise(async () => {
      const opened: Array<
        | { readonly draftId: string; readonly title: string }
        | { readonly environmentId: EnvironmentId; readonly threadId: string }
      > = [];
      const bases = new Map<string, string | null>();
      if (!start) await waitForComposerDraftsLoaded();
      for (const group of groups) {
        const { repo } = group;
        const threadOptions = repo && options.get(repo.project.environmentId);
        if (!repo || !threadOptions) continue;
        const { project } = repo;
        const text = group.items.map(startThreadPrompt).join("\n\n");
        const first = group.items[0]!;
        const title =
          group.items.length === 1 ? first.title : `${first.title} +${group.items.length - 1}`;
        if (!start) {
          const draftId = createNewTaskDraft({
            environmentId: project.environmentId,
            projectId: project.id,
          });
          setComposerDraftText(draftId, text);
          updateComposerDraftSettings(draftId, {
            modelSelection: threadOptions.modelSelection,
            workspaceSelection: {
              mode: threadOptions.workspaceMode,
              branch: null,
              worktreePath: null,
              startFromOrigin: false,
            },
          });
          opened.push({ draftId, title });
          props.onStarted(group.items);
          continue;
        }
        // A new worktree branches from the project checkout's current branch.
        let branch: string | null = null;
        if (threadOptions.workspaceMode === "worktree") {
          if (!bases.has(repo.key)) bases.set(repo.key, await readCurrentBranch(project));
          branch = bases.get(repo.key) ?? null;
          if (branch === null)
            throw new Error(
              `${repo.label}'s checkout is not on a branch to start a worktree from.`,
            );
        }
        const metadata = makeTurnCommandMetadata();
        await enqueueThreadOutboxMessage({
          environmentId: project.environmentId,
          threadId: ThreadId.make(metadata.threadId),
          messageId: MessageId.make(metadata.messageId),
          commandId: CommandId.make(metadata.commandId),
          text,
          attachments: [],
          modelSelection: threadOptions.modelSelection,
          runtimeMode: threadOptions.runtimeMode,
          interactionMode: "default",
          creation: {
            projectId: project.id,
            projectTitle: project.title,
            projectCwd: project.workspaceRoot,
            workspaceMode: threadOptions.workspaceMode,
            branch,
            worktreePath: null,
          },
          createdAt: metadata.createdAt,
        });
        opened.push({ environmentId: project.environmentId, threadId: metadata.threadId });
        props.onStarted(group.items);
      }
      return opened;
    });
    setSubmitting(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        start ? "Could not start the threads" : "Could not open the drafts",
        cause instanceof Error ? cause.message : "Try again.",
      );
      return;
    }
    props.onClose();
    // Open the thread when there is just one; a batch shows up in the thread list.
    const only = result.value.length === 1 ? result.value[0]! : null;
    if (only === null) return;
    if ("draftId" in only) navigation.navigate("Thread", { draft: only });
    else if (Platform.OS === "android") selectAndroidWorkspace({ name: "Thread", params: only });
    else navigation.navigate("Thread", only);
  };

  return (
    <Sheet
      title={items.length === 1 ? "Start thread" : `Start threads for ${items.length} cards`}
      onClose={props.onClose}
    >
      <ScrollView contentContainerClassName="gap-4 px-4 pb-8 pt-2">
        {items.length > 1 ? (
          <ListSection title="Threads">
            <ListChoiceRow
              label="One thread for all cards"
              selected={grouping === "one"}
              onPress={() => setGrouping("one")}
            />
            <ListChoiceRow
              label="One thread per card"
              separated
              selected={grouping === "separate"}
              onPress={() => setGrouping("separate")}
            />
          </ListSection>
        ) : null}
        {grouping === "one" && cardRepos.length > 1 ? (
          <ListSection title="Project">
            {cardRepos.map((repo, index) => (
              <ListChoiceRow
                key={repo.key}
                label={repo.label}
                separated={index > 0}
                selected={repo.key === threadRepoKey}
                onPress={() => setThreadRepoKey(repo.key)}
              />
            ))}
          </ListSection>
        ) : null}
        {environments.map((project) => (
          <EnvironmentSetup
            key={project.environmentId}
            project={project}
            titled={environments.length > 1}
            onChange={changeOptions}
          />
        ))}
        <View className="flex-row justify-end gap-2">
          <Button
            label="Open as draft"
            disabled={!ready || submitting}
            onPress={() => void submit(false)}
          />
          <Button
            label="Start"
            tone="primary"
            loading={submitting}
            disabled={!ready}
            onPress={() => void submit(true)}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}

async function readCurrentBranch(project: EnvironmentProject): Promise<string | null> {
  const status = await executeAtomQuery(
    appAtomRegistry,
    vcsEnvironment.status({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot },
    }),
  );
  return status._tag === "Success" ? (status.value.refName ?? null) : null;
}

/** The model and workspace for the threads of one environment, defaulting like a new task. */
function EnvironmentSetup(props: {
  readonly project: EnvironmentProject;
  readonly titled: boolean;
  readonly onChange: (environmentId: EnvironmentId, value: ThreadOptions) => void;
}) {
  const { project, onChange } = props;
  const config = useEnvironmentServerConfig(project.environmentId);
  const settings = resolveProjectSettings(
    config?.settings ?? DEFAULT_SERVER_SETTINGS,
    project.id,
    project,
  ).settings;
  const projectDefault = resolveDefaultableModelSelection(
    config,
    settings.defaultModelSelection,
    project.id,
  );
  const sticky = resolveDefaultableModelSelection(
    config,
    useStickyComposerModelSelection(),
    project.id,
  );
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const modelOptions = buildModelOptions(
    config,
    selection ?? projectDefault ?? sticky,
    undefined,
    project.id,
  );
  const active = resolveNewTaskModelSelection({
    draftSelection: selection,
    projectDefaultSelection: projectDefault,
    stickySelection: sticky,
    modelOptions,
  });
  const activeLabel = modelOptions.find(
    (option) =>
      option.selection.instanceId === active?.instanceId && option.selection.model === active.model,
  )?.label;
  const [mode, setMode] = useState<WorkspaceMode | null>(null);
  const workspaceMode = mode ?? settings.defaultThreadEnvMode ?? "worktree";
  const runtimeMode = settings.defaultRuntimeMode;

  useEffect(() => {
    if (active)
      onChange(project.environmentId, { modelSelection: active, runtimeMode, workspaceMode });
  }, [active, runtimeMode, workspaceMode, project.environmentId, onChange]);

  return (
    <View className="gap-2">
      {props.titled ? (
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          {project.title}
        </Text>
      ) : null}
      {active ? (
        <View className="flex-row flex-wrap gap-2">
          <ListFilterMenu
            label={activeLabel ?? active.model}
            accessibilityLabel="Model"
            actions={buildModelMenuActions(groupByProvider(modelOptions), active)}
            onSelect={(id) => {
              const option = modelOptions.find((candidate) => `model:${candidate.key}` === id);
              if (option) setSelection(option.selection);
            }}
          />
          <ListFilterMenu
            label={workspaceMode === "local" ? "Project checkout" : "New worktree per thread"}
            accessibilityLabel="Workspace"
            actions={(["local", "worktree"] as const).map((value) => ({
              id: value,
              title: value === "local" ? "Project checkout" : "New worktree per thread",
              state: workspaceMode === value ? ("on" as const) : undefined,
            }))}
            onSelect={(value) => setMode(value === "local" ? "local" : "worktree")}
          />
        </View>
      ) : (
        <Text textRole="footnote" className="text-foreground-muted">
          No model available in this environment.
        </Text>
      )}
    </View>
  );
}
