CREATE TABLE `browser_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`actor_person_id` text,
	`description` text NOT NULL,
	`originating_message` text NOT NULL,
	`sender_number` text NOT NULL,
	`sender_name` text,
	`allowed_tools` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`claimed_by` text,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `btasks_by_status_next` ON `browser_tasks` (`status`,`next_attempt_at`);