-- R3 independent migration hook. This file is intentionally not added to the
-- shared Drizzle journal; the integration owner must copy it into the next
-- numbered migration after R2/R3 merge ordering is known.

CREATE TABLE `r3_business_keys` (
  `key_type` varchar(64) NOT NULL,
  `key_value` varchar(191) NOT NULL,
  `aggregate_id` varchar(191) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `r3_business_keys_identity_unique` UNIQUE (`key_type`, `key_value`)
);

CREATE UNIQUE INDEX `r3_payment_record_reversal_unique`
  ON `payment_records` (`reverses_payment_record_id`);

-- The unique reversal index is also the fail-closed stored-data preflight:
-- malformed historical duplicate reversals abort migration. Corrections use a
-- separate one-to-one source relationship so reversal + correction can coexist.
ALTER TABLE `payment_records`
  ADD COLUMN `corrects_payment_record_id` int NULL AFTER `reverses_payment_record_id`;
CREATE UNIQUE INDEX `r3_payment_record_correction_unique`
  ON `payment_records` (`corrects_payment_record_id`);
ALTER TABLE `payment_records`
  ADD CONSTRAINT `r3_payment_reversal_type_check`
    CHECK (`reverses_payment_record_id` IS NULL OR `record_type` = 'reversal'),
  ADD CONSTRAINT `r3_payment_correction_type_check`
    CHECK (`corrects_payment_record_id` IS NULL OR `record_type` = 'correction');

ALTER TABLE `inventory_movements`
  ADD COLUMN `source_key` varchar(191) NULL AFTER `delivery_batch_id`;
CREATE UNIQUE INDEX `r3_inventory_movement_source_unique`
  ON `inventory_movements` (`source_key`);

ALTER TABLE `stocktake_adjustments`
  ADD COLUMN `bucket` varchar(32) NULL AFTER `stocktake_count_id`,
  ADD COLUMN `snapshot_quantity` int NULL AFTER `bucket`,
  ADD COLUMN `counted_quantity` int NULL AFTER `snapshot_quantity`,
  ADD COLUMN `revision` int NOT NULL DEFAULT 1 AFTER `variance_quantity`;
CREATE UNIQUE INDEX `r3_stocktake_adjustment_bucket_unique`
  ON `stocktake_adjustments` (`stocktake_id`, `stocktake_count_id`, `bucket`);

-- R1 binds Step-up to databaseObjectVersion(updated_at), expressed as Unix
-- milliseconds. A signed INT cannot store that value; BIGINT is the mechanical
-- compatibility correction required before any R3 finance/approval challenge.
ALTER TABLE `auth_challenges` MODIFY COLUMN `object_version` bigint;

INSERT INTO `writer_fences` (`resource`, `owner`, `enabled`, `generation`, `updated_at`) VALUES
  ('r3.approvals.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.inventory.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.transfers.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.production-orders.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.quality-inspections.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.stocktakes.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.shipments.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.returns.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.finance.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r3.warehouses.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
  `owner` = VALUES(`owner`), `enabled` = false, `generation` = VALUES(`generation`),
  `updated_at` = CURRENT_TIMESTAMP(3);
