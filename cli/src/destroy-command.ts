import { Effect } from "effect";
import { makeDestroyPlatform } from "./destroy-platform.js";
import {
  DestroyPlatform,
  DestroyResidueError,
  destroyDeployment,
  renderDestroyPlan,
  renderDestroyResidue,
} from "./destroy.js";
import { stepError, type InstallerError } from "./errors.js";
import { DeploymentReceipts } from "./install.js";
import { runLifecycleCommand } from "./lifecycle-command.js";

const fail = stepError("destroy");

export function destroyCommand(options: {
  readonly name: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly now?: boolean;
  readonly exportPath?: string;
}): Effect.Effect<void, InstallerError> {
  return runLifecycleCommand("destroy", "Could not destroy the deployment", ({ actor, receipts }) =>
    Effect.gen(function* () {
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
            ? fail(
                `${cause.name} still has ${cause.residue.length} residual resource${cause.residue.length === 1 ? "" : "s"}:\n${renderDestroyResidue(cause.residue)}\nResolve the residue, then run: npx get-jitney destroy ${cause.name}`,
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
    }),
  );
}
