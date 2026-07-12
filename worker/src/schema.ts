import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const attempts = sqliteTable(
  "attempts",
  {
    workflowJobId: integer("workflow_job_id").notNull(),
    attempt: integer("attempt").notNull(),
    state: text("state").notNull(),
    runnerName: text("runner_name").notNull().unique(),
    containerName: text("container_name").notNull().unique(),
    assignmentDeadline: integer("assignment_deadline").notNull(),
    runtimeDeadline: integer("runtime_deadline"),
  },
  (table) => [primaryKey({ columns: [table.workflowJobId, table.attempt] })],
);

export const assignments = sqliteTable("assignments", {
  workflowJobId: integer("workflow_job_id").primaryKey(),
  triggeringWorkflowJobId: integer("triggering_workflow_job_id").notNull(),
  attempt: integer("attempt").notNull(),
  runnerName: text("runner_name").notNull().unique(),
  containerName: text("container_name").notNull(),
  assignedAt: integer("assigned_at").notNull(),
});

export const pending = sqliteTable("pending", {
  workflowJobId: integer("workflow_job_id").primaryKey(),
  deliveryId: text("delivery_id").notNull(),
  installationId: integer("installation_id").notNull(),
  repositoryId: integer("repository_id").notNull(),
  repositoryOwner: text("repository_owner").notNull(),
  repositoryName: text("repository_name").notNull(),
  runnerName: text("runner_name").notNull(),
  containerName: text("container_name").notNull(),
});
