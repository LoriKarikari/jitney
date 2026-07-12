import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const deliveries = sqliteTable("deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  workflowJobId: integer("workflow_job_id").notNull(),
  receivedAt: integer("received_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  workflowJobId: integer("workflow_job_id").primaryKey(),
  state: text("state").notNull(),
  repositoryId: integer("repository_id").notNull(),
  conclusion: text("conclusion"),
  updatedAt: integer("updated_at").notNull(),
});

export const attempts = sqliteTable(
  "attempts",
  {
    workflowJobId: integer("workflow_job_id")
      .notNull()
      .references(() => jobs.workflowJobId, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    state: text("state").notNull(),
    installationId: integer("installation_id").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    runnerName: text("runner_name").notNull().unique(),
    containerName: text("container_name").notNull().unique(),
    assignmentDeadline: integer("assignment_deadline").notNull(),
    runtimeDeadline: integer("runtime_deadline"),
  },
  (table) => [
    primaryKey({ columns: [table.workflowJobId, table.attempt] }),
    index("attempts_state_assignment_deadline_idx").on(table.state, table.assignmentDeadline),
    index("attempts_state_runtime_deadline_idx").on(table.state, table.runtimeDeadline),
  ],
);

export const assignments = sqliteTable(
  "assignments",
  {
    workflowJobId: integer("workflow_job_id")
      .primaryKey()
      .references(() => jobs.workflowJobId, { onDelete: "cascade" }),
    triggeringWorkflowJobId: integer("triggering_workflow_job_id").notNull(),
    attempt: integer("attempt").notNull(),
    assignedAt: integer("assigned_at").notNull(),
  },
  (table) => [
    unique("assignments_attempt_unique").on(table.triggeringWorkflowJobId, table.attempt),
    foreignKey({
      columns: [table.triggeringWorkflowJobId, table.attempt],
      foreignColumns: [attempts.workflowJobId, attempts.attempt],
    }).onDelete("cascade"),
  ],
);

export const pending = sqliteTable(
  "pending",
  {
    workflowJobId: integer("workflow_job_id").primaryKey(),
    attempt: integer("attempt").notNull(),
    deliveryId: text("delivery_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.workflowJobId, table.attempt],
      foreignColumns: [attempts.workflowJobId, attempts.attempt],
    }).onDelete("cascade"),
  ],
);
