import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useOpenDraftWithPrompt } from "../../hooks/useOpenDraftWithPrompt";
import { useThreadShell } from "../../state/entities";
import { Button } from "../ui/button";

const DISMISSED_STORAGE_KEY = "t3code:dismissed-suggested-tasks";
// ponytail: dismissals live in this browser only and keep the newest 500; move them to the
// server if they should follow the user across devices.
const DISMISSED_LIMIT = 500;

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rememberDismissed(key: string): void {
  try {
    const next = [...readDismissed().filter((entry) => entry !== key), key];
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(next.slice(-DISMISSED_LIMIT)));
  } catch {
    // Storage unavailable: the card stays hidden until this view reloads.
  }
}

/** Identifies one suggestion within its thread, so dismissing it survives reloads. */
function suggestedTaskKey(threadId: string | undefined, task: SuggestedTask): string {
  return `${threadId ?? ""}\u0000${task.title}\u0000${task.prompt}`;
}

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
  const dismissKey = suggestedTaskKey(props.threadRef?.threadId, task);
  const [dismissed, setDismissed] = useState(() => readDismissed().includes(dismissKey));
  if (dismissed) return null;

  return (
    <div className="my-3 flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-4">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1 text-sm font-medium text-foreground">{task.title}</div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Dismiss suggestion"
          onClick={() => {
            rememberDismissed(dismissKey);
            setDismissed(true);
          }}
        >
          <XIcon />
        </Button>
      </div>
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
