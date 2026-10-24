import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("places fork items right after Rename and gates them", () => {
    expect(buildThreadActionMenuItems(baseState).map((item) => item.id)).not.toContain("fork-here");
    const fork = { canFork: true, worktreeBaseBranch: "main" };
    const items = buildThreadActionMenuItems({ ...baseState, fork });
    const renameIndex = items.findIndex((item) => item.id === "rename");
    expect(items.slice(renameIndex + 1, renameIndex + 3)).toMatchObject([
      { id: "fork-here", label: "Fork here", disabled: false },
      { id: "fork-in-worktree", label: "Fork in new worktree…", disabled: false },
    ]);
    const blocked = buildThreadActionMenuItems({
      ...baseState,
      fork: { canFork: false, worktreeBaseBranch: null },
    });
    expect(blocked.find((item) => item.id === "fork-here")?.disabled).toBe(true);
    expect(blocked.map((item) => item.id)).not.toContain("fork-in-worktree");
    const running = buildThreadActionMenuItems({ ...baseState, isRunning: true, fork });
    expect(running.find((item) => item.id === "fork-here")?.disabled).toBe(false);
    expect(running.find((item) => item.id === "fork-in-worktree")?.disabled).toBe(false);
  });

  it("offers working directory and branch name copies, branch only when present", () => {
    const copyChildren = (branch: string | null) =>
      buildThreadActionMenuItems({ ...baseState, branch }).find((item) => item.id === "copy")
        ?.children;
    expect(copyChildren(null)?.map((c) => c.label)).toEqual(["Working directory", "Thread ID"]);
    expect(copyChildren("main")?.map((c) => c.label)).toEqual([
      "Working directory",
      "Branch name",
      "Thread ID",
    ]);
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});
