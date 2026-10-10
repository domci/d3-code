import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectBoardPage, type ProjectBoardSearch } from "../components/board/ProjectBoardPage";

export const Route = createFileRoute("/_chat/board")({
  validateSearch: (raw: Record<string, unknown>): ProjectBoardSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
  }),
  component: BoardRouteView,
});

function BoardRouteView() {
  return <ProjectBoardPage search={Route.useSearch()} />;
}
