import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent } from "../src/domain";
import { runnerContainerInactivityTimeoutMs, SchedulerLifecycle } from "../src/lifecycle";
import {
  RunnerAttemptFailure,
  type RunnerAttemptOperations,
} from "../src/runner-attempt-operations";
import { Scheduler } from "../src/scheduler";

const testSchedulerTick = 60_000;

function withLifecycle<Result, Error>(
  scheduler: DurableObjectStub<Scheduler>,
  use: (lifecycle: SchedulerLifecycle) => Effect.Effect<Result, Error>,
): Promise<Result> {
  return runInDurableObject(scheduler, (_instance, state) =>
    Effect.runPromise(
      use(new SchedulerLifecycle(state.storage, "deployment-test", 60 * 60_000, testSchedulerTick)),
    ),
  );
}

async function disarmSchedulerAlarms(): Promise<void> {
  const ids = await listDurableObjectIds(env.SCHEDULER);
  await Promise.all(
    ids.map((id) =>
      runInDurableObject(env.SCHEDULER.get(id), (_instance, state) => state.storage.deleteAlarm()),
    ),
  );
}

function expirationReasons(logged: { mock: { calls: unknown[][] } }): unknown[] {
  return logged.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter((record) => record.event === "runner_attempt_expired")
    .map((record) => record.stopReason);
}

