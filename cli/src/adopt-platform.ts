import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Data, Effect, Option, Predicate, Schedule, Schema, Stream } from "effect";
import { AdoptPlatform } from "./adopt.js";
import { observeAccount, runnerApplicationName } from "./cloudflare-inventory.js";
import { captureCloudflareServices } from "./cloudflare-runtime.js";
import { workerBundlePath } from "./config.js";
import { InstallerError, orStepError } from "./errors.js";
import { fetchLifecycleStatus, rewriteOwnershipMarkers } from "./lifecycle-status-client.js";
import { deployReceiptStack, liveOperationSecret } from "./receipt-stack.js";
import { GitHubInstallation } from "./receipts/schema.js";
import { makeWorkerLifecycleClient } from "./worker-lifecycle-client.js";

const InventoryResponse = Schema.Struct({
  app: Schema.Struct({
    id: Schema.Number,
    slug: Schema.String,
    ownerLogin: Schema.String,
    ownerType: Schema.Literals(["User", "Organization"]),
  }),
  installations: Schema.Array(GitHubInstallation),
});

/** KV caches a read at the edge for up to 60 seconds. */
const kvPropagation = Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(23)]);

class StaleReceipt extends Data.TaggedError("StaleReceipt")<{
  entries: readonly {
    readonly fullName: string;
    readonly status: "ok" | "missing" | "drifted" | "unknown";
  }[];
}> {}

export const makeAdoptPlatform = Effect.fn(function* (version: string) {
  const cloudflare = yield* captureCloudflareServices;
  const operationSecret = liveOperationSecret();
  const lifecycle = yield* makeWorkerLifecycleClient(cloudflare, "adopt", operationSecret);

  return AdoptPlatform.of({
    inspect: ({ accountId, name }) =>
      cloudflare
        .provide(
          Effect.gen(function* () {
            const snapshot = yield* observeAccount(accountId);
            const application = snapshot.applications.find(
              (candidate) => candidate.name === runnerApplicationName(name),
            );
            const live = snapshot.workers.find((candidate) => candidate.name === name);
            if (live === undefined) {
              return {
                worker: null,
                application: application === undefined ? null : { id: application.id },
              };
            }
            const namespaces = yield* Stream.runCollect(
              DurableObjects.listNamespaces.items({ accountId }),
            );
            const secrets = yield* Stream.runCollect(
              Workers.listScriptSecrets.items({ accountId, scriptName: name }),
            );
            return {
              worker: {
                durableObjectClasses: [...namespaces].flatMap((namespace) =>
                  namespace.script === name && Predicate.isString(namespace.class)
                    ? [namespace.class]
                    : [],
                ),
                secretNames: [...secrets].map((secret) => secret.name),
                deploymentId: live.deploymentId,
              },
              application: application === undefined ? null : { id: application.id },
            };
          }),
        )
        .pipe(
          Effect.mapError(orStepError("adopt", `Could not inspect the resources named ${name}`)),
        ),
    deploy: (receipt) =>
      Effect.gen(function* () {
        const output = yield* deployReceiptStack({
          cloudflare,
          receipt,
          version,
          bundlePath: workerBundlePath(),
          operationSecret,
          adoptExisting: true,
        });
        const imagePrefix = `registry.cloudflare.com/${receipt.cloudflare.accountId}/${receipt.cloudflare.registryRepo}:`;
        if (!output.runnerImage.startsWith(imagePrefix) || output.runnerImage === imagePrefix) {
          return yield* new InstallerError({
            step: "registry_copy",
            message: `Cloudflare returned an unexpected runner image: ${output.runnerImage}`,
          });
        }
        return {
          applicationId: output.runnerApplicationId,
          registryTag: output.runnerImage.slice(imagePrefix.length),
        };
      }),
    inventory: (receipt) =>
      lifecycle.call(receipt, "inventory").pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new InstallerError({ step: "adopt", message: "The Worker is unavailable" }),
              ),
            onSome: (body) =>
              Effect.try({
                try: () => {
                  const { app, installations } = Schema.decodeUnknownSync(InventoryResponse)(body);
                  return {
                    app: {
                      appId: app.id,
                      appSlug: app.slug,
                      ownerLogin: app.ownerLogin,
                      ownerType: app.ownerType,
                    },
                    installations,
                  };
                },
                catch: orStepError("adopt", "The Worker returned an invalid inventory"),
              }),
          }),
        ),
      ),
    ownership: (receipt) => {
      const fullNames = new Map(
        receipt.github.installations.flatMap((installation) =>
          installation.repositories.map(
            (repository) => [`${installation.id}:${repository.id}`, repository.fullName] as const,
          ),
        ),
      );
      const read = cloudflare.provide(fetchLifecycleStatus(receipt)).pipe(
        Effect.map((status) =>
          status.ownership.flatMap((entry) => {
            const fullName = fullNames.get(`${entry.installationId}:${entry.repositoryId}`);
            return fullName === undefined ? [] : [{ fullName, status: entry.status }];
          }),
        ),
        Effect.mapError(orStepError("repository_ownership", "Could not read Ownership Markers")),
      );
      // The Worker reads the receipt from KV, which may serve a copy cached
      // before the installations were recorded.
      return read.pipe(
        Effect.flatMap((entries) =>
          entries.length < fullNames.size
            ? Effect.fail(new StaleReceipt({ entries }))
            : Effect.succeed(entries),
        ),
        Effect.retry({ while: (error) => error instanceof StaleReceipt, schedule: kvPropagation }),
        Effect.catchTag("StaleReceipt", ({ entries }) => Effect.succeed(entries)),
      );
    },
    writeOwnership: (receipt, fullNames) =>
      cloudflare
        .provide(rewriteOwnershipMarkers(receipt, fullNames))
        .pipe(
          Effect.retry({ schedule: kvPropagation }),
          Effect.mapError(orStepError("repository_ownership", "Could not write Ownership Markers")),
        ),
  });
});
