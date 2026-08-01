import { Cause, Context, Effect } from "effect";
import { InstallerError, UpgradeRollbackError, orStepError } from "./errors.js";
import { DeploymentReceipts } from "./install.js";
import { beginLeasedOperation } from "./receipts/leased-operation.js";
import { recordedImageTags, type DeploymentReceipt } from "./receipts/schema.js";

export type VersionChangeOperation = "upgrade" | "rollback";

export interface VersionChangeInput {
  readonly name: string;
  readonly actor: string;
  readonly operation: VersionChangeOperation;
  readonly targetVersion?: string;
}

interface PreparedVersion {
  readonly version: string;
  readonly tag: string;
}

export class UpgradePlatform extends Context.Service<
  UpgradePlatform,
  {
    readonly prepare: (
      receipt: DeploymentReceipt,
      operation: VersionChangeOperation,
      targetVersion: string,
      existingTag: string | null,
    ) => Effect.Effect<string, InstallerError>;
    readonly drain: (receipt: DeploymentReceipt) => Effect.Effect<void, InstallerError>;
    readonly activate: (
      receipt: DeploymentReceipt,
      version: string,
    ) => Effect.Effect<void, InstallerError>;
    readonly resume: (receipt: DeploymentReceipt) => Effect.Effect<void, InstallerError>;
    readonly prune: (
      receipt: DeploymentReceipt,
      tag: string,
      protectedTags: ReadonlySet<string>,
    ) => Effect.Effect<void, InstallerError>;
  }
>()("Jitney.UpgradePlatform") {}

const missingVersion = (message: string) => new InstallerError({ step: "upgrade", message });

function targetFor(
  receipt: DeploymentReceipt,
  input: VersionChangeInput,
): Effect.Effect<PreparedVersion, InstallerError, UpgradePlatform> {
  return Effect.gen(function* () {
    const platform = yield* UpgradePlatform;
    const version = input.operation === "upgrade" ? input.targetVersion : receipt.versions.previous;
    const existingTag = input.operation === "rollback" ? receipt.cloudflare.tags.previous : null;
    if (version === undefined || version === null) {
      return yield* missingVersion(
        input.operation === "rollback"
          ? `Deployment ${receipt.name} has no previous version to roll back to`
          : "The upgrade target version is missing",
      );
    }
    if (input.operation === "rollback" && existingTag === null) {
      return yield* missingVersion(
        `Deployment ${receipt.name} has no previous image tag to roll back to`,
      );
    }
    const tag = yield* platform.prepare(receipt, input.operation, version, existingTag);
    return { version, tag };
  });
}

export const changeDeploymentVersion = Effect.fn(function* (input: VersionChangeInput) {
  const receipts = yield* DeploymentReceipts;
  const platform = yield* UpgradePlatform;
  const held = yield* beginLeasedOperation(receipts, input.name, input.operation, input.actor);
  const original = yield* held.receipt();
  let drained = false;

  const operation = Effect.gen(function* () {
    if (
      input.operation === "upgrade" &&
      input.targetVersion !== undefined &&
      input.targetVersion === original.versions.current
    ) {
      return yield* held.finish({ phase: "active", outcome: "succeeded" });
    }

    const target = yield* targetFor(original, input);
    const desiredVersions = {
      current: target.version,
      previous: original.versions.current,
    };
    const desiredCloudflare = {
      ...original.cloudflare,
      tags: {
        current: target.tag,
        previous: original.cloudflare.tags.current,
      },
    };
    const desired = yield* held.record(() => ({
      versions: desiredVersions,
      cloudflare: desiredCloudflare,
    }));

    yield* platform.drain(desired);
    drained = true;
    yield* platform.activate(desired, target.version);

    if (input.operation === "upgrade" && original.cloudflare.tags.previous !== null) {
      const protectedTags = new Set(
        (yield* receipts
          .list()
          .pipe(Effect.mapError(orStepError("receipt_store", "Could not inspect image ownership"))))
          .filter((receipt) => receipt.id !== original.id)
          .flatMap((receipt) => recordedImageTags(receipt.cloudflare)),
      );
      yield* platform.prune(desired, original.cloudflare.tags.previous, protectedTags);
    }

    yield* platform.resume(desired);
    return yield* held.finish({
      phase: "active",
      outcome: "succeeded",
      versions: desiredVersions,
      cloudflare: desiredCloudflare,
    });
  });

  return yield* held.hold(
    operation.pipe(
      Effect.catchCause((cause) => {
        const restoreReceipt = held.finish({
          phase: "active",
          outcome: "failed",
          versions: original.versions,
          cloudflare: original.cloudflare,
        });
        if (!drained || original.versions.current === null) {
          return restoreReceipt.pipe(Effect.andThen(Effect.failCause(cause)));
        }
        const rollback = platform
          .activate(original, original.versions.current)
          .pipe(Effect.andThen(platform.resume(original)), Effect.andThen(restoreReceipt));
        return rollback.pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.failCause(cause),
            onFailure: (rollbackCause) =>
              Effect.fail(
                new UpgradeRollbackError({
                  operation: input.operation,
                  cause: Cause.squash(cause),
                  rollbackCause,
                }),
              ),
          }),
        );
      }),
    ),
  );
});
