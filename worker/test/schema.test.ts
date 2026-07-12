import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler";

describe("Scheduler persistence constraints", () => {
  it("rejects a Runner Attempt whose Job does not exist", async () => {
    const scheduler = env.SCHEDULER.getByName("schema-fk-attempt");
    await runInDurableObject(scheduler, (_instance: Scheduler, state) => {
      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO attempts
             (workflow_job_id, attempt, state, runner_name, container_name, assignment_deadline)
           VALUES (999999, 1, 'created', 'orphan-runner', 'orphan-container', 0)`,
        ),
      ).toThrowError(/FOREIGN KEY/i);
    });
  });

  it("rejects an Assignment that does not reference a Runner Attempt", async () => {
    const scheduler = env.SCHEDULER.getByName("schema-fk-assignment");
    await runInDurableObject(scheduler, (_instance: Scheduler, state) => {
      state.storage.sql.exec(
        "INSERT INTO jobs (workflow_job_id, state, repository_id, updated_at) VALUES (1, 'running', 2, 0)",
      );
      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO assignments
             (workflow_job_id, triggering_workflow_job_id, attempt, assigned_at)
           VALUES (1, 1, 1, 0)`,
        ),
      ).toThrowError(/FOREIGN KEY/i);
    });
  });

  it("rejects a second Assignment for one Runner Attempt", async () => {
    const scheduler = env.SCHEDULER.getByName("schema-fk-attempt-reuse");
    await runInDurableObject(scheduler, (_instance: Scheduler, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs (workflow_job_id, state, repository_id, updated_at)
         VALUES (1, 'running', 2, 0), (2, 'running', 2, 0), (3, 'queued', 2, 0)`,
      );
      state.storage.sql.exec(
        `INSERT INTO attempts
           (workflow_job_id, attempt, state, runner_name, container_name, assignment_deadline)
         VALUES (3, 1, 'running', 'runner-1', 'container-1', 0)`,
      );
      state.storage.sql.exec(
        "INSERT INTO assignments (workflow_job_id, triggering_workflow_job_id, attempt, assigned_at) VALUES (1, 3, 1, 0)",
      );
      expect(() =>
        state.storage.sql.exec(
          "INSERT INTO assignments (workflow_job_id, triggering_workflow_job_id, attempt, assigned_at) VALUES (2, 3, 1, 0)",
        ),
      ).toThrowError(/UNIQUE/i);
    });
  });
});
