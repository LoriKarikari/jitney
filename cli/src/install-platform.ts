import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Alchemy from "alchemy";
import { deploy as alchemyDeploy } from "alchemy/Deploy";
import { destroy as alchemyDestroy } from "alchemy/Destroy";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted, Ref, Schedule, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  GitHubAppOperationError,
  GitHubAppOperations,
  type GitHubAppAttributes,
} from "./alchemy/github-app.js";
import { jitneyStack, type JitneyProviderLayer } from "./alchemy/jitney-stack.js";
import { jitneyProviders } from "./alchemy/providers.js";
import { waitForDeploymentRemoval } from "./cloudflare-inventory.js";
import { alchemyCli } from "./cloudflare-runtime.js";
import { workerBundlePath } from "./config.js";
import { InstallerError, tryPromise } from "./errors.js";
import {
  createGitHubApp,
  openGitHubAppDeletion,
  openInstallation,
  waitForGitHubAppDeletion,
  type GitHubAppCredentials,
} from "./github-app.js";
import {
  claimGitHubRepositories,
  releaseGitHubRepositories,
  waitForGitHubInstallations,
} from "./github-installations.js";
import { InstallPlatform, type InstallInput, type InstallStackOutput } from "./install.js";
import { deleteRunnerImageTag } from "./runner-image-registry.js";

const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.String,
});

const withAlchemyWorkspace = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InstallerError, R> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = process.cwd();
      const workspace = join(homedir(), ".cache", "jitney", "alchemy");
      yield* tryPromise("filesystem", "Could not prepare the Alchemy workspace", () =>
        mkdir(workspace, { recursive: true }),
      );
      yield* Effect.sync(() => process.chdir(workspace));
      return previous;
    }),
    () => effect,
    (previous) => Effect.sync(() => process.chdir(previous)),
  );

interface JitneyStackOutput {
  readonly workerUrl: string;
  readonly runnerApplicationId: string;
  readonly runnerImage: string;
}

const githubAppAttributes = (credentials: GitHubAppCredentials): GitHubAppAttributes => ({
  appId: credentials.appId,
  slug: credentials.slug,
  settingsUrl:
    credentials.ownerType === "Organization"
      ? `https://github.com/organizations/${credentials.ownerLogin}/settings/apps/${credentials.slug}`
      : `https://github.com/settings/apps/${credentials.slug}`,
  ownerLogin: credentials.ownerLogin,
  ownerType: credentials.ownerType,
});

