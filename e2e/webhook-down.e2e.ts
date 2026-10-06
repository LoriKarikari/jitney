import { Effect } from "effect";
import { expect, it } from "vitest";
import { dispatch, finished, job, record, tailWorker, webhookRouteOff } from "./src/fixture.js";

it("finishes jobs no webhook reported and takes their end state from GitHub", async () => {
  const evidence = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tail = yield* tailWorker;
        yield* webhookRouteOff;
        const stamp = Date.now();
        const shortRun = yield* dispatch("long-job.yml", `e2e-short-${stamp}`, { seconds: "30" });
        const longRun = yield* dispatch("long-job.yml", `e2e-long-${stamp}`, { seconds: "420" });
        yield* Effect.all([finished(shortRun), finished(longRun)], { concurrency: 2 });
        const [short, long] = yield* Effect.all([job(shortRun), job(longRun)]);
        // The Scheduler reads GitHub on its next 30-second sweep after a runner exits.
        yield* Effect.sleep("2 minutes");
        return { short, long, events: tail.events() };
      }),
    ),
  );
  const { short, long, events } = evidence;
  const readSuccess = (jobId: number) =>
    events.some(
      (event) =>
        event.event === "job_status_read" &&
        event.workflowJobId === jobId &&
        event.state === "completed" &&
        event.conclusion === "success",
    );

  const checks = record(
    "webhook-down",
    {
      shortJobSucceeded: short.conclusion === "success",
      longJobSucceeded: long.conclusion === "success",
      shortConclusionReadFromGitHub: readSuccess(short.id),
      longConclusionReadFromGitHub: readSuccess(long.id),
      longRunnerKeptPastAssignmentDeadline: !events.some(
        (event) =>
          event.event === "runner_attempt_expired" &&
          event.workflowJobId === long.id &&
          event.stopReason === "assignment_deadline",
      ),
    },
    {
      jobs: { short: short.id, long: long.id },
      events: events.filter(
        (event) =>
          "workflowJobId" in event &&
          (event.workflowJobId === short.id || event.workflowJobId === long.id),
      ),
    },
  );
  expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map((key) => [key, true])));
});
