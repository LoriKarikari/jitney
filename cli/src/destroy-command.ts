import * as Cloudflare from "alchemy/Cloudflare";
import { hostname, userInfo } from "node:os";
import { Effect, Option } from "effect";
import { cloudflareRuntime } from "./cloudflare-runtime.js";
import { makeDestroyPlatform } from "./destroy-platform.js";
import {
  DestroyPlatform,
  DestroyResidueError,
  destroyDeployment,
  renderDestroyPlan,
} from "./destroy.js";
import { InstallerError, trySync } from "./errors.js";
import { DeploymentReceipts } from "./install.js";
import {
  findCloudflareReceiptNamespace,
  makeCloudflareReceiptBackend,
} from "./receipts/cloudflare.js";
import { makeReceiptStore } from "./receipts/store.js";

const destroyError = (message: string, cause?: unknown) =>
  new InstallerError({
    step: "destroy",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export function destroyCommand(options: {
  readonly name: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly now?: boolean;
  readonly exportPath?: string;
}): Effect.Effect<void, InstallerError> {
  return Effect.gen(function* () {
    const actor = yield* trySync(
      "argument_parsing",
      "Could not identify the command actor",
      () => `${userInfo().username}@${hostname()}`,
    );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const scope = yield* findCloudflareReceiptNamespace(accountId);
    if (Option.isNone(scope)) {
      return yield* destroyError("No Jitney deployments exist on this Cloudflare account.");
    }
    const receipts = yield* makeCloudflareReceiptBackend(scope.value).pipe(
      Effect.map(makeReceiptStore),
      Effect.mapError((cause) => destroyError("Could not connect to the receipt store", cause)),
    );
    const platform = yield* makeDestroyPlatform(options.yes === true);
    const result = yield* destroyDeployment({
      name: options.name,
      actor,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.exportPath === undefined ? {} : { exportPath: options.exportPath }),
    }).pipe(
      Effect.provideService(DeploymentReceipts, receipts),
      Effect.provideService(DestroyPlatform, platform),
      Effect.mapError((cause) =>
        cause instanceof DestroyResidueError
          ? destroyError(
              `${cause.name} still has ${cause.residue.length} residual resource${cause.residue.length === 1 ? "" : "s"}. Run destroy again after resolving the reported residue.`,
              cause,
            )
          : cause,
      ),
    );
    yield* Effect.sync(() => {
      if (result.status === "dry_run") {
        console.log(`${renderDestroyPlan(result.plan)}\n\nDry run only. Nothing was changed.`);
      } else if (result.status === "cancelled") {
        console.log("Destroy cancelled. Nothing was changed.");
      } else {
        console.log(`${result.plan.name} was destroyed with zero residue.`);
      }
    });
  }).pipe(
    Effect.provide(cloudflareRuntime),
    Effect.mapError((cause) =>
      cause instanceof InstallerError
        ? cause
        : destroyError("Could not destroy the deployment", cause),
    ),
  );
}