function operations(
  provision: RunnerAttemptOperations["provision"] = () => Effect.void,
  reclaim: RunnerAttemptOperations["reclaim"] = () => Effect.void,
  isRunning: RunnerAttemptOperations["isRunning"] = () => Effect.succeed(true),
  jobStatus: RunnerAttemptOperations["jobStatus"] = () =>
    Effect.succeed({ status: "in_progress", conclusion: null, runnerName: null }),
): RunnerAttemptOperations {
  return { provision, reclaim, isRunning, jobStatus };
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
  afterEach(disarmSchedulerAlarms);

  it("queues jobs during a drain and creates no attempt until intake resumes", async () => {
    const scheduler = env.SCHEDULER.getByName("drain-intake");
    const event = queuedEvent(1000, "delivery-drain");

    await scheduler.suspendIntake();
    expect(await scheduler.accept(event)).toEqual({ outcome: "accepted" });
    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: "queued",
      pending: false,
    });
    expect(await scheduler.getAttempts(event.workflowJobId)).toEqual([]);

    await scheduler.resumeIntake();
    const { action: _action, deliveryId: _deliveryId, ...candidate } = event;
    expect(await scheduler.reconcile(candidate)).toEqual({
      outcome: "accepted",
      runnerName: "jitney-456-1000-1",
    });
  });

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
        operations(
          () => Effect.fail(new RunnerAttemptFailure({ step: "container_start", cause: "failed" })),
          () => Effect.void,
        ),
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
      await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));
    }

    const rejected = queuedEvent(4026, "delivery-26");
    expect(await scheduler.accept(rejected)).toEqual({ outcome: "capacity_limited" });
    expect(await scheduler.getAttempts(rejected.workflowJobId)).toEqual([]);

    let privilegedCalls = 0;
    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => {
            privilegedCalls++;
            return Effect.void;
          },
          () => Effect.void,
        ),
      ),
    );
    expect(privilegedCalls).toBe(0);
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

  it("reclaims a started runner left idle by a cross-assignment", async () => {
    const scheduler = env.SCHEDULER.getByName("cross-assignment-idle");
    const jobA = queuedEvent(4701, "delivery-a-queued");
    const jobB = queuedEvent(4702, "delivery-b-queued");
    const attemptA = await scheduler.accept(jobA);
    await scheduler.accept(jobB);
    const runnerName = attemptA.runnerName;
    if (runnerName === undefined) throw new Error("accepted attempt has no runner name");
    const reclaimed: string[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      Effect.gen(function* () {
        yield* lifecycle.sweep(operations());
        yield* lifecycle.sweep(operations());
        yield* lifecycle.accept({
          ...jobB,
          action: "in_progress",
          deliveryId: "delivery-b-running",
          runnerName,
        });
        yield* lifecycle.sweep(
          operations(
            () => Effect.void,
            (request) => {
              reclaimed.push(request.runnerName);
              return Effect.void;
            },
          ),
          Date.now() + 6 * 60_000,
        );
      }),
    );

    expect(reclaimed).toEqual(["jitney-456-4702-1"]);
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

  it("preserves an assignment recorded while provisioning finishes", async () => {
    const scheduler = env.SCHEDULER.getByName("assignment-during-provisioning");
    const event = queuedEvent(5004, "delivery-queued");
    const accepted = await scheduler.accept(event);
    const runnerName = accepted.runnerName;
    if (runnerName === undefined) throw new Error("accepted attempt has no runner name");

    await withLifecycle(scheduler, (lifecycle) =>
      Effect.gen(function* () {
        let finishProvisioning: () => void = () => undefined;
        let markProvisioningStarted: () => void = () => undefined;
        const provisioningStarted = new Promise<void>((resolve) => {
          markProvisioningStarted = resolve;
        });
        const sweep = yield* Effect.forkChild(
          lifecycle.sweep(
            operations(() =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    finishProvisioning = resolve;
                    markProvisioningStarted();
                  }),
              ),
            ),
          ),
        );
        yield* Effect.promise(() => provisioningStarted);

        yield* lifecycle.accept({
          ...event,
          action: "in_progress",
          deliveryId: "delivery-in-progress",
          runnerName,
        });
        finishProvisioning();
        yield* Fiber.join(sweep);
      }),
    );

    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({ state: "running" });
    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "running" }]);
  });

  it("records a typed provisioning failure without rendering its cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const canary = `ghs_${"SECRET_CANARY".repeat(4)}`;
    const scheduler = env.SCHEDULER.getByName("provisioning-failure");
    const event = queuedEvent(5002, "delivery-queued");
    await scheduler.accept(event);

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => Effect.fail(new RunnerAttemptFailure({ step: "container_start", cause: canary })),
          () => Effect.void,
        ),
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

  it.each([
    ["jit_config", []],
    ["container_start", ["jitney-456-5102-1"]],
  ] as const)(
    "reclaims a runner minted before provisioning failed at %s",
    async (step, expected) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const scheduler = env.SCHEDULER.getByName(`provisioning-failure-${step}`);
      await scheduler.accept(queuedEvent(5102, "delivery-queued"));
      const reclaimed: string[] = [];

      await withLifecycle(scheduler, (lifecycle) =>
        lifecycle.sweep(
          operations(
            () => Effect.fail(new RunnerAttemptFailure({ step, cause: "boom" })),
            (request) => {
              reclaimed.push(request.runnerName);
              return Effect.void;
            },
          ),
        ),
      );

      expect(reclaimed).toEqual(expected);
      logged.mockRestore();
    },
  );

  it("expires an unassigned attempt past its assignment deadline", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("assignment-expiry");
    const event = queuedEvent(6001, "delivery-queued");
    const accepted = await scheduler.accept(event);
    if (accepted.runnerName === undefined) throw new Error("accepted attempt has no runner name");
    const reclaimed: string[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      Effect.gen(function* () {
        yield* lifecycle.sweep(operations());
        yield* lifecycle.sweep(
          operations(
            () => Effect.void,
            (request) => {
              reclaimed.push(request.runnerName);
              return Effect.void;
            },
          ),
          Date.now() + 6 * 60_000,
        );
      }),
    );

    expect(reclaimed).toEqual(["jitney-456-6001-1"]);
    expect(expirationReasons(logged)).toEqual(["assignment_deadline"]);
    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "expired" }]);
    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: "queued",
      pending: false,
    });

    expect(await scheduler.accept({ ...event, deliveryId: "delivery-retry" })).toEqual({
      outcome: "accepted",
      runnerName: "jitney-456-6001-2",
    });
    logged.mockRestore();
  });

  it("expires the attempt even when reclaiming fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("expiry-reclaim-failure");
    const event = queuedEvent(6004, "delivery-queued");
    await scheduler.accept(event);

    await withLifecycle(scheduler, (lifecycle) =>
      Effect.gen(function* () {
        yield* lifecycle.sweep(operations());
        yield* lifecycle.sweep(
          operations(
            () => Effect.void,
            () => Effect.fail(new RunnerAttemptFailure({ step: "runner_deletion", cause: "boom" })),
          ),
          Date.now() + 6 * 60_000,
        );
      }),
    );

    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "expired" }]);
    const failures = logged.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => record.event === "runner_reclaim_failed");
    expect(failures).toMatchObject([{ workflowJobId: 6004, step: "runner_deletion" }]);
    logged.mockRestore();
  });

  it("spares an attempt assigned while the sweep reclaims another", async () => {
    const scheduler = env.SCHEDULER.getByName("expiry-assignment-race");
    const first = queuedEvent(6101, "delivery-first");
    const second = queuedEvent(6102, "delivery-second");
    await scheduler.accept(first);
    const accepted = await scheduler.accept(second);
    if (accepted.runnerName === undefined) throw new Error("missing runner name");
    const runnerName = accepted.runnerName;
    const reclaimed: string[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      Effect.gen(function* () {
        yield* lifecycle.sweep(operations());
        yield* lifecycle.sweep(operations());
        yield* lifecycle.sweep(
          operations(
            () => Effect.void,
            (request) => {
              reclaimed.push(request.runnerName);
              return lifecycle
                .accept({
                  ...second,
                  action: "in_progress",
                  deliveryId: "delivery-second-running",
                  runnerName,
                })
                .pipe(Effect.orDie, Effect.asVoid);
            },
          ),
          Date.now() + 6 * 60_000,
        );
      }),
    );

    expect(reclaimed).toEqual(["jitney-456-6101-1"]);
    expect(await scheduler.getAttempts(second.workflowJobId)).toMatchObject([{ state: "running" }]);
  });

  it("keeps a job completed while the sweep reclaims another runtime expiry", async () => {
    const scheduler = env.SCHEDULER.getByName("runtime-completion-race");
    const first = queuedEvent(6201, "delivery-first");
    const second = queuedEvent(6202, "delivery-second");
    const reclaimed: string[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      Effect.gen(function* () {
        for (const event of [first, second]) {
          const { runnerName } = yield* lifecycle.accept(event);
          if (runnerName === undefined) throw new Error("missing runner name");
          yield* lifecycle.sweep(operations());
          yield* lifecycle.accept({
            ...event,
            action: "in_progress",
            deliveryId: `${event.deliveryId}-running`,
            runnerName,
          });
        }
        yield* lifecycle.sweep(
          operations(
            () => Effect.void,
            (request) => {
              reclaimed.push(request.runnerName);
              return lifecycle
                .accept({
                  ...second,
                  action: "completed",
                  conclusion: "success",
                  deliveryId: "delivery-second-completed",
                })
                .pipe(Effect.orDie, Effect.asVoid);
            },
          ),
          Date.now() + 61 * 60_000,
        );
      }),
    );

    expect(reclaimed).toEqual(["jitney-456-6201-1"]);
    expect(await scheduler.getJob(second.workflowJobId)).toMatchObject({ state: "completed" });
  });

  it("stops a running assignment past its runtime deadline and leaves its Job to GitHub", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("runtime-expiry");
    const event = queuedEvent(7001, "delivery-queued");
    const accepted = await scheduler.accept(event);
    if (accepted.runnerName === undefined) throw new Error("missing runner name");

    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));
    await scheduler.accept({
      ...event,
      action: "in_progress",
      deliveryId: "delivery-in-progress",
      runnerName: accepted.runnerName,
    });

    const reclaimed: string[] = [];
    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => Effect.void,
          (request) => {
            reclaimed.push(request.runnerName);
            return Effect.void;
          },
        ),
        Date.now() + 61 * 60_000,
      ),
    );

    expect(reclaimed).toEqual(["jitney-456-7001-1"]);
    expect(expirationReasons(logged)).toEqual(["runtime_deadline"]);
    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "expired" }]);
    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: "running",
      pending: false,
    });

    expect(await scheduler.accept({ ...event, deliveryId: "delivery-late-retry" })).toMatchObject({
      outcome: "duplicate",
    });
    expect(
      await scheduler.accept({
        ...event,
        action: "completed",
        conclusion: "success",
        deliveryId: "delivery-late-completed",
      }),
    ).toMatchObject({ outcome: "recorded" });
    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: "completed",
      conclusion: "success",
    });
    logged.mockRestore();
  });
});

