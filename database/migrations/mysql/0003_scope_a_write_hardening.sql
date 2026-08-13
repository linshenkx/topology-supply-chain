UPDATE `writer_fences`
SET `enabled` = false, `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `resource` = 'platform-writes';
--> statement-breakpoint
INSERT INTO `writer_fences` (`resource`, `owner`, `enabled`, `generation`, `updated_at`) VALUES
  ('auth.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('users.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('files.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('notifications.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('outbox.worker', 'worker-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('reminders.worker', 'worker-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('files.worker', 'worker-v1', false, 2, CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
  `owner` = VALUES(`owner`), `enabled` = false,
  `generation` = VALUES(`generation`), `updated_at` = CURRENT_TIMESTAMP(3);
--> statement-breakpoint
INSERT IGNORE INTO `outbox_messages` (
  `topic`, `aggregate_type`, `aggregate_id`, `deduplication_key`,
  `payload_json`, `status`, `available_at`, `attempts`, `max_attempts`,
  `created_at`, `updated_at`
)
SELECT 'file.scan', 'file_object', CAST(files.id AS CHAR),
       CONCAT('file-backfill:', files.id, ':', COALESCE(NULLIF(files.content_sha256, ''), 'unknown')),
       JSON_OBJECT('fileId', files.id, 'objectKey', files.object_key, 'backfill', true),
       'pending', CURRENT_TIMESTAMP(3), 0, 8, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `file_objects` AS files
WHERE files.scan_status <> 'clean';
--> statement-breakpoint
INSERT INTO `audit_logs` (
  `actor_user_id`, `action`, `module`, `entity_type`, `entity_id`,
  `after_json`, `sensitive_view`, `exported`, `archive_after`, `created_at`
)
SELECT files.owner_user_id, 'backfill_file_scope', 'files', 'file_object', CAST(files.id AS CHAR),
       JSON_OBJECT('entityType', 'legacy_file', 'entityId', CAST(files.id AS CHAR), 'strategy', 'owner_only'),
       0, 0, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 5 YEAR), CURRENT_TIMESTAMP(3)
FROM `file_objects` AS files
WHERE files.entity_type IS NULL OR files.entity_id IS NULL;
--> statement-breakpoint
UPDATE `file_objects`
SET `entity_type` = 'legacy_file', `entity_id` = CAST(`id` AS CHAR)
WHERE `entity_type` IS NULL OR `entity_id` IS NULL;
