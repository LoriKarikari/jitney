import * as Containers from "@distilled.cloud/cloudflare/containers";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { deploy as alchemyDeploy } from "alchemy/Deploy";
import { destroy as alchemyDestroy } from "alchemy/Destroy";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted, Ref, Schedule, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { jitneyProviders } from "./alchemy/providers.js";
import { jitneyStack, type JitneyProviderLayer } from "./alchemy/jitney-stack.js";
import {
  GitHubAppOperationError,
  GitHubAppOperations,
  type GitHubAppAttributes,
} from "./alchemy/github-app.js";
import { alchemyCli, cloudflareRuntime } from "./cloudflare-runtime.js";
import { ensureDeploymentAbsent, waitForDeploymentRemoval } from "./cloudflare-inventory.js";
import { workerBundlePath, validateWorkerName } from "./config.js";
import {
  ExistingDeploymentError,
  InstallerError,
  isInstallFailure,
  tryPromise,
  trySync,
  type InstallFailure,
} from "./errors.js";
import {
  claimGitHubRepositories,
  releaseGitHubRepositories,
  waitForGitHubInstallations,
} from "./github-installations.js";
import {
  createGitHubApp,
  openGitHubAppDeletion,
  openInstallation,
  waitForGitHubAppDeletion,
  type GitHubAppCredentials,
} from "./github-app.js";
import {
  DeploymentReceipts,
  InstallPlatform,
  installDeployment,
  type InstallInput,
  type InstallStackOutput,
} from "./install.js";
import {
  ensureCloudflareReceiptNamespace,
  findCloudflareReceiptNamespace,
  makeCloudflareReceiptBackend,
} from "./receipts/cloudflare.js";
import { deleteImage } from "./oras.js";
import { makeReceiptStore, type ReceiptStore } from "./receipts/store.js";

const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.String,
});

const PackageMetadata = Schema.Struct({ version: Schema.String });

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

export function deploy(options: {
  workerName: string;
  organization?: string;
  keepPartial?: boolean;
}): Effect.Effect<void, InstallFailure> {
  return Effect.gen(function* () {
    const name = yield* trySync("argument_parsing", "The Worker name is invalid", () =>
      validateWorkerName(options.workerName),
    );
    const version = yield* packageVersion();
    const actor = yield* trySync(
      "argument_parsing",
      "Could not identify the command actor",
      () => `${userInfo().username}@${hostname()}`,
    );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const existingScope = yield* findCloudflareReceiptNamespace(accountId).pipe(
      Effect.mapError(
        (cause) =>
          new InstallerError({
            step: "receipt_store",
            message: "Could not inspect the deployment receipt store",
            cause,
          }),
      ),
    );
    const existingStore = yield* Option.match(existingScope, {
      onNone: () => Effect.succeed(Option.none<ReceiptStore>()),
      onSome: (scope) => Effect.map(makeCloudflareStore(scope), Option.some),
    });
    if (Option.isSome(existingStore)) {
      yield* assertDeploymentAbsent(name, existingStore.value);
    }
    yield* ensureDeploymentAbsent(accountId, name);

    const receipts = yield* Option.match(existingStore, {
      onNone: () =>
        ensureCloudflareReceiptNamespace(accountId).pipe(
          Effect.mapError(
            (cause) =>
              new InstallerError({
                step: "receipt_store",
                message: "Could not prepare the deployment receipt store",
                cause,
              }),
          ),
          Effect.flatMap(makeCloudflareStore),
        ),
      onSome: Effect.succeed,
    });
    const credentials = yield* Ref.make(Option.none<GitHubAppCredentials>());
    const platform = yield* makeInstallPlatform(credentials);

    const result = yield* installDeployment({
      name,
      accountId,
      version,
      actor,
      ...(options.organization === undefined ? {} : { organization: options.organization }),
      ...(options.keepPartial === undefined ? {} : { keepPartial: options.keepPartial }),
    }).pipe(
      Effect.provideService(DeploymentReceipts, receipts),
      Effect.provideService(InstallPlatform, platform),
    );

    yield* Effect.sync(() => {
      console.log(`\nJitney is ready at ${result.workerUrl}`);
      console.log("Use `runs-on: jitney` in an installed private repository.");
    });
  }).pipe(
    Effect.provide(cloudflareRuntime),
    Effect.mapError(
      (cause): InstallFailure =>
        isInstallFailure(cause)
          ? cause
          : new InstallerError({
              step: "cloudflare_authentication",
              message: "Could not authenticate with Cloudflare",
              cause,
            }),
    ),
  );
}

const makeCloudflareStore = Effect.fn(function* (
  scope: Parameters<typeof makeCloudflareReceiptBackend>[0],
) {
  const backend = yield* makeCloudflareReceiptBackend(scope).pipe(
    Effect.mapError(
      (cause) =>
        new InstallerError({
          step: "receipt_store",
          message: "Could not connect to the deployment receipt store",
          cause,
        }),
    ),
  );
  return makeReceiptStore(backend);
});

const assertDeploymentAbsent = Effect.fn(function* (name: string, receipts: ReceiptStore) {
  const existingReceipt = yield* receipts.get(name).pipe(
    Effect.mapError(
      (cause) =>
        new InstallerError({
          step: "receipt_store",
          message: `Could not check deployment ${name}`,
          cause,
        }),
    ),
  );
  if (Option.isSome(existingReceipt)) {
    return yield* new ExistingDeploymentError({
      name,
      deploymentId: existingReceipt.value.id,
      phase: existingReceipt.value.phase,
    });
  }
});

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

const makeInstallPlatform = Effect.fn(function* (
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
          const registry = yield* provideCloudflareApi(
            Containers.createContainerRegistryCredentials({
              accountId: input.accountId,
              registryId: "registry.cloudflare.com",
              permissions: ["pull", "push"],
              expirationMinutes: 60,
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new InstallerError({
                  step: "registry_cleanup",
                  message: "Could not obtain credentials to remove the partial runner image",
                  cause,
                }),
            ),
          );
          const username = registry.username ?? registry.user;
          if (username === null || username === undefined) {
            return yield* new InstallerError({
              step: "registry_cleanup",
              message: "Cloudflare registry credentials did not include a username",
            });
          }
          yield* deleteImage({
            image: `registry.cloudflare.com/${input.accountId}/${input.receipt.cloudflare.registryRepo}:${registryTag}`,
            registryHost: "registry.cloudflare.com",
            username,
            password: registry.password,
          });
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

function packageVersion(): Effect.Effect<string, InstallerError> {
  return tryPromise("filesystem", "Could not read the Jitney package version", () =>
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).pipe(
    Effect.flatMap((contents) =>
      trySync(
        "filesystem",
        "Jitney package version is missing",
        () => Schema.decodeUnknownSync(PackageMetadata)(JSON.parse(contents)).version,
      ),
    ),
  );
}
