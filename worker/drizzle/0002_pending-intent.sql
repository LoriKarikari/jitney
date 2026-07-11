CREATE TABLE `pending` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_owner` text NOT NULL,
	`repository_name` text NOT NULL,
	`runner_name` text NOT NULL,
	`container_name` text NOT NULL
);
