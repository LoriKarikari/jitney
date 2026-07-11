import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { DurableObject } from "cloudflare:workers";
import { attempts, deliveries, jobs, pending, schema } from "./schema";
import type { WorkflowEvent } from "./domain";
import { generateJitConfig } from "./github";
import type { RunnerContainer } from "./runner-container";

export type AcceptResult = {
  outcome: "accepted" | "recorded";
  runnerName?: string;
};

export type JobSnapshot = {
  workflowJobId: number;
  state: string;
  repositoryId: number;
  runnerName?: string;
  pending: boolean;
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

    this.#db
      .insert(deliveries)
      .values({
        deliveryId: event.deliveryId,
        workflowJobId: event.workflowJobId,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .run();

    if (event.action === "queued") {
      const runnerName = `jitney-${event.repositoryId}-${event.workflowJobId}-1`;
      const containerName = `attempt-${event.repositoryId}-${event.workflowJobId}-1`;

      this.#db
        .insert(jobs)
        .values({
          workflowJobId: event.workflowJobId,
          state: "queued",
          repositoryId: event.repositoryId,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();

      this.#db
        .insert(attempts)
        .values({
          workflowJobId: event.workflowJobId,
          attempt: 1,
          state: "created",
          runnerName,
          containerName,
          assignmentDeadline: now + 5 * 60_000,
        })
        .onConflictDoNothing()
        .run();

      this.#db
        .insert(pending)
        .values({
          workflowJobId: event.workflowJobId,
          payload: JSON.stringify(event),
          runnerName,
          containerName,
        })
        .onConflictDoNothing()
        .run();

      await this.ctx.storage.setAlarm(now + 1_000);
      return { outcome: "accepted", runnerName };
    }

    if (event.action === "in_progress" && event.runnerName !== undefined) {
      this.#db
        .update(jobs)
        .set({ state: "running", runnerName: event.runnerName, updatedAt: now })
        .where(eq(jobs.workflowJobId, event.workflowJobId))
        .run();
      return { outcome: "recorded", runnerName: event.runnerName };
    }

    if (event.action === "completed") {
      this.#db
        .update(jobs)
        .set({ state: "completed", conclusion: event.conclusion ?? "unknown", updatedAt: now })
        .where(eq(jobs.workflowJobId, event.workflowJobId))
        .run();
    }

    return { outcome: "recorded" };
  }

  getJob(workflowJobId: number): JobSnapshot | undefined {
    const row = this.#db
      .select({
        workflowJobId: jobs.workflowJobId,
        state: jobs.state,
        repositoryId: jobs.repositoryId,
        runnerName: jobs.runnerName,
        pending: sql`EXISTS(SELECT 1 FROM ${pending} WHERE ${pending.workflowJobId} = ${jobs.workflowJobId})`,
      })
      .from(jobs)
      .where(eq(jobs.workflowJobId, workflowJobId))
      .all()[0];
    if (row === undefined) return undefined;

    const snapshot: JobSnapshot = {
      workflowJobId: row.workflowJobId,
      state: row.state,
      repositoryId: row.repositoryId,
      pending: row.pending === 1,
    };
    if (row.runnerName !== null) snapshot.runnerName = row.runnerName;
    return snapshot;
  }

  override async alarm(): Promise<void> {
    const pendingRow = this.#db.select().from(pending).orderBy(pending.workflowJobId).all()[0];
    if (pendingRow === undefined) return;

    const event = JSON.parse(pendingRow.payload) as WorkflowEvent;

    try {
      this.#db
        .update(jobs)
        .set({ state: "provisioning", updatedAt: Date.now() })
        .where(eq(jobs.workflowJobId, pendingRow.workflowJobId))
        .run();

      const jitConfig = await generateJitConfig({
        appId: this.env.GITHUB_APP_ID,
        privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        repositoryOwner: event.repositoryOwner,
        repositoryName: event.repositoryName,
        runnerName: pendingRow.runnerName,
      });

      const container = this.env.RUNNER_CONTAINERS.getByName(
        pendingRow.containerName,
      ) as DurableObjectStub<RunnerContainer>;
      await container.startAttempt(jitConfig);

      this.#db
        .update(jobs)
        .set({ state: "waiting_for_assignment", updatedAt: Date.now() })
        .where(eq(jobs.workflowJobId, pendingRow.workflowJobId))
        .run();

      this.#db
        .update(attempts)
        .set({ state: "starting" })
        .where(eq(attempts.workflowJobId, pendingRow.workflowJobId))
        .run();

      this.#db.delete(pending).where(eq(pending.workflowJobId, pendingRow.workflowJobId)).run();
    } catch (error) {
      this.#db
        .update(jobs)
        .set({ state: "failed", updatedAt: Date.now() })
        .where(eq(jobs.workflowJobId, pendingRow.workflowJobId))
        .run();

      this.#db
        .update(attempts)
        .set({ state: "failed" })
        .where(eq(attempts.workflowJobId, pendingRow.workflowJobId))
        .run();

      this.#db.delete(pending).where(eq(pending.workflowJobId, pendingRow.workflowJobId)).run();

      console.error(
        JSON.stringify({
          event: "runner_provisioning_failed",
          workflowJobId: pendingRow.workflowJobId,
          runnerName: pendingRow.runnerName,
          containerName: pendingRow.containerName,
          outcome: error instanceof Error ? "classified_error" : "unknown_error",
        }),
      );
    }

    const remaining = this.#db
      .select({ count: sql<number>`count(*)` })
      .from(pending)
      .all()[0];
    if (remaining !== undefined && remaining.count > 0)
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }
}
