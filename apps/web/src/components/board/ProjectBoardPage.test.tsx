import { createContext, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ProjectBoard } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  move: vi.fn(),
  close: vi.fn(),
  openDraft: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));
const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const projects = [
  {
    id: projectId,
    environmentId,
    title: "Web",
    workspaceRoot: "/work/web",
    repositoryIdentity: {
      provider: "github",
      canonicalKey: "github.com/acme/web",
      owner: "acme",
      name: "web",
    },
  },
];
const board: ProjectBoard = {
  projectId: "board",
  projectNumber: 1,
  title: "Work",
  url: "https://github.com/orgs/acme/projects/1",
  statusFieldId: "status",
  truncated: false,
  columns: [
    { optionId: "todo", name: "Todo", color: null },
    { optionId: "done", name: "Done", color: null },
  ],
  items: ["First", "Second"].map((title, index) => ({
    itemId: String(index),
    kind: "issue",
    number: index + 1,
    title,
    url: `https://github.com/acme/web/issues/${index + 1}`,
    state: "open",
    statusOptionId: "todo",
    labels: [],
    assignees: [],
    repository: "acme/web",
  })),
};
const registry = AtomRegistry.make();
vi.mock("@effect/atom-react", () => ({
  RegistryContext: createContext({ refresh: state.refresh }),
  useAtomValue: (atom: Atom.Atom<unknown>) => registry.get(atom),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => projects,
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    projectBoard: () => Atom.make(AsyncResult.success({ board })),
    moveProjectBoardItem: Object.assign(state.move, { permissionAtom: () => Atom.make(true) }),
    setProjectBoardIssueState: Object.assign(state.close, {
      permissionAtom: () => Atom.make(true),
    }),
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../hooks/useOpenDraftWithPrompt", () => ({
  useOpenDraftWithPrompt: () => state.openDraft,
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../localApi", () => ({ readLocalApi: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "checkbox" }));
vi.mock("../ui/menu", () => ({
  Menu: "menu",
  MenuTrigger: "menu-trigger",
  MenuPopup: "menu-popup",
  MenuCheckboxItem: "menu-checkbox",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogPopup: "dialog",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogFooter: "footer",
}));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "nav",
  WorkspaceBreadcrumbItem: "span",
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../pullRequest/pullRequestPresentation", () => ({
  PullRequestActorAvatar: () => null,
  PullRequestLabelChip: () => null,
}));
vi.mock("./BoardThreadSetup", () => ({
  BoardThreadSetup: ({
    onCreate,
  }: {
    onCreate: (options: Map<EnvironmentId, unknown>) => void;
  }) => (
    <button
      onClick={() =>
        onCreate(
          new Map([
            [
              environmentId,
              {
                modelSelection: { instanceId: "codex", model: "shared-model" },
                envMode: "worktree",
                branch: "main",
                startFromOrigin: true,
              },
            ],
          ]),
        )
      }
    >
      Create separate drafts
    </button>
  ),
}));

import { ProjectBoardPage } from "./ProjectBoardPage";

let view: ReactTestRenderer;
const button = (label: string) =>
  view.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const checkbox = (title: string) => view.root.findByProps({ "aria-label": `Select ${title}` });
const selectBoth = async () => {
  await act(async () => {
    checkbox("First").props.onCheckedChange(true);
    checkbox("Second").props.onCheckedChange(true);
  });
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.move.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.close.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openDraft.mockReset().mockResolvedValue(true);
  state.refresh.mockClear();
  state.toast.mockClear();
  await act(async () => {
    view = create(<ProjectBoardPage search={{}} />);
  });
});
afterEach(async () => {
  await act(async () => view.unmount());
  vi.unstubAllGlobals();
});

describe("board batch actions", () => {
  it("moves the selection even when the browser does not return the custom drag payload", async () => {
    await selectBoth();
    await act(async () => {
      view.root.findAllByType("li")[0]!.props.onDragStart({
        dataTransfer: { setData() {} },
      });
    });
    const acceptDrop = vi.fn();
    await act(async () => {
      view.root.findByProps({ "aria-label": "Done" }).props.onDragOver({
        preventDefault: acceptDrop,
        dataTransfer: {},
      });
    });
    expect(acceptDrop).toHaveBeenCalledOnce();
    await act(async () => {
      view.root.findByProps({ "aria-label": "Done" }).props.onDrop({
        preventDefault() {},
        dataTransfer: { getData: () => "" },
      });
    });
    expect(state.move.mock.calls.map(([call]) => [call.input.itemId, call.input.optionId])).toEqual(
      [
        ["0", "done"],
        ["1", "done"],
      ],
    );
    expect(checkbox("First").props.checked).toBe(false);
    expect(checkbox("Second").props.checked).toBe(false);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("moves only the dragged card when it is outside the selection", async () => {
    await act(async () => {
      checkbox("First").props.onCheckedChange(true);
    });
    await act(async () => {
      view.root.findAllByType("li")[1]!.props.onDragStart({ dataTransfer: { setData() {} } });
    });
    await act(async () => {
      view.root.findByProps({ "aria-label": "Done" }).props.onDrop({ preventDefault() {} });
    });
    expect(state.move.mock.calls.map(([call]) => call.input.itemId)).toEqual(["1"]);
    expect(checkbox("First").props.checked).toBe(true);
  });

  it("keeps a failed issue selected while finishing the rest of the close batch", async () => {
    state.close.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Denied"))));
    await selectBoth();
    await act(async () => {
      button("Close issues (2)").props.onClick();
    });
    expect(state.close.mock.calls.map(([call]) => call.input.itemId)).toEqual(["0", "1"]);
    expect(checkbox("First").props.checked).toBe(true);
    expect(checkbox("Second").props.checked).toBe(false);
    expect(state.toast).toHaveBeenCalledTimes(1);
  });

  it("asks how to group cards and combines both issues in one normal draft", async () => {
    await selectBoth();
    await act(async () => {
      button("Start threads").props.onClick();
    });
    expect(state.openDraft).not.toHaveBeenCalled();
    await act(async () => {
      button("One thread").props.onClick();
    });
    expect(state.openDraft).toHaveBeenCalledTimes(1);
    const [project, prompt] = state.openDraft.mock.calls[0]!;
    expect(project).toEqual({ environmentId, projectId });
    expect(prompt).toContain("https://github.com/acme/web/issues/1");
    expect(prompt).toContain("https://github.com/acme/web/issues/2");
  });

  it("opens one draft per issue using the same shared setup", async () => {
    await selectBoth();
    await act(async () => {
      button("Start threads").props.onClick();
    });
    await act(async () => {
      button("Separate threads").props.onClick();
    });
    expect(state.openDraft).not.toHaveBeenCalled();
    await act(async () => {
      button("Create separate drafts").props.onClick();
    });
    expect(state.openDraft).toHaveBeenCalledTimes(2);
    const first = state.openDraft.mock.calls[0]!;
    const second = state.openDraft.mock.calls[1]!;
    expect(first[1]).toContain("issues/1");
    expect(first[1]).not.toContain("issues/2");
    expect(second[1]).toContain("issues/2");
    expect(second[1]).not.toContain("issues/1");
    expect(first[2]).toEqual({
      modelSelection: { instanceId: "codex", model: "shared-model" },
      envMode: "worktree",
      branch: "main",
      startFromOrigin: true,
    });
    expect(second[2]).toEqual(first[2]);
  });
});
