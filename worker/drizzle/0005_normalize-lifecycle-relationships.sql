CREATE TABLE `__new_attempts` (
	`workflow_job_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`state` text NOT NULL,
	`installation_id` integer,
	`repository_owner` text,
	`repository_name` text,
	`runner_name` text NOT NULL,
	`container_name` text NOT NULL,
	`assignment_deadline` integer NOT NULL,
	`runtime_deadline` integer,
	PRIMARY KEY(`workflow_job_id`, `attempt`),
	FOREIGN KEY (`workflow_job_id`) REFERENCES `jobs`(`workflow_job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_attempts`("workflow_job_id", "attempt", "state", "installation_id", "repository_owner", "repository_name", "runner_name", "container_name", "assignment_deadline", "runtime_deadline") SELECT "workflow_job_id", "attempt", "state", "installation_id", "repository_owner", "repository_name", "runner_name", "container_name", "assignment_deadline", "runtime_deadline" FROM `attempts`;--> statement-breakpoint
DROP TABLE `attempts`;--> statement-breakpoint
ALTER TABLE `__new_attempts` RENAME TO `attempts`;--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_runner_name_unique` ON `attempts` (`runner_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_container_name_unique` ON `attempts` (`container_name`);--> statement-breakpoint
CREATE INDEX `attempts_state_assignment_deadline_idx` ON `attempts` (`state`,`assignment_deadline`);--> statement-breakpoint
CREATE INDEX `attempts_state_runtime_deadline_idx` ON `attempts` (`state`,`runtime_deadline`);--> statement-breakpoint
CREATE TABLE `__new_assignments` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`triggering_workflow_job_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`assigned_at` integer NOT NULL,
	FOREIGN KEY (`workflow_job_id`) REFERENCES `jobs`(`workflow_job_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`triggering_workflow_job_id`,`attempt`) REFERENCES `attempts`(`workflow_job_id`,`attempt`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_assignments`("workflow_job_id", "triggering_workflow_job_id", "attempt", "assigned_at") SELECT "workflow_job_id", "triggering_workflow_job_id", "attempt", "assigned_at" FROM `assignments`;--> statement-breakpoint
DROP TABLE `assignments`;--> statement-breakpoint
ALTER TABLE `__new_assignments` RENAME TO `assignments`;--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_attempt_unique` ON `assignments` (`triggering_workflow_job_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `__new_pending` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`attempt` integer NOT NULL,
	`delivery_id` text,
	FOREIGN KEY (`workflow_job_id`,`attempt`) REFERENCES `attempts`(`workflow_job_id`,`attempt`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_pending`("workflow_job_id", "attempt", "delivery_id")
SELECT p."workflow_job_id", a."attempt", p."delivery_id"
FROM `pending` p
INNER JOIN `attempts` a ON a."runner_name" = p."runner_name";--> statement-breakpoint
DROP TABLE `pending`;--> statement-breakpoint
ALTER TABLE `__new_pending` RENAME TO `pending`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `runner_name`;
