import { Context, Data, Effect, Option } from "effect";
import { InstallerError } from "./errors.js";
import { DeploymentReceipts } from "./install.js";
import { beginLeasedOperation } from "./receipts/leased-operation.js";
import type { DeploymentReceipt, DestroyResidue } from "./receipts/schema.js";

export interface DestroyPlan {
  readonly name: string;
  readonly deploymentId: string;
  readonly workerName: string;
  readonly applicationId: string | null;
  readonly appSlug: string | null;
  readonly installationIds: readonly number[];
  readonly repositories: readonly string[];
  readonly imageTags: readonly string[];
}

export interface DestroyInput {
  readonly name: string;
  readonly actor: string;
  readonly dryRun?: boolean;
  readonly now?: boolean;
  readonly exportPath?: string;
}

export interface DestroyResult {
  readonly status: "dry_run" | "cancelled" | "destroyed";
  readonly plan: DestroyPlan;
}

export class DestroyResidueError extends Data.TaggedError("DestroyResidueError")<{
  name: string;
  residue: readonly DestroyResidue[];
}> {}

export class DestroyPlatform extends Context.Service<
  DestroyPlatform,
  {
    readonly exportReceipt: (
      receipt: DeploymentReceipt,
      path: string,
    ) => Effect.Effect<void, InstallerError>;
    readonly confirm: (plan: DestroyPlan) => Effect.Effect<boolean, InstallerError>;
    readonly suspend: (receipt: DeploymentReceipt) => Effect.Effect<void, InstallerError>;
    readonly drain: (receipt: DeploymentReceipt) => Effect.Effect<void, InstallerError>;
    readonly deleteOwnership: (receipt: DeploymentReceipt) => Effect.Effect<void, InstallerError>;
    readonly deleteInstallations: (
      receipt: DeploymentReceipt,
    ) => Effect.Effect<void, InstallerError>;
    /** Destroy the receipt-owned Cloudflare stack through Alchemy. */
    readonly destroyCloudflare: (receipt: DeploymentReceipt) => Effect.Effect<void, InstallerError>;
    readonly pruneImages: (
      receipt: DeploymentReceipt,
      protectedTags: ReadonlySet<string>,
    ) => Effect.Effect<void, InstallerError>;
    readonly deleteApp: (receipt: DeploymentReceipt) => Effect.Effect<void, InstallerError>;
    readonly verify: (
      receipt: DeploymentReceipt,
    ) => Effect.Effect<readonly DestroyResidue[], InstallerError>;
  }
>()("Jitney.DestroyPlatform") {}

const destroyError = (message: string, cause?: unknown) =>
  new InstallerError({
    step: "destroy",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export const planDestroy = (receipt: DeploymentReceipt): DestroyPlan => ({
  name: receipt.name,
  deploymentId: receipt.id,
  workerName: receipt.cloudflare.workerName,
  applicationId: receipt.cloudflare.applicationId,
  appSlug: receipt.github.appSlug,
  installationIds: receipt.github.installations.map((installation) => installation.id),
  repositories: receipt.github.installations.flatMap((installation) =>
    installation.repositories.map((repository) => repository.fullName),
  ),
  imageTags: [receipt.cloudflare.tags.current, receipt.cloudflare.tags.previous].filter(
    (tag): tag is string => tag !== null,
  ),
});

const protectedImageTags = (
  receipts: readonly DeploymentReceipt[],
  deploymentId: string,
): ReadonlySet<string> =>
  new Set(
    receipts
      .filter((receipt) => receipt.id !== deploymentId)
      .flatMap((receipt) => [receipt.cloudflare.tags.current, receipt.cloudflare.tags.previous])
      .filter((tag): tag is string => tag !== null),
  );

export function renderDestroyResidue(residue: readonly DestroyResidue[]): string {
  return residue
    .map((item) => `  ${item.plane} ${item.resource} ${item.id}: ${item.reason}`)
    .join("\n");
}

export function renderDestroyPlan(plan: DestroyPlan): string {
  return [
    `${plan.name} (${plan.deploymentId}) will be destroyed:`,
    `  Worker: ${plan.workerName}`,
    `  Container application: ${plan.applicationId ?? "already missing"}`,
    `  GitHub App: ${plan.appSlug ?? "already missing"}`,
    `  Installations: ${plan.installationIds.join(", ") || "none"}`,
    `  Repositories: ${plan.repositories.join(", ") || "none"}`,
    `  Image tags: ${plan.imageTags.join(", ") || "none"}`,
  ].join("\n");
}

export const destroyDeployment = Effect.fn("Jitney.destroyDeployment")(function* (
  input: DestroyInput,
) {
  const receipts = yield* DeploymentReceipts;
  const platform = yield* DestroyPlatform;
  const receipt = yield* receipts.get(input.name).pipe(
    Effect.mapError((cause) => destroyError(`Could not read deployment ${input.name}`, cause)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(destroyError(`Deployment ${input.name} has no receipt. Nothing to destroy.`)),
        onSome: Effect.succeed,
      }),
    ),
  );
  const plan = planDestroy(receipt);

  if (input.dryRun === true) return { status: "dry_run", plan } satisfies DestroyResult;

  if (input.exportPath !== undefined) {
    // Receipts contain no credentials. Clearing the lease also keeps a stale
    // coordination token out of the portable export.
    yield* platform.exportReceipt({ ...receipt, lease: null }, input.exportPath);
  }

  const confirmed = yield* platform.confirm(plan);
  if (!confirmed) return { status: "cancelled", plan } satisfies DestroyResult;

  const allReceipts = yield* receipts
    .list()
    .pipe(Effect.mapError((cause) => destroyError("Could not inspect image references", cause)));
  const protectedTags = protectedImageTags(allReceipts, receipt.id);
  const held = yield* beginLeasedOperation(receipts, input.name, "destroy", input.actor);

  const teardown = Effect.gen(function* () {
    const current = yield* held.receipt();
    yield* held.guard(platform.suspend(current));
    if (input.now !== true) yield* held.guard(platform.drain(current));
    yield* held.guard(platform.deleteOwnership(current));
    yield* held.guard(platform.deleteInstallations(current));
    yield* held.guard(platform.destroyCloudflare(current));
    yield* held.guard(platform.pruneImages(current, protectedTags));
    yield* held.guard(platform.deleteApp(current));
    const residue = yield* held.guard(platform.verify(current));
    if (residue.length > 0) {
      yield* held.finish({
        phase: "destroying",
        outcome: "failed",
        residue,
      });
      return yield* new DestroyResidueError({ name: input.name, residue });
    }
    yield* held.deleteReceipt(receipt.id);
  });

  yield* teardown.pipe(
    Effect.tapError((error) =>
      // The residue branch already settled the receipt before failing.
      error instanceof DestroyResidueError
        ? Effect.void
        : held.finish({ phase: "destroying", outcome: "failed" }).pipe(Effect.ignore),
    ),
  );
  return { status: "destroyed", plan } satisfies DestroyResult;
});
