import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowEvent } from "../src/domain";
import { ProvisioningError } from "../src/github";
import { SchedulerLifecycle } from "../src/lifecycle";
import type { ProvisionRequest } from "../src/provisioning";
import { Scheduler } from "../src/scheduler";

function withLifecycle<Result>(
  scheduler: DurableObjectStub<Scheduler>,
  use: (lifecycle: SchedulerLifecycle) => Promise<Result>,
): Promise<Result> {
  return runInDurableObject(scheduler, (_instance, state) =>
    use(new SchedulerLifecycle(state.storage, "deployment-test")),
  );
}

function queuedEvent(workflowJobId: number, deliveryId: string): WorkflowEvent {
  return {
    deliveryId,
    action: "queued",
    installationId: 123,
    repositoryId: 456,
    repositoryOwner: "LoriKarikari",
    repositoryName: "jitney-test",
    repositoryPrivate: true,
    workflowJobId,
    labels: ["jitney"],
  };
}

describe("Scheduler admission", () => {
  it("suppresses delivery replay and manual redelivery while an attempt is viable", async () => {
    const scheduler = env.SCHEDULER.getByName("duplicate-delivery");
    const event = queuedEvent(1001, "delivery-1");

    expect(await scheduler.accept(event)).toMatchObject({ outcome: "accepted" });
    expect(await scheduler.accept(event)).toEqual({ outcome: "duplicate" });
    expect(await scheduler.accept({ ...event, deliveryId: "delivery-2" })).toMatchObject({
      outcome: "duplicate",
    });
    expect(await scheduler.getAttempts(event.workflowJobId)).toHaveLength(1);
  });

  it("creates one new attempt after every previous attempt becomes non-viable", async () => {
    const scheduler = env.SCHEDULER.getByName("recoverable-redelivery");
    const event = queuedEvent(1002, "delivery-1");
    await scheduler.accept(event);

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        () => Effect.fail(new ProvisioningError({ step: "container_start", cause: "failed" })),
        () => Effect.void,
      ),
    );

    expect(await scheduler.accept({ ...event, deliveryId: "delivery-2" })).toEqual({
      outcome: "accepted",
      runnerName: "jitney-456-1002-2",
    });
    expect(await scheduler.accept({ ...event, deliveryId: "delivery-3" })).toEqual({
      outcome: "duplicate",
      runnerName: "jitney-456-1002-2",
    });
    expect(await scheduler.getAttempts(event.workflowJobId)).toHaveLength(2);
  });

  it.each([
    ["completed", "success"],
    ["cancelled", "cancelled"],
    ["failed", "failure"],
  ])("does not move a %s job backwards", async (expectedState, conclusion) => {
    const scheduler = env.SCHEDULER.getByName(`terminal-${expectedState}`);
    const event = queuedEvent(1100, "delivery-queued");
    await scheduler.accept(event);
    await scheduler.accept({
      ...event,
      deliveryId: "delivery-completed",
      action: "completed",
      conclusion,
    });

    expect(await scheduler.accept({ ...event, deliveryId: "delivery-delayed" })).toMatchObject({
      outcome: "duplicate",
    });
    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: expectedState,
      pending: false,
    });
    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "created" }]);
  });

  it("rejects work durably when pending-work capacity is exhausted", async () => {
    const scheduler = env.SCHEDULER.getByName("capacity");
    for (let job = 1; job <= 10; job++) {
      expect(await scheduler.accept(queuedEvent(2000 + job, `delivery-${job}`))).toMatchObject({
        outcome: "accepted",
      });
    }

    const rejected = queuedEvent(2011, "delivery-11");
    expect(await scheduler.accept(rejected)).toEqual({ outcome: "capacity_limited" });
    expect(await scheduler.getJob(rejected.workflowJobId)).toMatchObject({
      state: "capacity_limited",
      pending: false,
    });
    expect(await scheduler.getAttempts(rejected.workflowJobId)).toEqual([]);
  });

  it("rejects work durably when active-attempt capacity is exhausted", async () => {
    const scheduler = env.SCHEDULER.getByName("active-capacity");
    for (let job = 1; job <= 25; job++) {
      const event = queuedEvent(4000 + job, `delivery-${job}`);
      expect(await scheduler.accept(event)).toMatchObject({ outcome: "accepted" });
      await withLifecycle(scheduler, (lifecycle) =>
        lifecycle.sweep(
          () => Effect.void,
          () => Effect.void,
        ),
      );
    }

    const rejected = queuedEvent(4026, "delivery-26");
    expect(await scheduler.accept(rejected)).toEqual({ outcome: "capacity_limited" });
    expect(await scheduler.getAttempts(rejected.workflowJobId)).toEqual([]);

    let privilegedCalls = 0;
    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        () => {
          privilegedCalls++;
          return Effect.void;
        },
        () => Effect.void,
      ),
    );
    expect(privilegedCalls).toBe(0);
  });

  it("binds a job to its assigned Runner Attempt", async () => {
    const scheduler = env.SCHEDULER.getByName("same-job-assignment");
    const event = queuedEvent(4501, "delivery-queued");
    const accepted = await scheduler.accept(event);
    const runnerName = accepted.runnerName;
    if (runnerName === undefined) throw new Error("accepted attempt has no runner name");

    expect(
      await scheduler.accept({
        ...event,
        action: "in_progress",
        deliveryId: "delivery-running",
        runnerName,
      }),
    ).toEqual({ outcome: "recorded", runnerName });
    expect(await scheduler.getAssignment(event.workflowJobId)).toMatchObject({
      workflowJobId: 4501,
      triggeringWorkflowJobId: 4501,
      attempt: 1,
      runnerName,
      containerName: "attempt-456-4501-1",
    });
  });

  it("binds a job to a Runner Attempt triggered by another job", async () => {
    const scheduler = env.SCHEDULER.getByName("cross-assignment");
    const jobA = queuedEvent(4601, "delivery-a-queued");
    const jobB = queuedEvent(4602, "delivery-b-queued");
    const attemptA = await scheduler.accept(jobA);
    await scheduler.accept(jobB);
    const runnerName = attemptA.runnerName;
    if (runnerName === undefined) throw new Error("accepted attempt has no runner name");

    await scheduler.accept({
      ...jobB,
      action: "in_progress",
      deliveryId: "delivery-b-running",
      runnerName,
    });

    expect(await scheduler.getAssignment(jobB.workflowJobId)).toMatchObject({
      workflowJobId: 4602,
      triggeringWorkflowJobId: 4601,
      runnerName,
      containerName: "attempt-456-4601-1",
    });
    expect(await scheduler.getJob(jobA.workflowJobId)).toMatchObject({ state: "queued" });
    expect(await scheduler.getJob(jobB.workflowJobId)).toMatchObject({
      state: "running",
      runnerName,
    });

    await scheduler.accept({
      ...jobB,
      action: "completed",
      conclusion: "success",
      deliveryId: "delivery-b-completed",
    });
    expect(await scheduler.getAttempts(jobA.workflowJobId)).toMatchObject([{ state: "stopped" }]);
    expect(await scheduler.getAttempts(jobB.workflowJobId)).toMatchObject([{ state: "stopped" }]);
  });

  it("classifies duplicate, conflicting, and unknown assignments", async () => {
    const scheduler = env.SCHEDULER.getByName("assignment-conflicts");
    const jobA = queuedEvent(4701, "delivery-a-queued");
    const jobB = queuedEvent(4702, "delivery-b-queued");
    const runnerA = (await scheduler.accept(jobA)).runnerName;
    const runnerB = (await scheduler.accept(jobB)).runnerName;
    if (runnerA === undefined || runnerB === undefined) {
      throw new Error("accepted attempt has no runner name");
    }

    const assignment = { ...jobB, action: "in_progress" as const, runnerName: runnerA };
    await scheduler.accept({ ...assignment, deliveryId: "delivery-assigned" });
    expect(await scheduler.accept({ ...assignment, deliveryId: "delivery-duplicate" })).toEqual({
      outcome: "duplicate",
      runnerName: runnerA,
    });
    expect(
      await scheduler.accept({
        ...assignment,
        deliveryId: "delivery-conflicting",
        runnerName: runnerB,
      }),
    ).toEqual({ outcome: "conflicting_assignment", runnerName: runnerB });
    expect(
      await scheduler.accept({
        ...jobA,
        action: "in_progress",
        deliveryId: "delivery-unknown",
        runnerName: "unknown-runner",
      }),
    ).toEqual({ outcome: "unknown_assignment", runnerName: "unknown-runner" });
  });

  it("drains pending work through one privileged provisioning seam", async () => {
    const scheduler = env.SCHEDULER.getByName("provisioning-seam");
    const event = queuedEvent(5001, "delivery-queued");
    await scheduler.accept(event);
    const requests: ProvisionRequest[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        (request) => {
          requests.push(request);
          return Effect.void;
        },
        () => Effect.void,
      ),
    );

    expect(requests).toEqual([
      {
        installationId: 123,
        repositoryId: 456,
        repositoryOwner: "LoriKarikari",
        repositoryName: "jitney-test",
        workflowJobId: 5001,
        runnerName: "jitney-456-5001-1",
        containerName: "attempt-456-5001-1",
      },
    ]);
    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: "waiting_for_assignment",
      pending: false,
    });
    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([
      { state: "waiting_for_assignment" },
    ]);
  });

  it("reconstructs one lifecycle from correlated structured events", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("observable-lifecycle");
    const event = queuedEvent(5003, "delivery-observable");
    const accepted = await scheduler.accept(event);
    if (accepted.runnerName === undefined) throw new Error("accepted attempt has no runner name");

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        () => Effect.void,
        () => Effect.void,
      ),
    );
    await scheduler.accept({
      ...event,
      action: "in_progress",
      deliveryId: "delivery-in-progress",
      runnerName: accepted.runnerName,
    });
    await scheduler.accept({
      ...event,
      action: "completed",
      deliveryId: "delivery-completed",
      conclusion: "success",
    });

    const records = logged.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => record.workflowJobId === event.workflowJobId);
    expect(records.map(({ event: name, action, outcome }) => ({ name, action, outcome }))).toEqual([
      { name: "scheduler_transition", action: "queued", outcome: "accepted" },
      { name: "runner_provisioning_started", action: undefined, outcome: undefined },
      { name: "runner_provisioning_succeeded", action: undefined, outcome: undefined },
      { name: "scheduler_transition", action: "in_progress", outcome: "recorded" },
      { name: "scheduler_transition", action: "completed", outcome: "recorded" },
    ]);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliveryId: "delivery-observable",
          deploymentId: "deployment-test",
          installationId: 123,
          repositoryId: 456,
          workflowJobId: 5003,
          runnerName: "jitney-456-5003-1",
          containerName: "attempt-456-5003-1",
        }),
      ]),
    );
    logged.mockRestore();
  });

  it("records a typed provisioning failure without rendering its cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const canary = `ghs_${"SECRET_CANARY".repeat(4)}`;
    const scheduler = env.SCHEDULER.getByName("provisioning-failure");
    const event = queuedEvent(5002, "delivery-queued");
    await scheduler.accept(event);

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        () => Effect.fail(new ProvisioningError({ step: "container_start", cause: canary })),
        () => Effect.void,
      ),
    );

    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: "queued",
      pending: false,
    });
    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "failed" }]);
    expect(String(logged.mock.calls[0]?.[0])).not.toContain(canary);
    logged.mockRestore();
  });

  it("expires an unassigned attempt past its assignment deadline", async () => {
    const scheduler = env.SCHEDULER.getByName("assignment-expiry");
    const event = queuedEvent(6001, "delivery-queued");
    const accepted = await scheduler.accept(event);
    if (accepted.runnerName === undefined) throw new Error("accepted attempt has no runner name");
    const reclaimed: string[] = [];

    await withLifecycle(scheduler, async (lifecycle) => {
      await lifecycle.sweep(
        () => Effect.void,
        () => Effect.void,
      );
      await lifecycle.sweep(
        () => Effect.void,
        (request) => {
          reclaimed.push(request.runnerName);
          return Effect.void;
        },
        Date.now() + 6 * 60_000,
      );
    });

    expect(reclaimed).toEqual(["jitney-456-6001-1"]);
    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "expired" }]);
    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: "queued",
      pending: false,
    });

    expect(await scheduler.accept({ ...event, deliveryId: "delivery-retry" })).toEqual({
      outcome: "accepted",
      runnerName: "jitney-456-6001-2",
    });
  });

  it("leaves assigned and on-time attempts untouched by the sweep", async () => {
    const scheduler = env.SCHEDULER.getByName("expiry-boundaries");
    const onTime = queuedEvent(6002, "delivery-on-time");
    const assigned = queuedEvent(6003, "delivery-assigned");
    await scheduler.accept(onTime);
    const acceptedAssigned = await scheduler.accept(assigned);
    if (acceptedAssigned.runnerName === undefined) throw new Error("missing runner name");

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        () => Effect.void,
        () => Effect.void,
      ),
    );
    await scheduler.accept({
      ...assigned,
      action: "in_progress",
      deliveryId: "delivery-in-progress",
      runnerName: acceptedAssigned.runnerName,
    });

    const reclaimed: string[] = [];
    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        () => Effect.void,
        (request) => {
          reclaimed.push(request.runnerName);
          return Effect.void;
        },
        Date.now() + 6 * 60_000,
      ),
    );

    expect(reclaimed).toEqual(["jitney-456-6002-1"]);
    expect(await scheduler.getAttempts(assigned.workflowJobId)).toMatchObject([
      { state: "running" },
    ]);
    expect(await scheduler.getJob(assigned.workflowJobId)).toMatchObject({ state: "running" });
  });

  it("expires the attempt even when reclaiming fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("expiry-reclaim-failure");
    const event = queuedEvent(6004, "delivery-queued");
    await scheduler.accept(event);

    await withLifecycle(scheduler, async (lifecycle) => {
      await lifecycle.sweep(
        () => Effect.void,
        () => Effect.void,
      );
      await lifecycle.sweep(
        () => Effect.void,
        () => Effect.fail(new ProvisioningError({ step: "runner_deletion", cause: "boom" })),
        Date.now() + 6 * 60_000,
      );
    });

    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "expired" }]);
    const failures = logged.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => record.event === "runner_reclaim_failed");
    expect(failures).toMatchObject([{ workflowJobId: 6004, step: "runner_deletion" }]);
    logged.mockRestore();
  });

  it("persists separate assignment and runtime deadlines", async () => {
    const scheduler = env.SCHEDULER.getByName("deadlines");
    const event = queuedEvent(3001, "delivery-queued");
    const accepted = await scheduler.accept(event);
    const initial = await scheduler.getAttempts(event.workflowJobId);
    const runnerName = accepted.runnerName;
    if (runnerName === undefined) throw new Error("accepted attempt has no runner name");

    expect(initial[0]?.assignmentDeadline).toBeGreaterThan(Date.now());
    expect(initial[0]?.runtimeDeadline).toBeNull();

    await scheduler.accept({
      ...event,
      deliveryId: "delivery-running",
      action: "in_progress",
      runnerName,
    });
    const running = await scheduler.getAttempts(event.workflowJobId);
    expect(running[0]?.runtimeDeadline).toBeGreaterThan(Date.now());
    expect(running[0]?.runtimeDeadline).not.toBe(running[0]?.assignmentDeadline);
  });
});
