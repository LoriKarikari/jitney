import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { request } from "@octokit/request";
import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { AdoptPlatform } from "./adopt.js";
import { observeAccount, runnerApplicationName } from "./cloudflare-inventory.js";
import { captureCloudflareServices } from "./cloudflare-runtime.js";
import { workerBundlePath } from "./config.js";
import { InstallerError, orStepError, tryPromise } from "./errors.js";
import { fetchLifecycleStatus, rewriteOwnershipMarkers } from "./lifecycle-status-client.js";
import { deployReceiptStack, liveOperationSecret } from "./receipt-stack.js";
import { GitHubInstallation } from "./receipts/schema.js";
import { makeWorkerLifecycleClient } from "./worker-lifecycle-client.js";

const InventoryResponse = Schema.Struct({ installations: Schema.Array(GitHubInstallation) });

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
    resolveApp: (slug) =>
      tryPromise("adopt", `GitHub App ${slug} does not exist`, () =>
        request("GET /apps/{app_slug}", { app_slug: slug }),
      ).pipe(
        Effect.flatMap(({ data }) => {
          if (data === null) {
            return Effect.fail(
              new InstallerError({ step: "adopt", message: `GitHub App ${slug} does not exist` }),
            );
          }
          const owner = data.owner;
          const ownerType =
            owner !== null &&
            "type" in owner &&
            (owner.type === "User" || owner.type === "Organization")
              ? owner.type
              : undefined;
          return owner === null || !("login" in owner) || ownerType === undefined
            ? Effect.fail(
                new InstallerError({
                  step: "adopt",
                  message: `GitHub App ${slug} is not owned by a user or organization`,
                }),
              )
            : Effect.succeed({
                appId: data.id,
                appSlug: data.slug ?? slug,
                ownerLogin: owner.login,
                ownerType,
              });
        }),
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
                try: () => Schema.decodeUnknownSync(InventoryResponse)(body).installations,
                catch: orStepError("adopt", "The Worker returned an invalid inventory"),
              }),
          }),
        ),
      ),
    ownership: (receipt) =>
      cloudflare.provide(fetchLifecycleStatus(receipt)).pipe(
        Effect.map((status) => {
          const fullNames = new Map(
            receipt.github.installations.flatMap((installation) =>
              installation.repositories.map(
                (repository) =>
                  [`${installation.id}:${repository.id}`, repository.fullName] as const,
              ),
            ),
          );
          return status.ownership.flatMap((entry) => {
            const fullName = fullNames.get(`${entry.installationId}:${entry.repositoryId}`);
            return fullName === undefined ? [] : [{ fullName, status: entry.status }];
          });
        }),
        Effect.mapError(orStepError("repository_ownership", "Could not read Ownership Markers")),
      ),
    writeOwnership: (receipt, fullNames) =>
      cloudflare
        .provide(rewriteOwnershipMarkers(receipt, fullNames))
        .pipe(
          Effect.mapError(orStepError("repository_ownership", "Could not write Ownership Markers")),
        ),
  });
});
