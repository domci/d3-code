import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { type RepositoryIdentity } from "@t3tools/contracts";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubProjectBoard from "./GitHubProjectBoard.ts";

const BOARD_BODY = JSON.stringify({
  data: {
    node: {
      id: "PVT_1",
      number: 3,
      title: "Roadmap",
      url: "https://github.com/orgs/acme/projects/3",
      field: {
        id: "PVTSSF_status",
        options: [
          { id: "opt_todo", name: "Todo", color: "GREEN" },
          { id: "opt_done", name: "Done", color: "PURPLE" },
        ],
      },
      items: {
        pageInfo: { hasNextPage: true },
        nodes: [
          {
            id: "PVTI_1",
            fieldValueByName: { optionId: "opt_todo" },
            content: {
              __typename: "Issue",
              number: 12,
              title: "Fix login",
              url: "https://github.com/acme/web/issues/12",
              issueState: "OPEN",
              repository: { nameWithOwner: "acme/web" },
              assignees: { nodes: [{ login: "octocat", avatarUrl: "https://avatars/octocat" }] },
              labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
            },
          },
          {
            // No Status set: GitHub answers null.
            id: "PVTI_2",
            fieldValueByName: null,
            content: {
              __typename: "PullRequest",
              number: 13,
              title: "Add login",
              url: "https://github.com/acme/web/pull/13",
              pullRequestState: "MERGED",
              repository: { nameWithOwner: "acme/web" },
              assignees: { nodes: [] },
              labels: { nodes: [] },
            },
          },
          // A draft item: no number, url or state, and a Status field value that is not an option.
          {
            id: "PVTI_3",
            fieldValueByName: {},
            content: { __typename: "DraftIssue", title: "Spike" },
          },
          // Content the viewer cannot see.
          { id: "PVTI_4", fieldValueByName: null, content: null },
        ],
      },
    },
  },
});

