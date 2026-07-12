import { Effect, Either } from "effect";
import { isAdmissible, type QueuedJobCandidate, type WorkflowEvent } from "./domain";
import type { ProvisioningError } from "./github";
import type { AcceptResult } from "./lifecycle";
import { emit } from "./log";

export type Discover = Effect.Effect<QueuedJobCandidate[], ProvisioningError>;

export type Submit = (event: WorkflowEvent) => Promise<AcceptResult>;

export async function reconcile(
  discover: Discover,
  submit: Submit,
  deploymentId: string,
  now = Date.now(),
): Promise<void> {
  emit({ event: "reconciliation_started", deploymentId });

  const discovered = await Effect.runPromise(discover.pipe(Effect.either));
  if (Either.isLeft(discovered)) {
    emit({ event: "reconciliation_failed", deploymentId, step: discovered.left.step });
    return;
  }

  let submitted = 0;
  let suppressed = 0;
  let ignored = 0;
  for (const candidate of discovered.right) {
    if (!isAdmissible(candidate.repositoryPrivate, candidate.labels)) {
      ignored++;
      continue;
    }
    const { outcome } = await submit({
      ...candidate,
      deliveryId: `reconciliation-${now}-${candidate.workflowJobId}`,
      action: "queued",
    });
    if (outcome === "accepted") submitted++;
    else suppressed++;
  }

  emit({
    event: "reconciliation_completed",
    deploymentId,
    discovered: discovered.right.length,
    submitted,
    suppressed,
    ignored,
  });
}
