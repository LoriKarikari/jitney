import * as Provider from "alchemy/Provider";
import { Resource, type Resource as AlchemyResource } from "alchemy/Resource";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "alchemy/Diff";

export interface GitHubAppProps {
  name: string;
  webhookUrl: string;
  organization?: string;
}

export interface GitHubAppAttributes {
  appId: string;
  slug: string;
  settingsUrl: string;
  ownerLogin: string;
  ownerType: "User" | "Organization";
}

export interface GitHubAppResource extends AlchemyResource<
  "Jitney.GitHubApp",
  GitHubAppProps,
  GitHubAppAttributes
> {}

export const GitHubApp = Resource<GitHubAppResource>("Jitney.GitHubApp");

export class GitHubAppOperationError extends Data.TaggedError("GitHubAppOperationError")<{
  operation: "reconcile" | "delete" | "list";
  cause: unknown;
}> {}

export class GitHubAppOperations extends Context.Service<
  GitHubAppOperations,
  {
    reconcile(input: {
      desired: GitHubAppProps;
      current: GitHubAppAttributes | undefined;
    }): Effect.Effect<GitHubAppAttributes, GitHubAppOperationError>;
    delete(app: GitHubAppAttributes): Effect.Effect<void, GitHubAppOperationError>;
    list(): Effect.Effect<GitHubAppAttributes[], GitHubAppOperationError>;
  }
>()("Jitney.GitHubAppOperations") {}

export const GitHubAppProvider = Provider.effect(
  // Alchemy beta.63's ResourceClass has an exact-optional mismatch with Provider.effect().
  // @ts-expect-error upstream beta type mismatch
  GitHubApp,
  Effect.gen(function* () {
    const operations = yield* GitHubAppOperations;
    return {
      list: () => operations.list(),
      diff: ({ news, olds }) =>
        isResolved(news) &&
        (news.name !== olds.name ||
          news.webhookUrl !== olds.webhookUrl ||
          news.organization !== olds.organization)
          ? Effect.succeed({ action: "update" as const })
          : Effect.void,
      reconcile: ({ news, output }) => operations.reconcile({ desired: news, current: output }),
      delete: ({ output }) => operations.delete(output),
    };
  }),
);
