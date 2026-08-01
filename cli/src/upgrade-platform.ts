import { deploy as alchemyDeploy } from "alchemy/Deploy";
import { randomBytes } from "node:crypto";
import { Effect, Layer, Option, Redacted, Ref, Schedule, Schema } from "effect";
import { mintOperationSecret } from "@jitney/shared/uninstall-protocol";
import {
  GitHubAppOperationError,
  GitHubAppOperations,
  type GitHubAppAttributes,
} from "./alchemy/github-app.js";
import { jitneyStack, type JitneyProviderLayer } from "./alchemy/jitney-stack.js";
import { jitneyProviders } from "./alchemy/providers.js";
import { withAlchemyWorkspace } from "./alchemy/workspace.js";
import {
  alchemyRuntime,
  captureCloudflareServices,
  ensureAlchemyStateStore,
} from "./cloudflare-runtime.js";
import { workerBundlePath } from "./config.js";
import { InstallerError, orStepError } from "./errors.js";
import { fetchLifecycleStatus } from "./lifecycle-status-client.js";
import type { DeploymentReceipt } from "./receipts/schema.js";
import {
  copyRunnerImage,
  deleteRunnerImageTag,
  garbageCollectRunnerLayers,
  listRunnerImageTags,
} from "./runner-image-registry.js";
import { UpgradePlatform } from "./upgrade.js";
import { makeWorkerLifecycleClient } from "./worker-lifecycle-client.js";
import { downloadWorkerBundle } from "./worker-artifact.js";

const DrainResponse = Schema.Struct({ activeAttempts: Schema.Number });
const secret = () =>
  mintOperationSecret(Date.now() + 2 * 60 * 60_000, randomBytes(32).toString("base64url"));

const appAttributes = (receipt: DeploymentReceipt): GitHubAppAttributes | null => {
  if (
    receipt.github.appId === null ||
    receipt.github.appSlug === null ||
    receipt.github.ownerLogin === null
  ) {
    return null;
  }
  const settingsUrl =
    receipt.github.ownerType === "Organization"
      ? `https://github.com/organizations/${receipt.github.ownerLogin}/settings/apps/${receipt.github.appSlug}`
      : `https://github.com/settings/apps/${receipt.github.appSlug}`;
  return {
    appId: String(receipt.github.appId),
    slug: receipt.github.appSlug,
    settingsUrl,
    ownerLogin: receipt.github.ownerLogin,
    ownerType: receipt.github.ownerType,
  };
};