describe("projectBoardFromResponses", () => {
  it("maps a project response to columns and cards, including unset and draft items", () => {
    const board = Option.getOrThrow(GitHubProjectBoard.projectBoardFromResponses([BOARD_BODY]));
    assert.deepStrictEqual(board, {
      projectId: "PVT_1",
      projectNumber: 3,
      title: "Roadmap",
      url: "https://github.com/orgs/acme/projects/3",
      statusFieldId: "PVTSSF_status",
      columns: [
        { optionId: "opt_todo", name: "Todo", color: "GREEN" },
        { optionId: "opt_done", name: "Done", color: "PURPLE" },
      ],
      items: [
        {
          itemId: "PVTI_1",
          kind: "issue",
          number: 12,
          title: "Fix login",
          url: "https://github.com/acme/web/issues/12",
          state: "open",
          statusOptionId: "opt_todo",
          labels: [{ name: "bug", color: "d73a4a" }],
          assignees: [{ login: "octocat", avatarUrl: "https://avatars/octocat" }],
          repository: "acme/web",
          body: "",
        },
        {
          itemId: "PVTI_2",
          kind: "pull_request",
          number: 13,
          title: "Add login",
          url: "https://github.com/acme/web/pull/13",
          state: "merged",
          statusOptionId: null,
          labels: [],
          assignees: [],
          repository: "acme/web",
          body: "",
        },
        {
          itemId: "PVTI_3",
          kind: "draft",
          number: null,
          title: "Spike",
          url: null,
          state: null,
          statusOptionId: null,
          labels: [],
          assignees: [],
          repository: null,
          body: "",
        },
      ],
      truncated: true,
    });
  });

  it("has no Status field id when the project's Status is not a single select", () => {
    const body = JSON.stringify({
      data: {
        node: {
          id: "PVT_2",
          number: 4,
          title: "Plain",
          url: "https://github.com/orgs/acme/projects/4",
          field: {},
          items: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    });
    const board = Option.getOrThrow(GitHubProjectBoard.projectBoardFromResponses([body]));
    assert.strictEqual(board.statusFieldId, null);
    assert.deepStrictEqual(board.columns, []);
  });
});

const identity: RepositoryIdentity = {
  canonicalKey: "github.com/acme/web",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/web.git" },
  owner: "acme",
  name: "web",
  provider: "github",
};

const LINKED_BODY = JSON.stringify({
  data: {
    repository: {
      projectsV2: {
        nodes: [
          {
            id: "PVT_1",
            number: 3,
            title: "Roadmap",
            url: "https://github.com/orgs/acme/projects/3",
          },
          { id: "PVT_9", number: 9, title: "Bugs", url: "https://github.com/orgs/acme/projects/9" },
        ],
      },
    },
  },
});

interface RecordedCall {
  readonly host: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>> | undefined;
  readonly allowReserve: boolean | undefined;
}

/** The service over a GitHubApi that answers each document from `answer` and records the calls. */
function makeService(
  answer: (call: RecordedCall) => Effect.Effect<string, GitHubApi.GitHubApiError>,
) {
  const calls: RecordedCall[] = [];
  const api = Layer.succeed(
    GitHubApi.GitHubApi,
    GitHubApi.GitHubApi.of({
      graphql: (input) => {
        const call = {
          host: input.host,
          query: input.query,
          variables: input.variables,
          allowReserve: input.allowReserve,
        };
        calls.push(call);
        return answer(call);
      },
      rest: () => Effect.die("unexpected REST call"),
      credential: () => Effect.die("unexpected credential read"),
    }),
  );
  const identities = Layer.succeed(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.RepositoryIdentityResolver.of({
      resolve: () => Effect.succeed(identity),
    }),
  );
  return {
    calls,
    layer: GitHubProjectBoard.layer.pipe(Layer.provide(api), Layer.provide(identities)),
  };
}

const page = (start: number, more: boolean) =>
  JSON.stringify({
    data: {
      node: {
        id: "PVT_1",
        number: 3,
        title: "Roadmap",
        url: "https://github.com/orgs/acme/projects/3",
        field: {},
        items: {
          pageInfo: { hasNextPage: more, endCursor: `c${start}` },
          nodes: Array.from({ length: 100 }, (_, index) => ({
            id: `I${start + index}`,
            content: { __typename: "DraftIssue", title: "t", bodyText: "x".repeat(3000) },
          })),
        },
      },
    },
  });
const endlessPage = page(0, true);

describe("GitHubProjectBoard", () => {
  it.effect("reads the linked projects, then the chosen project's board", () => {
    const { calls, layer } = makeService((call) =>
      Effect.succeed(call.query.includes("projectsV2") ? LINKED_BODY : BOARD_BODY),
    );
    return Effect.gen(function* () {
      const board = yield* GitHubProjectBoard.GitHubProjectBoard;
      const result = yield* board.getProjectBoard({ cwd: "/work/web", projectNumber: 9 });
      assert.deepStrictEqual(
        result.projects.map((project) => project.number),
        [3, 9],
      );
      // Project number 9 was asked for, so its id is what the board read names.
      assert.deepStrictEqual(calls[0]?.variables, { owner: "acme", name: "web" });
      assert.deepStrictEqual(calls[1]?.variables, { id: "PVT_9", after: null });
      assert.strictEqual(calls[0]?.host, "github.com");
      assert.isTrue(calls.every((call) => call.allowReserve === true));
      assert.isNotNull(result.board);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads every page of items, and marks a board truncated only at the cap", () => {
    const finite = makeService((call) =>
      Effect.succeed(
        call.query.includes("projectsV2")
          ? LINKED_BODY
          : call.variables?.after === "c0"
            ? page(100, false)
            : page(0, true),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* GitHubProjectBoard.GitHubProjectBoard;
      const result = yield* service.getProjectBoard({ cwd: "/work/web" });
      assert.strictEqual(result.board?.items.length, 200);
      assert.isFalse(result.board?.truncated);
      assert.strictEqual(result.board?.items[0]?.body?.length, GitHubProjectBoard.MAX_BODY_CHARS);
      assert.deepStrictEqual(
        finite.calls.slice(1).map((call) => call.variables?.after),
        [null, "c0"],
      );
    }).pipe(Effect.provide(finite.layer));
  });

  it.effect("stops at 1000 items and marks the board truncated", () => {
    const { calls, layer } = makeService((call) =>
      Effect.succeed(call.query.includes("projectsV2") ? LINKED_BODY : endlessPage),
    );
    return Effect.gen(function* () {
      const service = yield* GitHubProjectBoard.GitHubProjectBoard;
      const result = yield* service.getProjectBoard({ cwd: "/work/web" });
      assert.strictEqual(result.board?.items.length, 1000);
      assert.isTrue(result.board?.truncated);
      assert.strictEqual(calls.length, 11);
    }).pipe(Effect.provide(layer));
  });

  it.effect("has no board when no project is linked", () => {
    const { calls, layer } = makeService(() =>
      Effect.succeed(JSON.stringify({ data: { repository: { projectsV2: { nodes: [] } } } })),
    );
    return Effect.gen(function* () {
      const board = yield* GitHubProjectBoard.GitHubProjectBoard;
      const result = yield* board.getProjectBoard({ cwd: "/work/web" });
      assert.deepStrictEqual(result, { projects: [], board: null });
      assert.strictEqual(calls.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sets a Status option, or clears it when no option is given", () => {
    const { calls, layer } = makeService(() => Effect.succeed('{"data":{}}'));
    return Effect.gen(function* () {
      const board = yield* GitHubProjectBoard.GitHubProjectBoard;
      const target = { cwd: "/work/web", projectId: "PVT_1", itemId: "PVTI_1", fieldId: "F_1" };
      yield* board.moveItem({ ...target, optionId: "opt_done" });
      yield* board.moveItem({ ...target, optionId: null });
      assert.include(calls[0]?.query ?? "", "updateProjectV2ItemFieldValue");
      assert.deepStrictEqual(calls[0]?.variables, {
        project: "PVT_1",
        item: "PVTI_1",
        field: "F_1",
        option: "opt_done",
      });
      assert.include(calls[1]?.query ?? "", "clearProjectV2ItemFieldValue");
      assert.deepStrictEqual(calls[1]?.variables, {
        project: "PVT_1",
        item: "PVTI_1",
        field: "F_1",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("tells a token without the project scope how to grant it", () => {
    const { layer } = makeService(() =>
      Effect.fail(
        new GitHubApi.GitHubApiResponseError({
          host: "github.com",
          operation: "listLinkedProjects",
          status: 200,
          githubErrors: [
            "Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project'].",
          ],
        }),
      ),
    );
    return Effect.gen(function* () {
      const board = yield* GitHubProjectBoard.GitHubProjectBoard;
      const error = yield* Effect.flip(board.getProjectBoard({ cwd: "/work/web" }));
      assert.strictEqual(error.reason, "scope_missing");
      assert.strictEqual(
        error.message,
        "Run `gh auth refresh -s project -s read:org -s repo` to grant GitHub Projects access.",
      );
    }).pipe(Effect.provide(layer));
  });
});
