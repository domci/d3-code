import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newThreadId, randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { vcsEnvironment } from "../state/vcs";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { buildThreadRouteParams } from "../threadRoutes";

export interface ForkThreadInput {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly title: string;
  /** Omit to fork from the source's latest stable run. */
  readonly runId?: RunId;
  readonly newWorktree?: { readonly baseBranch: string };
  /** Project root the new worktree is created from. */
  readonly projectCwd: string | undefined;
  /** Fork failures; null means the error carried no message. */
  readonly reportError: (message: string | null) => void;
}

/**
 * Forks a thread (from a run, or its latest stable point), optionally into a
 * new git worktree, and opens the fork. Shared by the chat's per-response fork
 * and the thread action menu.
 */
export function useForkThread() {
  const navigate = useNavigate();
  const forkThread = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const createGitWorktree = useAtomCommand(vcsEnvironment.createWorktree, {
    reportFailure: false,
  });
  const removeGitWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const runWorktreeSetup = useAtomCommand(threadEnvironment.runWorktreeSetup, {
    reportFailure: false,
  });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  return useCallback(
    async (input: ForkThreadInput) => {
      const { environmentId } = input;
      const targetThreadId = newThreadId();
      const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
      const result = await forkThread({
        environmentId,
        input: {
          sourceThreadId: input.sourceThreadId,
          targetThreadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          title: input.title,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          input.reportError(error instanceof Error ? error.message : null);
        }
        return;
      }
      const targetThreadReady = await waitForThreadShell(targetThreadRef);
      if (!targetThreadReady) {
        input.reportError(
          "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
        );
        return;
      }
      if (input.newWorktree) {
        // The fork exists on the source's worktree already, so a failure below still opens it.
        const projectCwd = input.projectCwd;
        const reasonOf = (failed: { readonly cause: Cause.Cause<unknown> }) => {
          const error = squashAtomCommandFailure(failed);
          return error instanceof Error ? error.message : "unknown error";
        };
        let setupFailure: string | null = null;
        if (!projectCwd) {
          setupFailure = "the project is unavailable";
        } else {
          const created = await createGitWorktree({
            environmentId,
            input: {
              cwd: projectCwd,
              refName: input.newWorktree.baseBranch,
              newRefName: buildTemporaryWorktreeBranchName(randomUUID),
              baseRefName: input.newWorktree.baseBranch,
              path: null,
            },
          });
          if (created._tag === "Failure") {
            setupFailure = reasonOf(created);
          } else {
            const { path, refName } = created.value.worktree;
            const pointed = await updateThreadMetadata({
              environmentId,
              input: { threadId: targetThreadId, branch: refName, worktreePath: path },
            });
            if (pointed._tag === "Failure") {
              setupFailure = reasonOf(pointed);
              void removeGitWorktree({
                environmentId,
                input: { cwd: projectCwd, path, force: true },
              });
            } else {
              // The fork keeps its new worktree if the script fails; only say so.
              const setup = await runWorktreeSetup({
                environmentId,
                input: { threadId: targetThreadId },
              });
              if (setup._tag === "Failure" && !isAtomCommandInterrupted(setup)) {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Worktree setup script did not start",
                    description: reasonOf(setup),
                  }),
                );
              }
            }
          }
        }
        if (setupFailure !== null) {
          // A toast, not the source thread's error banner: the fork is opened right below.
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Fork is using the original worktree",
              description: `Its new worktree could not be set up: ${setupFailure}`,
            }),
          );
        }
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetThreadRef),
      });
    },
    [
      createGitWorktree,
      forkThread,
      navigate,
      removeGitWorktree,
      runWorktreeSetup,
      updateThreadMetadata,
    ],
  );
}

/**
 * Reads the project checkout's git status (waiting briefly for the
 * subscription to warm up) for the thread menu: whether it is a git repo and
 * its current branch, the project's default base for a new worktree.
 */
export async function readProjectGitBranch(
  environmentId: EnvironmentId,
  cwd: string,
): Promise<{ readonly isRepo: boolean; readonly refName: string | null }> {
  const atom = vcsEnvironment.status({ environmentId, input: { cwd } });
  const read = () => Option.getOrNull(AsyncResult.value(appAtomRegistry.get(atom)));
  await waitForAtomValue({
    registry: appAtomRegistry,
    atom,
    predicate: (result) => Option.isSome(AsyncResult.value(result)),
    timeoutMs: 750,
  });
  const status = read();
  return { isRepo: status?.isRepo === true, refName: status?.refName ?? null };
}
