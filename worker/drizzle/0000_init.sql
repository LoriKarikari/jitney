CREATE TABLE IF NOT EXISTS `assignments` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`triggering_workflow_job_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`runner_name` text NOT NULL,
	`container_name` text NOT NULL,
	`assigned_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `assignments_runner_name_unique` ON `assignments` (`runner_name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `attempts` (
	`workflow_job_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`state` text NOT NULL,
	`runner_name` text NOT NULL,
	`container_name` text NOT NULL,
	`assignment_deadline` integer NOT NULL,
	`runtime_deadline` integer,
	PRIMARY KEY(`workflow_job_id`, `attempt`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `attempts_runner_name_unique` ON `attempts` (`runner_name`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `attempts_container_name_unique` ON `attempts` (`container_name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`workflow_job_id` integer NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `jobs` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`repository_id` integer NOT NULL,
	`runner_name` text,
	`conclusion` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pending` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`runner_name` text NOT NULL,
	`container_name` text NOT NULL
);
