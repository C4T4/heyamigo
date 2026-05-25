CREATE TABLE `thread_category_weights` (
	`category` text PRIMARY KEY NOT NULL,
	`weight` integer DEFAULT 50 NOT NULL,
	`samples` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_jid` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`hotness` integer DEFAULT 50 NOT NULL,
	`status` text DEFAULT 'live' NOT NULL,
	`linked_memory` text,
	`opened_at` integer NOT NULL,
	`last_touched_at` integer NOT NULL,
	`next_review_at` integer NOT NULL,
	`resolution_note` text,
	`total_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_output_tokens` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_by_jid_hot` ON `threads` (`target_jid`,`status`,`hotness`);--> statement-breakpoint
CREATE INDEX `threads_by_due` ON `threads` (`enabled`,`status`,`next_review_at`);