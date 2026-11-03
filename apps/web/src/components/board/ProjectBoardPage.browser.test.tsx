import { createContext, type ReactNode } from "react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, type ProjectBoard } from "@t3tools/contracts";

import { render, type Screen } from "../../../test/render";

const state = vi.hoisted(() => ({
  move: vi.fn(),
  close: vi.fn(),
  openDraft: vi.fn(),
  start: vi.fn(),
  createWorktree: vi.fn(),
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
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
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
vi.mock("../../hooks/useStartThreadWithPrompt", () => ({
  useStartThreadWithPrompt: () => ({
    startThread: state.start,
    createSharedWorktree: state.createWorktree,
  }),
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../localApi", () => ({ readLocalApi: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
    "aria-label": label,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    "aria-label": string;
  }) => (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogPopup: "div",
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
    onSubmit,
  }: {
    onSubmit: (options: Map<EnvironmentId, unknown>, start: boolean) => void;
  }) => {
    const setup = (sharedWorktree: boolean) =>
      new Map([
        [
          environmentId,
          {
            modelSelection: { instanceId: "codex", model: "shared-model" },
            envMode: "worktree",
            branch: "main",
            startFromOrigin: true,
            runtimeMode: "full-access",
            sharedWorktree,
          },
        ],
      ]);
    return (
      <>
        <button onClick={() => onSubmit(setup(false), false)}>Open as draft</button>
        <button onClick={() => onSubmit(setup(false), true)}>Start</button>
        <button onClick={() => onSubmit(setup(true), true)}>Start shared</button>
      </>
    );
  },
}));

import { ProjectBoardPage } from "./ProjectBoardPage";

function setup() {
  state.move.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.close.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openDraft.mockReset().mockResolvedValue(true);
  state.start.mockReset().mockResolvedValue(true);
  state.createWorktree.mockReset().mockResolvedValue({ branch: "tmp", path: "/work/tmp" });
  state.refresh.mockClear();
  state.toast.mockClear();
}

const renderBoard = () => render(<ProjectBoardPage search={{}} />);
const button = (screen: Screen, label: string) =>
  screen.getByRole("button", { name: label, exact: true });
const checkbox = (screen: Screen, title: string) =>
  screen.getByRole("checkbox", { name: `Select ${title}`, exact: true });
const selectBoth = async (screen: Screen) => {
  await userEvent.click(checkbox(screen, "First"));
  await userEvent.click(checkbox(screen, "Second"));
};
const drag = (target: Element, type: "dragstart" | "dragover" | "drop") =>
  target.dispatchEvent(
    new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: new DataTransfer(),
    }),
  );
const card = (screen: Screen, index: number) => screen.getByRole("listitem").nth(index).element();
const doneColumn = (screen: Screen) => screen.getByRole("region", { name: "Done" }).element();

