import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import migrations from "../drizzle/migrations";
import type { QueuedJobCandidate, WorkflowEvent } from "./domain";
import {
  SchedulerLifecycle,
  type AcceptResult,
  type AssignmentSnapshot,
  type AttemptSnapshot,
  type JobSnapshot,
} from "./lifecycle";
import { createRunnerAttemptOperations } from "./runner-attempt-operations";
import { assignments, attempts, deliveries, jobs, pending } from "./schema";

export type { AcceptResult, AssignmentSnapshot, AttemptSnapshot, JobSnapshot } from "./lifecycle";

const intakeSuspendedKey = "jitney:intake-suspended";

export class Scheduler extends DurableObject<Env> {
  #lifecycle: SchedulerLifecycle;
  #intakeSuspended = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = drizzle(ctx.storage, {
      schema: { deliveries, jobs, attempts, assignments, pending },
    });
    this.#lifecycle = new SchedulerLifecycle(
      ctx.storage,
      env.CF_VERSION_METADATA.id,
      Number(env.RUNTIME_TIMEOUT_MS) || undefined,
      Number(env.SCHEDULER_TICK_MS) || undefined,
    );
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
      this.#intakeSuspended = (await ctx.storage.get<boolean>(intakeSuspendedKey)) ?? false;
    });
  }

  accept(event: WorkflowEvent): Promise<AcceptResult> {
    return event.action === "queued" && this.#intakeSuspended
      ? Promise.resolve({ outcome: "ignored" })
      : Effect.runPromise(this.#lifecycle.accept(event));
  }

  reconcile(candidate: QueuedJobCandidate): Promise<AcceptResult> {
    return this.#intakeSuspended
      ? Promise.resolve({ outcome: "ignored" })
      : Effect.runPromise(this.#lifecycle.reconcile(candidate));
  }

  async suspendIntake(): Promise<void> {
    await this.ctx.storage.put(intakeSuspendedKey, true);
    this.#intakeSuspended = true;
  }

  async resumeIntake(): Promise<void> {
    await this.ctx.storage.delete(intakeSuspendedKey);
    this.#intakeSuspended = false;
  }

  activeAttemptCount(): number {
    return this.#lifecycle.activeAttemptCount();
  }

  getJob(workflowJobId: number): JobSnapshot | undefined {
    return this.#lifecycle.getJob(workflowJobId);
  }

  getAttempts(workflowJobId: number): AttemptSnapshot[] {
    return this.#lifecycle.getAttempts(workflowJobId);
  }

  getAssignment(workflowJobId: number): AssignmentSnapshot | undefined {
    return this.#lifecycle.getAssignment(workflowJobId);
  }

  override alarm(): Promise<void> {
    return Effect.runPromise(this.#lifecycle.sweep(createRunnerAttemptOperations(this.env)));
  }
}
