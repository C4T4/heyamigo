ALTER TABLE `inbound` ADD `kind` text;--> statement-breakpoint
CREATE INDEX `inbound_by_kind_done` ON `inbound` (`kind`,`status`);