describe("board batch actions", () => {
  it("moves the selection even when the browser does not return the custom drag payload", async () => {
    setup();
    await using screen = await renderBoard();
    await selectBoth(screen);
    drag(card(screen, 0), "dragstart");
    // A cancelled dragover is what lets the browser drop here.
    await vi.waitFor(() => expect(drag(doneColumn(screen), "dragover")).toBe(false));
    drag(doneColumn(screen), "drop");
    await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
    expect(state.move.mock.calls.map(([call]) => [call.input.itemId, call.input.optionId])).toEqual(
      [
        ["0", "done"],
        ["1", "done"],
      ],
    );
    await expect.element(checkbox(screen, "First")).not.toBeChecked();
    await expect.element(checkbox(screen, "Second")).not.toBeChecked();
  });

  it("moves only the dragged card when it is outside the selection", async () => {
    setup();
    await using screen = await renderBoard();
    await userEvent.click(checkbox(screen, "First"));
    drag(card(screen, 1), "dragstart");
    await vi.waitFor(() => expect(drag(doneColumn(screen), "dragover")).toBe(false));
    drag(doneColumn(screen), "drop");
    await vi.waitFor(() =>
      expect(state.move.mock.calls.map(([call]) => call.input.itemId)).toEqual(["1"]),
    );
    await expect.element(checkbox(screen, "First")).toBeChecked();
  });

  it("keeps a failed issue selected while finishing the rest of the close batch", async () => {
    setup();
    state.close.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Denied"))));
    await using screen = await renderBoard();
    await selectBoth(screen);
    await userEvent.click(button(screen, "Close issues (2)"));
    await expect.element(checkbox(screen, "Second")).not.toBeChecked();
    expect(state.close.mock.calls.map(([call]) => call.input.itemId)).toEqual(["0", "1"]);
    await expect.element(checkbox(screen, "First")).toBeChecked();
    expect(state.toast).toHaveBeenCalledTimes(1);
  });

  const chooseGrouping = (screen: Screen, value: "one" | "separate") =>
    userEvent.selectOptions(screen.getByRole("combobox", { name: "Threads" }), value);
  const chosenOptions = {
    modelSelection: { instanceId: "codex", model: "shared-model" },
    envMode: "worktree",
    branch: "main",
    startFromOrigin: true,
    runtimeMode: "full-access",
    sharedWorktree: false,
  };

  it("opens both issues in one draft by default", async () => {
    setup();
    await using screen = await renderBoard();
    await selectBoth(screen);
    await userEvent.click(button(screen, "Start threads"));
    expect(state.openDraft).not.toHaveBeenCalled();
    await userEvent.click(button(screen, "Open as draft"));
    await vi.waitFor(() => expect(state.openDraft).toHaveBeenCalledTimes(1));
    const [project, prompt, options] = state.openDraft.mock.calls[0]!;
    expect(project).toEqual({ environmentId, projectId });
    expect(prompt).toContain("https://github.com/acme/web/issues/1");
    expect(prompt).toContain("https://github.com/acme/web/issues/2");
    expect(options).toEqual(chosenOptions);
  });

  it("opens one draft per issue using the same shared setup", async () => {
    setup();
    await using screen = await renderBoard();
    await selectBoth(screen);
    await userEvent.click(button(screen, "Start threads"));
    await chooseGrouping(screen, "separate");
    await userEvent.click(button(screen, "Open as draft"));
    await vi.waitFor(() => expect(state.openDraft).toHaveBeenCalledTimes(2));
    const first = state.openDraft.mock.calls[0]!;
    const second = state.openDraft.mock.calls[1]!;
    expect(first[1]).toContain("issues/1");
    expect(first[1]).not.toContain("issues/2");
    expect(second[1]).toContain("issues/2");
    expect(second[1]).not.toContain("issues/1");
    expect(first[2]).toEqual(chosenOptions);
    expect(second[2]).toEqual(first[2]);
  });

  it("starts one thread for both issues right away", async () => {
    setup();
    await using screen = await renderBoard();
    await selectBoth(screen);
    await userEvent.click(button(screen, "Start threads"));
    await userEvent.click(button(screen, "Start"));
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
    expect(state.openDraft).not.toHaveBeenCalled();
    const [input] = state.start.mock.calls[0]!;
    expect(input.title).toBe("First +1");
    expect(input.prompt).toContain("issues/1");
    expect(input.prompt).toContain("issues/2");
    expect(input.open).toBe(true);
    expect(input.shared).toBeUndefined();
    await expect.element(checkbox(screen, "First")).not.toBeChecked();
  });

  it("starts a thread per issue in their own worktrees, or in one shared worktree", async () => {
    setup();
    await using screen = await renderBoard();
    await selectBoth(screen);
    await userEvent.click(button(screen, "Start threads"));
    await chooseGrouping(screen, "separate");
    await userEvent.click(button(screen, "Start"));
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
    expect(state.createWorktree).not.toHaveBeenCalled();
    expect(state.start.mock.calls.map(([call]) => [call.title, call.shared, call.open])).toEqual([
      ["First", undefined, false],
      ["Second", undefined, false],
    ]);

    await expect.element(checkbox(screen, "First")).not.toBeChecked();
    await selectBoth(screen);
    await userEvent.click(button(screen, "Start threads"));
    await chooseGrouping(screen, "separate");
    state.start.mockClear();
    await userEvent.click(button(screen, "Start shared"));
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
    expect(state.createWorktree).toHaveBeenCalledTimes(1);
    expect(state.start.mock.calls.map(([call]) => call.shared)).toEqual([
      { branch: "tmp", path: "/work/tmp", setup: true },
      { branch: "tmp", path: "/work/tmp", setup: false },
    ]);
  });
});
