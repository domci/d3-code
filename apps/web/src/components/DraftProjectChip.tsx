import type { EnvironmentId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useScratchProject } from "~/hooks/useScratchProject";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { useProjects } from "~/state/entities";
import type { DraftId } from "../composerDraftStore";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ComposerControl } from "./chat/ComposerControl";
import { useSelectDraftProject } from "./chat/DraftHeroHeadline";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "./ui/combobox";

/** Chip that lists the selected environment's projects and moves the draft to the picked one. */
export const DraftProjectChip = memo(function DraftProjectChip({
  draftId,
  environmentId,
  projectId,
  disabled,
}: {
  draftId: DraftId;
  environmentId: EnvironmentId;
  projectId: string;
  disabled: boolean;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { scratchWorkspaceRootFor } = useScratchProject();
  const selectDraftProject = useSelectDraftProject(draftId);
  const [query, setQuery] = useState("");
  const scratchRoot = scratchWorkspaceRootFor(environmentId);
  const options = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.environmentId === environmentId && !isScratchProject(project, scratchRoot),
        )
        .map((project) => ({
          project,
          key: deriveLogicalProjectKeyFromSettings(project, groupingSettings),
        })),
    [environmentId, groupingSettings, projects, scratchRoot],
  );
  const active = options.find(({ project }) => project.id === projectId);
  const needle = query.trim().toLowerCase();
  const filtered = options.filter(({ project }) => project.title.toLowerCase().includes(needle));
  const label = active?.project.title ?? "Project";
  const content = (
    <>
      <FolderIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </>
  );

  if (disabled) {
    return (
      <span
        className="inline-flex h-6 min-w-0 items-center gap-1 px-1.75"
        data-composer-context-control
      >
        {content}
      </span>
    );
  }
  return (
    <Combobox
      items={filtered.map(({ key }) => key)}
      filteredItems={filtered.map(({ key }) => key)}
      autoHighlight
      value={active?.key ?? null}
      onValueChange={(key) => {
        const next = options.find((option) => option.key === key);
        if (next && next.project.id !== projectId) selectDraftProject(next.project, next.key);
      }}
      onOpenChange={() => setQuery("")}
    >
      <ComboboxTrigger
        render={<ComposerControl size="xs" />}
        className="min-w-0 max-w-full"
        aria-label="Project"
      >
        {content}
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" side="top" className="w-72" {...composerFloatingLayerProps}>
        <ComboboxSearchInput
          placeholder="Search projects..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No projects found.</ComboboxEmpty>
        <ComboboxList className="max-h-56 overflow-x-hidden">
          {filtered.map(({ project, key }) => (
            <ComboboxItem key={key} value={key} hideIndicator>
              <span className="min-w-0 truncate">{project.title}</span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
});
