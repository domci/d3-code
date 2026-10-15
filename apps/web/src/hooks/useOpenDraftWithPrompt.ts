import type { ModelSelection, ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";

export interface DraftPromptOptions {
  readonly modelSelection: ModelSelection;
  readonly envMode: "local" | "worktree";
  readonly branch: string | null;
  readonly startFromOrigin: boolean;
}

/**
 * Opens a new draft thread on a project with `prompt` already in its composer, for the reader to
 * review and send. Resolves true once the draft is open, false if no draft could be opened.
 */
export function useOpenDraftWithPrompt(): (
  projectRef: ScopedProjectRef,
  prompt: string,
  options?: DraftPromptOptions,
) => Promise<boolean> {
  const newThread = useNewThreadHandler();
  return useCallback(
    async (projectRef, prompt, options) => {
      const session = await newThread(
        projectRef,
        options
          ? {
              envMode: options.envMode,
              branch: options.branch,
              worktreePath: null,
              startFromOrigin: options.startFromOrigin,
            }
          : undefined,
      ).then(
        (result) => result,
        () => null,
      );
      if (!session) return false;
      useComposerDraftStore.getState().setPrompt(session.draftId, prompt);
      if (options)
        useComposerDraftStore
          .getState()
          .setModelSelection(session.draftId, options.modelSelection, {
            explicit: true,
            replaceOptions: true,
          });
      return true;
    },
    [newThread],
  );
}
