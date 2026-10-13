import { useDroppable } from "@dnd-kit/core";
import { ChevronRightIcon, FolderIcon, MoreHorizontalIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { create } from "zustand";
import {
  AuthOrchestrationOperateScope,
  type ProjectThreadFolder,
  type ProjectThreadFolderOperation,
} from "@t3tools/contracts";
import { scopedProjectKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { Project } from "../../types";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useEnvironmentScope } from "../../state/session";
import { ensureLocalApi } from "../../localApi";
import { cn, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

interface SidebarThreadFolder {
  key: string;
  project: Project;
  folder: ProjectThreadFolder;
}

// Shared with keyboard navigation; collapse state stays local to this client.
export const useThreadFolderExpansion = create<{
  collapsed: ReadonlySet<string>;
  setExpanded: (key: string, expanded: boolean) => void;
}>((set) => ({
  collapsed: new Set(),
  setExpanded: (key, expanded) =>
    set((state) => {
      if (state.collapsed.has(key) === !expanded) return state;
      const collapsed = new Set(state.collapsed);
      if (expanded) collapsed.delete(key);
      else collapsed.add(key);
      return { collapsed };
    }),
}));

export function buildSidebarThreadFolders(projects: readonly Project[]) {
  const folders = projects.flatMap((project) =>
    (project.threadFolders ?? []).map((folder) => ({
      key: JSON.stringify([
        scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
        folder.id,
      ]),
      project,
      folder,
    })),
  );
  const folderByThreadKey = new Map(
    folders.flatMap((entry) =>
      entry.folder.threadIds.map(
        (threadId) =>
          [
            scopedThreadKey({ environmentId: entry.project.environmentId, threadId }),
            entry.key,
          ] as const,
      ),
    ),
  );
  return { folders, folderByThreadKey };
}

export function useProjectThreadFolders(projects: readonly Project[]) {
  const update = useOrchestrationCommand(projectEnvironment.update, { reportFailure: false });
  const [editor, setEditor] = useState<{ project: Project; folder?: ProjectThreadFolder } | null>(
    null,
  );
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const { folders, folderByThreadKey } = useMemo(
    () => buildSidebarThreadFolders(projects),
    [projects],
  );
  const run = useCallback(
    async (project: Project, operation: ProjectThreadFolderOperation) => {
      const result = await update({
        environmentId: project.environmentId,
        input: { projectId: project.id, threadFolderOperation: operation },
      });
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not update folder",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
      return false;
    },
    [update],
  );
  const edit = useCallback((project: Project, folder?: ProjectThreadFolder) => {
    setName(folder?.name ?? "");
    setEditor({ project, ...(folder ? { folder } : {}) });
  }, []);
  const save = async () => {
    if (!editor || saving || !name.trim()) return;
    setSaving(true);
    try {
      if (
        await run(
          editor.project,
          editor.folder
            ? { type: "rename", id: editor.folder.id, name: name.trim() }
            : { type: "create", id: randomUUID(), name: name.trim() },
        )
      )
        setEditor(null);
    } finally {
      setSaving(false);
    }
  };
  return {
    folders,
    folderByThreadKey,
    run,
    edit,
    dialog: (
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditor(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{editor?.folder ? "Rename folder" : "New folder"}</DialogTitle>
            <DialogDescription>Organize threads in {editor?.project.title}.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              autoFocus
              aria-label="Folder name"
              maxLength={100}
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button disabled={saving || !name.trim()} onClick={() => void save()}>
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    ),
  };
}

export function ProjectThreadFolderRow({
  entry,
  expanded,
  count,
  onToggle,
  onRename,
  onDelete,
}: {
  entry: SidebarThreadFolder;
  expanded: boolean;
  count: number;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const canOperate = useEnvironmentScope(
    entry.project.environmentId,
    AuthOrchestrationOperateScope,
  );
  const { setNodeRef, isOver } = useDroppable({ id: entry.key, disabled: !canOperate });
  const menu = async (position: { x: number; y: number }) => {
    const action = await ensureLocalApi().contextMenu.show(
      [
        { id: "rename", label: "Rename folder", disabled: !canOperate },
        { id: "delete", label: "Delete folder (keep threads)", disabled: !canOperate },
      ],
      position,
    );
    if (action === "rename") onRename();
    if (action === "delete") onDelete();
  };
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      className={cn(
        "flex items-center rounded-md text-sm text-sidebar-foreground",
        isOver && "bg-accent ring-1 ring-primary",
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        void menu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRightIcon className={cn("size-3 shrink-0", expanded && "rotate-90")} />
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="truncate">{entry.folder.name}</span>
        <span className="text-xs text-muted-foreground">{count}</span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Actions for folder ${entry.folder.name}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          void menu({ x: rect.left, y: rect.bottom });
        }}
      >
        <MoreHorizontalIcon />
      </Button>
    </li>
  );
}

export function ProjectThreadRootDropTarget({
  project,
  label,
}: {
  project: Project;
  label: string;
}) {
  const canOperate = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-root:${scopedProjectKey({ environmentId: project.environmentId, projectId: project.id })}`,
    disabled: !canOperate,
  });
  return (
    <li
      ref={setNodeRef}
      className={cn(
        "rounded-md px-2 py-2 text-xs text-muted-foreground",
        isOver && "bg-accent ring-1 ring-primary",
      )}
    >
      {label}
    </li>
  );
}
