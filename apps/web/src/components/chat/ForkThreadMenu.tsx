import type { EnvironmentId } from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Where a fork's new worktree would branch from; null when the project is not a git repository. */
export interface ForkWorktreeSource {
  /** The project's workspace root, the repository the worktree is created in. */
  readonly cwd: string;
  /** Preselected base: the source thread's branch, when it has one. */
  readonly defaultBaseBranch: string | null;
}

/**
 * Fork button that asks where the fork should run: the source thread's worktree, or a new
 * worktree created from a base branch the user picks.
 */
export function ForkThreadMenu({
  environmentId,
  source,
  busy,
  label = "Fork from this response",
  onFork,
}: {
  environmentId: EnvironmentId;
  source: ForkWorktreeSource;
  busy: boolean;
  label?: string;
  onFork: (newWorktree?: { readonly baseBranch: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choosingBase, setChoosingBase] = useState(false);
  const [pickedBase, setPickedBase] = useState<string | null>(null);
  const baseBranch = pickedBase ?? source.defaultBaseBranch ?? "";
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setChoosingBase(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={label}
                />
              }
            />
          }
        >
          <GitForkIcon className={cn("size-3", busy && "animate-pulse")} />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="top" align="start" width="sm" padding="compact">
        {choosingBase ? (
          <div className="flex flex-col gap-2">
            <PopoverTitle>Base branch</PopoverTitle>
            <WorktreeBaseBranchPicker
              environmentId={environmentId}
              cwd={source.cwd}
              value={baseBranch}
              onValueChange={setPickedBase}
            />
            <Button
              type="button"
              size="sm"
              disabled={baseBranch === ""}
              onClick={() => {
                handleOpenChange(false);
                onFork({ baseBranch });
              }}
            >
              Fork
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                handleOpenChange(false);
                onFork();
              }}
            >
              Fork in same worktree
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => setChoosingBase(true)}
            >
              Fork into new worktree…
            </Button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