describe("Runner Container exits", () => {
  afterEach(disarmSchedulerAlarms);

  it("ends the attempt of an exited Runner Container on the next sweep and frees its capacity", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("container-exit");
    for (let job = 1; job <= 25; job++) {
      await scheduler.accept(queuedEvent(8000 + job, `delivery-${job}`));
      await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));
    }
    await scheduler.accept({
      ...queuedEvent(8001, "delivery-in-progress"),
      action: "in_progress",
      runnerName: "jitney-456-8001-1",
    });
    const waiting = queuedEvent(8026, "delivery-26");
    expect(await scheduler.accept(waiting)).toEqual({ outcome: "capacity_limited" });

    const reclaimed: string[] = [];
    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => Effect.void,
          (request) => {
            reclaimed.push(request.runnerName);
            return Effect.void;
          },
          (request) =>
            request.runnerName === "jitney-456-8002-1"
              ? Effect.fail(new RunnerAttemptFailure({ step: "container_probe", cause: "down" }))
              : Effect.succeed(request.runnerName !== "jitney-456-8001-1"),
        ),
      ),
    );

    expect(reclaimed).toEqual(["jitney-456-8001-1"]);
    expect(await scheduler.getAttempts(8001)).toMatchObject([{ state: "stopped" }]);
    expect(await scheduler.getAttempts(8002)).toMatchObject([{ state: "waiting_for_assignment" }]);
    expect(await scheduler.activeAttemptCount()).toBe(24);
    const { action: _action, deliveryId: _deliveryId, ...candidate } = waiting;
    expect(await scheduler.reconcile(candidate)).toMatchObject({ outcome: "accepted" });
    logged.mockRestore();
  });

  it("requeues the job of a runner that exits before any job claims it", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("container-exit-unassigned");
    const event = queuedEvent(8101, "delivery-queued");
    await scheduler.accept(event);
    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => Effect.void,
          () => Effect.void,
          () => Effect.succeed(false),
          () => Effect.succeed({ status: "queued", conclusion: null, runnerName: null }),
        ),
      ),
    );

    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "stopped" }]);
    expect(await scheduler.getJob(event.workflowJobId)).toMatchObject({
      state: "queued",
      pending: false,
    });
    logged.mockRestore();
  });
});

