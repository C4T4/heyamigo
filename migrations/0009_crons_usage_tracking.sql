ALTER TABLE `crons` ADD `fire_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `crons` ADD `total_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `crons` ADD `total_output_tokens` integer DEFAULT 0 NOT NULL;