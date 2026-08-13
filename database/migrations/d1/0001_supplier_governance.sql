ALTER TABLE `suppliers` ADD `legal_name` text NOT NULL DEFAULT '';
ALTER TABLE `suppliers` ADD `business_license_expires_at` text;
ALTER TABLE `suppliers` ADD `business_license_long_term` integer NOT NULL DEFAULT 0;
ALTER TABLE `suppliers` ADD `source` text NOT NULL DEFAULT 'manual';
ALTER TABLE `suppliers` ADD `source_created_at` text;
ALTER TABLE `suppliers` ADD `verification_status` text NOT NULL DEFAULT 'pending';
ALTER TABLE `suppliers` ADD `verified_by` integer;
ALTER TABLE `suppliers` ADD `verified_at` text;

CREATE TABLE `supplier_contacts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `supplier_id` integer NOT NULL REFERENCES `suppliers`(`id`),
  `name` text NOT NULL,
  `phone` text NOT NULL,
  `email` text NOT NULL DEFAULT '',
  `wechat` text NOT NULL DEFAULT '',
  `responsibility` text NOT NULL DEFAULT 'other',
  `is_primary` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'active',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `supplier_bank_accounts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `supplier_id` integer NOT NULL REFERENCES `suppliers`(`id`),
  `account_name` text NOT NULL,
  `bank_name` text NOT NULL,
  `encrypted_account_no` text NOT NULL,
  `usage` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE `supplier_skus` ADD `factory_id` integer REFERENCES `factories`(`id`);
ALTER TABLE `supplier_skus` ADD `priority` integer NOT NULL DEFAULT 1;
ALTER TABLE `supplier_skus` ADD `minimum_order_quantity` integer NOT NULL DEFAULT 1;
ALTER TABLE `supplier_skus` ADD `packaging_multiple` integer NOT NULL DEFAULT 1;
ALTER TABLE `supplier_skus` ADD `purchase_unit` text NOT NULL DEFAULT '';
ALTER TABLE `supplier_skus` ADD `daily_capacity` integer;
ALTER TABLE `supplier_skus` ADD `monthly_capacity` integer;
ALTER TABLE `supplier_skus` ADD `effective_from` text;
ALTER TABLE `supplier_skus` ADD `requested_by` integer REFERENCES `users`(`id`);
ALTER TABLE `supplier_skus` ADD `reviewed_by` integer REFERENCES `users`(`id`);
ALTER TABLE `supplier_skus` ADD `reviewed_at` text;
CREATE UNIQUE INDEX `supplier_sku_factory_unique` ON `supplier_skus` (`factory_id`,`supplier_id`,`sku`);

ALTER TABLE `core_price_change_requests` ADD `evidence_file_key` text;
