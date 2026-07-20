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

export class Scheduler extends DurableObject<Env> {
  #lifecycle: SchedulerLifecycle;

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
    });
  }

  accept(event: WorkflowEvent): Promise<AcceptResult> {
    return Effect.runPromise(this.#lifecycle.accept(event));
  }

  reconcile(candidate: QueuedJobCandidate): Promise<AcceptResult> {
    return Effect.runPromise(this.#lifecycle.reconcile(candidate));
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
