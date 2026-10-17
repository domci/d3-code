import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { StartThreadOptions } from "../../hooks/useStartThreadWithPrompt";

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
vi.mock("../../providerInstances", () => ({
  deriveProviderInstanceEntries: () => entries,
  applyProviderInstanceSettings: (value: unknown) => value,
  sortProviderInstanceEntries: (value: unknown) => value,
}));
vi.mock("../../modelSelection", () => ({ getCustomModelOptionsByInstance: () => new Map() }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: "input" }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: "output" }));
vi.mock("../WorktreeBaseBranchPicker", () => ({ WorktreeBaseBranchPicker: "textarea" }));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { BoardThreadSetup } from "./BoardThreadSetup";

let view: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => view?.unmount());
  vi.unstubAllGlobals();
});

it("collects one editable setup per environment, with a thinking level, and starts or drafts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  await act(async () => {
    view = create(<BoardThreadSetup projects={projects} onSubmit={submit} />);
  });
  expect(view!.root.findAllByType("fieldset")).toHaveLength(2);
  const first = view!.root.findAllByType("fieldset")[0]!;
  await act(async () => {
    first.findByType("input").props.onInstanceModelChange("codex", "chosen-model");
    first.findByType("select").props.onChange({ target: { value: "worktree" } });
  });
  await act(async () => {
    first.findByType("textarea").props.onValueChange("release");
    first.findByType("textarea").props.onStartFromOriginChange(true);
  });
  await act(async () => {
    first.findByType("output").props.onModelOptionsChange([{ id: "effort", value: "high" }]);
  });
  const button = (label: string) =>
    view!.root.findAllByType("button").find((node) => node.children.join("") === label)!;
  await act(async () => {
    button("Open as draft").props.onClick();
    button("Start").props.onClick();
  });
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
  });
  expect(options.get(remote)?.modelSelection.model).toBe("default");
});
