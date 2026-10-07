import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ProjectBoardError,
  type MoveProjectBoardItemInput,
  type ProjectBoard,
  type ProjectBoardInput,
  type ProjectBoardItem,
  type ProjectBoardProject,
  type ProjectBoardResult,
} from "@t3tools/contracts";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubApi from "./GitHubApi.ts";
import { gitHubApiHostForRemote } from "./GitHubCli.ts";

/**
 * GitHub Projects (v2) boards for a repository's linked projects. Two typed operations rather
 * than a GraphQL passthrough: read the board, and move one card between Status columns.
 */
export class GitHubProjectBoard extends Context.Service<
  GitHubProjectBoard,
  {
    readonly getProjectBoard: (
      input: ProjectBoardInput,
    ) => Effect.Effect<ProjectBoardResult, ProjectBoardError>;
    readonly moveItem: (input: MoveProjectBoardItemInput) => Effect.Effect<void, ProjectBoardError>;
  }
>()("t3/sourceControl/GitHubProjectBoard") {}

const LINKED_PROJECTS_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    projectsV2(first:20){ nodes{ id number title url } }
  }
}`;

const CONTENT_FIELDS = `number title url repository{ nameWithOwner }
  assignees(first:5){ nodes{ login avatarUrl } }
  labels(first:10){ nodes{ name color } }`;

// ponytail: first 100 items only; add cursor paging if boards grow past that.
const BOARD_ITEMS = `items(first:100){
  pageInfo{ hasNextPage }
  nodes{
    id
    fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { optionId } }
    content{
      __typename
      ... on Issue { ${CONTENT_FIELDS} issueState: state }
      ... on PullRequest { ${CONTENT_FIELDS} pullRequestState: state }
      ... on DraftIssue { title }
    }
  }
}`;

// `state` is aliased per type: GraphQL rejects one response key that is IssueState on Issue
// and PullRequestState on PullRequest.
const BOARD_QUERY = `query($id:ID!){
  node(id:$id){
    ... on ProjectV2 {
      id number title url
      field(name:"Status"){ ... on ProjectV2SingleSelectField { id options{ id name color } } }
      ${BOARD_ITEMS}
    }
  }
}`;

const SET_STATUS_MUTATION = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
  updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){
    projectV2Item{ id }
  }
}`;

const CLEAR_STATUS_MUTATION = `mutation($project:ID!,$item:ID!,$field:ID!){
  clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}){
    projectV2Item{ id }
  }
}`;

/** GraphQL connection lists and their members may each be null. */
const nodesOf = <S extends Schema.Top>(member: S) =>
  Schema.Struct({
    nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(member)))),
  });

const LinkedProjectsResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        projectsV2: Schema.optional(
          Schema.NullOr(
            nodesOf(
              Schema.Struct({
                id: Schema.String,
                number: Schema.Int,
                title: Schema.String,
                url: Schema.String,
              }),
            ),
          ),
        ),
      }),
    ),
  }),
});

// An inline fragment that does not match answers `{}`, so every field below it is optional.
const ItemContent = Schema.Struct({
  __typename: Schema.String,
  number: Schema.optional(Schema.Int),
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  issueState: Schema.optional(Schema.String),
  pullRequestState: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.Struct({ nameWithOwner: Schema.String })),
  assignees: Schema.optional(
    nodesOf(Schema.Struct({ login: Schema.String, avatarUrl: Schema.String })),
  ),
  // GitHub's schema makes `labels` and `optionId` nullable, unlike `assignees`.
  labels: Schema.optional(
    Schema.NullOr(nodesOf(Schema.Struct({ name: Schema.String, color: Schema.String }))),
  ),
});

const BoardItemNode = Schema.Struct({
  id: Schema.String,
  fieldValueByName: Schema.optional(
    Schema.NullOr(Schema.Struct({ optionId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  content: Schema.optional(Schema.NullOr(ItemContent)),
});
type BoardItemNode = typeof BoardItemNode.Type;

const BoardResponse = Schema.Struct({
  data: Schema.Struct({
    node: Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        number: Schema.optional(Schema.Int),
        title: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        field: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              id: Schema.optional(Schema.String),
              options: Schema.optional(
                Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    name: Schema.String,
                    color: Schema.optional(Schema.NullOr(Schema.String)),
                  }),
                ),
              ),
            }),
          ),
        ),
        items: Schema.optional(
          Schema.Struct({
            pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
            nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(BoardItemNode)))),
          }),
        ),
      }),
    ),
  }),
});

const decodeLinkedProjects = Schema.decodeUnknownOption(
  Schema.fromJsonString(LinkedProjectsResponse),
);
const decodeBoard = Schema.decodeUnknownOption(Schema.fromJsonString(BoardResponse));

const toItemState = (state: string | undefined) =>
  state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : state === "MERGED" ? "merged" : null;

/** Null for content this board cannot show: a redacted item, or a type GitHub adds later. */
function toItem(node: BoardItemNode): ProjectBoardItem | null {
  const content = node.content;
  if (content === null || content === undefined) return null;
  const shared = {
    itemId: node.id,
    title: content.title ?? "",
    statusOptionId: node.fieldValueByName?.optionId ?? null,
  };
  if (content.__typename === "DraftIssue") {
    return {
      ...shared,
      kind: "draft",
      number: null,
      url: null,
      state: null,
      labels: [],
      assignees: [],
      repository: null,
    };
  }
  if (content.__typename !== "Issue" && content.__typename !== "PullRequest") return null;
  return {
    ...shared,
    kind: content.__typename === "Issue" ? "issue" : "pull_request",
    number: content.number ?? null,
    url: content.url ?? null,
    state: toItemState(
      content.__typename === "Issue" ? content.issueState : content.pullRequestState,
    ),
    labels: (content.labels?.nodes ?? []).flatMap((label) => (label === null ? [] : [label])),
    assignees: (content.assignees?.nodes ?? []).flatMap((user) => (user === null ? [] : [user])),
    repository: content.repository?.nameWithOwner ?? null,
  };
}

