CREATE TABLE `waiting` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`installation_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_owner` text NOT NULL,
	`repository_name` text NOT NULL,
	`queued_at` integer NOT NULL,
	FOREIGN KEY (`workflow_job_id`) REFERENCES `jobs`(`workflow_job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `waiting_queued_at_idx` ON `waiting` (`queued_at`);