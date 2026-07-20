import * as Cloudflare from "alchemy/Cloudflare";
import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { Effect, Option, Ref, Schema } from "effect";
import { ensureDeploymentAbsent } from "./cloudflare-inventory.js";
import { cloudflareRuntime } from "./cloudflare-runtime.js";
import { validateWorkerName } from "./config.js";
import {
  ExistingDeploymentError,
  InstallerError,
  isInstallFailure,
  tryPromise,
  trySync,
  type InstallFailure,
} from "./errors.js";
import type { GitHubAppCredentials } from "./github-app.js";
import { makeInstallPlatform } from "./install-platform.js";
import { DeploymentReceipts, InstallPlatform, installDeployment } from "./install.js";
import {
  ensureCloudflareReceiptNamespace,
  findCloudflareReceiptNamespace,
  makeCloudflareReceiptBackend,
} from "./receipts/cloudflare.js";
import { makeReceiptStore, type ReceiptStore } from "./receipts/store.js";

const PackageMetadata = Schema.Struct({ version: Schema.String });

export function deploy(options: {
  workerName: string;
  organization?: string;
  keepPartial?: boolean;
}): Effect.Effect<void, InstallFailure> {
  return Effect.gen(function* () {
    const name = yield* trySync("argument_parsing", "The Worker name is invalid", () =>
      validateWorkerName(options.workerName),
    );
    const version = yield* packageVersion();
    const actor = yield* trySync(
      "argument_parsing",
      "Could not identify the command actor",
      () => `${userInfo().username}@${hostname()}`,
    );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const existingScope = yield* findCloudflareReceiptNamespace(accountId).pipe(
      Effect.mapError(
        (cause) =>
          new InstallerError({
            step: "receipt_store",
            message: "Could not inspect the deployment receipt store",
            cause,
          }),
      ),
    );
    const existingStore = yield* Option.match(existingScope, {
      onNone: () => Effect.succeed(Option.none<ReceiptStore>()),
      onSome: (scope) => Effect.map(makeCloudflareStore(scope), Option.some),
    });
    if (Option.isSome(existingStore)) {
      yield* assertDeploymentAbsent(name, existingStore.value);
    }
    yield* ensureDeploymentAbsent(accountId, name);

    const receipts = yield* Option.match(existingStore, {
      onNone: () =>
        ensureCloudflareReceiptNamespace(accountId).pipe(
          Effect.mapError(
            (cause) =>
              new InstallerError({
                step: "receipt_store",
                message: "Could not prepare the deployment receipt store",
                cause,
              }),
          ),
          Effect.flatMap(makeCloudflareStore),
        ),
      onSome: Effect.succeed,
    });
    const credentials = yield* Ref.make(Option.none<GitHubAppCredentials>());
    const platform = yield* makeInstallPlatform(credentials);

    const result = yield* installDeployment({
      name,
      accountId,
      version,
      actor,
      ...(options.organization === undefined ? {} : { organization: options.organization }),
      ...(options.keepPartial === undefined ? {} : { keepPartial: options.keepPartial }),
    }).pipe(
      Effect.provideService(DeploymentReceipts, receipts),
      Effect.provideService(InstallPlatform, platform),
    );

    yield* Effect.sync(() => {
      console.log(`\nJitney is ready at ${result.workerUrl}`);
      console.log("Use `runs-on: jitney` in an installed private repository.");
    });
  }).pipe(
    Effect.provide(cloudflareRuntime),
    Effect.mapError(
      (cause): InstallFailure =>
        isInstallFailure(cause)
          ? cause
          : new InstallerError({
              step: "cloudflare_authentication",
              message: "Could not authenticate with Cloudflare",
              cause,
            }),
    ),
  );
}

const makeCloudflareStore = Effect.fn(function* (
  scope: Parameters<typeof makeCloudflareReceiptBackend>[0],
) {
  const backend = yield* makeCloudflareReceiptBackend(scope).pipe(
    Effect.mapError(
      (cause) =>
        new InstallerError({
          step: "receipt_store",
          message: "Could not connect to the deployment receipt store",
          cause,
        }),
    ),
  );
  return makeReceiptStore(backend);
});

const assertDeploymentAbsent = Effect.fn(function* (name: string, receipts: ReceiptStore) {
  const existingReceipt = yield* receipts.get(name).pipe(
    Effect.mapError(
      (cause) =>
        new InstallerError({
          step: "receipt_store",
          message: `Could not check deployment ${name}`,
          cause,
        }),
    ),
  );
  if (Option.isSome(existingReceipt)) {
    return yield* new ExistingDeploymentError({
      name,
      deploymentId: existingReceipt.value.id,
      phase: existingReceipt.value.phase,
    });
  }
});

function packageVersion(): Effect.Effect<string, InstallerError> {
  return tryPromise("filesystem", "Could not read the Jitney package version", () =>
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).pipe(
    Effect.flatMap((contents) =>
      trySync(
        "filesystem",
        "Jitney package version is missing",
        () => Schema.decodeUnknownSync(PackageMetadata)(JSON.parse(contents)).version,
      ),
    ),
  );
}
