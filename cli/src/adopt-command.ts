import { Effect } from "effect";
import { adoptDeployment, AdoptPlatform } from "./adopt.js";
import { makeAdoptPlatform } from "./adopt-platform.js";
import { packageVersion } from "./deploy.js";
import { DeploymentReceipts } from "./install.js";
import { runLifecycleCommand } from "./lifecycle-command.js";

export const adoptCommand = (input: { readonly name: string; readonly appSlug: string }) =>
  runLifecycleCommand(
    "adopt",
    `Could not adopt ${input.name}`,
    ({ actor, accountId, receipts }) =>
      Effect.gen(function* () {
        const version = yield* packageVersion();
        const platform = yield* makeAdoptPlatform(version);
        const receipt = yield* adoptDeployment({
          name: input.name,
          accountId,
          version,
          actor,
          appSlug: input.appSlug,
        }).pipe(
          Effect.provideService(DeploymentReceipts, receipts),
          Effect.provideService(AdoptPlatform, platform),
        );
        yield* Effect.sync(() =>
          console.log(`Adopted ${input.name} as Deployment ${receipt.id}, running ${version}.`),
        );
      }),
    { createReceiptNamespace: true },
  );
