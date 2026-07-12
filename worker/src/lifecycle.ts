import { and, desc, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { Either, Effect } from "effect";
import { assignments, attempts, deliveries, jobs, pending } from "./schema";
import { isAdmissible, type QueuedJobCandidate, type WorkflowEvent } from "./domain";
import type { Provision, ProvisionRequest, Reclaim } from "./provisioning";
import { ProvisioningError } from "./github";
import { emit } from "./log";

const maxPendingJobs = 10;
const maxActiveAttempts = 25;
const assignmentTimeout = 5 * 60_000;
const defaultRuntimeTimeout = 60 * 60_000;
const viableAttemptStates = ["created", "starting", "waiting_for_assignment"];
const activeAttemptStates = [...viableAttemptStates, "running"];
const terminalJobStates = ["completed", "cancelled", "failed"];

export type AcceptResult = {
  outcome:
    | "accepted"
    | "recorded"
    | "duplicate"
    | "capacity_limited"
    | "ignored"
    | "unknown_assignment"
    | "conflicting_assignment";
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

export type AssignmentSnapshot = typeof assignments.$inferSelect & {
  runnerName: string;
  containerName: string;
};

type TransitionInput = QueuedJobCandidate & {
  action: string;
  deliveryId?: string | undefined;
  runnerName?: string | undefined;
  conclusion?: string | undefined;
};

export class SchedulerLifecycle {
  #db: DrizzleSqliteDODatabase<SchedulerSchema>;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deploymentId?: string,
    private readonly runtimeTimeout = defaultRuntimeTimeout,
  ) {
    this.#db = drizzle(storage, { schema: { deliveries, jobs, attempts, assignments, pending } });
  }

  async accept(event: WorkflowEvent): Promise<AcceptResult> {
    const now = Date.now();
    const result = this.storage.transactionSync(() => {
      if (!this.#recordDelivery(event, now)) return { outcome: "duplicate" } as const;

      const job = this.#db
        .select()
        .from(jobs)
        .where(eq(jobs.workflowJobId, event.workflowJobId))
        .all()[0];
      if (job !== undefined && terminalJobStates.includes(job.state)) {
        const runnerName = this.getAssignment(event.workflowJobId)?.runnerName;
        return { outcome: "duplicate" as const, ...(runnerName && { runnerName }) };
      }
      if (event.action === "queued" && job?.state === "running") {
        const runnerName = this.getAssignment(event.workflowJobId)?.runnerName;
        return { outcome: "duplicate" as const, ...(runnerName && { runnerName }) };
      }
      if (event.action === "queued") return this.#acceptQueued(event, event.deliveryId, now);
      if (event.action === "in_progress" && event.runnerName !== undefined) {
        return this.#recordAssignment(event, event.runnerName, now);
      }
      if (event.action === "completed") this.#recordCompletion(event, now);
      return { outcome: "recorded" } as const;
    });

    this.#emitTransition(event, result);
    if (event.action === "queued" && result.outcome === "accepted") {
      await this.storage.setAlarm(now + 1_000);
    }
    if (event.action === "in_progress" && result.outcome === "recorded") {
      const deadline = now + this.runtimeTimeout;
      const alarm = await this.storage.getAlarm();
      if (alarm === null || alarm > deadline) await this.storage.setAlarm(deadline);
    }
    return result;
  }

  async reconcile(candidate: QueuedJobCandidate): Promise<AcceptResult> {
    const now = Date.now();
    const result = this.storage.transactionSync(() =>
      isAdmissible(candidate.repositoryPrivate, candidate.labels)
        ? this.#acceptQueued(candidate, null, now)
        : { outcome: "ignored" as const },
    );
    this.#emitTransition({ ...candidate, action: "queued" }, result);
    if (result.outcome === "accepted") await this.storage.setAlarm(now + 1_000);
    return result;
  }

  #emitTransition(event: TransitionInput, result: AcceptResult): void {
    const {
      deliveryId,
      installationId,
      repositoryId,
      workflowJobId,
      runnerName: assignedRunnerName,
      action,
      conclusion,
    } = event;
    const { outcome } = result;
    const runnerName = result.runnerName ?? assignedRunnerName;
    const attempt =
      runnerName === undefined
        ? undefined
        : this.#db.select().from(attempts).where(eq(attempts.runnerName, runnerName)).all()[0];
    const job = this.#db
      .select({ state: jobs.state })
      .from(jobs)
      .where(eq(jobs.workflowJobId, workflowJobId))
      .all()[0];

    emit({
      event: "scheduler_transition",
      deliveryId,
      deploymentId: this.deploymentId,
      installationId,
      repositoryId,
      workflowJobId,
      attempt: attempt?.attempt,
      runnerName,
      containerName: attempt?.containerName,
      action,
      outcome,
      state: job?.state,
      conclusion,
    });
  }

  #recordDelivery(event: WorkflowEvent, now: number): boolean {
    const { deliveryId, workflowJobId } = event;
    const inserted = this.#db
      .insert(deliveries)
      .values({ deliveryId, workflowJobId, receivedAt: now })
      .onConflictDoNothing()
      .returning({ deliveryId: deliveries.deliveryId })
      .all();
    return inserted.length === 1;
  }

  #acceptQueued(event: QueuedJobCandidate, deliveryId: string | null, now: number): AcceptResult {
    const viableAttempt = this.#db
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
    if (!this.#hasCapacity()) {
      this.#recordCapacityLimit(event, now);
      return { outcome: "capacity_limited" };
    }

    const runnerName = this.#createAttempt(event, deliveryId, now);
    return { outcome: "accepted", runnerName };
  }

  #hasCapacity(): boolean {
    const pendingCount =
      this.#db
        .select({ count: sql<number>`count(*)` })
        .from(pending)
        .all()[0]?.count ?? 0;
    const activeCount =
      this.#db
        .select({ count: sql<number>`count(*)` })
        .from(attempts)
        .where(inArray(attempts.state, activeAttemptStates))
        .all()[0]?.count ?? 0;
    return pendingCount < maxPendingJobs && activeCount < maxActiveAttempts;
  }

  #recordCapacityLimit(event: QueuedJobCandidate, now: number): void {
    const { workflowJobId, repositoryId } = event;
    this.#db
      .insert(jobs)
      .values({ workflowJobId, state: "capacity_limited", repositoryId, updatedAt: now })
      .onConflictDoUpdate({
        target: jobs.workflowJobId,
        set: { state: "capacity_limited", updatedAt: now },
      })
      .run();
  }

  #createAttempt(event: QueuedJobCandidate, deliveryId: string | null, now: number): string {
    const { installationId, repositoryId, repositoryOwner, repositoryName, workflowJobId } = event;
    const previousAttempt = this.#db
      .select({ attempt: attempts.attempt })
      .from(attempts)
      .where(eq(attempts.workflowJobId, workflowJobId))
      .orderBy(desc(attempts.attempt))
      .all()[0];
    const attempt = (previousAttempt?.attempt ?? 0) + 1;
    const runnerName = `jitney-${repositoryId}-${workflowJobId}-${attempt}`;
    const containerName = `attempt-${repositoryId}-${workflowJobId}-${attempt}`;

    this.#db
      .insert(jobs)
      .values({ workflowJobId, state: "queued", repositoryId, updatedAt: now })
      .onConflictDoUpdate({ target: jobs.workflowJobId, set: { state: "queued", updatedAt: now } })
      .run();
    this.#db
      .insert(attempts)
      .values({
        workflowJobId,
        attempt,
        state: "created",
        installationId,
        repositoryOwner,
        repositoryName,
        runnerName,
        containerName,
        assignmentDeadline: now + assignmentTimeout,
        runtimeDeadline: null,
      })
      .run();
    const intent = { attempt, deliveryId };
    this.#db
      .insert(pending)
      .values({ workflowJobId, ...intent })
      .onConflictDoUpdate({ target: pending.workflowJobId, set: intent })
      .run();
    return runnerName;
  }

  #recordAssignment(event: WorkflowEvent, runnerName: string, now: number): AcceptResult {
    const { workflowJobId, repositoryId } = event;
    const attempt = this.#db
      .select()
      .from(attempts)
      .where(eq(attempts.runnerName, runnerName))
      .all()[0];
    if (attempt === undefined) return { outcome: "unknown_assignment", runnerName };
    const { workflowJobId: triggeringWorkflowJobId, attempt: attemptNumber } = attempt;

    const jobAssignment = this.#db
      .select()
      .from(assignments)
      .where(eq(assignments.workflowJobId, workflowJobId))
      .all()[0];
    const attemptAssignment = this.#db
      .select()
      .from(assignments)
      .where(
        and(
          eq(assignments.triggeringWorkflowJobId, triggeringWorkflowJobId),
          eq(assignments.attempt, attemptNumber),
        ),
      )
      .all()[0];
    if (
      jobAssignment?.triggeringWorkflowJobId === triggeringWorkflowJobId &&
      jobAssignment.attempt === attemptNumber &&
      attemptAssignment?.workflowJobId === workflowJobId
    ) {
      return { outcome: "duplicate", runnerName };
    }
    if (jobAssignment !== undefined || attemptAssignment !== undefined) {
      return { outcome: "conflicting_assignment", runnerName };
    }

    this.#db
      .insert(jobs)
      .values({ workflowJobId, state: "running", repositoryId, updatedAt: now })
      .onConflictDoUpdate({
        target: jobs.workflowJobId,
        set: { state: "running", repositoryId, updatedAt: now },
      })
      .run();
    this.#db
      .insert(assignments)
      .values({
        workflowJobId,
        triggeringWorkflowJobId,
        attempt: attemptNumber,
        assignedAt: now,
      })
      .run();
    this.#db
      .update(attempts)
      .set({ state: "running", runtimeDeadline: now + this.runtimeTimeout })
      .where(eq(attempts.runnerName, runnerName))
      .run();
    this.#db
      .delete(pending)
      .where(inArray(pending.workflowJobId, [workflowJobId, triggeringWorkflowJobId]))
      .run();
    this.#db
      .update(attempts)
      .set({ state: "stopped" })
      .where(
        and(
          eq(attempts.workflowJobId, workflowJobId),
          inArray(attempts.state, viableAttemptStates),
          ne(attempts.runnerName, runnerName),
        ),
      )
      .run();
    if (triggeringWorkflowJobId !== workflowJobId) {
      this.#db
        .update(jobs)
        .set({ state: "queued", updatedAt: now })
        .where(eq(jobs.workflowJobId, triggeringWorkflowJobId))
        .run();
    }
    return { outcome: "recorded", runnerName };
  }

  #recordCompletion(event: WorkflowEvent, now: number): void {
    const { workflowJobId, conclusion } = event;
    const state =
      conclusion === "cancelled" ? "cancelled" : conclusion === "success" ? "completed" : "failed";
    this.#db
      .update(jobs)
      .set({ state, conclusion: conclusion ?? "unknown", updatedAt: now })
      .where(eq(jobs.workflowJobId, workflowJobId))
      .run();

    const assignment = this.getAssignment(workflowJobId);
    if (assignment !== undefined) {
      this.#db
        .update(attempts)
        .set({ state: "stopped" })
        .where(eq(attempts.runnerName, assignment.runnerName))
        .run();
    }
    this.#db.delete(pending).where(eq(pending.workflowJobId, workflowJobId)).run();
  }

  getJob(workflowJobId: number): JobSnapshot | undefined {
    const row = this.#db.select().from(jobs).where(eq(jobs.workflowJobId, workflowJobId)).all()[0];
    if (row === undefined) return undefined;
    const pendingRow = this.#db
      .select({ workflowJobId: pending.workflowJobId })
      .from(pending)
      .where(eq(pending.workflowJobId, workflowJobId))
      .all()[0];
    const runnerName = this.getAssignment(workflowJobId)?.runnerName;
    const { state, repositoryId } = row;
    return {
      workflowJobId,
      state,
      repositoryId,
      pending: pendingRow !== undefined,
      ...(runnerName && { runnerName }),
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

  getAssignment(workflowJobId: number): AssignmentSnapshot | undefined {
    return this.#db
      .select({
        ...getTableColumns(assignments),
        runnerName: attempts.runnerName,
        containerName: attempts.containerName,
      })
      .from(assignments)
      .innerJoin(
        attempts,
        and(
          eq(attempts.workflowJobId, assignments.triggeringWorkflowJobId),
          eq(attempts.attempt, assignments.attempt),
        ),
      )
      .where(eq(assignments.workflowJobId, workflowJobId))
      .all()[0];
  }

  async sweep(provision: Provision, reclaim: Reclaim, now = Date.now()): Promise<void> {
    const morePending = await drainPending(this.#db, this.storage, provision, this.deploymentId);
    await this.#expireUnassignedAttempts(reclaim, now);
    await this.#expireRunningAttempts(reclaim, now);

    const wakeAt = morePending ? now + 1_000 : this.#nextDeadline();
    if (wakeAt !== undefined) {
      await this.storage.setAlarm(Math.max(wakeAt, now + 1_000));
    }
  }

  #nextDeadline(): number | undefined {
    const assignment = this.#db
      .select({ deadline: sql<number | null>`min(${attempts.assignmentDeadline})` })
      .from(attempts)
      .where(inArray(attempts.state, viableAttemptStates))
      .all()[0]?.deadline;
    const runtime = this.#db
      .select({ deadline: sql<number | null>`min(${attempts.runtimeDeadline})` })
      .from(attempts)
      .where(eq(attempts.state, "running"))
      .all()[0]?.deadline;
    const deadlines = [assignment, runtime].filter((value) => value != null);
    return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
  }

  async #expireUnassignedAttempts(reclaim: Reclaim, now: number): Promise<void> {
    const expired = this.#expiredAttempts(
      and(
        inArray(attempts.state, viableAttemptStates),
        sql`${attempts.assignmentDeadline} <= ${now}`,
      ),
    );

    for (const row of expired) {
      const { workflowJobId, runnerName } = row;
      this.storage.transactionSync(() => {
        this.#db
          .update(attempts)
          .set({ state: "expired" })
          .where(eq(attempts.runnerName, runnerName))
          .run();
        this.#db.delete(pending).where(eq(pending.workflowJobId, workflowJobId)).run();
        this.#db
          .update(jobs)
          .set({ state: "queued", updatedAt: now })
          .where(
            and(
              eq(jobs.workflowJobId, workflowJobId),
              inArray(jobs.state, ["queued", "provisioning", "waiting_for_assignment"]),
            ),
          )
          .run();
      });
      await this.#reclaimExpired(reclaim, row, "assignment_deadline");
    }
  }

  async #expireRunningAttempts(reclaim: Reclaim, now: number): Promise<void> {
    const expired = this.#expiredAttempts(
      and(eq(attempts.state, "running"), sql`${attempts.runtimeDeadline} <= ${now}`),
    );

    for (const row of expired) {
      const { runnerName } = row;
      const assignment = this.#db
        .select()
        .from(assignments)
        .where(
          and(
            eq(assignments.triggeringWorkflowJobId, row.workflowJobId),
            eq(assignments.attempt, row.attempt),
          ),
        )
        .all()[0];
      const assignedJobId = assignment?.workflowJobId ?? row.workflowJobId;
      this.storage.transactionSync(() => {
        this.#db
          .update(attempts)
          .set({ state: "expired" })
          .where(eq(attempts.runnerName, runnerName))
          .run();
        this.#db
          .update(jobs)
          .set({ state: "failed", conclusion: "timed_out", updatedAt: now })
          .where(eq(jobs.workflowJobId, assignedJobId))
          .run();
        this.#db.delete(pending).where(eq(pending.workflowJobId, assignedJobId)).run();
      });
      await this.#reclaimExpired(reclaim, row, "runtime_deadline");
    }
  }

  #expiredAttempts(condition: ReturnType<typeof and>): ExpiredAttempt[] {
    return this.#db
      .select({ ...getTableColumns(attempts), repositoryId: jobs.repositoryId })
      .from(attempts)
      .innerJoin(jobs, eq(jobs.workflowJobId, attempts.workflowJobId))
      .where(condition)
      .all();
  }

  async #reclaimExpired(reclaim: Reclaim, row: ExpiredAttempt, stopReason: string): Promise<void> {
    const { workflowJobId, attempt, runnerName, containerName, repositoryId } = row;
    const correlation = {
      installationId: row.installationId ?? 0,
      repositoryId,
      workflowJobId,
      runnerName,
      containerName,
      deploymentId: this.deploymentId,
    };
    emit({ event: "runner_attempt_expired", ...correlation, attempt, stopReason });

    if (
      row.installationId === null ||
      row.repositoryOwner === null ||
      row.repositoryName === null
    ) {
      return;
    }
    const result = await Effect.runPromise(
      reclaim({
        installationId: row.installationId,
        repositoryId,
        repositoryOwner: row.repositoryOwner,
        repositoryName: row.repositoryName,
        workflowJobId,
        runnerName,
        containerName,
      }).pipe(Effect.either),
    );
    if (Either.isLeft(result)) {
      emit({ event: "runner_reclaim_failed", ...correlation, step: result.left.step });
    }
  }
}

