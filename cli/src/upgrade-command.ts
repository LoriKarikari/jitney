import { Effect } from "effect";
import { packageVersion } from "./deploy.js";
import { DeploymentReceipts } from "./install.js";
import { runLifecycleCommand } from "./lifecycle-command.js";
import { makeUpgradePlatform } from "./upgrade-platform.js";
import {
  UpgradePlatform,
  changeDeploymentVersion,
  type VersionChangeOperation,
} from "./upgrade.js";

export const upgradeCommand = (input: {
  readonly name: string;
  readonly operation: VersionChangeOperation;
}) =>
  runLifecycleCommand(
    "upgrade",
    `Could not ${input.operation} ${input.name}`,
    ({ actor, receipts }) =>
      Effect.gen(function* () {
        const version = yield* packageVersion();
        const platform = yield* makeUpgradePlatform(version);
        const receipt = yield* changeDeploymentVersion({
          name: input.name,
          actor,
          operation: input.operation,
          ...(input.operation === "upgrade" ? { targetVersion: version } : {}),
        }).pipe(
          Effect.provideService(DeploymentReceipts, receipts),
          Effect.provideService(UpgradePlatform, platform),
        );
        yield* Effect.sync(() =>
          console.log(
            input.operation === "upgrade"
              ? `${input.name} is now ${receipt.versions.current}.`
              : `${input.name} rolled back to ${receipt.versions.current}.`,
          ),
        );
      }),
  );
