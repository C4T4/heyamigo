CREATE TABLE `outbound` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`media_path` text,
	`media_mime` text,
	`media_bytes` integer,
	`quote_msg_id` text,
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
CREATE INDEX `outbound_by_status_next` ON `outbound` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `outbound_by_address` ON `outbound` (`address`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_idempotency_key_uq` ON `outbound` (`idempotency_key`) WHERE "outbound"."idempotency_key" IS NOT NULL;