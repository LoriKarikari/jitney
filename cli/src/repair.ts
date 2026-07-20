import { Context, DateTime, Effect, Option } from "effect";
import { runnerApplicationName, type AccountSnapshot } from "./cloudflare-inventory.js";
import { InstallerError } from "./errors.js";
import { DeploymentReceipts } from "./install.js";
import { beginLeasedOperation } from "./receipts/leased-operation.js";
import type { DeploymentReceipt } from "./receipts/schema.js";

export type RepairAction =
  | { readonly kind: "release_expired_lease"; readonly operation: string; readonly actor: string }
  | {
      readonly kind: "record_application";
      readonly applicationId: string;
      readonly proof: "worker_tag" | "explicit_adopt";
    }
  | { readonly kind: "rewrite_ownership"; readonly fullName: string };

export interface RepairBlocker {
  readonly reason: string;
  readonly command?: string;
}

export interface RepairPlan {
  readonly name: string;
  readonly deploymentId: string;
  readonly phase: DeploymentReceipt["phase"];
  /** Set when the interrupted operation belongs to another command. */
  readonly redirect: "deploy" | "destroy" | "upgrade" | null;
  readonly actions: readonly RepairAction[];
  readonly blockers: readonly RepairBlocker[];
}

export interface RepairInput {
  readonly name: string;
  readonly actor: string;
  /** Explicit adoption evidence, for example `application:a034dae7`. */
  readonly adopt?: readonly string[];
}

export interface OwnershipProbe {
  readonly fullName: string;
  readonly class: "ok" | "missing" | "drifted" | "unknown";
  readonly value?: string;
}

export class RepairPlatform extends Context.Service<
  RepairPlatform,
  {
    readonly snapshot: (accountId: string) => Effect.Effect<AccountSnapshot, InstallerError>;
    readonly ownership: (
      receipt: DeploymentReceipt,
    ) => Effect.Effect<readonly OwnershipProbe[], InstallerError>;
    readonly rewriteOwnership: (
      receipt: DeploymentReceipt,
      fullNames: readonly string[],
    ) => Effect.Effect<void, InstallerError>;
    readonly confirm: (plan: RepairPlan) => Effect.Effect<boolean, InstallerError>;
  }
>()("Jitney.RepairPlatform") {}

