import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useOpenDraftWithPrompt } from "../../hooks/useOpenDraftWithPrompt";
import { useThreadShell } from "../../state/entities";
import { Button } from "../ui/button";

export interface SuggestedTask {
  readonly title: string;
  readonly summary: string;
  readonly prompt: string;
}

/** The body of a `t3-task` fence, or null while it is not a complete task. */
export function parseSuggestedTask(code: string): SuggestedTask | null {
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { title, summary, prompt } = value as Record<string, unknown>;
  if (typeof title !== "string" || title.trim() === "") return null;
  if (typeof prompt !== "string" || prompt.trim() === "") return null;
  return { title, summary: typeof summary === "string" ? summary : "", prompt };
}

/**
 * An agent's proposed follow-up task, with a button that opens it as a draft thread in the
 * project of the thread the message belongs to.
 */
export function SuggestedTaskCard(props: {
  readonly task: SuggestedTask;
  readonly threadRef: ScopedThreadRef | undefined;
}) {
  const { task } = props;
  const openDraft = useOpenDraftWithPrompt();
  const [opening, setOpening] = useState(false);
  const thread = useThreadShell(props.threadRef ?? null);
  const projectRef = thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null;

  return (
    <div className="my-3 flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-4">
      <div className="min-w-0 text-sm font-medium text-foreground">{task.title}</div>
      {task.summary ? <p className="text-sm text-muted-foreground">{task.summary}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={projectRef === null || opening}
          onClick={() => {
            if (projectRef === null) return;
            setOpening(true);
            void openDraft(projectRef, task.prompt).finally(() => setOpening(false));
          }}
        >
          Start thread
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.threadRef === undefined}
          onClick={() => {
            const threadRef = props.threadRef;
            if (threadRef === undefined) return;
            // Leaves the task in this thread's composer for the reader to review and send,
            // after whatever they have already typed.
            const store = useComposerDraftStore.getState();
            const current = store.getComposerDraft(threadRef)?.prompt ?? "";
            store.setPrompt(
              threadRef,
              current.trim() === "" ? task.prompt : `${current.trimEnd()}\n\n${task.prompt}`,
            );
          }}
        >
          Add to this session
        </Button>
      </div>
    </div>
  );
}
