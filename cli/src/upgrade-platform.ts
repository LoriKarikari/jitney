import { Effect, Option, Ref, Schedule, Schema } from "effect";
import { captureCloudflareServices } from "./cloudflare-runtime.js";
import { workerBundlePath } from "./config.js";
import { InstallerError, orStepError } from "./errors.js";
import { deployReceiptStack, liveOperationSecret } from "./receipt-stack.js";
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

export const makeUpgradePlatform = Effect.fn(function* (localVersion: string) {
  const cloudflare = yield* captureCloudflareServices;
  const operationSecret = liveOperationSecret();
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
    bundleFor(version).pipe(
      Effect.flatMap((bundlePath) =>
        deployReceiptStack({ cloudflare, receipt, version, bundlePath, operationSecret }),
      ),
      Effect.asVoid,
    );

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
