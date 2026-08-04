CREATE TABLE `browser_tab_leases` (
	`target_id` text PRIMARY KEY NOT NULL,
	`owner_task_id` text NOT NULL,
	`browser_context_id` text,
	`opener_target_id` text,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`created_by_task` integer DEFAULT false NOT NULL,
	`claimed_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`lease_expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `btab_leases_by_owner` ON `browser_tab_leases` (`owner_task_id`);--> statement-breakpoint
CREATE INDEX `btab_leases_by_expiry` ON `browser_tab_leases` (`lease_expires_at`);