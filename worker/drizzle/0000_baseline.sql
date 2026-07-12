CREATE TABLE `assignments` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`triggering_workflow_job_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`assigned_at` integer NOT NULL,
	FOREIGN KEY (`workflow_job_id`) REFERENCES `jobs`(`workflow_job_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`triggering_workflow_job_id`,`attempt`) REFERENCES `attempts`(`workflow_job_id`,`attempt`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_attempt_unique` ON `assignments` (`triggering_workflow_job_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`workflow_job_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`state` text NOT NULL,
	`installation_id` integer NOT NULL,
	`repository_owner` text NOT NULL,
	`repository_name` text NOT NULL,
	`runner_name` text NOT NULL,
	`container_name` text NOT NULL,
	`assignment_deadline` integer NOT NULL,
	`runtime_deadline` integer,
	PRIMARY KEY(`workflow_job_id`, `attempt`),
	FOREIGN KEY (`workflow_job_id`) REFERENCES `jobs`(`workflow_job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_runner_name_unique` ON `attempts` (`runner_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_container_name_unique` ON `attempts` (`container_name`);--> statement-breakpoint
CREATE INDEX `attempts_state_assignment_deadline_idx` ON `attempts` (`state`,`assignment_deadline`);--> statement-breakpoint
CREATE INDEX `attempts_state_runtime_deadline_idx` ON `attempts` (`state`,`runtime_deadline`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`workflow_job_id` integer NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`repository_id` integer NOT NULL,
	`conclusion` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`attempt` integer NOT NULL,
	`delivery_id` text,
	FOREIGN KEY (`workflow_job_id`,`attempt`) REFERENCES `attempts`(`workflow_job_id`,`attempt`) ON UPDATE no action ON DELETE cascade
);
