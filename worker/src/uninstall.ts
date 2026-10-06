import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { Context, Data, Effect, Predicate, Schema } from "effect";
import {
  isLiveSecret,
  ownershipEnvironmentName,
  UNINSTALL_ACTIONS,
} from "../../shared/contract.js";
import {
  makeLifecycleGitHub,
  readReceipt,
  type LifecycleInstallation,
  type Receipt,
} from "./lifecycle-status";

export const UninstallAction = Schema.Literals([...UNINSTALL_ACTIONS]);

export interface AppIdentity {
  readonly id: number;
  readonly slug: string;
  readonly ownerLogin: string;
  readonly ownerType: "User" | "Organization";
}
export type UninstallAction = typeof UninstallAction.Type;
export const UninstallRequest = Schema.Struct({ action: UninstallAction });

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
    readonly resumeIntake: () => Effect.Effect<void, unknown>;
    readonly suspendInstallations: (ids: readonly number[]) => Effect.Effect<void, unknown>;
    readonly activeAttempts: () => Effect.Effect<number, unknown>;
    readonly deleteOwnership: (
      installations: Receipt["github"]["installations"],
    ) => Effect.Effect<void, unknown>;
    readonly deleteInstallations: (ids: readonly number[]) => Effect.Effect<void, unknown>;
    readonly inventory: () => Effect.Effect<
      { readonly app: AppIdentity; readonly installations: readonly LifecycleInstallation[] },
      unknown
    >;
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
    resumeIntake: () =>
      Effect.tryPromise({
        try: () => scheduler.resumeIntake(),
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
                  installation.request(
                    "DELETE /repos/{owner}/{repo}/environments/{environment_name}",
                    {
                      owner,
                      repo,
                      environment_name: ownershipEnvironmentName(env.JITNEY_DEPLOYMENT),
                    },
                  ),
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
    inventory: () =>
      Effect.all({
        app: Effect.tryPromise({
          try: () => app.rest.apps.getAuthenticated(),
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap(({ data }) => {
            const owner = data?.owner;
            const type = owner != null && "type" in owner ? owner.type : undefined;
            const ownerType: AppIdentity["ownerType"] | undefined =
              type === "User" || type === "Organization" ? type : undefined;
            return data == null || owner == null || !("login" in owner) || ownerType === undefined
              ? Effect.fail(new Error("The GitHub App has no user or organization owner"))
              : Effect.succeed({
                  id: data.id,
                  slug: data.slug ?? "",
                  ownerLogin: owner.login,
                  ownerType,
                });
          }),
        ),
        installations: makeLifecycleGitHub(env).inventory(),
      }),
  });
};

export const readUninstallReceipt = (env: Env) =>
  readReceipt(env).pipe(
    Effect.mapError((cause) => new UninstallOperationError({ operation: "receipt", cause })),
  );

export const authorizeUninstall = (request: Request, secret: string): boolean => {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return false;
  if (!isLiveSecret(secret, Date.now())) return false;
  const supplied = new TextEncoder().encode(authorization.slice("Bearer ".length));
  const expected = new TextEncoder().encode(secret);
  return (
    supplied.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(supplied, expected)
  );
};

export const executeUninstall = Effect.fn("GitHub.executeUninstall")(function* (
  receipt: Receipt,
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
    case "suspend_intake":
      yield* platform.suspendIntake();
      return { accepted: true } as const;
    case "drain":
      return {
        accepted: true,
        activeAttempts: yield* platform.activeAttempts(),
      } as const;
    case "resume_intake":
      yield* platform.resumeIntake();
      return { accepted: true } as const;
    case "delete_ownership":
      yield* platform.deleteOwnership(receipt.github.installations);
      return { accepted: true } as const;
    case "delete_installations":
      yield* platform.deleteInstallations(installationIds);
      return { accepted: true } as const;
    case "inventory":
      return { accepted: true, inventory: yield* platform.inventory() } as const;
  }
});
