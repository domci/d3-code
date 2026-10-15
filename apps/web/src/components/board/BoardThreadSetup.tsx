import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DraftPromptOptions } from "../../hooks/useOpenDraftWithPrompt";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { Button } from "../ui/button";

type Project = ReturnType<typeof useProjects>[number];

/** One shared setup per destination environment; provider instance IDs belong to that environment. */
export function BoardThreadSetup(props: {
  readonly projects: ReadonlyArray<Project>;
  readonly onCreate: (options: ReadonlyMap<EnvironmentId, DraftPromptOptions>) => void;
}) {
  const [options, setOptions] = useState<ReadonlyMap<EnvironmentId, DraftPromptOptions>>(new Map());
  const changeOptions = useCallback((environmentId: EnvironmentId, value: DraftPromptOptions) => {
    setOptions((current) => new Map(current).set(environmentId, value));
  }, []);
  const environments = [
    ...new Map(props.projects.map((project) => [project.environmentId, project])).values(),
  ];
  return (
    <div className="flex flex-col gap-4">
      {environments.map((project) => (
        <EnvironmentSetup key={project.environmentId} project={project} onChange={changeOptions} />
      ))}
      <Button
        disabled={environments.some((project) => !options.has(project.environmentId))}
        onClick={() => props.onCreate(options)}
      >
        Create separate drafts
      </Button>
    </div>
  );
}

function EnvironmentSetup({
  project,
  onChange,
}: {
  readonly project: Project;
  readonly onChange: (environmentId: EnvironmentId, value: DraftPromptOptions) => void;
}) {
  const settings = useEnvironmentSettings(project.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(project.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const defaults = resolveProjectSettings(settings, project.id, project).settings;
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const active = useMemo(
    () =>
      selection ??
      defaults.defaultModelSelection ??
      entries.flatMap((entry) =>
        entry.models
          .filter((model) => !model.isLegacy)
          .map((model) => ({ instanceId: entry.instanceId, model: model.slug })),
      )[0],
    [selection, defaults.defaultModelSelection, entries],
  );
  const [envMode, setEnvMode] = useState<"local" | "worktree">(
    defaults.defaultThreadEnvMode ?? "worktree",
  );
  const [branch, setBranch] = useState("");
  const [startFromOrigin, setStartFromOrigin] = useState(defaults.newWorktreesStartFromOrigin);
  const modelOptions = useMemo(
    () =>
      active
        ? getCustomModelOptionsByInstance(settings, providers, active.instanceId, active.model)
        : new Map(),
    [settings, providers, active],
  );
  useEffect(() => {
    if (active)
      onChange(project.environmentId, {
        modelSelection: active,
        envMode,
        branch: branch || null,
        startFromOrigin,
      });
  }, [active, envMode, branch, startFromOrigin, project.environmentId, onChange]);
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">{project.title}</legend>
      {active ? (
        <ProviderModelPicker
          activeInstanceId={active.instanceId}
          model={active.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptions}
          isComposerOwned={false}
          onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
        />
      ) : (
        <p className="text-sm text-muted-foreground">No model available in this environment.</p>
      )}
      <label className="flex items-center gap-2 text-sm">
        Workspace
        <select
          value={envMode}
          onChange={(event) => setEnvMode(event.target.value === "worktree" ? "worktree" : "local")}
          className="h-8 rounded-md border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="local">Project checkout</option>
          <option value="worktree">New worktree per thread</option>
        </select>
      </label>
      {envMode === "worktree" ? (
        <WorktreeBaseBranchPicker
          environmentId={project.environmentId}
          cwd={project.workspaceRoot}
          value={branch}
          onValueChange={setBranch}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={setStartFromOrigin}
        />
      ) : null}
    </fieldset>
  );
}