type ExpiredAttempt = typeof attempts.$inferSelect & { repositoryId: number };

type SchedulerSchema = {
  deliveries: typeof deliveries;
  jobs: typeof jobs;
  attempts: typeof attempts;
  assignments: typeof assignments;
  pending: typeof pending;
};

type PendingRow = ProvisionRequest & {
  attempt: number;
  deliveryId: string | null;
};

async function drainPending(
  db: DrizzleSqliteDODatabase<SchedulerSchema>,
  storage: DurableObjectStorage,
  provision: Provision,
  deploymentId?: string,
): Promise<boolean> {
  const row = db
    .select({
      ...getTableColumns(pending),
      installationId: attempts.installationId,
      repositoryId: jobs.repositoryId,
      repositoryOwner: attempts.repositoryOwner,
      repositoryName: attempts.repositoryName,
      runnerName: attempts.runnerName,
      containerName: attempts.containerName,
    })
    .from(pending)
    .innerJoin(
      attempts,
      and(eq(attempts.workflowJobId, pending.workflowJobId), eq(attempts.attempt, pending.attempt)),
    )
    .innerJoin(jobs, eq(jobs.workflowJobId, pending.workflowJobId))
    .orderBy(pending.workflowJobId)
    .all()[0];
  if (row === undefined) return false;
  if (row.installationId === null || row.repositoryOwner === null || row.repositoryName === null) {
    storage.transactionSync(() => {
      db.update(attempts)
        .set({ state: "failed" })
        .where(
          and(eq(attempts.workflowJobId, row.workflowJobId), eq(attempts.attempt, row.attempt)),
        )
        .run();
      db.update(jobs)
        .set({ state: "queued", updatedAt: Date.now() })
        .where(eq(jobs.workflowJobId, row.workflowJobId))
        .run();
      db.delete(pending).where(eq(pending.workflowJobId, row.workflowJobId)).run();
    });
    return true;
  }

  const pendingRow: PendingRow = {
    ...row,
    installationId: row.installationId,
    repositoryOwner: row.repositoryOwner,
    repositoryName: row.repositoryName,
  };
  const {
    deliveryId,
    installationId,
    repositoryId,
    repositoryOwner,
    repositoryName,
    workflowJobId,
    runnerName,
    containerName,
  } = pendingRow;
  const correlation = {
    ...(deliveryId && { deliveryId }),
    deploymentId,
    installationId,
    repositoryId,
    workflowJobId,
    runnerName,
    containerName,
  };

  emit({ event: "runner_provisioning_started", ...correlation });
  storage.transactionSync(() => {
    db.update(jobs)
      .set({ state: "provisioning", updatedAt: Date.now() })
      .where(eq(jobs.workflowJobId, workflowJobId))
      .run();
    db.update(attempts)
      .set({ state: "starting" })
      .where(
        and(eq(attempts.workflowJobId, workflowJobId), eq(attempts.attempt, pendingRow.attempt)),
      )
      .run();
  });

  const result = await Effect.runPromise(
    provision({
      installationId,
      repositoryId,
      repositoryOwner,
      repositoryName,
      workflowJobId,
      runnerName,
      containerName,
    }).pipe(Effect.either),
  );

  storage.transactionSync(() => {
    if (Either.isRight(result)) {
      finishProvisioning(db, pendingRow);
    } else {
      failProvisioning(db, pendingRow, result.left, deploymentId);
    }
    db.delete(pending).where(eq(pending.workflowJobId, workflowJobId)).run();
  });
  if (Either.isRight(result)) emit({ event: "runner_provisioning_succeeded", ...correlation });
  const remaining = db
    .select({ count: sql<number>`count(*)` })
    .from(pending)
    .all()[0];
  return remaining !== undefined && remaining.count > 0;
}

