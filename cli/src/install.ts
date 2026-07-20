import { Context, DateTime, Effect } from "effect";
import { InstallRollbackError, InstallerError, type InstallFailure } from "./errors.js";
import type { GitHubAppCredentials } from "./github-app.js";
import {
  createDeploymentReceipt,
  generateDeploymentId,
  type DeploymentReceipt,
  type GitHubInstallation,
  type OperationLease,
} from "./receipts/schema.js";
import type { LeaseContext, ReceiptStore, ReceiptStoreError } from "./receipts/store.js";

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

const receiptError = (message: string) =>
  Effect.mapError(
    (cause: ReceiptStoreError) => new InstallerError({ step: "receipt_store", message, cause }),
  );

type HeldDeploymentReceipt = DeploymentReceipt & { readonly lease: OperationLease };

const requireHeldReceipt = (
  receipt: DeploymentReceipt,
): Effect.Effect<HeldDeploymentReceipt, InstallerError> =>
  receipt.lease === null
    ? Effect.fail(
        new InstallerError({
          step: "receipt_store",
          message: `Deployment ${receipt.name} lost its operation lease`,
        }),
      )
    : Effect.succeed({ ...receipt, lease: receipt.lease });

const leaseContext = (
  name: string,
  receipt: HeldDeploymentReceipt,
  now: DateTime.Utc,
): LeaseContext => ({ name, lease: receipt.lease, now });

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
  let held = yield* receipts
    .createWithInstallLease(initial, input.actor, startedAt)
    .pipe(
      receiptError("Could not create the deployment receipt"),
      Effect.flatMap(requireHeldReceipt),
    );
  let credentials: GitHubAppCredentials | undefined;

  const renewHeldLease = Effect.fn(function* () {
    const now = yield* DateTime.now;
    held = yield* receipts
      .renewLease(leaseContext(input.name, held, now))
      .pipe(receiptError("Could not renew the install lease"), Effect.flatMap(requireHeldReceipt));
  });
  const withLeaseHeartbeat = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    renewHeldLease().pipe(
      Effect.andThen(
        Effect.raceFirst(
          effect,
          Effect.forever(Effect.sleep("5 minutes").pipe(Effect.andThen(renewHeldLease()))),
        ),
      ),
    );

  const operation = Effect.gen(function* () {
    const bootstrap = yield* withLeaseHeartbeat(
      platform.deployBootstrap({ ...input, deploymentId }),
    );

    const resourcesRecordedAt = yield* DateTime.now;
    held = yield* receipts
      .updateOperation(leaseContext(input.name, held, resourcesRecordedAt), {
        cloudflare: {
          ...held.cloudflare,
          applicationId: bootstrap.applicationId,
          tags: { current: bootstrap.registryTag, previous: null },
        },
      })
      .pipe(
        receiptError("Could not record the created Cloudflare resources"),
        Effect.flatMap(requireHeldReceipt),
      );

    const githubApp = yield* withLeaseHeartbeat(
      platform.createGitHubApp({
        ...input,
        workerUrl: bootstrap.workerUrl,
      }),
    );
    credentials = githubApp.credentials;
    const appRecordedAt = yield* DateTime.now;
    held = yield* receipts
      .updateOperation(leaseContext(input.name, held, appRecordedAt), {
        github: {
          ...held.github,
          appId: githubApp.appId,
          appSlug: githubApp.appSlug,
          ownerLogin: githubApp.ownerLogin,
          ownerType: githubApp.ownerType,
        },
      })
      .pipe(
        receiptError("Could not record the created GitHub App"),
        Effect.flatMap(requireHeldReceipt),
      );

    yield* withLeaseHeartbeat(
      platform.activate({ ...input, deploymentId, credentials: githubApp.credentials }),
    );

    const installations = yield* withLeaseHeartbeat(
      platform.installGitHubApp(githubApp.credentials),
    );
    const installationsRecordedAt = yield* DateTime.now;
    held = yield* receipts
      .updateOperation(leaseContext(input.name, held, installationsRecordedAt), {
        github: { ...held.github, installations: [...installations] },
      })
      .pipe(
        receiptError("Could not record the GitHub App installations"),
        Effect.flatMap(requireHeldReceipt),
      );

    yield* withLeaseHeartbeat(
      platform.claimRepositories(githubApp.credentials, deploymentId, installations),
    );
    yield* withLeaseHeartbeat(platform.checkHealth(bootstrap.workerUrl, input.version));

    const completedAt = yield* DateTime.now;
    const receipt = yield* receipts
      .finishOperation(leaseContext(input.name, held, completedAt), {
        phase: "active",
        outcome: "succeeded",
      })
      .pipe(receiptError("Could not complete the deployment receipt"));

    return {
      deploymentId,
      workerUrl: bootstrap.workerUrl,
      receipt,
    } satisfies InstallResult;
  });

  return yield* operation.pipe(
    Effect.catch((cause: InstallFailure) => {
      if (input.keepPartial === true) return Effect.fail(cause);
      return withLeaseHeartbeat(
        platform.rollback({
          ...input,
          deploymentId,
          receipt: held,
          ...(credentials === undefined ? {} : { credentials }),
        }),
      ).pipe(
        Effect.flatMap(() =>
          DateTime.now.pipe(
            Effect.flatMap((now) =>
              receipts.deleteReceipt(leaseContext(input.name, held, now), deploymentId),
            ),
            receiptError("Could not remove the rolled-back deployment receipt"),
          ),
        ),
        Effect.matchEffect({
          onFailure: (rollbackCause) =>
            Effect.fail(new InstallRollbackError({ cause, rollbackCause })),
          onSuccess: () => Effect.fail(cause),
        }),
      );
    }),
  );
});
