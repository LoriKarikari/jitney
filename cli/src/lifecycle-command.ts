import * as Cloudflare from "alchemy/Cloudflare";
import { hostname, userInfo } from "node:os";
import { Effect, Layer, Option } from "effect";
import { cloudflareRuntime } from "./cloudflare-runtime.js";
import {
  orStepError,
  stepError,
  trySync,
  isInstallFailure,
  type InstallFailure,
  type InstallerError,
  type InstallerStep,
} from "./errors.js";
import {
  findCloudflareReceiptNamespace,
  makeCloudflareReceiptBackend,
} from "./receipts/cloudflare.js";
import { makeReceiptStore, type ReceiptStore } from "./receipts/store.js";

export interface LifecycleCommandContext {
  readonly actor: string;
  readonly accountId: string;
  readonly receipts: ReceiptStore;
}

/** Everything the shared command runtime provides to a command body. */
export type LifecycleCommandServices = Layer.Success<typeof cloudflareRuntime>;

/**
 * The shared preamble of every receipt-driven command: identify the actor,
 * resolve the Cloudflare account, require the receipt namespace, connect the
 * store, and wrap unknown failures in the command's step.
 */
export function runLifecycleCommand<A, E extends InstallFailure>(
  step: InstallerStep,
  failureMessage: string,
  use: (
    context: LifecycleCommandContext,
  ) => Effect.Effect<A, E, LifecycleCommandServices>,
): Effect.Effect<A, E | InstallerError> {
  const fail = stepError(step);
  return Effect.gen(function* () {
    const actor = yield* trySync(
      "argument_parsing",
      "Could not identify the command actor",
      () => `${userInfo().username}@${hostname()}`,
    );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const scope = yield* findCloudflareReceiptNamespace(accountId);
    if (Option.isNone(scope)) {
      return yield* fail("No Jitney deployments exist on this Cloudflare account.");
    }
    const receipts = yield* makeCloudflareReceiptBackend(scope.value).pipe(
      Effect.map(makeReceiptStore),
      Effect.mapError((cause) => fail("Could not connect to the receipt store", cause)),
    );
    return yield* use({ actor, accountId, receipts });
  }).pipe(
    Effect.provide(cloudflareRuntime),
    Effect.mapError((cause) =>
      isInstallFailure(cause) ? cause : orStepError(step, failureMessage)(cause),
    ),
  );
}
