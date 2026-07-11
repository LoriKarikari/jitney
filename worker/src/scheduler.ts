import { DurableObject } from "cloudflare:workers";
import type { WorkflowEvent } from "./domain";
import { generateJitConfig } from "./github";
import type { RunnerContainer } from "./runner-container";

export interface AcceptResult {
  outcome: "accepted" | "recorded";
  runnerName?: string;
}

export interface JobSnapshot {
  workflowJobId: number;
  state: string;
  repositoryId: number;
  runnerName?: string;
  pending: boolean;
}

type PendingRow = Record<string, SqlStorageValue> & {
  workflow_job_id: number;
  payload: string;
  runner_name: string;
  container_name: string;
};

export class Scheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id TEXT PRIMARY KEY,
          workflow_job_id INTEGER NOT NULL,
          received_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          workflow_job_id INTEGER PRIMARY KEY,
          state TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          runner_name TEXT,
          conclusion TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attempts (
          workflow_job_id INTEGER NOT NULL,
          attempt INTEGER NOT NULL,
          state TEXT NOT NULL,
          runner_name TEXT NOT NULL UNIQUE,
          container_name TEXT NOT NULL UNIQUE,
          assignment_deadline INTEGER NOT NULL,
          runtime_deadline INTEGER,
          PRIMARY KEY (workflow_job_id, attempt)
        );
        CREATE TABLE IF NOT EXISTS pending (
          workflow_job_id INTEGER PRIMARY KEY,
          payload TEXT NOT NULL,
          runner_name TEXT NOT NULL,
          container_name TEXT NOT NULL
        );
      `);
    });
  }

  async accept(event: WorkflowEvent): Promise<AcceptResult> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO deliveries (delivery_id, workflow_job_id, received_at) VALUES (?, ?, ?)",
      event.deliveryId,
      event.workflowJobId,
      now,
    );

    if (event.action === "queued") {
      const runnerName = `jitney-${event.repositoryId}-${event.workflowJobId}-1`;
      const containerName = `attempt-${event.repositoryId}-${event.workflowJobId}-1`;
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO jobs (workflow_job_id, state, repository_id, updated_at) VALUES (?, 'queued', ?, ?)",
        event.workflowJobId,
        event.repositoryId,
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO attempts (workflow_job_id, attempt, state, runner_name, container_name, assignment_deadline) VALUES (?, 1, 'created', ?, ?, ?)",
        event.workflowJobId,
        runnerName,
        containerName,
        now + 5 * 60_000,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO pending (workflow_job_id, payload, runner_name, container_name) VALUES (?, ?, ?, ?)",
        event.workflowJobId,
        JSON.stringify(event),
        runnerName,
        containerName,
      );
      await this.ctx.storage.setAlarm(now + 1_000);
      return { outcome: "accepted", runnerName };
    }

    if (event.action === "in_progress" && event.runnerName !== undefined) {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET state = 'running', runner_name = ?, updated_at = ? WHERE workflow_job_id = ?",
        event.runnerName,
        now,
        event.workflowJobId,
      );
      return { outcome: "recorded", runnerName: event.runnerName };
    }

    if (event.action === "completed") {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET state = 'completed', conclusion = ?, updated_at = ? WHERE workflow_job_id = ?",
        event.conclusion ?? "unknown",
        now,
        event.workflowJobId,
      );
    }
    return { outcome: "recorded" };
  }

  getJob(workflowJobId: number): JobSnapshot | undefined {
    const rows = this.ctx.storage.sql
      .exec<
        Record<string, SqlStorageValue> & {
          workflow_job_id: number;
          state: string;
          repository_id: number;
          runner_name: string | null;
          pending: number;
        }
      >(
        `SELECT j.workflow_job_id, j.state, j.repository_id, j.runner_name,
                EXISTS(SELECT 1 FROM pending p WHERE p.workflow_job_id = j.workflow_job_id) AS pending
           FROM jobs j WHERE j.workflow_job_id = ?`,
        workflowJobId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return undefined;
    const snapshot: JobSnapshot = {
      workflowJobId: row.workflow_job_id,
      state: row.state,
      repositoryId: row.repository_id,
      pending: row.pending === 1,
    };
    if (row.runner_name !== null) snapshot.runnerName = row.runner_name;
    return snapshot;
  }

  override async alarm(): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<PendingRow>(
        "SELECT workflow_job_id, payload, runner_name, container_name FROM pending ORDER BY workflow_job_id LIMIT 1",
      )
      .one();
    const event = JSON.parse(pending.payload) as WorkflowEvent;

    try {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET state = 'provisioning', updated_at = ? WHERE workflow_job_id = ?",
        Date.now(),
        pending.workflow_job_id,
      );
      const jitConfig = await generateJitConfig({
        appId: this.env.GITHUB_APP_ID,
        privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        repositoryOwner: event.repositoryOwner,
        repositoryName: event.repositoryName,
        runnerName: pending.runner_name,
      });
      const container = this.env.RUNNER_CONTAINERS.getByName(
        pending.container_name,
      ) as DurableObjectStub<RunnerContainer>;
      await container.startAttempt(jitConfig);
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET state = 'waiting_for_assignment', updated_at = ? WHERE workflow_job_id = ?",
        Date.now(),
        pending.workflow_job_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE attempts SET state = 'starting' WHERE workflow_job_id = ? AND attempt = 1",
        pending.workflow_job_id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM pending WHERE workflow_job_id = ?",
        pending.workflow_job_id,
      );
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET state = 'failed', updated_at = ? WHERE workflow_job_id = ?",
        Date.now(),
        pending.workflow_job_id,
      );
      console.error(
        JSON.stringify({
          event: "runner_provisioning_failed",
          workflowJobId: pending.workflow_job_id,
          runnerName: pending.runner_name,
          containerName: pending.container_name,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }

    const remaining = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending")
      .one();
    if (remaining.count > 0) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }
}
