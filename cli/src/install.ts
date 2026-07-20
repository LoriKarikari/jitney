import { Context, DateTime, Effect } from "effect";
import { InstallRollbackError, type InstallerError, type InstallFailure } from "./errors.js";
import type { GitHubAppCredentials } from "./github-app.js";
import { beginInstallOperation } from "./receipts/leased-operation.js";
import {
  createDeploymentReceipt,
  generateDeploymentId,
  type DeploymentReceipt,
  type GitHubInstallation,
} from "./receipts/schema.js";
import type { ReceiptStore } from "./receipts/store.js";

export interface InstallStackOutput {
  readonly workerUrl: string;
  readonly applicationId: string;
  readonly registryTag: string;
}

export interface CreatedGitHubApp {
  readonly appId: number;
  readonly appSlug: string;
  readonly ownerLogin: string;
  readonly ownerType: "User" | "Organization";
  readonly credentials: GitHubAppCredentials;
}

export interface InstallInput {
  readonly name: string;
  readonly accountId: string;
  readonly version: string;
  readonly actor: string;
  readonly organization?: string;
  readonly keepPartial?: boolean;
}

export interface InstallResult {
  readonly deploymentId: string;
  readonly workerUrl: string;
  readonly receipt: DeploymentReceipt;
}

export class DeploymentReceipts extends Context.Service<DeploymentReceipts, ReceiptStore>()(
  "Jitney.DeploymentReceipts",
) {}

export class InstallPlatform extends Context.Service<
  InstallPlatform,
  {
    readonly deployBootstrap: (
      input: InstallInput & { readonly deploymentId: string },
    ) => Effect.Effect<InstallStackOutput, InstallerError>;
    readonly createGitHubApp: (
      input: InstallInput & { readonly workerUrl: string },
    ) => Effect.Effect<CreatedGitHubApp, InstallerError>;
    readonly activate: (
      input: InstallInput & {
        readonly deploymentId: string;
        readonly credentials: GitHubAppCredentials;
      },
    ) => Effect.Effect<void, InstallerError>;
    readonly installGitHubApp: (
      credentials: GitHubAppCredentials,
    ) => Effect.Effect<readonly GitHubInstallation[], InstallerError>;
    readonly claimRepositories: (
      credentials: GitHubAppCredentials,
      deploymentId: string,
      installations: readonly GitHubInstallation[],
    ) => Effect.Effect<void, InstallerError>;
    readonly checkHealth: (
      workerUrl: string,
      version: string,
    ) => Effect.Effect<void, InstallerError>;
    readonly rollback: (
      input: InstallInput & {
        readonly deploymentId: string;
        readonly receipt: DeploymentReceipt;
        readonly credentials?: GitHubAppCredentials;
      },
    ) => Effect.Effect<void, InstallerError>;
  }
>()("Jitney.InstallPlatform") {}

export const installDeployment = Effect.fn(function* (input: InstallInput) {
  const receipts = yield* DeploymentReceipts;
  const platform = yield* InstallPlatform;
  const deploymentId = yield* generateDeploymentId;
  const startedAt = yield* DateTime.now;
  const initial = createDeploymentReceipt({
    id: deploymentId,
    name: input.name,
    version: input.version,
    now: startedAt,
    cloudflare: {
      accountId: input.accountId,
      workerName: input.name,
      applicationId: null,
      applicationName: `${input.name}-runner`,
      durableObjectClasses: ["Scheduler", "RunnerContainer"],
      registryRepo: `${input.name}-runner`,
      tags: { current: input.version, previous: null },
    },
    github: {
      appId: null,
      appSlug: null,
      ownerLogin: input.organization ?? null,
      ownerType: input.organization === undefined ? "User" : "Organization",
      installations: [],
    },
    autoUpgrade: { enabled: false, channel: "patch" },
  });
  const held = yield* beginInstallOperation(receipts, initial, input.actor, startedAt);
  let credentials: GitHubAppCredentials | undefined;

  const operation = Effect.gen(function* () {
    const bootstrap = yield* held.guard(platform.deployBootstrap({ ...input, deploymentId }));

    yield* held.record((current) => ({
      cloudflare: {
        ...current.cloudflare,
        applicationId: bootstrap.applicationId,
        tags: { current: bootstrap.registryTag, previous: null },
      },
    }));

    const githubApp = yield* held.guard(
      platform.createGitHubApp({
        ...input,
        workerUrl: bootstrap.workerUrl,
      }),
    );
    credentials = githubApp.credentials;
    yield* held.record((current) => ({
      github: {
        ...current.github,
        appId: githubApp.appId,
        appSlug: githubApp.appSlug,
        ownerLogin: githubApp.ownerLogin,
        ownerType: githubApp.ownerType,
      },
    }));

    yield* held.guard(
      platform.activate({ ...input, deploymentId, credentials: githubApp.credentials }),
    );

    const installations = yield* held.guard(platform.installGitHubApp(githubApp.credentials));
    yield* held.record((current) => ({
      github: { ...current.github, installations: [...installations] },
    }));

    yield* held.guard(
      platform.claimRepositories(githubApp.credentials, deploymentId, installations),
    );
    yield* held.guard(platform.checkHealth(bootstrap.workerUrl, input.version));

    const receipt = yield* held.finish({ phase: "active", outcome: "succeeded" });

    return {
      deploymentId,
      workerUrl: bootstrap.workerUrl,
      receipt,
    } satisfies InstallResult;
  });

  return yield* operation.pipe(
    Effect.catch((cause: InstallFailure) => {
      if (input.keepPartial === true) return Effect.fail(cause);
      return held.receipt().pipe(
        Effect.flatMap((receipt) =>
          held.guard(
            platform.rollback({
              ...input,
              deploymentId,
              receipt,
              ...(credentials === undefined ? {} : { credentials }),
            }),
          ),
        ),
        Effect.flatMap(() => held.deleteReceipt(deploymentId)),
        Effect.matchEffect({
          onFailure: (rollbackCause) =>
            Effect.fail(new InstallRollbackError({ cause, rollbackCause })),
          onSuccess: () => Effect.fail(cause),
        }),
      );
    }),
  );
});
