import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { Context, Data, Effect, Predicate, Schema } from "effect";

export const UninstallAction = Schema.Literals([
  "suspend",
  "drain",
  "delete_ownership",
  "delete_installations",
]);
export type UninstallAction = typeof UninstallAction.Type;
export const UninstallRequest = Schema.Struct({ action: UninstallAction });

export const UninstallReceipt = Schema.Struct({
  id: Schema.String,
  github: Schema.Struct({
    installations: Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        repositories: Schema.Array(Schema.Struct({ fullName: Schema.String })),
      }),
    ),
  }),
});
export type UninstallReceipt = typeof UninstallReceipt.Type;

class UninstallOperationError extends Data.TaggedError("UninstallOperationError")<{
  operation:
    | "receipt"
    | "scheduler"
    | "suspend_installation"
    | "delete_ownership"
    | "delete_installation";
  cause: unknown;
}> {}

export class UninstallPlatform extends Context.Service<
  UninstallPlatform,
  {
    readonly suspendIntake: () => Effect.Effect<void, unknown>;
    readonly suspendInstallations: (ids: readonly number[]) => Effect.Effect<void, unknown>;
    readonly activeAttempts: () => Effect.Effect<number, unknown>;
    readonly deleteOwnership: (
      installations: UninstallReceipt["github"]["installations"],
    ) => Effect.Effect<void, unknown>;
    readonly deleteInstallations: (ids: readonly number[]) => Effect.Effect<void, unknown>;
  }
>()("Jitney.UninstallPlatform") {}

const ignoreMissing = <A>(
  operation: UninstallOperationError["operation"],
  evaluate: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new UninstallOperationError({ operation, cause }),
  }).pipe(
    Effect.asVoid,
    Effect.catchTag("UninstallOperationError", (error) =>
      Predicate.hasProperty(error.cause, "status") && error.cause.status === 404
        ? Effect.void
        : Effect.fail(error),
    ),
  );

export const makeUninstallPlatform = (env: Env): UninstallPlatform["Service"] => {
  const app = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
  });
  const scheduler = env.SCHEDULER.getByName("global-v3");
  return UninstallPlatform.of({
    suspendIntake: () =>
      Effect.tryPromise({
        try: () => scheduler.suspendIntake(),
        catch: (cause) => new UninstallOperationError({ operation: "scheduler", cause }),
      }),
    activeAttempts: () =>
      Effect.tryPromise({
        try: () => scheduler.activeAttemptCount(),
        catch: (cause) => new UninstallOperationError({ operation: "scheduler", cause }),
      }),
    suspendInstallations: (ids) =>
      Effect.forEach(ids, (installationId) =>
        ignoreMissing("suspend_installation", () =>
          app.rest.apps.suspendInstallation({ installation_id: installationId }),
        ),
      ).pipe(Effect.asVoid),
    deleteOwnership: (installations) =>
      Effect.forEach(installations, (recorded) =>
        Effect.gen(function* () {
          yield* ignoreMissing("delete_ownership", () =>
            app.rest.apps.unsuspendInstallation({ installation_id: recorded.id }),
          );
          const installation = new Octokit({
            authStrategy: createAppAuth,
            auth: {
              appId: env.GITHUB_APP_ID,
              privateKey: env.GITHUB_APP_PRIVATE_KEY,
              installationId: recorded.id,
            },
          });
          yield* Effect.forEach(recorded.repositories, (repository) => {
            const [owner, repo] = repository.fullName.split("/", 2);
            return owner === undefined || repo === undefined
              ? Effect.fail(
                  new UninstallOperationError({
                    operation: "delete_ownership",
                    cause: new Error(`Invalid repository name: ${repository.fullName}`),
                  }),
                )
              : ignoreMissing("delete_ownership", () =>
                  installation.rest.actions.deleteRepoVariable({
                    owner,
                    repo,
                    name: "JITNEY_DEPLOYMENT",
                  }),
                );
          }).pipe(
            Effect.ensuring(
              ignoreMissing("suspend_installation", () =>
                app.rest.apps.suspendInstallation({ installation_id: recorded.id }),
              ).pipe(Effect.ignore),
            ),
          );
        }),
      ).pipe(Effect.asVoid),
    deleteInstallations: (ids) =>
      Effect.forEach(ids, (installationId) =>
        ignoreMissing("delete_installation", () =>
          app.rest.apps.deleteInstallation({ installation_id: installationId }),
        ),
      ).pipe(Effect.asVoid),
  });
};

export const readUninstallReceipt = (env: Env) =>
  Effect.tryPromise({
    try: () => env.JITNEY_RECEIPTS.get(env.JITNEY_RECEIPT_NAME, "json"),
    catch: (cause) => new UninstallOperationError({ operation: "receipt", cause }),
  }).pipe(
    Effect.flatMap((value) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(UninstallReceipt)(value),
        catch: (cause) => new UninstallOperationError({ operation: "receipt", cause }),
      }),
    ),
  );

export const authorizeUninstall = (request: Request, secret: string): boolean => {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return false;
  const [expiresAt] = secret.split(".", 1);
  if (expiresAt === undefined || !Number.isSafeInteger(Number(expiresAt))) return false;
  if (Number(expiresAt) <= Date.now()) return false;
  const supplied = new TextEncoder().encode(authorization.slice("Bearer ".length));
  const expected = new TextEncoder().encode(secret);
  return (
    supplied.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(supplied, expected)
  );
};

export const executeUninstall = Effect.fn("GitHub.executeUninstall")(function* (
  receipt: UninstallReceipt,
  deploymentId: string,
  action: UninstallAction,
) {
  if (receipt.id !== deploymentId) return { accepted: false } as const;
  const platform = yield* UninstallPlatform;
  const installationIds = receipt.github.installations.map((installation) => installation.id);
  switch (action) {
    case "suspend":
      yield* platform.suspendIntake();
      yield* platform.suspendInstallations(installationIds);
      return { accepted: true } as const;
    case "drain":
      return {
        accepted: true,
        activeAttempts: yield* platform.activeAttempts(),
      } as const;
    case "delete_ownership":
      yield* platform.deleteOwnership(receipt.github.installations);
      return { accepted: true } as const;
    case "delete_installations":
      yield* platform.deleteInstallations(installationIds);
      return { accepted: true } as const;
  }
});
