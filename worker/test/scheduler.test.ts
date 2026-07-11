import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "../src/domain";
import { Scheduler } from "../src/scheduler";

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

    await runInDurableObject(scheduler, async (_instance: Scheduler, state) => {
      state.storage.sql.exec(
        "UPDATE attempts SET state = 'failed' WHERE workflow_job_id = ?",
        event.workflowJobId,
      );
      state.storage.sql.exec("DELETE FROM pending WHERE workflow_job_id = ?", event.workflowJobId);
    });

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
    expect(await scheduler.getAttempts(event.workflowJobId)).toMatchObject([{ state: "stopped" }]);
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
      await runInDurableObject(scheduler, async (_instance: Scheduler, state) => {
        state.storage.sql.exec(
          "UPDATE attempts SET state = 'waiting_for_assignment' WHERE workflow_job_id = ?",
          event.workflowJobId,
        );
        state.storage.sql.exec(
          "DELETE FROM pending WHERE workflow_job_id = ?",
          event.workflowJobId,
        );
      });
    }

    const rejected = queuedEvent(4026, "delivery-26");
    expect(await scheduler.accept(rejected)).toEqual({ outcome: "capacity_limited" });
    expect(await scheduler.getAttempts(rejected.workflowJobId)).toEqual([]);
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
