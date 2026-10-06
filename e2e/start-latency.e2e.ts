import { Effect } from "effect";
import { expect, it } from "vitest";
import { dispatch, finished, health, jobLog, jobs, record } from "./src/fixture.js";

const runs = Number(process.env.E2E_RUNS ?? "5");

it(`starts the canary's job within 60 seconds in each of ${runs} runs`, async () => {
  const samples = await Effect.runPromise(
    Effect.gen(function* () {
      const version = process.env.E2E_VERSION ?? (yield* health).version;
      const samples: { run: number; conclusion: string | null; waitSeconds: number | undefined }[] =
        [];
      for (let i = 1; i <= runs; i++) {
        const run = yield* dispatch("jitney.yml", `e2e-latency-${i}-${Date.now()}`, { version });
        const completed = yield* finished(run);
        const canary = (yield* jobs(run)).find((candidate) => candidate.name === "canary");
        const log = canary === undefined ? "" : yield* jobLog(canary.id);
        const wait = /wait=(\d+)s/.exec(log)?.[1];
        samples.push({
          run,
          conclusion: completed.conclusion,
          waitSeconds: wait === undefined ? undefined : Number(wait),
        });
      }
      return samples;
    }),
  );
  const waits = samples
    .flatMap((sample) => (sample.waitSeconds === undefined ? [] : [sample.waitSeconds]))
    .sort((a, b) => a - b);
  const median = waits[Math.floor((waits.length - 1) / 2)];

  const checks = record(
    "start-latency",
    {
      everyRunSucceeded: samples.every((sample) => sample.conclusion === "success"),
      everyJobStartedWithin60Seconds: waits.length === runs && waits.every((wait) => wait <= 60),
    },
    { medianSeconds: median, samples },
  );
  expect(checks).toEqual({ everyRunSucceeded: true, everyJobStartedWithin60Seconds: true });
});
