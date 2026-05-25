CREATE TABLE `memory_writes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op` text NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text,
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
CREATE INDEX `memwr_by_status_next` ON `memory_writes` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `memwr_idemp_uq` ON `memory_writes` (`idempotency_key`) WHERE "memory_writes"."idempotency_key" IS NOT NULL;