import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { QueuedJobCandidate, WorkflowEvent } from "./domain";
import { SchedulerLifecycle, type AcceptResult } from "./lifecycle";
import { createRunnerAttemptOperations } from "./runner-attempt-operations";

const intakeSuspendedKey = "jitney:intake-suspended";

export class Scheduler extends DurableObject<Env> {
  #lifecycle: SchedulerLifecycle;
  #intakeSuspended = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#lifecycle = new SchedulerLifecycle(
      ctx.storage,
      env.CF_VERSION_METADATA.id,
      Number(env.RUNTIME_TIMEOUT_MS) || undefined,
      Number(env.SCHEDULER_TICK_MS) || undefined,
    );
    void ctx.blockConcurrencyWhile(async () => {
      await this.#lifecycle.migrate();
      this.#intakeSuspended = (await ctx.storage.get<boolean>(intakeSuspendedKey)) ?? false;
    });
  }

  accept(event: WorkflowEvent): Promise<AcceptResult> {
    return Effect.runPromise(
      event.action === "queued" && this.#intakeSuspended
        ? this.#lifecycle.defer(event)
        : this.#lifecycle.accept(event),
    );
  }

  reconcile(candidate: QueuedJobCandidate): Promise<AcceptResult> {
    return Effect.runPromise(
      this.#intakeSuspended
        ? this.#lifecycle.defer(candidate)
        : this.#lifecycle.reconcile(candidate),
    );
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

  override alarm(): Promise<void> {
    return Effect.runPromise(this.#lifecycle.sweep(createRunnerAttemptOperations(this.env)));
  }
}
