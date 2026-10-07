import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

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
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <ProjectBoardPage
      search={search}
      onSelectProject={(project) =>
        void navigate({
          search: { environmentId: project.environmentId, projectId: project.id },
          replace: true,
        })
      }
    />
  );
}
