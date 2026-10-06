import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  dispatch,
  finished,
  getJitney,
  health,
  jobs,
  receipt,
  record,
  runnerApplication,
  tailWorker,
} from "./src/fixture.js";

const budget = 4;
const shards = 8;

const at = (time: string | null | undefined) => (time ? Date.parse(time) : Number.NaN);
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];

it(`runs an ${shards}-shard matrix on a budget of ${budget} without the reconciliation cron`, async () => {
  const evidence = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const version = process.env.E2E_VERSION ?? (yield* health).version;
        const before = (yield* receipt).concurrencyBudget ?? 20;
        yield* Effect.acquireRelease(
          getJitney(version, ["upgrade", "jitney", "--budget", String(budget)]),
          () =>
            getJitney(version, ["upgrade", "jitney", "--budget", String(before)]).pipe(
              Effect.orDie,
            ),
        );
        const recorded = yield* receipt;
        const application = yield* runnerApplication(recorded.cloudflare.applicationName);

        const tail = yield* tailWorker;
        const run = yield* dispatch("matrix.yml", `e2e-budget-${Date.now()}`, { seconds: "60" });
        const completed = yield* finished(run);
        const ran = yield* jobs(run);
        // A runner's exit reaches the Scheduler within one 30-second sweep.
        yield* Effect.sleep("40 seconds");
        return {
          version,
          recordedBudget: recorded.concurrencyBudget,
          maxInstances: application?.max_instances,
          conclusion: completed.conclusion,
          jobs: ran.map((job) => ({
            id: job.id,
            conclusion: job.conclusion,
            startedAt: job.started_at,
            completedAt: job.completed_at,
          })),
          events: tail.events(),
          stream: tail.stream(),
        };
      }),
    ),
  );

  const { jobs: ran, events } = evidence;
  const ids = new Set(ran.map((job) => job.id));
  const ours = events.filter(
    (event) =>
      "workflowJobId" in event && event.workflowJobId !== undefined && ids.has(event.workflowJobId),
  );
  const admissions = ours.filter(
    (event) =>
      event.event === "scheduler_transition" &&
      event.action === "queued" &&
      ["accepted", "waiting", "capacity_limited"].includes(event.outcome),
  );
  const startTimes = ran.map((job) => at(job.startedAt));
  const ends = ran.map((job) => at(job.completedAt)).sort((a, b) => a - b);
  const mostAtOnce = Math.max(
    ...startTimes.map(
      (start) =>
        ran.filter((job) => at(job.startedAt) <= start && at(job.completedAt) > start).length,
    ),
  );
  // For each shard that had to wait, the time from the latest runner finishing to its start.
  const handoffs = [...startTimes]
    .sort((a, b) => a - b)
    .slice(budget)
    .map((start) => start - Math.max(...ends.filter((end) => end <= start)))
    .filter(Number.isFinite)
    .map((ms) => Math.round(ms / 1000));

  const checks = record(
    "concurrency-budget",
    {
      receiptRecordsTheBudget: evidence.recordedBudget === budget,
      applicationNeverCapsBelowTheBudget: (evidence.maxInstances ?? 0) >= budget,
      everyShardSucceeded:
        ran.length === shards && ran.every((job) => job.conclusion === "success"),
      neverMoreThanTheBudgetAtOnce: mostAtOnce <= budget,
      everyShardAdmittedByWebhook:
        admissions.length >= shards &&
        admissions.every((event) => "deliveryId" in event && event.deliveryId !== undefined) &&
        !admissions.some(
          (event) => event.event === "scheduler_transition" && event.outcome === "capacity_limited",
        ),
      medianHandoffUnder15Seconds: handoffs.length > 0 && (median(handoffs) ?? Infinity) < 15,
    },
    { ...evidence, mostAtOnce, handoffSeconds: handoffs, events: ours },
  );
  expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map((key) => [key, true])));
});
