import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  deployWorkerVersion,
  dispatch,
  finished,
  job,
  poll,
  record,
  tailWorker,
} from "./src/fixture.js";

it("keeps a runner alive through a Worker deploy in the middle of its job", async () => {
  const { run, ran, events } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tail = yield* tailWorker;
        const run = yield* dispatch("long-job.yml", `e2e-deploy-${Date.now()}`, { seconds: "900" });
        yield* poll(
          "job starts",
          job(run).pipe(
            Effect.map((current) => (current.status === "in_progress" ? current : undefined)),
          ),
          "5 seconds",
          120,
        );
        yield* Effect.sleep("5 minutes");
        yield* Effect.scoped(deployWorkerVersion(String(run)));
        const completed = yield* finished(run);
        const ran = yield* job(run);
        return { run: completed, ran, events: tail.events() };
      }),
    ),
  );
  const versions = new Set(
    events.flatMap((event) =>
      "workflowJobId" in event && event.workflowJobId === ran.id && event.deploymentId
        ? [event.deploymentId]
        : [],
    ),
  );

  const checks = record(
    "deploy-during-job",
    { jobSucceeded: run.conclusion === "success", jobSpannedTwoWorkerVersions: versions.size >= 2 },
    { run: run.id, job: ran.id, workerVersions: [...versions] },
  );
  expect(checks).toEqual({ jobSucceeded: true, jobSpannedTwoWorkerVersions: true });
});
