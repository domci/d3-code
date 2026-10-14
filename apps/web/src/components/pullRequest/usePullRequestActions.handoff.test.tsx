import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { DraftId } from "~/composerDraftStore";

const { newThread, prepareThread } = vi.hoisted(() => ({
  newThread: vi.fn(),
  prepareThread: vi.fn(),
}));

vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => newThread }));
vi.mock("~/lib/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({ run: prepareThread, isAllowed: true, error: null }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(() => "toast"), update: vi.fn() },
}));

import {
  canReusePullRequestHandoffWorkspace,
  usePullRequestHandoffs,
} from "./usePullRequestActions";

let latestHandoffs: ReturnType<typeof usePullRequestHandoffs> | null = null;

function Harness() {
  latestHandoffs = usePullRequestHandoffs({
    environmentId: EnvironmentId.make("env-1"),
    detail: {
      projectId: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
      url: "https://github.com/acme/app/pull/1",
    },
  });
  return null;
}

let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  latestHandoffs = null;
  newThread
    .mockReset()
    .mockResolvedValue({ draftId: DraftId.make("draft-1"), threadId: ThreadId.make("thread-1") });
  prepareThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      branch: "feature",
      worktreePath: "/repo/worktrees/feature",
      isOnPullRequestHead: true,
    },
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("reuses the source session worktree instead of preparing a checkout", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    await latestHandoffs!.startHandoff("conflicts", { prompt: "resolve conflicts" }, "worktree", {
      branch: "feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });
  expect(prepareThread).not.toHaveBeenCalled();
  expect(newThread).toHaveBeenCalledTimes(1);
  expect(newThread).toHaveBeenCalledWith(
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
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    await latestHandoffs!.startHandoff("conflicts", { prompt: "resolve conflicts" });
  });
  expect(prepareThread).toHaveBeenCalled();
  expect(newThread).toHaveBeenCalled();
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
