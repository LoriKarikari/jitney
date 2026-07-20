import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Cloudflare from "alchemy/Cloudflare";
import { createInterface } from "node:readline/promises";
import { hostname, userInfo } from "node:os";
import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { observeAccount } from "./cloudflare-inventory.js";
import { cloudflareRuntime } from "./cloudflare-runtime.js";
import { InstallerError, tryPromise, trySync } from "./errors.js";
import { fetchLifecycleStatus, rewriteOwnershipMarkers } from "./lifecycle-status-client.js";
import { DeploymentReceipts } from "./install.js";
import {
  RepairPlatform,
  repairDeployment,
  renderRepairPlan,
  type OwnershipProbe,
} from "./repair.js";
import {
  findCloudflareReceiptNamespace,
  makeCloudflareReceiptBackend,
} from "./receipts/cloudflare.js";
import { makeReceiptStore } from "./receipts/store.js";

const repairError = (message: string, cause?: unknown) =>
  new InstallerError({
    step: "repair",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const makeRepairPlatform = (assumeYes: boolean) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const provideCloudflare = <A, E>(
      effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
    ) =>
      effect.pipe(
        Effect.provideService(Credentials, credentials),
        Effect.provideService(HttpClient.HttpClient, client),
      );

    return RepairPlatform.of({
      snapshot: (accountId) =>
        provideCloudflare(observeAccount(accountId)).pipe(
          Effect.mapError((cause) => repairError("Could not inspect Cloudflare", cause)),
        ),
      ownership: (receipt) =>
        provideCloudflare(fetchLifecycleStatus(receipt)).pipe(
          Effect.mapError((cause) => repairError("Could not inspect GitHub ownership", cause)),
          Effect.map((status): readonly OwnershipProbe[] =>
            receipt.github.installations.flatMap((installation) =>
              installation.repositories.map((repository) => ({
                fullName: repository.fullName,
                class:
                  status.ownership.find(
                    (item) =>
                      item.installationId === installation.id &&
                      item.repositoryId === repository.id,
                  )?.status ?? "unknown",
              })),
            ),
          ),
        ),
      rewriteOwnership: (receipt, fullNames) =>
        provideCloudflare(rewriteOwnershipMarkers(receipt, fullNames)).pipe(
          Effect.mapError((cause) => repairError("Could not rewrite ownership markers", cause)),
        ),
      confirm: (plan) => {
        if (assumeYes) return Effect.succeed(true);
        return Effect.sync(() => console.log(`\n${renderRepairPlan(plan)}`)).pipe(
          Effect.andThen(
            tryPromise("repair", "Could not read the confirmation", async () => {
              const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              try {
                return await readline.question(
                  `Apply ${plan.actions.length} action${plan.actions.length === 1 ? "" : "s"}? (y/N) `,
                );
              } finally {
                readline.close();
              }
            }),
          ),
          Effect.map((answer) => answer.trim().toLowerCase() === "y"),
        );
      },
    });
  });

export function repairCommand(options: {
  readonly name: string;
  readonly yes?: boolean;
  readonly adopt?: readonly string[];
}): Effect.Effect<void, InstallerError> {
  return Effect.gen(function* () {
    const name = yield* trySync("argument_parsing", "The deployment name is invalid", () => {
      if (options.name.length === 0) throw new TypeError("empty deployment name");
      return options.name;
    });
    const actor = yield* trySync(
      "argument_parsing",
      "Could not identify the command actor",
      () => `${userInfo().username}@${hostname()}`,
    );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const scope = yield* findCloudflareReceiptNamespace(accountId);
    if (Option.isNone(scope)) {
      return yield* repairError("No Jitney deployments exist on this Cloudflare account.");
    }
    const receipts = yield* makeCloudflareReceiptBackend(scope.value).pipe(
      Effect.map(makeReceiptStore),
      Effect.mapError((cause) => repairError("Could not connect to the receipt store", cause)),
    );
    const platform = yield* makeRepairPlatform(options.yes === true);

    const plan = yield* repairDeployment({
      name,
      actor,
      ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
    }).pipe(
      Effect.provideService(DeploymentReceipts, receipts),
      Effect.provideService(RepairPlatform, platform),
    );

    yield* Effect.sync(() => {
      if (options.yes === true) console.log(renderRepairPlan(plan));
      console.log(
        plan.redirect !== null
          ? `\nLease freed. Continue the interrupted operation: npx get-jitney ${plan.redirect} ${plan.redirect === "deploy" ? "--name " : ""}${plan.name}`
          : plan.actions.length === 0 && plan.blockers.length === 0
            ? `\n${plan.name} is clean. Nothing was changed.`
            : `\n${plan.name} repaired.${plan.blockers.length > 0 ? " Some findings still need you (see above)." : ""}`,
      );
    });
  }).pipe(
    Effect.provide(cloudflareRuntime),
    Effect.mapError((cause) =>
      cause instanceof InstallerError
        ? cause
        : repairError("Could not repair the deployment", cause),
    ),
  );
}
