import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const deliveries = sqliteTable("deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  workflowJobId: integer("workflow_job_id").notNull(),
  receivedAt: integer("received_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  workflowJobId: integer("workflow_job_id").primaryKey(),
  state: text("state").notNull(),
  repositoryId: integer("repository_id").notNull(),
  runnerName: text("runner_name"),
  conclusion: text("conclusion"),
  updatedAt: integer("updated_at").notNull(),
});

export const attempts = sqliteTable("attempts", {
  workflowJobId: integer("workflow_job_id").notNull(),
  attempt: integer("attempt").notNull(),
  state: text("state").notNull(),
  runnerName: text("runner_name").notNull().unique(),
  containerName: text("container_name").notNull().unique(),
  assignmentDeadline: integer("assignment_deadline").notNull(),
  runtimeDeadline: integer("runtime_deadline"),
});

export const pending = sqliteTable("pending", {
  workflowJobId: integer("workflow_job_id").primaryKey(),
  payload: text("payload").notNull(),
  runnerName: text("runner_name").notNull(),
  containerName: text("container_name").notNull(),
});

export const schema = sql`
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
`;
