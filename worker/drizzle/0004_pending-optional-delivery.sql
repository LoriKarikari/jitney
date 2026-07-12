PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`delivery_id` text,
	`installation_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_owner` text NOT NULL,
	`repository_name` text NOT NULL,
	`runner_name` text NOT NULL,
	`container_name` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_pending`("workflow_job_id", "delivery_id", "installation_id", "repository_id", "repository_owner", "repository_name", "runner_name", "container_name") SELECT "workflow_job_id", "delivery_id", "installation_id", "repository_id", "repository_owner", "repository_name", "runner_name", "container_name" FROM `pending`;--> statement-breakpoint
DROP TABLE `pending`;--> statement-breakpoint
ALTER TABLE `__new_pending` RENAME TO `pending`;--> statement-breakpoint
PRAGMA foreign_keys=ON;