export const makeUpgradePlatform = Effect.fn(function* (localVersion: string) {
  const cloudflare = yield* captureCloudflareServices;
  const operationSecret = secret();
  const lifecycle = yield* makeWorkerLifecycleClient(cloudflare, "upgrade", operationSecret);
  const bundles = yield* Ref.make(new Map([[localVersion, workerBundlePath()]]));

  const bundleFor = (version: string) =>
    Effect.gen(function* () {
      const known = (yield* Ref.get(bundles)).get(version);
      if (known !== undefined) return known;
      const bundle = yield* downloadWorkerBundle(version);
      yield* Ref.update(bundles, (current) => new Map(current).set(version, bundle));
      return bundle;
    });

  const deployVersion = (receipt: DeploymentReceipt, version: string) =>
    Effect.gen(function* () {
      const app = appAttributes(receipt);
      const githubOperations = Layer.succeed(GitHubAppOperations, {
        reconcile: ({ current }) =>
          current !== undefined
            ? Effect.succeed(current)
            : app === null
              ? Effect.fail(
                  new GitHubAppOperationError({
                    operation: "reconcile",
                    cause: new Error("The deployment receipt has no GitHub App"),
                  }),
                )
              : Effect.succeed(app),
        delete: () => Effect.void,
        list: () => Effect.succeed(app === null ? [] : [app]),
      });
      const providers = jitneyProviders(githubOperations) as unknown as JitneyProviderLayer;
      const bundle = yield* bundleFor(version);
      const stack = jitneyStack(
        {
          deploymentId: receipt.id,
          workerName: receipt.cloudflare.workerName,
          workerBundlePath: bundle,
          version,
          manageGitHubApp: app !== null,
          githubConfigured: app !== null,
          uninstallSecret: Redacted.make(operationSecret),
          ...(receipt.github.ownerType === "Organization" && receipt.github.ownerLogin !== null
            ? { organization: receipt.github.ownerLogin }
            : {}),
        },
        { providers },
      );
      yield* withAlchemyWorkspace(
        ensureAlchemyStateStore.pipe(Effect.andThen(alchemyDeploy({ stack, stage: receipt.name }))),
      ).pipe(
        Effect.provide(alchemyRuntime),
        Effect.mapError(
          (cause) =>
            new InstallerError({
              step: "worker_deployment",
              message: `Could not deploy Jitney ${version}`,
              cause,
            }),
        ),
      );

      const unhealthy = new InstallerError({
        step: "health_check",
        message: `Jitney ${version} did not pass the upgrade health gate`,
      });
      yield* cloudflare.provide(fetchLifecycleStatus(receipt)).pipe(
        Effect.flatMap((status) =>
          status.version === version &&
          status.scheduler === "ok" &&
          status.container === "ok" &&
          status.app === "ok"
            ? Effect.void
            : Effect.fail(unhealthy),
        ),
        Effect.mapError(orStepError("health_check", `Jitney ${version} failed its health gate`)),
        Effect.retry(Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(29)])),
      );
    }) as unknown as Effect.Effect<void, InstallerError>;

  return UpgradePlatform.of({
    prepare: (receipt, operation, targetVersion, existingTag) =>
      Effect.gen(function* () {
        yield* bundleFor(targetVersion);
        if (receipt.versions.current !== null) yield* bundleFor(receipt.versions.current);
        if (operation === "rollback") {
          if (existingTag === null) {
            return yield* new InstallerError({
              step: "upgrade",
              message: `Deployment ${receipt.name} has no previous image tag`,
            });
          }
          const tags = yield* cloudflare.provide(
            listRunnerImageTags(receipt.cloudflare.accountId, receipt.cloudflare.registryRepo),
          );
          if (!tags.includes(existingTag)) {
            return yield* new InstallerError({
              step: "upgrade",
              message: `Previous image tag ${existingTag} is missing`,
            });
          }
          return existingTag;
        }
        return yield* cloudflare.provide(
          copyRunnerImage(
            receipt.cloudflare.accountId,
            receipt.cloudflare.registryRepo,
            targetVersion,
          ),
        );
      }),
    drain: (receipt) => {
      const active = new InstallerError({
        step: "upgrade",
        message: `Runner Attempts are still active for ${receipt.name}`,
      });
      const wait = lifecycle.call(receipt, "drain").pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new InstallerError({ step: "upgrade", message: "The Worker is unavailable" }),
              ),
            onSome: (body) =>
              Effect.try({
                try: () => Schema.decodeUnknownSync(DrainResponse)(body),
                catch: orStepError("upgrade", "The Worker returned an invalid drain response"),
              }).pipe(
                Effect.flatMap(({ activeAttempts }) =>
                  activeAttempts === 0 ? Effect.void : Effect.fail(active),
                ),
              ),
          }),
        ),
        Effect.retry({
          while: (error) => error === active,
          schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(719)]),
        }),
      );
      return lifecycle.call(receipt, "suspend_intake").pipe(
        Effect.andThen(wait),
        Effect.asVoid,
        Effect.onError(() => lifecycle.call(receipt, "resume_intake").pipe(Effect.ignore)),
      );
    },
    activate: deployVersion,
    resume: (receipt) => lifecycle.call(receipt, "resume_intake").pipe(Effect.asVoid),
    prune: (receipt, tag, protectedTags) =>
      protectedTags.has(tag)
        ? Effect.void
        : cloudflare
            .provide(
              deleteRunnerImageTag(
                receipt.cloudflare.accountId,
                receipt.cloudflare.registryRepo,
                tag,
              ),
            )
            .pipe(
              Effect.andThen(
                cloudflare.provide(garbageCollectRunnerLayers(receipt.cloudflare.accountId)),
              ),
            ),
  });
});
