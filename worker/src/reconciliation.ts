import { Effect, Result } from "effect";
import type { QueuedJobCandidate } from "./domain";
import type { DiscoveryError, DiscoveryResult } from "./github";
import type { AcceptResult } from "./lifecycle";
import { emit } from "./log";

export type ReconciliationSubmission<Error = never> = (
  candidate: QueuedJobCandidate,
) => Effect.Effect<AcceptResult, Error>;

export const reconcile: <Error>(
  discover: Effect.Effect<DiscoveryResult, DiscoveryError>,
  submit: ReconciliationSubmission<Error>,
  deploymentId: string,
) => Effect.Effect<void, Error> = Effect.fn("Scheduler.reconcileQueuedJobs")(function* <Error>(
  discover: Effect.Effect<DiscoveryResult, DiscoveryError>,
  submit: ReconciliationSubmission<Error>,
  deploymentId: string,
) {
  yield* Effect.sync(() => emit({ event: "reconciliation_started", deploymentId }));

  const discovered = yield* discover.pipe(Effect.result);
  if (Result.isFailure(discovered)) {
    yield* Effect.sync(() =>
      emit({ event: "reconciliation_failed", deploymentId, step: discovered.failure.step }),
    );
    return;
  }

  const { candidates, failures } = discovered.success;
  for (const failure of failures) {
    yield* Effect.sync(() =>
      emit({ event: "reconciliation_discovery_failed", deploymentId, ...failure }),
    );
  }

  let submitted = 0;
  let suppressed = 0;
  let ignored = 0;
  for (const candidate of candidates) {
    const { outcome } = yield* submit(candidate);
    if (outcome === "accepted") submitted++;
    else if (outcome === "ignored") ignored++;
    else suppressed++;
  }

  yield* Effect.sync(() =>
    emit({
      event: "reconciliation_completed",
      deploymentId,
      discovered: candidates.length,
      submitted,
      suppressed,
      ignored,
      failures: failures.length,
    }),
  );
});
