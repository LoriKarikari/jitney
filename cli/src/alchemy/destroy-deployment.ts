import * as Alchemy from "alchemy";
import { destroy as alchemyDestroy } from "alchemy/Destroy";
import { Effect, Layer, Redacted } from "effect";
import { GitHubAppOperationError, GitHubAppOperations } from "./github-app.js";
import { jitneyStack, type JitneyProviderLayer } from "./jitney-stack.js";
import { jitneyProviders } from "./providers.js";
import { withAlchemyWorkspace } from "./workspace.js";
import { alchemyCli } from "../cloudflare-runtime.js";
import { workerBundlePath } from "../config.js";
import { InstallerError } from "../errors.js";
import type { DeploymentReceipt } from "../receipts/schema.js";

/** Destroy the Cloudflare resources recorded in one Alchemy deployment stage. */
export const destroyDeploymentStack = (
  receipt: DeploymentReceipt,
): Effect.Effect<void, InstallerError> => {
  const githubOperations = Layer.succeed(GitHubAppOperations, {
    reconcile: ({ current }) =>
      current === undefined
        ? Effect.fail(
            new GitHubAppOperationError({
              operation: "reconcile",
              cause: new Error("GitHub App state is missing"),
            }),
          )
        : Effect.succeed(current),
    delete: () => Effect.void,
    list: () => Effect.succeed([]),
  });
  const providers = jitneyProviders(githubOperations) as unknown as JitneyProviderLayer;
  const version = receipt.versions.current ?? receipt.versions.previous;
  if (version === null) {
    return Effect.fail(
      new InstallerError({
        step: "destroy",
        message: `Deployment ${receipt.name} has no recorded version`,
      }),
    );
  }
  const stack = jitneyStack(
    {
      deploymentId: receipt.id,
      workerName: receipt.cloudflare.workerName,
      workerBundlePath: workerBundlePath(),
      version,
      manageGitHubApp: receipt.github.appSlug !== null,
      // Destroy only reads existing resource state. This value is never applied.
      uninstallSecret: Redacted.make("destroy-state-placeholder"),
    },
    { providers },
  );
  return withAlchemyWorkspace(alchemyDestroy({ stack, stage: receipt.name })).pipe(
    Effect.provideService(Alchemy.Cli, alchemyCli),
    Effect.asVoid,
    Effect.mapError((cause) =>
      cause instanceof InstallerError
        ? cause
        : new InstallerError({
            step: "destroy",
            message: "Could not destroy the Cloudflare deployment through Alchemy",
            cause,
          }),
    ),
  ) as Effect.Effect<void, InstallerError>;
};
