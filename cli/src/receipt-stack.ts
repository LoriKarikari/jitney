import { deploy as alchemyDeploy } from "alchemy/Deploy";
import { randomBytes } from "node:crypto";
import { Effect, Layer, Redacted, Schedule } from "effect";
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
  ensureAlchemyStateStore,
  type CloudflareServices,
} from "./cloudflare-runtime.js";
import { InstallerError, orStepError } from "./errors.js";
import { fetchLifecycleStatus } from "./lifecycle-status-client.js";
import type { DeploymentReceipt } from "./receipts/schema.js";

/** An Uninstall Protocol secret that stays live for the two hours a lifecycle command may take. */
export const liveOperationSecret = (): string =>
  mintOperationSecret(Date.now() + 2 * 60 * 60_000, randomBytes(32).toString("base64url"));

export interface ReceiptStackOutput {
  readonly workerUrl: string;
  readonly runnerApplicationId: string;
  readonly runnerImage: string;
}

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

/**
 * Deploy a Deployment's resource stack from its receipt, keeping the Worker's
 * GitHub secrets, then wait for the Worker's lifecycle status to report the
 * version healthy. `adoptExisting` lets Alchemy take over a Worker and
 * container application that it did not create.
 */
export const deployReceiptStack = (input: {
  readonly cloudflare: CloudflareServices;
  readonly receipt: DeploymentReceipt;
  readonly version: string;
  readonly bundlePath: string;
  readonly operationSecret: string;
  readonly adoptExisting?: boolean;
}): Effect.Effect<ReceiptStackOutput, InstallerError> =>
  Effect.gen(function* () {
    const { receipt, version } = input;
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
    const stack = jitneyStack(
      {
        deploymentId: receipt.id,
        workerName: receipt.cloudflare.workerName,
        workerBundlePath: input.bundlePath,
        version,
        manageGitHubApp: app !== null,
        // An adopted Worker already holds its App's secrets, though the receipt
        // learns which App it is only after this deploy.
        githubConfigured: app !== null || input.adoptExisting === true,
        uninstallSecret: Redacted.make(input.operationSecret),
        ...(input.adoptExisting === true ? { adoptExisting: true } : {}),
        ...(receipt.github.ownerType === "Organization" && receipt.github.ownerLogin !== null
          ? { organization: receipt.github.ownerLogin }
          : {}),
      },
      { providers },
    );
    const output = (yield* withAlchemyWorkspace(
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
    )) as ReceiptStackOutput;

    const unhealthy = new InstallerError({
      step: "health_check",
      message: `Jitney ${version} did not pass the health gate`,
    });
    yield* input.cloudflare.provide(fetchLifecycleStatus(receipt)).pipe(
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
    return output;
  }) as unknown as Effect.Effect<ReceiptStackOutput, InstallerError>;
