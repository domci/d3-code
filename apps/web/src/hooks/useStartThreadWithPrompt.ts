import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, RuntimeMode } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { vcsEnvironment } from "../state/vcs";
import { buildThreadRouteParams } from "../threadRoutes";
import { readProjectGitBranch } from "./useForkThread";
import type { DraftPromptOptions } from "./useOpenDraftWithPrompt";

export interface StartThreadOptions extends DraftPromptOptions {
  readonly runtimeMode: RuntimeMode;
  /** Worktree mode only: the batch's threads share one worktree per repository. */
  readonly sharedWorktree: boolean;
}

export interface StartThreadProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

/** A worktree that several threads of one batch run in. */
export interface SharedWorktree {
  readonly branch: string;
  readonly path: string;
}

const failureMessage = (failure: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error ? error.message : "unknown error";
};

/**
 * Starts a thread running `prompt` right away, without opening a draft. Worktree mode creates a
 * fresh worktree for the thread unless a `shared` one is passed. `createSharedWorktree` makes one
 * for a batch. Failures are toasted and reported as `false`/`null`.
 */
export function useStartThreadWithPrompt() {
  const navigate = useNavigate();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const runWorktreeSetup = useAtomCommand(threadEnvironment.runWorktreeSetup, {
    reportFailure: false,
  });

  /** The base is the picked branch, else the project checkout's current one. */
  const resolveBase = useCallback(
    async (project: StartThreadProject, branch: string | null) =>
      branch ?? (await readProjectGitBranch(project.environmentId, project.workspaceRoot)).refName,
    [],
  );

  const createSharedWorktree = useCallback(
    async (project: StartThreadProject, options: StartThreadOptions) => {
      const base = await resolveBase(project, options.branch);
      if (base === null) {
        toastManager.add({ type: "error", title: "Select a base branch for the new worktree" });
        return null;
      }
      const created = await createWorktree({
        environmentId: project.environmentId,
        input: {
          cwd: project.workspaceRoot,
          refName: options.startFromOrigin ? `origin/${base}` : base,
          newRefName: buildTemporaryWorktreeBranchName(randomUUID),
          baseRefName: base,
          path: null,
        },
      });
      if (created._tag === "Failure") {
        if (!isAtomCommandInterrupted(created))
          toastManager.add({
            type: "error",
            title: "Could not create the shared worktree",
            description: failureMessage(created),
          });
        return null;
      }
      const { path, refName } = created.value.worktree;
      return { branch: refName, path } satisfies SharedWorktree;
    },
    [createWorktree, resolveBase],
  );

  const startThread = useCallback(
    async (input: {
      readonly project: StartThreadProject;
      readonly prompt: string;
      readonly title: string;
      readonly options: StartThreadOptions;
      /** Run in this worktree instead of creating one; `setup` runs its setup script once. */
      readonly shared?: SharedWorktree & { readonly setup: boolean };
      readonly open: boolean;
    }) => {
      const { project, options, shared } = input;
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const worktree = shared === undefined && options.envMode === "worktree";
      const base = worktree ? await resolveBase(project, options.branch) : null;
      if (worktree && base === null) {
        toastManager.add({ type: "error", title: "Select a base branch for the new worktree" });
        return false;
      }
      const result = await startTurn({
        environmentId: project.environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: options.modelSelection,
          titleSeed: input.title,
          runtimeMode: options.runtimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title: input.title,
              modelSelection: options.modelSelection,
              runtimeMode: options.runtimeMode,
              interactionMode: "default",
              branch: shared?.branch ?? base,
              worktreePath: shared?.path ?? null,
              createdAt,
            },
            ...(worktree
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch: base!,
                    requireWorktree: true,
                    ...(options.startFromOrigin ? { startFromOrigin: true } : {}),
                  },
                  runSetupScript: true,
                }
              : {}),
          },
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          toastManager.add({
            type: "error",
            title: `Could not start ${input.title}`,
            description: failureMessage(result),
          });
        return false;
      }
      if (shared?.setup) {
        const setup = await runWorktreeSetup({
          environmentId: project.environmentId,
          input: { threadId },
        });
        if (setup._tag === "Failure" && !isAtomCommandInterrupted(setup))
          toastManager.add({
            type: "error",
            title: "Worktree setup script did not start",
            description: failureMessage(setup),
          });
      }
      if (input.open)
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(project.environmentId, threadId)),
        });
      return true;
    },
    [navigate, resolveBase, runWorktreeSetup, startTurn],
  );

  return { startThread, createSharedWorktree };
}
