import { Effect, Either } from "effect";
import type { QueuedJobCandidate } from "./domain";
import type { DiscoveryResult, ProvisioningError } from "./github";
import type { AcceptResult } from "./lifecycle";
import { emit } from "./log";

export async function reconcile(
  discover: Effect.Effect<DiscoveryResult, ProvisioningError>,
  submit: (candidate: QueuedJobCandidate) => Promise<AcceptResult>,
  deploymentId: string,
): Promise<void> {
  emit({ event: "reconciliation_started", deploymentId });

  const discovered = await Effect.runPromise(discover.pipe(Effect.either));
  if (Either.isLeft(discovered)) {
    emit({ event: "reconciliation_failed", deploymentId, step: discovered.left.step });
    return;
  }

  const { candidates, failures } = discovered.right;
  for (const failure of failures) {
    emit({ event: "reconciliation_discovery_failed", deploymentId, ...failure });
  }

  let submitted = 0;
  let suppressed = 0;
  let ignored = 0;
  for (const candidate of candidates) {
    const { outcome } = await submit(candidate);
    if (outcome === "accepted") submitted++;
    else if (outcome === "ignored") ignored++;
    else suppressed++;
  }

  emit({
    event: "reconciliation_completed",
    deploymentId,
    discovered: candidates.length,
    submitted,
    suppressed,
    ignored,
    failures: failures.length,
  });
}
