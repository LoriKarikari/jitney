import { Effect } from "effect";
import { captureCloudflareServices } from "./cloudflare-runtime.js";
import { observeAccount } from "./cloudflare-inventory.js";
import { stepError, trySync, type InstallerError } from "./errors.js";
import { fetchLifecycleStatus, rewriteOwnershipMarkers } from "./lifecycle-status-client.js";
import { DeploymentReceipts } from "./install.js";
import { runLifecycleCommand } from "./lifecycle-command.js";
import { confirmInTerminal } from "./prompt.js";
import {
  RepairPlatform,
  repairDeployment,
  renderRepairPlan,
  type OwnershipProbe,
} from "./repair.js";
import { recordedRepositories } from "./receipts/schema.js";

const fail = stepError("repair");

const makeRepairPlatform = (assumeYes: boolean) =>
  Effect.gen(function* () {
    const cloudflare = yield* captureCloudflareServices;

    return RepairPlatform.of({
      snapshot: (accountId) =>
        cloudflare
          .provide(observeAccount(accountId))
          .pipe(Effect.mapError((cause) => fail("Could not inspect Cloudflare", cause))),
      ownership: (receipt) =>
        cloudflare.provide(fetchLifecycleStatus(receipt)).pipe(
          Effect.mapError((cause) => fail("Could not inspect GitHub ownership", cause)),
          Effect.map((status): readonly OwnershipProbe[] =>
            recordedRepositories(receipt.github).map((repository) => ({
              fullName: repository.fullName,
              class:
                status.ownership.find(
                  (item) =>
                    item.installationId === repository.installationId &&
                    item.repositoryId === repository.repositoryId,
                )?.status ?? "unknown",
            })),
          ),
        ),
      rewriteOwnership: (receipt, fullNames) =>
        cloudflare
          .provide(rewriteOwnershipMarkers(receipt, fullNames))
          .pipe(Effect.mapError((cause) => fail("Could not rewrite ownership markers", cause))),
      confirm: (plan) =>
        assumeYes
          ? Effect.succeed(true)
          : confirmInTerminal({
              step: "repair",
              render: `\n${renderRepairPlan(plan)}`,
              question: `Apply ${plan.actions.length} action${plan.actions.length === 1 ? "" : "s"}? (y/N) `,
              accept: (answer) => answer.toLowerCase() === "y",
            }),
    });
  });

export function repairCommand(options: {
  readonly name: string;
  readonly yes?: boolean;
  readonly adopt?: readonly string[];
}): Effect.Effect<void, InstallerError> {
  return runLifecycleCommand("repair", "Could not repair the deployment", ({ actor, receipts }) =>
    Effect.gen(function* () {
      const name = yield* trySync("argument_parsing", "The deployment name is invalid", () => {
        if (options.name.length === 0) throw new TypeError("empty deployment name");
        return options.name;
      });
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
    }),
  );
}
