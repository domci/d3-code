import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { DraftId } from "~/composerDraftStore";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ newThread: vi.fn(), prepareThread: vi.fn() }));

vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.newThread }));
vi.mock("~/state/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({
    run: state.prepareThread,
    isAllowed: true,
    error: null,
  }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(() => "toast"), update: vi.fn() },
}));

import {
  canReusePullRequestHandoffWorkspace,
  usePullRequestHandoffs,
} from "./usePullRequestActions";

function setup() {
  state.newThread
    .mockReset()
    .mockResolvedValue({ draftId: DraftId.make("draft-1"), threadId: ThreadId.make("thread-1") });
  state.prepareThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      branch: "feature",
      worktreePath: "/repo/worktrees/feature",
      isOnPullRequestHead: true,
    },
  });
}

function Harness() {
  const handoffs = usePullRequestHandoffs({
    environmentId: EnvironmentId.make("env-1"),
    detail: {
      projectId: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
      url: "https://github.com/acme/app/pull/1",
    },
  });
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void handoffs.startHandoff("conflicts", { prompt: "resolve conflicts" }, "worktree", {
            branch: "feature",
            worktreePath: "/repo/worktrees/feature",
          })
        }
      >
        Keep workspace
      </button>
      <button
        type="button"
        onClick={() => void handoffs.startHandoff("conflicts", { prompt: "resolve conflicts" })}
      >
        Prepare checkout
      </button>
    </>
  );
}

it("reuses the source session worktree instead of preparing a checkout", async () => {
  setup();
  await using screen = await render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Keep workspace" }));
  await vi.waitFor(() => expect(state.newThread).toHaveBeenCalledTimes(1));
  expect(state.prepareThread).not.toHaveBeenCalled();
  expect(state.newThread).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("project-1"),
    }),
    {
      branch: "feature",
      worktreePath: "/repo/worktrees/feature",
      envMode: "worktree",
      startFromOrigin: false,
    },
  );
});

it("prepares a checkout when the source session has no workspace to keep", async () => {
  setup();
  await using screen = await render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Prepare checkout" }));
  await vi.waitFor(() => expect(state.prepareThread).toHaveBeenCalled());
  expect(state.newThread).toHaveBeenCalled();
});

it("canReusePullRequestHandoffWorkspace requires a branch or worktree", () => {
  expect(canReusePullRequestHandoffWorkspace(null)).toBe(false);
  expect(canReusePullRequestHandoffWorkspace({ branch: null, worktreePath: null })).toBe(false);
  expect(canReusePullRequestHandoffWorkspace({ branch: "feature", worktreePath: null })).toBe(true);
  expect(
    canReusePullRequestHandoffWorkspace({
      branch: "feature",
      worktreePath: "/repo/worktrees/feature",
    }),
  ).toBe(true);
});
