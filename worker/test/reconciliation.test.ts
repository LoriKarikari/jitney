import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { QueuedJobCandidate } from "../src/domain";
import { DiscoveryError } from "../src/github";
import { reconcile, type ReconciliationSubmission } from "../src/reconciliation";

type Submit = ReconciliationSubmission;

function candidate(workflowJobId: number, overrides?: Partial<QueuedJobCandidate>) {
  return {
    installationId: 123,
    repositoryId: 456,
    repositoryOwner: "LoriKarikari",
    repositoryName: "jitney-test",
    repositoryPrivate: true,
    workflowJobId,
    labels: ["jitney"],
    ...overrides,
  };
}

function completedRecords(logged: { mock: { calls: unknown[][] } }) {
  return logged.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter((record) => record.event === "reconciliation_completed");
}

describe("reconciliation", () => {
  it("backfills a queued job the scheduler does not track", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("reconciliation-backfill");
    const submit: Submit = (candidate) => Effect.promise(() => scheduler.reconcile(candidate));

    await Effect.runPromise(
      reconcile(
        Effect.succeed({
          candidates: [candidate(8001)],
          failures: [{ installationId: 999, step: "repository_listing" }],
        }),
        submit,
        "deployment-test",
      ),
    );

    expect(await scheduler.getJob(8001)).toMatchObject({ state: "queued", pending: true });
    expect(await scheduler.getAttempts(8001)).toHaveLength(1);
    expect(completedRecords(logged)).toMatchObject([
      { discovered: 1, submitted: 1, suppressed: 0, ignored: 0, failures: 1 },
    ]);
    logged.mockRestore();
  });

  it("does not resubmit a job with a viable attempt", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("reconciliation-duplicate");
    const submit: Submit = (candidate) => Effect.promise(() => scheduler.reconcile(candidate));

    await Effect.runPromise(
      reconcile(
        Effect.succeed({ candidates: [candidate(8002)], failures: [] }),
        submit,
        "deployment-test",
      ),
    );
    await Effect.runPromise(
      reconcile(
        Effect.succeed({ candidates: [candidate(8002)], failures: [] }),
        submit,
        "deployment-test",
      ),
    );

    expect(await scheduler.getAttempts(8002)).toHaveLength(1);
    expect(completedRecords(logged)[1]).toMatchObject({
      discovered: 1,
      submitted: 0,
      suppressed: 1,
    });
    logged.mockRestore();
  });

  it("does not resurrect a terminal job", async () => {
    const scheduler = env.SCHEDULER.getByName("reconciliation-terminal");
    const queued = candidate(8006);
    await scheduler.accept({
      ...queued,
      deliveryId: "delivery-queued",
      action: "queued",
    });
    await scheduler.accept({
      ...queued,
      deliveryId: "delivery-completed",
      action: "completed",
      conclusion: "failure",
    });

    expect(await scheduler.reconcile(queued)).toMatchObject({ outcome: "duplicate" });
    expect(await scheduler.getJob(8006)).toMatchObject({ state: "failed", pending: false });
    expect(await scheduler.getAttempts(8006)).toHaveLength(1);
  });

  it("does not requeue a running job", async () => {
    const scheduler = env.SCHEDULER.getByName("reconciliation-running");
    const queued = candidate(8007);
    const accepted = await scheduler.accept({
      ...queued,
      deliveryId: "delivery-queued",
      action: "queued",
    });
    if (accepted.runnerName === undefined) throw new Error("missing runner name");
    await scheduler.accept({
      ...queued,
      deliveryId: "delivery-in-progress",
      action: "in_progress",
      runnerName: accepted.runnerName,
    });

    expect(await scheduler.reconcile(queued)).toEqual({
      outcome: "duplicate",
      runnerName: accepted.runnerName,
    });
    expect(await scheduler.getJob(8007)).toMatchObject({ state: "running" });
    expect(await scheduler.getAttempts(8007)).toHaveLength(1);
  });

  it("ignores public repositories and unsupported labels", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("reconciliation-admission");
    const submit: Submit = (candidate) => Effect.promise(() => scheduler.reconcile(candidate));

    await Effect.runPromise(
      reconcile(
        Effect.succeed({
          candidates: [
            candidate(8003, { repositoryPrivate: false }),
            candidate(8004, { labels: ["ubuntu-latest"] }),
            candidate(8005, { labels: ["jitney", "gpu"] }),
          ],
          failures: [],
        }),
        submit,
        "deployment-test",
      ),
    );

    expect(await scheduler.getJob(8003)).toBeUndefined();
    expect(await scheduler.getJob(8004)).toBeUndefined();
    expect(await scheduler.getJob(8005)).toBeUndefined();
    expect(completedRecords(logged)).toMatchObject([
      { discovered: 3, submitted: 0, suppressed: 0, ignored: 3 },
    ]);
    logged.mockRestore();
  });

  it("reports a discovery failure without submitting", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const submit = vi.fn<Submit>();

    await Effect.runPromise(
      reconcile(
        Effect.fail(new DiscoveryError({ step: "run_listing", cause: "boom" })),
        submit,
        "deployment-test",
      ),
    );

    expect(submit).not.toHaveBeenCalled();
    const failures = logged.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => record.event === "reconciliation_failed");
    expect(failures).toMatchObject([{ step: "run_listing" }]);
    logged.mockRestore();
  });
});
