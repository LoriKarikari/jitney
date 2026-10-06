import { Effect } from "effect";
import { expect, it } from "vitest";
import { cancel, dispatch, job, record, selfHostedRunners, tailWorker } from "./src/fixture.js";

it("stops a runner no job claims at the assignment deadline", async () => {
  const { jobId, events, exceptions, runnersLeft } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tail = yield* tailWorker;
        const dispatchedAt = Date.now();
        const run = yield* dispatch("long-job.yml", `e2e-unclaimed-${dispatchedAt}`, {
          seconds: "600",
        });
        // Cancel before the new runner can claim the job.
        yield* Effect.sleep(Math.max(0, dispatchedAt + 6_000 - Date.now()));
        yield* cancel(run);
        const cancelled = yield* job(run);
        yield* Effect.sleep("6 minutes");
        return {
          jobId: cancelled.id,
          events: tail.events(),
          exceptions: tail.exceptions(),
          runnersLeft: yield* selfHostedRunners,
        };
      }),
    ),
  );

  const checks = record(
    "unclaimed-runner",
    {
      expiredAtAssignmentDeadline: events.some(
        (event) =>
          event.event === "runner_attempt_expired" &&
          event.workflowJobId === jobId &&
          event.stopReason === "assignment_deadline",
      ),
      noRunnerLeft: runnersLeft.length === 0,
    },
    {
      job: jobId,
      runnersLeft,
      exceptions,
      events: events.filter((event) => "workflowJobId" in event && event.workflowJobId === jobId),
    },
  );
  expect(checks).toEqual({ expiredAtAssignmentDeadline: true, noRunnerLeft: true });
});