function finishProvisioning(
  db: DrizzleSqliteDODatabase<SchedulerSchema>,
  pendingRow: PendingRow,
): void {
  const { workflowJobId, runnerName } = pendingRow;
  db.update(jobs)
    .set({ state: "waiting_for_assignment", updatedAt: Date.now() })
    .where(eq(jobs.workflowJobId, workflowJobId))
    .run();
  db.update(attempts)
    .set({ state: "waiting_for_assignment" })
    .where(and(eq(attempts.workflowJobId, workflowJobId), eq(attempts.runnerName, runnerName)))
    .run();
}

function failProvisioning(
  db: DrizzleSqliteDODatabase<SchedulerSchema>,
  pendingRow: PendingRow,
  error: Effect.Effect.Error<ReturnType<Provision>>,
  deploymentId?: string,
): void {
  const { deliveryId, installationId, repositoryId, workflowJobId, runnerName, containerName } =
    pendingRow;
  db.update(jobs)
    .set({ state: "queued", updatedAt: Date.now() })
    .where(eq(jobs.workflowJobId, workflowJobId))
    .run();
  db.update(attempts)
    .set({ state: "failed" })
    .where(and(eq(attempts.workflowJobId, workflowJobId), eq(attempts.runnerName, runnerName)))
    .run();
  emit({
    event: "runner_provisioning_failed",
    ...(deliveryId && { deliveryId }),
    deploymentId,
    installationId,
    repositoryId,
    workflowJobId,
    runnerName,
    containerName,
    step: error instanceof ProvisioningError ? error.step : "installation_mismatch",
  });
}
