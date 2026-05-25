CREATE TABLE `crons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enqueue_into` text NOT NULL,
	`payload` text NOT NULL,
	`recurrence` text,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crons_by_due` ON `crons` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `crons_name_uq` ON `crons` (`name`) WHERE "crons"."recurrence" IS NOT NULL;