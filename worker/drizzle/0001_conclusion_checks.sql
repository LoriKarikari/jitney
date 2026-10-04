CREATE TABLE `conclusion_checks` (
	`workflow_job_id` integer PRIMARY KEY NOT NULL,
	`installation_id` integer NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_owner` text NOT NULL,
	`repository_name` text NOT NULL,
	`check_at` integer NOT NULL,
	FOREIGN KEY (`workflow_job_id`) REFERENCES `jobs`(`workflow_job_id`) ON UPDATE no action ON DELETE cascade
);
