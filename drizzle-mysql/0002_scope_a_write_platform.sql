CREATE TABLE `command_idempotency` (
	`id` int AUTO_INCREMENT NOT NULL,
	`command_name` varchar(191) NOT NULL,
	`actor_scope` varchar(191) NOT NULL,
	`idempotency_key` varchar(191) NOT NULL,
	`request_digest` varchar(191) NOT NULL,
	`status` text NOT NULL DEFAULT ('pending'),
	`response_status` int,
	`response_json` text,
	`expires_at` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `command_idempotency_id` PRIMARY KEY(`id`),
	CONSTRAINT `command_idempotency_scope_key_unique` UNIQUE(`command_name`,`actor_scope`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `outbox_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`topic` varchar(191) NOT NULL,
	`aggregate_type` varchar(191) NOT NULL,
	`aggregate_id` varchar(191) NOT NULL,
	`deduplication_key` varchar(191) NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL DEFAULT ('pending'),
	`available_at` text NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 8,
	`locked_by` text,
	`locked_at` text,
	`last_error_code` text,
	`completed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `outbox_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `outbox_messages_deduplication_key_unique` UNIQUE(`deduplication_key`)
);
--> statement-breakpoint
CREATE TABLE `resource_versions` (
	`resource_type` varchar(191) NOT NULL,
	`resource_id` varchar(191) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `resource_versions_identity_unique` UNIQUE(`resource_type`,`resource_id`)
);
--> statement-breakpoint
CREATE TABLE `writer_fences` (
	`resource` varchar(191) NOT NULL,
	`owner` varchar(191) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`generation` int NOT NULL DEFAULT 1,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `writer_fences_resource` PRIMARY KEY(`resource`)
);
--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD `session_id` int;--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD `action` text;--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD `object_type` varchar(191);--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD `object_id` varchar(191);--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD `object_version` int;--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD `request_digest` varchar(191);--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD `consumed_at` text;--> statement-breakpoint
ALTER TABLE `file_objects` ADD `scan_status` varchar(191) DEFAULT 'quarantined' NOT NULL;--> statement-breakpoint
ALTER TABLE `file_objects` ADD `content_sha256` varchar(191) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD CONSTRAINT `auth_challenges_session_id_auth_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO `writer_fences` (`resource`, `owner`, `enabled`, `generation`, `updated_at`)
VALUES ('platform-writes', 'fastify-v1', true, 1, CURRENT_TIMESTAMP(3));--> statement-breakpoint
CREATE INDEX `outbox_claim_idx`
ON `outbox_messages` (`status`(16), `available_at`(27), `id`);--> statement-breakpoint
CREATE INDEX `outbox_lease_idx`
ON `outbox_messages` (`status`(16), `locked_at`(27), `id`);--> statement-breakpoint
INSERT IGNORE INTO `outbox_messages` (
  `topic`, `aggregate_type`, `aggregate_id`, `deduplication_key`,
  `payload_json`, `status`, `available_at`, `attempts`, `max_attempts`,
  `created_at`, `updated_at`
)
SELECT
  'email.deliver',
  'notification',
  CAST(messages.id AS CHAR),
  CONCAT('legacy-notification:', messages.id, ':email'),
  JSON_OBJECT(
    'to', users.email,
    'subject', messages.title,
    'text', messages.message,
    'businessNo', messages.business_no,
    'messageId', messages.id
  ),
  'pending',
  CURRENT_TIMESTAMP(3),
  0,
  8,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `notification_messages` AS messages
INNER JOIN `users` AS users ON users.id = messages.recipient_user_id
WHERE messages.channel = 'email' AND messages.status = 'queued';