const repairError = (message: string, cause?: unknown) =>
  new InstallerError({
    step: "repair",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const parseAdoptions = (
  adopt: readonly string[],
): Effect.Effect<readonly string[], InstallerError> =>
  Effect.forEach(adopt, (token) => {
    const [resource, id] = token.split(":", 2);
    return resource === "application" && id !== undefined && id.length > 0
      ? Effect.succeed(id)
      : Effect.fail(
          repairError(`Unsupported --adopt target: ${token}. Expected application:<id>.`),
        );
  });

export const planRepair = Effect.fn(function* (
  input: RepairInput,
  receipt: DeploymentReceipt,
  now: DateTime.Utc,
) {
  const platform = yield* RepairPlatform;
  const adoptions = yield* parseAdoptions(input.adopt ?? []);
  const actions: RepairAction[] = [];
  const blockers: RepairBlocker[] = [];

  if (receipt.lease !== null) {
    if (DateTime.isGreaterThan(receipt.lease.expiresAt, now)) {
      return yield* Effect.fail(
        repairError(
          `Deployment ${input.name} has a live ${receipt.lease.operation} lease held by ${receipt.lease.actor}. Wait for it to finish or expire.`,
        ),
      );
    }
    actions.push({
      kind: "release_expired_lease",
      operation: receipt.lease.operation,
      actor: receipt.lease.actor,
    });
  }

  const redirect =
    receipt.phase === "installing"
      ? ("deploy" as const)
      : receipt.phase === "destroying"
        ? ("destroy" as const)
        : receipt.phase === "upgrading"
          ? ("upgrade" as const)
          : null;
  if (redirect !== null) {
    return {
      name: input.name,
      deploymentId: receipt.id,
      phase: receipt.phase,
      redirect,
      actions,
      blockers,
    } satisfies RepairPlan;
  }

  const snapshot = yield* platform.snapshot(receipt.cloudflare.accountId);
  const worker = snapshot.workers.find(
    (candidate) => candidate.name === receipt.cloudflare.workerName,
  );
  const application = snapshot.applications.find(
    (candidate) => candidate.name === runnerApplicationName(receipt.name),
  );

  if (worker === undefined) {
    blockers.push({
      reason: `Worker ${receipt.cloudflare.workerName} is missing; repair never recreates infrastructure`,
      command: `npx get-jitney deploy --name ${receipt.name}`,
    });
  }
  if (receipt.cloudflare.applicationId === null && application !== undefined) {
    if (worker?.deploymentId === receipt.id) {
      actions.push({
        kind: "record_application",
        applicationId: application.id,
        proof: "worker_tag",
      });
    } else if (!adoptions.includes(application.id)) {
      blockers.push({
        reason: `Container application ${application.name} (${application.id}) carries no id proof`,
        command: `npx get-jitney repair ${input.name} --adopt application:${application.id}`,
      });
    }
  }
  for (const applicationId of adoptions) {
    if (snapshot.applications.every((candidate) => candidate.id !== applicationId)) {
      return yield* Effect.fail(
        repairError(`Cannot adopt application ${applicationId}: Cloudflare does not report it.`),
      );
    }
    if (actions.some((action) => action.kind === "record_application")) continue;
    actions.push({ kind: "record_application", applicationId, proof: "explicit_adopt" });
  }

  const ownership = yield* platform
    .ownership(receipt)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (ownership === null) {
    blockers.push({
      reason: "GitHub ownership could not be inspected; the Worker or GitHub is unreachable",
      command: "npx get-jitney list",
    });
  }
  for (const probe of ownership ?? []) {
    if (probe.class === "missing") {
      actions.push({ kind: "rewrite_ownership", fullName: probe.fullName });
    } else if (probe.class === "drifted") {
      blockers.push({
        reason: `${probe.fullName} belongs to deployment ${probe.value ?? "unknown"}; repair never overwrites foreign ownership`,
        command: "npx get-jitney list --json",
      });
    }
  }

  return {
    name: input.name,
    deploymentId: receipt.id,
    phase: receipt.phase,
    redirect: null,
    actions,
    blockers,
  } satisfies RepairPlan;
});

export const repairDeployment = Effect.fn(function* (input: RepairInput) {
  const receipts = yield* DeploymentReceipts;
  const platform = yield* RepairPlatform;
  const now = yield* DateTime.now;
  const receipt = yield* receipts.get(input.name).pipe(
    Effect.mapError((cause) => repairError(`Could not read deployment ${input.name}`, cause)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(repairError(`Deployment ${input.name} has no receipt. Nothing to repair.`)),
        onSome: Effect.succeed,
      }),
    ),
  );

  const plan = yield* planRepair(input, receipt, now);
  const confirmed = yield* platform.confirm(plan);
  if (!confirmed) return plan;

  if (plan.actions.some((action) => action.kind === "release_expired_lease")) {
    yield* receipts
      .releaseExpiredLeaseForRepair(input.name, input.actor, now)
      .pipe(Effect.mapError((cause) => repairError("Could not release the expired lease", cause)));
  }
  // Interrupted install/destroy/upgrade recovery belongs to the owning
  // command; repair only frees the dead lease so that command can run.
  if (plan.redirect !== null) return plan;

  const applicationActions = plan.actions.filter(
    (action): action is Extract<RepairAction, { kind: "record_application" }> =>
      action.kind === "record_application",
  );
  const ownershipActions = plan.actions.filter(
    (action): action is Extract<RepairAction, { kind: "rewrite_ownership" }> =>
      action.kind === "rewrite_ownership",
  );
  if (applicationActions.length === 0 && ownershipActions.length === 0) return plan;

  const held = yield* beginLeasedOperation(receipts, input.name, "repair", input.actor);
  const settle = Effect.gen(function* () {
    for (const action of applicationActions) {
      yield* held.record((current) => ({
        cloudflare: { ...current.cloudflare, applicationId: action.applicationId },
      }));
    }
    if (ownershipActions.length > 0) {
      const current = yield* held.receipt();
      yield* held.guard(
        platform.rewriteOwnership(
          current,
          ownershipActions.map((action) => action.fullName),
        ),
      );
    }
    yield* held.finish({ phase: "active", outcome: "succeeded" });
  });
  yield* settle.pipe(
    Effect.tapError(() => held.finish({ phase: "active", outcome: "failed" }).pipe(Effect.ignore)),
  );
  return plan;
});

export function renderRepairPlan(plan: RepairPlan): string {
  const lines = [`${plan.name} (phase: ${plan.phase}) — plan:`];
  if (plan.actions.length === 0) {
    lines.push("", "  Nothing to repair.");
  } else {
    lines.push("", "  WILL DO");
    plan.actions.forEach((action, index) => {
      const description =
        action.kind === "release_expired_lease"
          ? `release expired lease (${action.operation}, ${action.actor})`
          : action.kind === "record_application"
            ? `record container application ${action.applicationId} (${action.proof === "worker_tag" ? "id proven by worker tag" : "explicitly adopted"})`
            : `rewrite JITNEY_DEPLOYMENT on ${action.fullName} (missing)`;
      lines.push(`  ${index + 1}. ${description}`);
    });
  }
  if (plan.blockers.length > 0) {
    lines.push("", "  WON'T TOUCH (needs you)");
    for (const blocker of plan.blockers) {
      lines.push(`  - ${blocker.reason}`);
      if (blocker.command !== undefined) lines.push(`    ${blocker.command}`);
    }
  }
  if (plan.redirect !== null) {
    lines.push(
      "",
      `  The interrupted ${plan.phase} operation belongs to \`${plan.redirect}\`. Repair frees the lease; run that command next.`,
    );
  }
  return lines.join("\n");
}