export const makeInstallPlatform = Effect.fn(function* (
  capturedCredentials: Ref.Ref<Option.Option<GitHubAppCredentials>>,
) {
  const credentialsService = yield* Credentials;
  const httpClient = yield* HttpClient.HttpClient;
  const provideCloudflareApi = <A, E>(
    effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) =>
    effect.pipe(
      Effect.provideService(Credentials, credentialsService),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const githubOperations = Layer.succeed(GitHubAppOperations, {
    reconcile: ({ current }) => {
      if (current !== undefined) return Effect.succeed(current);
      return Ref.get(capturedCredentials).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new GitHubAppOperationError({
                  operation: "reconcile",
                  cause: new Error("GitHub App credentials are unavailable"),
                }),
              ),
            onSome: (credentials) => Effect.succeed(githubAppAttributes(credentials)),
          }),
        ),
      );
    },
    delete: () => Effect.void,
    list: () => Effect.succeed([]),
  });
  // Alchemy beta.63 keeps its local-runtime state service private, so the
  // public provider type cannot see that jitneyProviders supplies it.
  const providers = jitneyProviders(githubOperations) as unknown as JitneyProviderLayer;

  const stackFor = (
    input: InstallInput & { deploymentId: string },
    credentials?: GitHubAppCredentials,
  ) =>
    jitneyStack(
      {
        deploymentId: input.deploymentId,
        workerName: input.name,
        workerBundlePath: workerBundlePath(),
        version: input.version,
        manageGitHubApp: credentials !== undefined,
        ...(input.organization === undefined ? {} : { organization: input.organization }),
        ...(credentials === undefined
          ? {}
          : {
              githubCredentials: {
                appId: Redacted.make(credentials.appId),
                privateKey: Redacted.make(credentials.privateKey),
                webhookSecret: Redacted.make(credentials.webhookSecret),
              },
            }),
      },
      { providers },
    );

  // Alchemy beta.63's deploy/destroy signatures leak stack services that
  // evalStack supplies internally. Keep that upstream type mismatch here.
  const runStack = (
    input: InstallInput & { deploymentId: string },
    credentials?: GitHubAppCredentials,
  ) =>
    withAlchemyWorkspace(
      alchemyDeploy({
        stack: stackFor(input, credentials),
        stage: input.name,
      }),
    ).pipe(
      Effect.provideService(Alchemy.Cli, alchemyCli),
      Effect.mapError(
        (cause) =>
          new InstallerError({
            step: "worker_deployment",
            message: "Could not deploy the Jitney resource stack",
            cause,
          }),
      ),
    ) as unknown as Effect.Effect<JitneyStackOutput, InstallerError>;

  const destroyStack = (
    input: InstallInput & { deploymentId: string },
    credentials?: GitHubAppCredentials,
  ) =>
    withAlchemyWorkspace(
      alchemyDestroy({
        stack: stackFor(input, credentials),
        stage: input.name,
      }),
    ).pipe(
      Effect.provideService(Alchemy.Cli, alchemyCli),
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new InstallerError({
            step: "rollback",
            message: "Could not remove the partial Cloudflare deployment",
            cause,
          }),
      ),
    ) as Effect.Effect<void, InstallerError>;

  return InstallPlatform.of({
    deployBootstrap: (input) =>
      Effect.gen(function* () {
        yield* Effect.sync(() =>
          console.log(`Deploying Jitney ${input.version} as ${input.name}...`),
        );
        const output = yield* runStack(input);
        const imagePrefix = `registry.cloudflare.com/${input.accountId}/${input.name}-runner:`;
        if (
          !output.runnerImage.startsWith(imagePrefix) ||
          output.runnerImage.length === imagePrefix.length
        ) {
          return yield* new InstallerError({
            step: "registry_copy",
            message: `Cloudflare returned an unexpected runner image: ${output.runnerImage}`,
          });
        }
        return {
          workerUrl: output.workerUrl,
          applicationId: output.runnerApplicationId,
          registryTag: output.runnerImage.slice(imagePrefix.length),
        } satisfies InstallStackOutput;
      }),
    createGitHubApp: (input) =>
      createGitHubApp({
        workerName: input.name,
        workerUrl: input.workerUrl,
        ...(input.organization === undefined ? {} : { organization: input.organization }),
      }).pipe(
        Effect.tap((credentials) => Ref.set(capturedCredentials, Option.some(credentials))),
        Effect.flatMap((credentials) => {
          const appId = Number(credentials.appId);
          return Number.isSafeInteger(appId)
            ? Effect.succeed({
                appId,
                appSlug: credentials.slug,
                ownerLogin: credentials.ownerLogin,
                ownerType: credentials.ownerType,
                credentials,
              })
            : Effect.fail(
                new InstallerError({
                  step: "github_app_conversion",
                  message: "GitHub returned an invalid App id",
                }),
              );
        }),
      ),
    activate: (input) =>
      Effect.sync(() => console.log("Enabling webhooks and reconciliation...")).pipe(
        Effect.andThen(runStack(input, input.credentials)),
        Effect.asVoid,
      ),
    installGitHubApp: (credentials) =>
      Effect.gen(function* () {
        yield* Effect.sync(() =>
          console.log(
            "Opening GitHub to install the App. Choose the private repositories that may use Jitney.",
          ),
        );
        yield* openInstallation(credentials);
        return yield* waitForGitHubInstallations(credentials);
      }),
    claimRepositories: claimGitHubRepositories,
    checkHealth: (workerUrl, version) =>
      httpClient.get(`${workerUrl}/health`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap((body) =>
          Effect.try({
            try: () => Schema.decodeUnknownSync(HealthResponse)(body),
            catch: (cause) =>
              new InstallerError({
                step: "health_check",
                message: "Jitney returned an invalid health response",
                cause,
              }),
          }),
        ),
        Effect.flatMap((health) =>
          health.version === version
            ? Effect.void
            : Effect.fail(
                new InstallerError({
                  step: "health_check",
                  message: `Jitney reported version ${health.version}; expected ${version}`,
                }),
              ),
        ),
        Effect.retry(Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(29)])),
        Effect.mapError((cause) =>
          cause instanceof InstallerError
            ? cause
            : new InstallerError({
                step: "health_check",
                message: "Jitney did not become healthy",
                cause,
              }),
        ),
      ),
    rollback: (input) =>
      Effect.gen(function* () {
        const captured = Option.getOrUndefined(yield* Ref.get(capturedCredentials));
        const credentials = input.credentials ?? captured;
        if (credentials !== undefined) {
          yield* releaseGitHubRepositories(
            credentials,
            input.deploymentId,
            input.receipt.github.installations,
          );
        }
        yield* destroyStack(input, credentials);
        yield* provideCloudflareApi(waitForDeploymentRemoval(input.accountId, input.name));
        const registryTag = input.receipt.cloudflare.tags.current;
        if (input.receipt.cloudflare.applicationId !== null && registryTag !== null) {
          yield* provideCloudflareApi(
            deleteRunnerImageTag(
              input.accountId,
              input.receipt.cloudflare.registryRepo,
              registryTag,
            ),
          );
        }
        if (credentials !== undefined) {
          yield* Effect.sync(() =>
            console.log(
              `Delete the partial GitHub App ${credentials.slug} in the browser to finish rollback.`,
            ),
          );
          yield* openGitHubAppDeletion(credentials);
          yield* waitForGitHubAppDeletion(credentials).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
        }
      }),
  });
});
