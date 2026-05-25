CREATE TABLE `inbound` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`actor_address` text,
	`person_id` text,
	`actor_person_id` text,
	`external_msg_id` text,
	`text` text NOT NULL,
	`media_path` text,
	`media_mime` text,
	`media_bytes` integer,
	`push_name` text,
	`trigger_reason` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`claimed_by` text,
	`claimed_at` integer,
	`received_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbound_by_status_next` ON `inbound` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `inbound_by_address` ON `inbound` (`address`);--> statement-breakpoint
CREATE INDEX `inbound_by_person` ON `inbound` (`person_id`,`received_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_external_msg_id_uq` ON `inbound` (`external_msg_id`) WHERE "inbound"."external_msg_id" IS NOT NULL;