describe("Job conclusions from GitHub", () => {
  afterEach(disarmSchedulerAlarms);

  async function runningJob(name: string, workflowJobId: number) {
    const scheduler = env.SCHEDULER.getByName(name);
    const event = queuedEvent(workflowJobId, "delivery-queued");
    const { runnerName } = await scheduler.accept(event);
    if (runnerName === undefined) throw new Error("missing runner name");
    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));
    await scheduler.accept({
      ...event,
      action: "in_progress",
      deliveryId: "delivery-in-progress",
      runnerName,
    });
    return scheduler;
  }

  it("records the conclusion GitHub reports for a Job whose attempt ended without a completed delivery", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = await runningJob("conclusion-read", 9001);
    const reads: unknown[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => Effect.void,
          () => Effect.void,
          () => Effect.succeed(false),
          (check) => {
            reads.push(check);
            return Effect.succeed({
              status: "completed",
              conclusion: "success",
              runnerName: "jitney-456-9001-1",
            });
          },
        ),
      ),
    );

    expect(reads).toMatchObject([
      { workflowJobId: 9001, repositoryOwner: "LoriKarikari", repositoryName: "jitney-test" },
    ]);
    expect(await scheduler.getJob(9001)).toMatchObject({
      state: "completed",
      conclusion: "success",
    });
    logged.mockRestore();
  });

  it("keeps a Job GitHub still reports in progress open and reads it again on a later sweep", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = await runningJob("conclusion-in-progress", 9002);
    const statuses = ["in_progress", "completed"];
    let reads = 0;
    const checking = operations(
      () => Effect.void,
      () => Effect.void,
      () => Effect.succeed(false),
      () => {
        const status = statuses[reads++] ?? "completed";
        return Effect.succeed({
          status,
          conclusion: status === "completed" ? "failure" : null,
          runnerName: "jitney-456-9002-1",
        });
      },
    );
    const now = Date.now();
    await runInDurableObject(scheduler, (_instance, state) => state.storage.deleteAlarm());

    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(checking, now));
    expect(reads).toBe(1);
    expect(await scheduler.getJob(9002)).toMatchObject({ state: "running" });
    await runInDurableObject(scheduler, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(now + testSchedulerTick);
    });

    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(checking, now + 1_000));
    expect(reads).toBe(1);

    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(checking, now + 31_000));
    expect(reads).toBe(2);
    expect(await scheduler.getJob(9002)).toMatchObject({
      state: "failed",
      conclusion: "failure",
    });
    logged.mockRestore();
  });

  function exitedWith(jobStatus: RunnerAttemptOperations["jobStatus"]): RunnerAttemptOperations {
    return operations(
      () => Effect.void,
      () => Effect.void,
      () => Effect.succeed(false),
      jobStatus,
    );
  }

  it.each([
    ["success", "completed"],
    ["cancelled", "cancelled"],
    ["failure", "failed"],
    ["timed_out", "failed"],
    ["skipped", "failed"],
    ["neutral", "failed"],
    ["action_required", "failed"],
    ["startup_failure", "failed"],
    ["stale", "failed"],
  ])("records GitHub's %s conclusion as a %s Job", async (conclusion, state) => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const workflowJobId = 9100 + conclusion.length;
    const scheduler = await runningJob(`conclusion-${conclusion}`, workflowJobId);

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        exitedWith(() => Effect.succeed({ status: "completed", conclusion, runnerName: null })),
      ),
    );

    expect(await scheduler.getJob(workflowJobId)).toMatchObject({ state, conclusion });
    logged.mockRestore();
  });

  it("keeps the conclusion a completed delivery records while a read is in flight", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = await runningJob("conclusion-race", 9201);
    let reads = 0;
    const now = Date.now();

    await withLifecycle(scheduler, (lifecycle) => {
      const racing = exitedWith(() => {
        reads++;
        return lifecycle
          .accept({
            ...queuedEvent(9201, "delivery-completed"),
            action: "completed",
            conclusion: "failure",
          })
          .pipe(
            Effect.orDie,
            Effect.as({ status: "completed", conclusion: "success", runnerName: null }),
          );
      });
      return Effect.gen(function* () {
        yield* lifecycle.sweep(racing, now);
        yield* lifecycle.sweep(racing, now + 31_000);
      });
    });

    expect(reads).toBe(1);
    expect(await scheduler.getJob(9201)).toMatchObject({ state: "failed", conclusion: "failure" });
    logged.mockRestore();
  });

  it("reads the Job a cross-assigned runner ran, not the Job that triggered it", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("conclusion-cross-assignment");
    const jobA = queuedEvent(9301, "delivery-a");
    const jobB = queuedEvent(9302, "delivery-b");
    const { runnerName } = await scheduler.accept(jobA);
    if (runnerName === undefined) throw new Error("missing runner name");
    await scheduler.accept(jobB);
    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));
    await scheduler.accept({ ...jobB, action: "in_progress", deliveryId: "b-running", runnerName });
    const reads: number[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        exitedWith((check) => {
          reads.push(check.workflowJobId);
          return Effect.succeed({ status: "completed", conclusion: "success", runnerName });
        }),
      ),
    );

    expect(reads).toContain(9302);
    expect(reads).not.toContain(9301);
    expect(await scheduler.getJob(9302)).toMatchObject({ state: "completed" });
    logged.mockRestore();
  });

  it("records the conclusion of a Job whose in_progress delivery was lost", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("conclusion-lost-in-progress");
    const { runnerName } = await scheduler.accept(queuedEvent(9401, "delivery-queued"));
    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        exitedWith(() =>
          Effect.succeed({
            status: "completed",
            conclusion: "success",
            runnerName: runnerName ?? null,
          }),
        ),
      ),
    );

    expect(await scheduler.getAttempts(9401)).toMatchObject([{ state: "stopped" }]);
    expect(await scheduler.getJob(9401)).toMatchObject({
      state: "completed",
      conclusion: "success",
    });
    logged.mockRestore();
  });

  it("keeps a runner GitHub says is running its Job past the assignment deadline", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("conclusion-assignment-deadline");
    const { runnerName } = await scheduler.accept(queuedEvent(9501, "delivery-queued"));
    if (runnerName === undefined) throw new Error("missing runner name");
    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));
    const reclaimed: string[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => Effect.void,
          (request) => {
            reclaimed.push(request.runnerName);
            return Effect.void;
          },
          () => Effect.succeed(true),
          () => Effect.succeed({ status: "in_progress", conclusion: null, runnerName }),
        ),
        Date.now() + 6 * 60_000,
      ),
    );

    expect(reclaimed).toEqual([]);
    expect(await scheduler.getAttempts(9501)).toMatchObject([{ state: "running" }]);
    expect(await scheduler.getJob(9501)).toMatchObject({ state: "running", runnerName });
    logged.mockRestore();
  });

  it("reclaims a runner at the assignment deadline when GitHub says its Job already ended", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = env.SCHEDULER.getByName("conclusion-deadline-ended");
    const event = queuedEvent(9502, "delivery-queued");
    const { runnerName } = await scheduler.accept(event);
    if (runnerName === undefined) throw new Error("missing runner name");
    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(operations()));
    await scheduler.accept({
      ...event,
      action: "completed",
      conclusion: "cancelled",
      deliveryId: "delivery-cancelled",
    });
    const reclaimed: string[] = [];

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => Effect.void,
          (request) => {
            reclaimed.push(request.runnerName);
            return Effect.void;
          },
          () => Effect.succeed(true),
          () => Effect.succeed({ status: "completed", conclusion: "cancelled", runnerName }),
        ),
        Date.now() + 6 * 60_000,
      ),
    );

    expect(reclaimed).toEqual([runnerName]);
    expect(await scheduler.getAttempts(9502)).toMatchObject([{ state: "expired" }]);
    expect(await scheduler.getJob(9502)).toMatchObject({ state: "cancelled" });
    logged.mockRestore();
  });

  it("keeps the check and reads again later when a read fails", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const failed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = await runningJob("conclusion-read-fails", 9601);
    let reads = 0;
    const checking = exitedWith(() => {
      reads++;
      return reads === 1
        ? Effect.fail(new RunnerAttemptFailure({ step: "job_status", cause: "rate limited" }))
        : Effect.succeed({ status: "completed", conclusion: "success", runnerName: null });
    });
    const now = Date.now();

    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(checking, now));
    expect(await scheduler.getJob(9601)).toMatchObject({ state: "running" });
    expect(failed.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toContain(
      "job_status_failed",
    );

    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(checking, now + 31_000));
    expect(reads).toBe(2);
    expect(await scheduler.getJob(9601)).toMatchObject({ state: "completed" });
    logged.mockRestore();
    failed.mockRestore();
  });

  it("ends a Job GitHub no longer has as failed with an unknown conclusion and stops reading", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = await runningJob("conclusion-not-found", 9701);
    let reads = 0;
    const checking = exitedWith(() => {
      reads++;
      return Effect.succeed({ status: "not_found", conclusion: null, runnerName: null });
    });
    const now = Date.now();

    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(checking, now));
    await withLifecycle(scheduler, (lifecycle) => lifecycle.sweep(checking, now + 31_000));

    expect(reads).toBe(1);
    expect(await scheduler.getJob(9701)).toMatchObject({ state: "failed", conclusion: "unknown" });
    logged.mockRestore();
  });

  it("reads a Job whose runtime deadline passed", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = await runningJob("conclusion-runtime-deadline", 9801);

    await withLifecycle(scheduler, (lifecycle) =>
      lifecycle.sweep(
        operations(
          () => Effect.void,
          () => Effect.void,
          () => Effect.succeed(true),
          () => Effect.succeed({ status: "completed", conclusion: "cancelled", runnerName: null }),
        ),
        Date.now() + 61 * 60_000,
      ),
    );

    expect(await scheduler.getJob(9801)).toMatchObject({
      state: "cancelled",
      conclusion: "cancelled",
    });
    logged.mockRestore();
  });
});

describe("Runner Container inactivity timeout", () => {
  it("outlasts the assignment and runtime deadlines and never exceeds 6 hours", () => {
    expect(runnerContainerInactivityTimeoutMs(60 * 60_000)).toBe(75 * 60_000);
    expect(runnerContainerInactivityTimeoutMs(2 * 60 * 60_000)).toBe(135 * 60_000);
    expect(runnerContainerInactivityTimeoutMs(6 * 60 * 60_000)).toBe(6 * 60 * 60_000);
  });
});
