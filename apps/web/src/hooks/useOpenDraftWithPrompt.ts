import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";

/**
 * Opens a new draft thread on a project with `prompt` already in its composer, for the reader to
 * review and send. Resolves true once the draft is open, false if no draft could be opened.
 */
export function useOpenDraftWithPrompt(): (
  projectRef: ScopedProjectRef,
  prompt: string,
) => Promise<boolean> {
  const newThread = useNewThreadHandler();
  return useCallback(
    async (projectRef, prompt) => {
      const session = await newThread(projectRef).then(
        (result) => result,
        () => null,
      );
      if (!session) return false;
      useComposerDraftStore.getState().setPrompt(session.draftId, prompt);
      return true;
    },
    [newThread],
  );
}
