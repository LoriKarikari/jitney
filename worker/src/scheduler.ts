import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { DurableObject } from "cloudflare:workers";
import { Either, Effect } from "effect";
import { attempts, deliveries, jobs, pending, schema } from "./schema";
import type { WorkflowEvent } from "./domain";
import type { Provision } from "./provisioning";
import { createProvisioner } from "./provisioning";
import { ProvisioningError } from "./github";

const maxPendingJobs = 10;
const maxActiveAttempts = 25;
const assignmentTimeout = 5 * 60_000;
const runtimeTimeout = 60 * 60_000;
const viableAttemptStates = ["created", "starting", "waiting_for_assignment", "running"];
const terminalJobStates = ["completed", "cancelled", "failed"];

export type AcceptResult = {
  outcome: "accepted" | "recorded" | "duplicate" | "capacity_limited";
  runnerName?: string;
};

export type JobSnapshot = {
  workflowJobId: number;
  state: string;
  repositoryId: number;
  runnerName?: string;
  pending: boolean;
};

export type AttemptSnapshot = {
  attempt: number;
  state: string;
  runnerName: string;
  assignmentDeadline: number;
  runtimeDeadline: number | null;
};

export class Scheduler extends DurableObject<Env> {
  #db = drizzle(this.ctx.storage, { schema: { deliveries, jobs, attempts, pending } });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#db.run(schema);
    });
  }

  async accept(event: WorkflowEvent): Promise<AcceptResult> {
    const now = Date.now();
    const db = this.#db;
    const delivery = db
      .select({ deliveryId: deliveries.deliveryId })
      .from(deliveries)
      .where(eq(deliveries.deliveryId, event.deliveryId))
      .all()[0];
    if (delivery !== undefined) return { outcome: "duplicate" };

    db.insert(deliveries)
      .values({ deliveryId: event.deliveryId, workflowJobId: event.workflowJobId, receivedAt: now })
      .run();

    const job = db.select().from(jobs).where(eq(jobs.workflowJobId, event.workflowJobId)).all()[0];
    if (job !== undefined && terminalJobStates.includes(job.state)) {
      return { outcome: "duplicate", ...(job.runnerName && { runnerName: job.runnerName }) };
    }

    if (event.action === "queued") {
      const viableAttempt = db
        .select({ runnerName: attempts.runnerName })
        .from(attempts)
        .where(
          and(
            eq(attempts.workflowJobId, event.workflowJobId),
            inArray(attempts.state, viableAttemptStates),
          ),
        )
        .all()[0];
      if (viableAttempt !== undefined) {
        return { outcome: "duplicate", runnerName: viableAttempt.runnerName };
      }

      const pendingCount =
        db
          .select({ count: sql<number>`count(*)` })
          .from(pending)
          .all()[0]?.count ?? 0;
      const activeCount =
        db
          .select({ count: sql<number>`count(*)` })
          .from(attempts)
          .where(inArray(attempts.state, viableAttemptStates))
          .all()[0]?.count ?? 0;
      if (pendingCount >= maxPendingJobs || activeCount >= maxActiveAttempts) {
        db.insert(jobs)
          .values({
            workflowJobId: event.workflowJobId,
            state: "capacity_limited",
            repositoryId: event.repositoryId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: jobs.workflowJobId,
            set: { state: "capacity_limited", updatedAt: now },
          })
          .run();
        return { outcome: "capacity_limited" };
      }

      const previousAttempt = db
        .select({ attempt: attempts.attempt })
        .from(attempts)
        .where(eq(attempts.workflowJobId, event.workflowJobId))
        .orderBy(desc(attempts.attempt))
        .all()[0];
      const attempt = (previousAttempt?.attempt ?? 0) + 1;
      const runnerName = `jitney-${event.repositoryId}-${event.workflowJobId}-${attempt}`;
      const containerName = `attempt-${event.repositoryId}-${event.workflowJobId}-${attempt}`;

      db.insert(jobs)
        .values({
          workflowJobId: event.workflowJobId,
          state: "queued",
          repositoryId: event.repositoryId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: jobs.workflowJobId,
          set: { state: "queued", updatedAt: now },
        })
        .run();

      db.insert(attempts)
        .values({
          workflowJobId: event.workflowJobId,
          attempt,
          state: "created",
          runnerName,
          containerName,
          assignmentDeadline: now + assignmentTimeout,
          runtimeDeadline: null,
        })
        .run();

      db.insert(pending)
        .values({
          workflowJobId: event.workflowJobId,
          payload: JSON.stringify(event),
          runnerName,
          containerName,
        })
        .onConflictDoUpdate({
          target: pending.workflowJobId,
          set: { payload: JSON.stringify(event), runnerName, containerName },
        })
        .run();

      await this.ctx.storage.setAlarm(now + 1_000);
      return { outcome: "accepted", runnerName };
    }

    if (event.action === "in_progress" && event.runnerName !== undefined) {
      db.update(jobs)
        .set({ state: "running", runnerName: event.runnerName, updatedAt: now })
        .where(eq(jobs.workflowJobId, event.workflowJobId))
        .run();
      db.update(attempts)
        .set({ state: "running", runtimeDeadline: now + runtimeTimeout })
        .where(eq(attempts.runnerName, event.runnerName))
        .run();
      return { outcome: "recorded", runnerName: event.runnerName };
    }

    if (event.action === "completed") {
      const state =
        event.conclusion === "cancelled"
          ? "cancelled"
          : event.conclusion === "success"
            ? "completed"
            : "failed";
      db.update(jobs)
        .set({ state, conclusion: event.conclusion ?? "unknown", updatedAt: now })
        .where(eq(jobs.workflowJobId, event.workflowJobId))
        .run();
      db.update(attempts)
        .set({ state: "stopped" })
        .where(
          and(
            eq(attempts.workflowJobId, event.workflowJobId),
            inArray(attempts.state, ["created", "starting", "waiting_for_assignment"]),
          ),
        )
        .run();
      db.delete(pending).where(eq(pending.workflowJobId, event.workflowJobId)).run();
    }

    return { outcome: "recorded" };
  }

  getJob(workflowJobId: number): JobSnapshot | undefined {
    const row = this.#db.select().from(jobs).where(eq(jobs.workflowJobId, workflowJobId)).all()[0];
    if (row === undefined) return undefined;
    const pendingRow = this.#db
      .select({ workflowJobId: pending.workflowJobId })
      .from(pending)
      .where(eq(pending.workflowJobId, workflowJobId))
      .all()[0];

    return {
      workflowJobId: row.workflowJobId,
      state: row.state,
      repositoryId: row.repositoryId,
      pending: pendingRow !== undefined,
      ...(row.runnerName && { runnerName: row.runnerName }),
    };
  }

  getAttempts(workflowJobId: number): AttemptSnapshot[] {
    return this.#db
      .select({
        attempt: attempts.attempt,
        state: attempts.state,
        runnerName: attempts.runnerName,
        assignmentDeadline: attempts.assignmentDeadline,
        runtimeDeadline: attempts.runtimeDeadline,
      })
      .from(attempts)
      .where(eq(attempts.workflowJobId, workflowJobId))
      .orderBy(attempts.attempt)
      .all();
  }

  override async alarm(): Promise<void> {
    if (await drainPending(this.#db, createProvisioner(this.env))) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }
}

type SchedulerSchema = {
  deliveries: typeof deliveries;
  jobs: typeof jobs;
  attempts: typeof attempts;
  pending: typeof pending;
};

export async function drainPending(
  db: DrizzleSqliteDODatabase<SchedulerSchema>,
  provision: Provision,
): Promise<boolean> {
  const pendingRow = db.select().from(pending).orderBy(pending.workflowJobId).all()[0];
  if (pendingRow === undefined) return false;

  const event = JSON.parse(pendingRow.payload) as WorkflowEvent;
  db.update(jobs)
    .set({ state: "provisioning", updatedAt: Date.now() })
    .where(eq(jobs.workflowJobId, pendingRow.workflowJobId))
    .run();

  const result = await Effect.runPromise(
    provision({
      installationId: event.installationId,
      repositoryId: event.repositoryId,
      repositoryOwner: event.repositoryOwner,
      repositoryName: event.repositoryName,
      workflowJobId: event.workflowJobId,
      runnerName: pendingRow.runnerName,
      containerName: pendingRow.containerName,
    }).pipe(Effect.either),
  );

  if (Either.isRight(result)) {
    db.update(jobs)
      .set({ state: "waiting_for_assignment", updatedAt: Date.now() })
      .where(eq(jobs.workflowJobId, pendingRow.workflowJobId))
      .run();
    db.update(attempts)
      .set({ state: "waiting_for_assignment" })
      .where(
        and(
          eq(attempts.workflowJobId, pendingRow.workflowJobId),
          eq(attempts.runnerName, pendingRow.runnerName),
        ),
      )
      .run();
  } else {
    const error = result.left;
    const step = error instanceof ProvisioningError ? error.step : "installation_mismatch";

    db.update(jobs)
      .set({ state: "queued", updatedAt: Date.now() })
      .where(eq(jobs.workflowJobId, pendingRow.workflowJobId))
      .run();
    db.update(attempts)
      .set({ state: "failed" })
      .where(
        and(
          eq(attempts.workflowJobId, pendingRow.workflowJobId),
          eq(attempts.runnerName, pendingRow.runnerName),
        ),
      )
      .run();
    console.error(
      JSON.stringify({
        event: "runner_provisioning_failed",
        workflowJobId: pendingRow.workflowJobId,
        runnerName: pendingRow.runnerName,
        containerName: pendingRow.containerName,
        step,
      }),
    );
  }

  db.delete(pending).where(eq(pending.workflowJobId, pendingRow.workflowJobId)).run();
  const remaining = db
    .select({ count: sql<number>`count(*)` })
    .from(pending)
    .all()[0];
  return remaining !== undefined && remaining.count > 0;
}
