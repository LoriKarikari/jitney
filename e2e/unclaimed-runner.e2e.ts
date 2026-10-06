import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  cancel,
  dispatch,
  job,
  poll,
  record,
  selfHostedRunners,
  tailWorker,
} from "./src/fixture.js";

it("stops a runner no job claims at the assignment deadline", async () => {
  const evidence = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tail = yield* tailWorker;
        const run = yield* dispatch("long-job.yml", `e2e-unclaimed-${Date.now()}`, {
          seconds: "600",
        });
        const { id: jobId } = yield* job(run);
        const ourEvents = () =>
          tail
            .events()
            .filter((event) => "workflowJobId" in event && event.workflowJobId === jobId);
        // Cancel the moment the Worker accepts the job, before its runner can start and claim it.
        yield* poll(
          "Worker accepts the job",
          Effect.sync(() =>
            ourEvents().find(
              (event) => event.event === "scheduler_transition" && event.outcome === "accepted",
            ),
          ),
          "200 millis",
          300,
        );
        yield* cancel(run);
        const expired = yield* poll(
          "attempt expires",
          Effect.sync(() => ourEvents().find((event) => event.event === "runner_attempt_expired")),
          "10 seconds",
          45,
        ).pipe(Effect.option);
        yield* Effect.sleep("30 seconds");
        return {
          jobId,
          expired,
          claimed: ourEvents().some(
            (event) => event.event === "webhook_classified" && event.action === "in_progress",
          ),
          runnersLeft: yield* selfHostedRunners,
          events: ourEvents(),
          exceptions: tail.exceptions(),
          stream: tail.stream(),
        };
      }),
    ),
  );
  const { expired, claimed, runnersLeft } = evidence;

  const checks = record(
    "unclaimed-runner",
    {
      runnerNeverClaimedTheJob: !claimed,
      expiredAtAssignmentDeadline:
        expired._tag === "Some" &&
        expired.value.event === "runner_attempt_expired" &&
        expired.value.stopReason === "assignment_deadline",
      noRunnerLeft: runnersLeft.length === 0,
    },
    evidence,
  );
  expect(checks).toEqual({
    runnerNeverClaimedTheJob: true,
    expiredAtAssignmentDeadline: true,
    noRunnerLeft: true,
  });
});