/** The projects linked to a repository, from the raw body of the linked-projects query. */
function linkedProjectsFromResponse(
  body: string,
): Option.Option<ReadonlyArray<ProjectBoardProject>> {
  return decodeLinkedProjects(body).pipe(
    Option.map(({ data }) =>
      (data.repository?.projectsV2?.nodes ?? []).flatMap((project) =>
        project === null ? [] : [project],
      ),
    ),
  );
}

/** One project's board, from the raw body of the board query. None when it cannot be read. */
export function projectBoardFromResponse(body: string): Option.Option<ProjectBoard> {
  return decodeBoard(body).pipe(
    Option.flatMap(({ data: { node } }) => {
      if (
        node === null ||
        node.id === undefined ||
        node.number === undefined ||
        node.title === undefined ||
        node.url === undefined
      ) {
        return Option.none();
      }
      // A project without a single-select Status answers `field: {}` or null.
      const statusFieldId = node.field?.id ?? null;
      return Option.some({
        projectId: node.id,
        projectNumber: node.number,
        title: node.title,
        url: node.url,
        statusFieldId,
        columns:
          statusFieldId === null
            ? []
            : (node.field?.options ?? []).map((option) => ({
                optionId: option.id,
                name: option.name,
                color: option.color ?? null,
              })),
        items: (node.items?.nodes ?? []).flatMap((item) => {
          const mapped = item === null ? null : toItem(item);
          return mapped === null ? [] : [mapped];
        }),
        truncated: node.items?.pageInfo.hasNextPage ?? false,
      });
    }),
  );
}

// GitHub says this about a token without the `project` scope in a GraphQL `INSUFFICIENT_SCOPES`
// error ("... has not been granted the required scopes ...") or a plain refusal. `GitHubApi`
// keeps the messages of a failed document but not its error types, so the text is what is left.
const MISSING_SCOPE_MESSAGE = /required scopes|insufficient[\s_]+scopes?|resource not accessible/i;

function isMissingProjectScope(error: GitHubApi.GitHubApiError): boolean {
  return (
    error._tag === "GitHubApiResponseError" &&
    (error.githubErrors ?? []).some((message) => MISSING_SCOPE_MESSAGE.test(message))
  );
}

const unreadable = (operation: string) =>
  new ProjectBoardError({
    operation,
    reason: "failed",
    detail: "GitHub returned a project board this app could not read.",
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  /** Reads and writes here are a user acting on a board, so they may spend the GraphQL reserve. */
  const graphql = (
    operation: string,
    input: {
      readonly host: string;
      readonly query: string;
      readonly variables: Readonly<Record<string, unknown>>;
    },
  ) =>
    api.graphql({ ...input, operation, allowReserve: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectBoardError({
            operation,
            reason: isMissingProjectScope(cause) ? "scope_missing" : "failed",
            detail: cause.message,
            cause,
          }),
      ),
    );

  const resolveRepository = Effect.fn("GitHubProjectBoard.resolveRepository")(function* (
    operation: string,
    cwd: string,
  ) {
    const identity = yield* repositoryIdentities.resolve(cwd);
    const host = identity === null ? null : gitHubApiHostForRemote(identity.locator.remoteUrl);
    if (identity === null || host === null || !identity.owner || !identity.name) {
      return yield* new ProjectBoardError({
        operation,
        reason: "not_github_repository",
        detail: "This project's repository is not hosted on GitHub.",
      });
    }
    return { host, owner: identity.owner, name: identity.name };
  });

  const getProjectBoard = Effect.fn("GitHubProjectBoard.getProjectBoard")(function* (
    input: ProjectBoardInput,
  ) {
    const operation = "getProjectBoard";
    const repository = yield* resolveRepository(operation, input.cwd);
    const linked = yield* graphql("listLinkedProjects", {
      host: repository.host,
      query: LINKED_PROJECTS_QUERY,
      variables: { owner: repository.owner, name: repository.name },
    }).pipe(
      Effect.flatMap((body) =>
        Option.match(linkedProjectsFromResponse(body), {
          onNone: () => Effect.fail(unreadable(operation)),
          onSome: Effect.succeed,
        }),
      ),
    );
    // A remembered choice that no longer exists falls back to the first project.
    const chosen = linked.find((project) => project.number === input.projectNumber) ?? linked[0];
    if (chosen === undefined) return { projects: linked, board: null };
    const board = yield* graphql("getProjectBoard", {
      host: repository.host,
      query: BOARD_QUERY,
      variables: { id: chosen.id },
    }).pipe(
      Effect.flatMap((body) =>
        Option.match(projectBoardFromResponse(body), {
          onNone: () => Effect.fail(unreadable(operation)),
          onSome: Effect.succeed,
        }),
      ),
    );
    return { projects: linked, board };
  });

  const moveItem = Effect.fn("GitHubProjectBoard.moveItem")(function* (
    input: MoveProjectBoardItemInput,
  ) {
    const operation = "moveProjectBoardItem";
    const repository = yield* resolveRepository(operation, input.cwd);
    const target = { project: input.projectId, item: input.itemId, field: input.fieldId };
    yield* graphql(operation, {
      host: repository.host,
      ...(input.optionId === null
        ? { query: CLEAR_STATUS_MUTATION, variables: target }
        : { query: SET_STATUS_MUTATION, variables: { ...target, option: input.optionId } }),
    });
  });

  return GitHubProjectBoard.of({ getProjectBoard, moveItem });
});

export const layer = Layer.effect(GitHubProjectBoard, make);
