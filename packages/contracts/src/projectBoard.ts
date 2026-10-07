import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What a token without the `project` scope is told to run. Shared so the UI can show it as code. */
export const PROJECT_BOARD_SCOPE_COMMAND = "gh auth refresh -s project -s read:org -s repo";

export const ProjectBoardInput = Schema.Struct({
  /** The T3 project's workspace root; its git remote names the GitHub repository. */
  cwd: TrimmedNonEmptyString,
  /** Which linked GitHub Project to read. Absent means the first one. */
  projectNumber: Schema.optional(PositiveInt),
});
export type ProjectBoardInput = typeof ProjectBoardInput.Type;

export const ProjectBoardProject = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
});
export type ProjectBoardProject = typeof ProjectBoardProject.Type;

export const ProjectBoardColumn = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
});
export type ProjectBoardColumn = typeof ProjectBoardColumn.Type;

export const ProjectBoardItemKind = Schema.Literals(["issue", "pull_request", "draft"]);
export type ProjectBoardItemKind = typeof ProjectBoardItemKind.Type;

export const ProjectBoardItemState = Schema.Literals(["open", "closed", "merged"]);
export type ProjectBoardItemState = typeof ProjectBoardItemState.Type;

export const ProjectBoardLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
});
export type ProjectBoardLabel = typeof ProjectBoardLabel.Type;

export const ProjectBoardAssignee = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.String,
});
export type ProjectBoardAssignee = typeof ProjectBoardAssignee.Type;

export const ProjectBoardItem = Schema.Struct({
  itemId: Schema.String,
  kind: ProjectBoardItemKind,
  number: Schema.NullOr(Schema.Int),
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  state: Schema.NullOr(ProjectBoardItemState),
  statusOptionId: Schema.NullOr(Schema.String),
  labels: Schema.Array(ProjectBoardLabel),
  assignees: Schema.Array(ProjectBoardAssignee),
  repository: Schema.NullOr(Schema.String),
});
export type ProjectBoardItem = typeof ProjectBoardItem.Type;

export const ProjectBoard = Schema.Struct({
  projectId: Schema.String,
  projectNumber: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  /** Null when the project has no single-select "Status" field; the board is then read-only. */
  statusFieldId: Schema.NullOr(Schema.String),
  columns: Schema.Array(ProjectBoardColumn),
  items: Schema.Array(ProjectBoardItem),
  /** The project holds more items than were read. */
  truncated: Schema.Boolean,
});
export type ProjectBoard = typeof ProjectBoard.Type;

export const ProjectBoardResult = Schema.Struct({
  /** GitHub Projects linked to the repository (the first 20). */
  projects: Schema.Array(ProjectBoardProject),
  /** The chosen project, or null when the repository has none linked. */
  board: Schema.NullOr(ProjectBoard),
});
export type ProjectBoardResult = typeof ProjectBoardResult.Type;

export const MoveProjectBoardItemInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  itemId: TrimmedNonEmptyString,
  fieldId: TrimmedNonEmptyString,
  /** The Status option to move to; null clears the Status. */
  optionId: Schema.NullOr(TrimmedNonEmptyString),
});
export type MoveProjectBoardItemInput = typeof MoveProjectBoardItemInput.Type;

export const ProjectBoardErrorReason = Schema.Literals([
  /** The token lacks the `project` scope; running `PROJECT_BOARD_SCOPE_COMMAND` fixes it. */
  "scope_missing",
  "not_github_repository",
  "failed",
]);
export type ProjectBoardErrorReason = typeof ProjectBoardErrorReason.Type;

export class ProjectBoardError extends Schema.TaggedError<ProjectBoardError>()(
  "ProjectBoardError",
  {
    operation: Schema.String,
    reason: ProjectBoardErrorReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "scope_missing"
      ? `Run \`${PROJECT_BOARD_SCOPE_COMMAND}\` to grant GitHub Projects access.`
      : this.detail;
  }
}
