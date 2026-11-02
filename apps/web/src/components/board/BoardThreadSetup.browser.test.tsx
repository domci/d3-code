import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { StartThreadOptions } from "../../hooks/useStartThreadWithPrompt";
import { render } from "../../../test/render";

const entries = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: "codex",
    models: [{ slug: "default", isLegacy: false }],
  },
];
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providersValueAtom: () => null },
  EMPTY_SERVER_PROVIDERS: [],
}));
vi.mock("../../providerInstances", () => ({ providerInstanceEntriesFor: () => entries }));
vi.mock("../../modelSelection", () => ({ getCustomModelOptionsByInstance: () => new Map() }));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    onInstanceModelChange: (instanceId: string, model: string) => void;
  }) => (
    <button type="button" onClick={() => props.onInstanceModelChange("codex", "chosen-model")}>
      Pick model
    </button>
  ),
}));
vi.mock("../chat/TraitsPicker", () => ({
  TraitsPicker: (props: {
    onModelOptionsChange: (options: ReadonlyArray<{ id: string; value: string }>) => void;
  }) => (
    <button
      type="button"
      onClick={() => props.onModelOptionsChange([{ id: "effort", value: "high" }])}
    >
      High effort
    </button>
  ),
}));
vi.mock("../WorktreeBaseBranchPicker", () => ({
  WorktreeBaseBranchPicker: (props: {
    onValueChange: (value: string) => void;
    onStartFromOriginChange: (value: boolean) => void;
  }) => (
    <>
      <button type="button" onClick={() => props.onValueChange("release")}>
        Pick release
      </button>
      <button type="button" onClick={() => props.onStartFromOriginChange(true)}>
        From origin
      </button>
    </>
  ),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { BoardThreadSetup } from "./BoardThreadSetup";

it("collects one editable setup per environment, with a thinking level, and starts or drafts", async () => {
  const env = EnvironmentId.make("server");
  const remote = EnvironmentId.make("remote");
  const projects = [env, env, remote].map((environmentId, index) => ({
    id: ProjectId.make(String(index)),
    environmentId,
    title: `Project ${index}`,
    workspaceRoot: `/work/${index}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  }));
  const submit =
    vi.fn<(options: ReadonlyMap<EnvironmentId, StartThreadOptions>, start: boolean) => void>();
  await using screen = await render(
    <BoardThreadSetup projects={projects} canShareWorktree onSubmit={submit} />,
  );
  expect(screen.getByRole("group").elements()).toHaveLength(2);
  const first = screen.getByRole("group", { name: "Project 1" });
  await userEvent.click(first.getByRole("button", { name: "Pick model" }));
  await userEvent.selectOptions(first.getByRole("combobox"), "shared");
  await userEvent.click(first.getByRole("button", { name: "Pick release" }));
  await userEvent.click(first.getByRole("button", { name: "From origin" }));
  await userEvent.click(first.getByRole("button", { name: "High effort" }));
  await userEvent.click(screen.getByRole("button", { name: "Open as draft" }));
  await userEvent.click(screen.getByRole("button", { name: "Start", exact: true }));
  expect(submit.mock.calls.map(([, start]) => start)).toEqual([false, true]);
  const options = submit.mock.calls[1]![0];
  expect(options.size).toBe(2);
  expect(options.get(env)).toEqual({
    modelSelection: {
      instanceId: "codex",
      model: "chosen-model",
      options: [{ id: "effort", value: "high" }],
    },
    envMode: "worktree",
    branch: "release",
    startFromOrigin: true,
    runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
    sharedWorktree: true,
  });
  expect(options.get(remote)?.sharedWorktree).toBe(false);
  expect(options.get(remote)?.modelSelection.model).toBe("default");
});
