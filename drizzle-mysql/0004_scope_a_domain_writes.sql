CREATE TABLE `r3_business_keys` (
  `key_type` varchar(64) NOT NULL,
  `key_value` varchar(191) NOT NULL,
  `aggregate_id` varchar(191) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `r3_business_keys_identity_unique` UNIQUE (`key_type`, `key_value`)
);
--> statement-breakpoint
ALTER TABLE `payment_records`
  ADD COLUMN `corrects_payment_record_id` int NULL AFTER `reverses_payment_record_id`;
--> statement-breakpoint
UPDATE `payment_records`
  SET `corrects_payment_record_id` = `reverses_payment_record_id`,
      `reverses_payment_record_id` = NULL
  WHERE `record_type` = 'correction'
    AND `reverses_payment_record_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `r3_payment_record_reversal_unique`
  ON `payment_records` (`reverses_payment_record_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `r3_payment_record_correction_unique`
  ON `payment_records` (`corrects_payment_record_id`);
--> statement-breakpoint
ALTER TABLE `payment_records`
  ADD CONSTRAINT `r3_payment_reversal_type_check`
    CHECK (`reverses_payment_record_id` IS NULL OR `record_type` = 'reversal'),
  ADD CONSTRAINT `r3_payment_correction_type_check`
    CHECK (`corrects_payment_record_id` IS NULL OR `record_type` = 'correction');
--> statement-breakpoint
ALTER TABLE `inventory_movements`
  ADD COLUMN `source_key` varchar(191) NULL AFTER `delivery_batch_id`;
--> statement-breakpoint
CREATE UNIQUE INDEX `r3_inventory_movement_source_unique`
  ON `inventory_movements` (`source_key`);
--> statement-breakpoint
ALTER TABLE `stocktake_adjustments`
  ADD COLUMN `bucket` varchar(32) NULL AFTER `stocktake_count_id`,
  ADD COLUMN `snapshot_quantity` int NULL AFTER `bucket`,
  ADD COLUMN `counted_quantity` int NULL AFTER `snapshot_quantity`,
  ADD COLUMN `revision` int NOT NULL DEFAULT 1 AFTER `variance_quantity`;
--> statement-breakpoint
CREATE UNIQUE INDEX `r3_stocktake_adjustment_bucket_unique`
  ON `stocktake_adjustments` (`stocktake_id`, `stocktake_count_id`, `bucket`);
--> statement-breakpoint
ALTER TABLE `auth_challenges` MODIFY COLUMN `object_version` bigint;
--> statement-breakpoint
INSERT INTO `writer_fences` (`resource`, `owner`, `enabled`, `generation`, `updated_at`) VALUES
  ('r2.imports.preview', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.imports.stage', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.imports.commit', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.master-data.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.suppliers.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.supplier-skus.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.supplier-prices.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.supplier-performance.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.purchase-plans.create', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.purchase-plans.update', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.purchase-orders.create', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.purchase-orders.update', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
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
  `owner` = VALUES(`owner`), `enabled` = false,
  `generation` = VALUES(`generation`), `updated_at` = CURRENT_TIMESTAMP(3);
