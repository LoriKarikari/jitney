import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { Array as Arr, Context, Data, Effect, Option, Predicate, Result, Schema } from "effect";

const Receipt = Schema.Struct({
  id: Schema.String,
  github: Schema.Struct({
    installations: Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        repositories: Schema.Array(Schema.Struct({ id: Schema.Number, fullName: Schema.String })),
      }),
    ),
  }),
});

export const LifecycleStatus = Schema.Struct({
  app: Schema.Literals(["ok", "unknown"]),
  installations: Schema.Literals(["ok", "drifted", "unknown"]),
  ownership: Schema.Array(
    Schema.Struct({
      installationId: Schema.Number,
      repositoryId: Schema.Number,
      status: Schema.Literals(["ok", "missing", "drifted", "unknown"]),
    }),
  ),
});

export type LifecycleStatus = typeof LifecycleStatus.Type;

type Receipt = typeof Receipt.Type;

export interface LifecycleInstallation {
  readonly id: number;
  readonly repositories: readonly { readonly id: number; readonly fullName: string }[];
}

class VariableMissing extends Data.TaggedError("VariableMissing")<{}> {}

export class LifecycleGitHubError extends Data.TaggedError("LifecycleGitHubError")<{
  operation: "inventory" | "ownership";
  cause: unknown;
}> {}

export class LifecycleGitHub extends Context.Service<
  LifecycleGitHub,
  {
    readonly inventory: () => Effect.Effect<readonly LifecycleInstallation[], LifecycleGitHubError>;
    readonly ownership: (
      installationId: number,
      fullName: string,
    ) => Effect.Effect<Option.Option<string>, LifecycleGitHubError>;
  }
>()("Jitney.LifecycleGitHub") {}

const inventoryKey = (installations: readonly LifecycleInstallation[]): string =>
  Arr.flatMap(installations, (installation) =>
    Arr.map(
      installation.repositories,
      (repository) => `${installation.id}:${repository.id}:${repository.fullName}`,
    ),
  )
    .sort()
    .join(",");

const unknownStatus = (receipt: Receipt): LifecycleStatus => ({
  app: "unknown",
  installations: "unknown",
  ownership: Arr.flatMap(receipt.github.installations, (installation) =>
    Arr.map(installation.repositories, (repository) => ({
      installationId: installation.id,
      repositoryId: repository.id,
      status: "unknown" as const,
    })),
  ),
});

export const makeLifecycleGitHub = (env: Env): LifecycleGitHub["Service"] => {
  const app = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
  });
  return LifecycleGitHub.of({
    inventory: () =>
      Effect.gen(function* () {
        const installations = yield* Effect.tryPromise({
          try: () => app.paginate(app.rest.apps.listInstallations, { per_page: 100 }),
          catch: (cause) => new LifecycleGitHubError({ operation: "inventory", cause }),
        });
        const result: LifecycleInstallation[] = [];
        for (const { id: installationId } of installations) {
          const installation = new Octokit({
            authStrategy: createAppAuth,
            auth: {
              appId: env.GITHUB_APP_ID,
              privateKey: env.GITHUB_APP_PRIVATE_KEY,
              installationId,
            },
          });
          const repositories = yield* Effect.tryPromise({
            try: () =>
              installation.paginate(installation.rest.apps.listReposAccessibleToInstallation, {
                per_page: 100,
              }),
            catch: (cause) => new LifecycleGitHubError({ operation: "inventory", cause }),
          });
          result.push({
            id: installationId,
            repositories: Arr.map(repositories, ({ id, full_name }) => ({
              id,
              fullName: full_name,
            })),
          });
        }
        return result;
      }),
    ownership: (installationId, fullName) => {
      const [owner, repo] = fullName.split("/", 2);
      if (owner === undefined || repo === undefined) {
        return Effect.fail(
          new LifecycleGitHubError({
            operation: "ownership",
            cause: new Error(`Invalid repository name: ${fullName}`),
          }),
        );
      }
      const installation = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
          installationId,
        },
      });
      return Effect.tryPromise({
        try: () =>
          installation.rest.actions.getRepoVariable({
            owner,
            repo,
            name: "JITNEY_DEPLOYMENT",
          }),
        catch: (cause) =>
          Predicate.hasProperty(cause, "status") && cause.status === 404
            ? new VariableMissing()
            : new LifecycleGitHubError({ operation: "ownership", cause }),
      }).pipe(
        Effect.map((response) => Option.some(response.data.value)),
        Effect.catchTag("VariableMissing", () => Effect.succeed(Option.none())),
      );
    },
  });
};

export const lifecycleStatus = Effect.fn("GitHub.lifecycleStatus")(function* (env: Env) {
  const github = yield* LifecycleGitHub;
  const value = yield* Effect.tryPromise({
    try: () => env.JITNEY_RECEIPTS.get(env.JITNEY_RECEIPT_NAME, "json"),
    catch: (cause) => cause,
  });
  const receipt = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Receipt)(value),
    catch: (cause) => cause,
  });
  if (receipt.id !== env.JITNEY_DEPLOYMENT) return unknownStatus(receipt);

  const liveInventory = yield* Effect.result(github.inventory());
  if (Result.isFailure(liveInventory)) return unknownStatus(receipt);

  const ownership: LifecycleStatus["ownership"][number][] = [];
  for (const recordedInstallation of receipt.github.installations) {
    for (const repository of recordedInstallation.repositories) {
      const variable = yield* Effect.result(
        github.ownership(recordedInstallation.id, repository.fullName),
      );
      ownership.push({
        installationId: recordedInstallation.id,
        repositoryId: repository.id,
        status: Result.isFailure(variable)
          ? "unknown"
          : Option.match(variable.success, {
              onNone: () => "missing" as const,
              onSome: (value) => (value === receipt.id ? "ok" : "drifted"),
            }),
      });
    }
  }

  return {
    app: "ok",
    installations:
      inventoryKey(liveInventory.success) === inventoryKey(receipt.github.installations)
        ? "ok"
        : "drifted",
    ownership,
  } satisfies LifecycleStatus;
});
