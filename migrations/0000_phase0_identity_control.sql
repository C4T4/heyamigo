CREATE TABLE `control` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`requested_by` text,
	`requested_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`person_id` text NOT NULL,
	`address` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `address`),
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_address_unique` ON `identities` (`address`);--> statement-breakpoint
CREATE TABLE `persons` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`timezone` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`current_job` text,
	`last_seen` integer NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workers_by_kind_status` ON `workers` (`kind`,`status`);--> statement-breakpoint
CREATE INDEX `workers_by_last_seen` ON `workers` (`last_seen`);